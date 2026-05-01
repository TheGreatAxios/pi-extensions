/**
 * pi-container-sandbox
 * --------------------
 * Run every read/write/edit/bash operation pi performs inside a per-session
 * Linux container (Docker only).
 *
 * Threat model:
 *   - The agent's bash and file tools never touch the host filesystem outside
 *     the project cwd, which is bind-mounted into the container at /workspace.
 *   - The agent runs as a non-root user (uid 1000) inside the container.
 *   - No host secrets are mounted (no $HOME, ~/.ssh, ~/.aws, ~/.config, no
 *     SSH agent, no Docker socket).
 *   - Network is enabled by default; the security proxy gates outbound traffic.
 *     Disable with --no-container-net.
 *     Docker uses --network none (when disabled).
 *   - Resource caps via size tiers (xs, sm, md, lg, xlg, xxlg) limit blast radius.
 *     Override with --container-size or individual --container-memory, --container-cpus, etc.
 *
 * Path safety:
 *   - Any tool path resolved outside of cwd is rejected. The agent literally
 *     cannot ask the sandbox to read /etc/passwd on the host.
 *     EXCEPTION: pi clipboard temp files (basename "pi-clipboard-*") are read
 *     directly from the host. Additional paths can be allowed via
 *     --container-allow-paths or /sandbox-allow.
 *
 * Usage:
 *   Docker: image is pulled automatically from Docker Hub on first run.
 *   Then run pi with the extension (sandbox is ON by default):
 *        pi -e ./index.ts
 *      Optional flags:
 *        --container-size xs|sm|md|lg|xlg|xxlg (default: sm)
 *        --sandbox-name <name>                 (re-usable sandbox; reattaches if exists)
 *        --sandbox-persist                     (keep container after pi exits)
 *        --sandbox-cache <volume>              (persistent cache volume at /cache)
 *        --container-image <name>            (default: thegreataxios/pi-sandbox:latest)
 *        --container-net                     (allow outbound network)
 *        --prawl, --browser                  (alias for --container-net)
 *        --container-keep                    (don't stop the container on exit)
 *        --container-mount-skills            (mount ~/.agents/skills & ~/.pi/agent/skills read-only at /skills; default: on)
 *        --container-mount-paths <paths>     (comma-separated extra host dirs to mount at /skills/<basename>)
 *        --container-memory <limit>          (e.g., 10g, 512m)
 *        --container-cpus <count>            (e.g., 4, 0.5)
 *        --container-pids-limit <n>          (max processes; default: 512)
 *        --container-swap <limit>            (swap limit, e.g., 1g)
 *        --no-container, --noc               (bypass entirely)
 *
 * Config file (.pi/config.json):
 *   {
 *     "sandbox": {
 *       "size": "lg",
 *       "persist": true,
 *       "cacheVolume": "my-project-cache"
 *     }
 *   }
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ExtensionAPI,
	type ReadOperations,
	type WriteOperations,
} from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Size tier configuration
// ---------------------------------------------------------------------------

type SizeTier = "xs" | "sm" | "md" | "lg" | "xlg" | "xxlg";

interface TierSpec {
	memory: string;
	swap: string;
	cpus: string;
	disk: string;
}

const TIER_SPECS: Record<SizeTier, TierSpec> = {
	xs: { memory: "512m", swap: "512m", cpus: "0.5", disk: "2g" },
	sm: { memory: "2g", swap: "1g", cpus: "1", disk: "5g" },
	md: { memory: "4g", swap: "2g", cpus: "2", disk: "10g" },
	lg: { memory: "8g", swap: "4g", cpus: "4", disk: "20g" },
	xlg: { memory: "16g", swap: "4g", cpus: "8", disk: "40g" },
	xxlg: { memory: "32g", swap: "4g", cpus: "16", disk: "80g" },
};

/** Parse a human-readable size string (e.g., "2g", "512m") to bytes */
function parseBytesToBytes(s: string): number {
	const match = s.match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g|t)?$/i);
	if (!match) return 0;
	const val = parseFloat(match[1]);
	const unit = (match[2] ?? "b").toLowerCase();
	const multipliers: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
	return Math.round(val * (multipliers[unit] ?? 1));
}

/** Format bytes back to the largest whole unit (e.g., 3221225472 → "3g") */
function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3 && bytes % (1024 ** 3) === 0) return `${bytes / (1024 ** 3)}g`;
	if (bytes >= 1024 ** 2 && bytes % (1024 ** 2) === 0) return `${bytes / (1024 ** 2)}m`;
	if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}k`;
	return `${bytes}b`;
}

function parseSizeTier(tier: string): SizeTier | null {
	if (tier in TIER_SPECS) return tier as SizeTier;
	return null;
}

interface SandboxConfig {
	size?: SizeTier;
	persist?: boolean;
	cacheVolume?: string;
}

function loadSandboxConfig(hostCwd: string): SandboxConfig | null {
	const configPath = resolvePath(hostCwd, ".pi", "config.json");
	if (!existsSync(configPath)) return null;
	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(content);
		if (parsed?.sandbox && typeof parsed.sandbox === "object") {
			return parsed.sandbox as SandboxConfig;
		}
	} catch {
		// Invalid JSON or missing sandbox key
	}
	return null;
}

// ---------------------------------------------------------------------------
// Runtime abstraction (Docker only for now)
// ---------------------------------------------------------------------------

type RuntimeKind = "docker";

interface Runtime {
	kind: RuntimeKind;
	bin: string;
	/** Returns the container name actually used (may differ from args.name on collision). */
	run(args: RunArgs): Promise<string>;
	stop(name: string): void;
	exists(image: string): Promise<boolean>;
	/** Check if a container with the given name is running. */
	isRunning(name: string): Promise<boolean>;
	/** Start an existing stopped container. */
	start(name: string): Promise<boolean>;
	/** Create a Docker volume if it doesn't exist (Docker only). Apple container returns false. */
	createVolume(name: string): Promise<boolean>;
}

interface MountSpec {
	/** Absolute path on the host. */
	source: string;
	/** Absolute path inside the container. */
	target: string;
}

interface RunArgs {
	name: string;
	image: string;
	hostCwd: string;
	allowNetwork: boolean;
	/** Extra read-only bind mounts (e.g. skill directories). */
	extraMounts?: MountSpec[];
	/** Resource limits (undefined = use runtime default). */
	resources?: {
		memory?: string;  // e.g., "2g", "512m", "10gb"
		cpus?: string;    // e.g., "2", "0.5", "4.0"
		pidsLimit?: number; // e.g., 512 (Docker only)
		swap?: string;    // e.g., "1g", "0" to disable (Docker only)
		disk?: string;    // disk/storage limit (e.g., "10g", "20gb")
	};
	/** Optional Docker volume to mount at /cache for persistent caching. */
	cacheVolume?: string;
}

function randomSuffix(): string {
	return randomBytes(4).toString("hex");
}

function which(bin: string): boolean {
	const r = spawnSync("which", [bin], { stdio: "ignore" });
	return r.status === 0;
}

async function detectRuntime(ctx?: any): Promise<Runtime | null> {
	const haveDocker = which("docker");

	if (!haveDocker) {
		return null;
	}

	const runtime = dockerRuntime();

	// Test the runtime with a quick 3s smoke test
	const testName = `pi-test-${randomSuffix()}`;
	try {
		const r = await spawnWithTimeout(runtime.bin, ["run", "-d", "--rm", "--name", testName, "debian:bookworm-slim", "sleep", "infinity"], 3000);
		if (r.code === 0 && !r.timedOut) {
			// Clean up test container
			runtime.stop(testName);
			if (ctx?.ui) {
				ctx.ui.notify(`Using docker runtime (3s smoke test passed)`, "info");
			}
			return runtime;
		}
		if (r.timedOut) {
			if (ctx?.ui) {
				ctx.ui.notify(`docker runtime timed out (3s)`, "warning");
			}
		}
	} catch {
		// Fall through
	}

	return null;
}

/** Spawn a command with a timeout. Returns {code, stdout, stderr, timedOut} */
function spawnWithTimeout(
	bin: string,
	args: string[],
	timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout.on("data", (d) => out.push(d));
		child.stderr.on("data", (d) => err.push(d));
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: -1, stdout: "", stderr: "spawn error", timedOut: false });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				code,
				stdout: Buffer.concat(out).toString(),
				stderr: Buffer.concat(err).toString(),
				timedOut,
			});
		});
	});
}

function dockerRuntime(): Runtime {
	const bin = "docker";
	return {
		kind: "docker",
		bin,
		exists: async (image) => {
			const r = await spawnWithTimeout(bin, ["image", "inspect", image], 10000);
			return r.code === 0 && !r.timedOut;
		},
		stop: (name) => {
			spawnSync(bin, ["stop", name], { stdio: "ignore" });
		},
		isRunning: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["inspect", "--format", "{{.State.Running}}", name], 5000);
			return r.code === 0 && r.stdout.trim() === "true";
		},
		start: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["start", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		createVolume: async (name: string) => {
			const r = await spawnWithTimeout(bin, ["volume", "create", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		run: async ({ name, image, hostCwd, allowNetwork, extraMounts, resources, cacheVolume }) => {
			const memory = resources?.memory ?? "2g";
			const cpus = resources?.cpus ?? "2";
			const pidsLimit = resources?.pidsLimit ?? 512;
			const swap = resources?.swap;
			const disk = resources?.disk;

			const args: string[] = [
				"run",
				"-d",
				"--name", name,
				"--user", "1000:1000",
				"--memory", memory,
				"--cpus", cpus,
				"--cap-drop", "ALL",
				"--security-opt", "no-new-privileges",
				"--pids-limit", String(pidsLimit),
				"-v", `${hostCwd}:/workspace`,
				"-w", "/workspace",
			];
			if (extraMounts) {
				for (const m of extraMounts) {
					args.push("-v", `${m.source}:${m.target}:ro`);
				}
			}
			// Mount cache volume if provided
			if (cacheVolume) {
				args.push("-v", `${cacheVolume}:/cache`);
			}
			// Add storage/disk limit if provided (Docker supports this on some storage drivers)
			if (disk) {
				args.push("--storage-opt", `size=${disk}`);
			}
			if (swap !== undefined) {
				if (swap === "0") {
					args.push("--memory-swap", "0"); // 0 = unlimited swap
				} else {
					// Docker --memory-swap = RAM + swap (total), tier spec stores swap-only portion
					const totalSwap = parseBytesToBytes(memory) + parseBytesToBytes(swap);
					args.push("--memory-swap", formatBytes(totalSwap));
				}
			}
			if (!allowNetwork) args.push("--network", "none");
			args.push(image, "sleep", "infinity");
			const r = await spawnWithTimeout(bin, args, 60000);
			if (r.timedOut) {
				throw new Error(`docker run timed out after 60s (command: docker run ${name})`);
			}
			if (r.code !== 0) {
				throw new Error(`docker run failed: ${r.stderr || r.stdout}`);
			}
			return name;
		},
	};
}

// ---------------------------------------------------------------------------
// Sandbox session: a single running container per pi session
// ---------------------------------------------------------------------------

interface Sandbox {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	keep: boolean;
	/** Mounts applied when the container was created. */
	mounts: MountSpec[];
	/** Host path prefixes allowed for read access from outside cwd. */
	allowedExternalPrefixes: string[];
	/** Resource limits applied to the container. */
	resources?: RunArgs["resources"];
	/** Whether this sandbox is re-usable across sessions. */
	isReusable: boolean;
	/** Whether this sandbox was reattached (vs newly created). */
	isReattached: boolean;
}

let sandbox: Sandbox | null = null;
const getSbx = () => sandbox;

// ---------------------------------------------------------------------------
// Path translation + safety
// ---------------------------------------------------------------------------

const REMOTE_ROOT = "/workspace";
const SKILLS_ROOT = "/skills";

/** Return the container-side path if it falls under a known extra mount, otherwise null. */
function resolveExtraMountPath(containerPath: string, mounts: MountSpec[]): string | null {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return containerPath;
		}
	}
	return null;
}

function toRemote(hostPath: string, hostCwd: string, mounts?: MountSpec[]): string {
	// If the path is already a container-absolute path (/workspace/...),
	// accept it directly — the agent may be thinking in container space
	// because the system prompt shows CWD as /workspace.
	if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) {
		return hostPath;
	}
	// Also accept paths under any extra mount target (e.g. /skills/...)
	if (mounts) {
		const resolved = resolveExtraMountPath(hostPath, mounts);
		if (resolved) return resolved;
	}
	const abs = resolvePath(hostCwd, hostPath);
	if (abs !== hostCwd && !abs.startsWith(`${hostCwd}/`)) {
		throw new Error(
			`sandbox: refusing to access ${abs}: outside of project cwd ${hostCwd}`,
		);
	}
	const rel = abs === hostCwd ? "" : abs.slice(hostCwd.length + 1);
	return rel ? `${REMOTE_ROOT}/${rel}` : REMOTE_ROOT;
}

/**
 * Check whether a container-side path falls under an extra (read-only) mount.
 * Used to reject write/edit operations against skill directories.
 */
function isReadOnlyMount(containerPath: string, mounts: MountSpec[]): boolean {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return true;
		}
	}
	return false;
}

/**
 * Check whether an external host path is allowed for read access.
 * Default: pi clipboard temp files (basename starts with "pi-clipboard-").
 * Additional prefixes can be added via --container-allow-paths or /sandbox-allow.
 */
function isAllowedExternalResource(hostPath: string, allowedPrefixes: string[]): boolean {
	const abs = resolvePath(hostPath);
	// Default: pi clipboard files
	const basename = abs.split("/").pop() || "";
	if (basename.startsWith("pi-clipboard-")) return true;
	// User-configured prefixes
	for (const prefix of allowedPrefixes) {
		if (abs === prefix || abs.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

/**
 * Check if a host path falls inside the project cwd.
 */
function isInsideCwd(hostPath: string, hostCwd: string): boolean {
	const abs = resolvePath(hostCwd, hostPath);
	return abs === hostCwd || abs.startsWith(`${hostCwd}/`);
}

function shq(s: string): string {
	// POSIX single-quote: ' -> '\''
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Container exec helpers
// ---------------------------------------------------------------------------

function execCapture(sbx: Sandbox, command: string, timeoutMs?: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(sbx.runtime.bin, ["exec", sbx.name, "sh", "-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;

		const timer = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs)
			: undefined;

		child.stdout.on("data", (d) => out.push(d));
		child.stderr.on("data", (d) => err.push(d));
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`exec timed out after ${timeoutMs}ms: ${command}`));
			} else if (code !== 0) {
				reject(new Error(`exec failed (${code}): ${Buffer.concat(err).toString()}`));
			} else {
				resolve(Buffer.concat(out));
			}
		});
	});
}

function execStream(
	sbx: Sandbox,
	command: string,
	{ onData, signal, timeout }: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(sbx.runtime.bin, ["exec", sbx.name, "sh", "-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;
		const timer = timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeout * 1000)
			: undefined;
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${timeout}`));
			else resolve({ exitCode: code });
		});
	});
}

// ---------------------------------------------------------------------------
// Operations adapters (one per built-in tool)
// ---------------------------------------------------------------------------

function readOps(sbx: Sandbox): ReadOperations {
	const resolveAbs = (p: string) => resolvePath(sbx.hostCwd, p);
	const tryExternal = (p: string): { external: true; abs: string } | { external: false } => {
		if (isInsideCwd(p, sbx.hostCwd)) return { external: false };
		const abs = resolveAbs(p);
		return isAllowedExternalResource(abs, sbx.allowedExternalPrefixes)
			? { external: true, abs }
			: { external: false };
	};

	return {
		readFile: (p) => {
			const ext = tryExternal(p);
			if (ext.external) return Promise.resolve(readFileSync(ext.abs));
			return execCapture(sbx, `cat ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`);
		},
		access: (p) => {
			const ext = tryExternal(p);
			if (ext.external) {
				try { statSync(ext.abs); return Promise.resolve(); }
				catch (e) { return Promise.reject(e); }
			}
			return execCapture(sbx, `test -r ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`).then(() => {});
		},
		detectImageMimeType: async (p) => {
			const ext = tryExternal(p);
			if (ext.external) {
				const ext2lower = ext.abs.split(".").pop()?.toLowerCase() || "";
				const map: Record<string, string> = {
					jpg: "image/jpeg", jpeg: "image/jpeg",
					png: "image/png", gif: "image/gif", webp: "image/webp",
				};
				return map[ext2lower] || null;
			}
			try {
				const r = await execCapture(sbx, `file --mime-type -b ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function writeOps(sbx: Sandbox): WriteOperations {
	return {
		writeFile: async (p, content) => {
			const remote = toRemote(p, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(remote, sbx.mounts)) {
				throw new Error(`sandbox: refusing to write to ${remote}: read-only skill mount`);
			}
			const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
			const b64 = buf.toString("base64");
			await execCapture(sbx, `printf %s ${shq(b64)} | base64 -d > ${shq(remote)}`);
		},
		mkdir: async (dir) => {
			const remote = toRemote(dir, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(remote, sbx.mounts)) {
				throw new Error(`sandbox: refusing to mkdir in ${remote}: read-only skill mount`);
			}
			await execCapture(sbx, `mkdir -p ${shq(remote)}`);
		},
	};
}

function editOps(sbx: Sandbox): EditOperations {
	const r = readOps(sbx);
	const w = writeOps(sbx);
	return {
		readFile: r.readFile,
		access: r.access,
		writeFile: async (p, content) => {
			const remote = toRemote(p, sbx.hostCwd, sbx.mounts);
			if (isReadOnlyMount(remote, sbx.mounts)) {
				throw new Error(`sandbox: refusing to edit ${remote}: read-only skill mount`);
			}
			return w.writeFile(p, content);
		},
	};
}

function bashOps(sbx: Sandbox): BashOperations {
	return {
		exec: (command, cwd, opts) => {
			const remoteCwd = toRemote(cwd, sbx.hostCwd, sbx.mounts);
			return execStream(sbx, `cd ${shq(remoteCwd)} && ${command}`, opts);
		},
	};
}

// ---------------------------------------------------------------------------
// Skill directory discovery
// ---------------------------------------------------------------------------

/**
 * Scan the host filesystem for agent skill directories and return mount specs.
 *
 * Looks under the following host directories (in order):
 *   - Any additional paths passed via --container-mount-skills (comma-separated)
 *   - $HOME/.agents/skills/
 *   - $HOME/.pi/agent/skills/
 *
 * Each immediate subdirectory that exists on disk becomes a read-only bind mount
 * at /skills/<name> inside the container.
 */
function discoverSkillDirs(additionalPaths?: string[]): MountSpec[] {
	const home = homedir();
	const skillRoots = [
		...additionalPaths ?? [],
		resolvePath(home, ".agents", "skills"),
		resolvePath(home, ".pi", "agent", "skills"),
	];

	const mounts: MountSpec[] = [];

	for (const root of skillRoots) {
		if (!existsSync(root)) continue;
		try {
			const entries = readdirSync(root);
			for (const entry of entries) {
				const full = resolvePath(root, entry);
				try {
					const st = statSync(full);
					if (!st.isDirectory()) continue;
				} catch {
					continue;
				}
				// Avoid duplicate mount targets if the same skill name exists
				// under multiple roots — first one wins.
				const target = `${SKILLS_ROOT}/${entry}`;
				if (mounts.some((m) => m.target === target)) continue;
				mounts.push({ source: full, target });
			}
		} catch {
			// Permission or I/O error — skip silently.
		}
	}

	return mounts;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("container", {
		description: "Sandbox all bash/read/write/edit ops inside a Linux container (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-container", {
		description: "Force-disable container sandboxing",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("noc", {
		description: "Alias for --no-container",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-size", {
		description: "Sandbox size tier: xs, sm (default), md, lg, xlg, xxlg. Sets memory, swap, cpu, disk limits.",
		type: "string",
		default: "sm",
	});
	pi.registerFlag("sandbox-name", {
		description: "Re-usable sandbox name. If container exists, reattaches; otherwise creates new. Random name if omitted.",
		type: "string",
	});
	pi.registerFlag("sandbox-persist", {
		description: "Keep sandbox container running after pi exits (for re-usable sandboxes)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-cache", {
		description: "Docker volume name for persistent cache at /cache (auto-created if needed)",
		type: "string",
	});
	pi.registerFlag("container-image", {
		description: "Image to use for the sandbox (default: thegreataxios/pi-sandbox:latest)",
		type: "string",
	});
	pi.registerFlag("container-net", {
		description: "Allow outbound network from the sandbox (default: on; use --no-container-net to disable)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("prawl", {
		description: "Alias for --container-net (enables network for prawl/chromium)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("browser", {
		description: "Alias for --container-net (enables network for prawl/chromium)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-keep", {
		description: "Don't stop the sandbox container when pi exits (for debugging)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-mount-skills", {
		description: "Mount agent skill directories read-only into the container at /skills (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("container-mount-paths", {
		description: "Comma-separated list of additional host directories to mount read-only at /skills/<basename>",
		type: "string",
	});
	pi.registerFlag("container-allow-paths", {
		description: "Comma-separated list of host path prefixes to allow for read access from outside the sandbox (e.g. ~/Downloads)",
		type: "string",
	});
	pi.registerFlag("container-memory", {
		description: "Memory limit for the container (e.g., 2g, 512m, 10gb). Default: 2g",
		type: "string",
	});
	pi.registerFlag("container-cpus", {
		description: "CPU limit for the container (e.g., 2, 0.5, 4.0). Default: 2",
		type: "string",
	});
	pi.registerFlag("container-pids-limit", {
		description: "Maximum number of PIDs the container can create (Docker only). Default: 512",
		type: "string",
	});
	pi.registerFlag("container-swap", {
		description: "Swap limit for the container (e.g., 1g, 0 to disable). Docker only. Default: unset",
		type: "string",
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localRead.execute(id, params, signal, onUpdate);
			const tool = createReadTool(localCwd, { operations: readOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localWrite.execute(id, params, signal, onUpdate);
			const tool = createWriteTool(localCwd, { operations: writeOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localEdit.execute(id, params, signal, onUpdate);
			const tool = createEditTool(localCwd, { operations: editOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localBash.execute(id, params, signal, onUpdate);
			const tool = createBashTool(localCwd, { operations: bashOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		const sbx = getSbx();
		if (!sbx) return;
		return { operations: bashOps(sbx) };
	});

	pi.on("before_agent_start", async (event) => {
		const sbx = getSbx();
		if (!sbx) return;

		const skillInfo = sbx.mounts.length
			? `Agent skills are mounted read-only at ${SKILLS_ROOT}/ (e.g. ${sbx.mounts.map((m) => m.target).join(", ")}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
			: "No skill directories are mounted.";

		return {
			systemPrompt: event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				[
					`Current working directory: ${REMOTE_ROOT} (sandboxed in ${sbx.runtime.kind} container ${sbx.name}, host cwd ${localCwd} mounted read-write)`,
					skillInfo,
				].join("\n"),
			),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if ((pi.getFlag("no-container") as boolean) || (pi.getFlag("noc") as boolean)) return;
		if (!(pi.getFlag("container") as boolean)) return;

		try {
			const runtime = await detectRuntime(ctx);
			if (!runtime) {
				ctx.ui.notify("Docker not available or timed out. Running without sandbox.", "warning");
				return;
			}

			// Load sandbox config from .pi/config.json
			const config = loadSandboxConfig(localCwd);

			// Determine size tier (flag > config > default)
			const sizeFlag = pi.getFlag("container-size") as string | undefined;
			const sizeTier = parseSizeTier(sizeFlag || config?.size || "sm") || "sm";
			const tierSpec = TIER_SPECS[sizeTier];

			const image = (pi.getFlag("container-image") as string) || "thegreataxios/pi-sandbox:latest";
			const allowNetwork = (pi.getFlag("container-net") as boolean) || (pi.getFlag("prawl") as boolean) || (pi.getFlag("browser") as boolean);
			const keep = pi.getFlag("container-keep") as boolean;
			const persist = pi.getFlag("sandbox-persist") as boolean || config?.persist || false;
			const mountSkills = pi.getFlag("container-mount-skills") as boolean;
			const extraPathsRaw = pi.getFlag("container-mount-paths") as string | undefined;
			const extraPaths = extraPathsRaw ? extraPathsRaw.split(",").map((p) => p.trim()).filter(Boolean) : undefined;

			// Determine sandbox name
			const nameFlag = pi.getFlag("sandbox-name") as string | undefined;
			const sandboxName = nameFlag || `pi-sbx-${randomSuffix()}`;
			const isReusable = !!nameFlag;

			// Determine cache volume
			const cacheFlag = pi.getFlag("sandbox-cache") as string | undefined;
			const cacheVolume = cacheFlag || config?.cacheVolume;

			// Create cache volume if specified
			if (cacheVolume) {
				await runtime.createVolume(cacheVolume);
			}

			// Discover skill directories on the host.
			const skillMounts = mountSkills ? discoverSkillDirs(extraPaths) : [];

			// Check if sandbox already exists and is running (re-usable sandbox)
			let isReattached = false;
			if (isReusable) {
				const running = await runtime.isRunning(sandboxName);
				if (running) {
					isReattached = true;
					ctx.ui.notify(`Reattaching to existing sandbox: ${sandboxName}`, "info");
				} else {
					// Try to start if it exists but is stopped
					const started = await runtime.start(sandboxName);
					if (started) {
						isReattached = true;
						ctx.ui.notify(`Restarted existing sandbox: ${sandboxName}`, "info");
					}
				}
			}

			if (!(await runtime.exists(image))) {
				ctx.ui.notify(`Sandbox image "${image}" not found locally, pulling from registry...`);
				const pull = await spawnWithTimeout(runtime.bin, ["pull", image], 120000);
				if (!pull || pull.code !== 0 || pull.timedOut) {
					ctx.ui.notify(
						`Sandbox image "${image}" not found. Pull failed. Build it manually:\n  docker build -t ${image} -f docker/Dockerfile docker`,
						"error",
					);
					return;
				}
			}

			const allowPathsRaw = pi.getFlag("container-allow-paths") as string | undefined;
			const allowedExternalPrefixes = allowPathsRaw
				? allowPathsRaw.split(",").map((p) => p.trim()).filter(Boolean).map((p) =>
					p.startsWith("~") ? resolvePath(homedir(), p.slice(1)) : resolvePath(p)
				)
				: [];

			// Build resource config from tier + flag overrides
			const resources: RunArgs["resources"] = {
				memory: tierSpec.memory,
				cpus: tierSpec.cpus,
				swap: tierSpec.swap,
				disk: tierSpec.disk,
			};

			// Apply flag overrides
			const memFlag = pi.getFlag("container-memory") as string | undefined;
			const cpusFlag = pi.getFlag("container-cpus") as string | undefined;
			const pidsFlagRaw = pi.getFlag("container-pids-limit") as string | undefined;
			const pidsFlag = pidsFlagRaw ? parseInt(pidsFlagRaw, 10) : undefined;
			const swapFlag = pi.getFlag("container-swap") as string | undefined;
			if (memFlag) resources.memory = memFlag;
			if (cpusFlag) resources.cpus = cpusFlag;
			if (pidsFlag !== undefined) resources.pidsLimit = pidsFlag;
			if (swapFlag !== undefined) resources.swap = swapFlag;

			// Create new sandbox if not reattaching
			let actualName = sandboxName;
			if (!isReattached) {
				actualName = await runtime.run({
					name: sandboxName,
					image,
					hostCwd: localCwd,
					allowNetwork,
					extraMounts: skillMounts.length ? skillMounts : undefined,
					resources,
					cacheVolume,
				});
			}

			sandbox = {
				runtime,
				name: actualName,
				hostCwd: localCwd,
				keep: keep || persist,
				mounts: skillMounts,
				allowedExternalPrefixes,
				resources,
				isReusable,
				isReattached,
			};

			// Cleanup handler - only stop if not keep/persist and not re-usable
			const cleanup = () => {
				const s = sandbox;
				if (!s || s.keep) return;
				try {
					s.runtime.stop(s.name);
				} catch {}
				sandbox = null;
			};
			process.once("exit", cleanup);
			process.once("SIGINT", () => {
				cleanup();
				process.exit(130);
			});
			process.once("SIGTERM", () => {
				cleanup();
				process.exit(143);
			});

			// Smoke test (10s timeout)
			const ok = (await execCapture(sandbox, "id -un && pwd", 10000)).toString().trim();

			// Build resource status string
			const resParts: string[] = [
				`size=${sizeTier}`,
				`mem=${resources.memory}`,
				`cpu=${resources.cpus}`,
				`swap=${resources.swap}`,
				`disk=${resources.disk}`,
			];
			if (resources.pidsLimit !== undefined) resParts.push(`pids=${resources.pidsLimit}`);
			const resStr = ` (${resParts.join(", ")})`;

			const statusPrefix = isReattached ? "🔄 Reattached" : "🛡 Sandbox up";
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `${statusPrefix}: ${actualName} (net=${allowNetwork ? "on" : "off"})${resStr}`),
			);
			ctx.ui.notify(
				`${statusPrefix}: docker ${actualName}${resStr}${isReusable ? " [re-usable]" : ""}\n${ok}${skillMounts.length ? `\nSkills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : ""}${cacheVolume ? `\nCache volume: ${cacheVolume} at /cache` : ""}`,
				"info"
			);
		} catch (e) {
			sandbox = null;
			ctx.ui.notify(`Sandbox init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		const sbx = getSbx();
		if (!sbx) return;
		if (!sbx.keep) sbx.runtime.stop(sbx.name);
		sandbox = null;
	});

	pi.registerCommand("sandbox", {
		description: "Show sandbox status",
		handler: async (_args, ctx) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active. Start pi with --container.", "info");
				return;
			}
			const info = (await execCapture(sbx, "id; uname -a; df -h /workspace | tail -1")).toString();
			const resParts: string[] = [];
			if (sbx.resources?.memory) resParts.push(`memory: ${sbx.resources.memory}`);
			if (sbx.resources?.cpus) resParts.push(`cpus: ${sbx.resources.cpus}`);
			if (sbx.resources?.disk) resParts.push(`disk: ${sbx.resources.disk}`);
			if (sbx.resources?.swap !== undefined) resParts.push(`swap: ${sbx.resources.swap}`);
			if (sbx.resources?.pidsLimit !== undefined) resParts.push(`pids-limit: ${sbx.resources.pidsLimit}`);
			const resStr = resParts.length ? `\nresources: ${resParts.join(", ")}` : "";
			const reusableStr = sbx.isReusable ? ` [re-usable${sbx.isReattached ? ", reattached" : ""}]` : "";
			ctx.ui.notify(
				`Sandbox: ${sbx.runtime.kind} container ${sbx.name}${reusableStr}\nhost cwd: ${sbx.hostCwd}${resStr}\n${info}`,
				"info",
			);
		},
	});

	pi.registerCommand("sandbox-allow", {
		description: "Allow the sandbox to read files from a host path (added for this session)",
		handler: async (args, ctx) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify("Usage: /sandbox-allow <host-path>\nAdds a host path prefix for read access from the sandbox.", "info");
				return;
			}
			const abs = raw.startsWith("~") ? resolvePath(homedir(), raw.slice(1)) : resolvePath(raw);
			if (sbx.allowedExternalPrefixes.includes(abs)) {
				ctx.ui.notify(`Path ${abs} is already allowed.`, "info");
				return;
			}
			if (!existsSync(abs)) {
				ctx.ui.notify(`Path ${abs} does not exist on host.`, "warning");
				return;
			}
			sbx.allowedExternalPrefixes.push(abs);
			ctx.ui.notify(`Sandbox: read access now allowed for ${abs}`, "info");
		},
	});
}
