/**
 * pi-container-sandbox
 * --------------------
 * Run every read/write/edit/bash operation pi performs inside a per-session
 * Linux container. Supports Apple's `container` CLI and Docker.
 *
 * Threat model:
 *   - The agent's bash and file tools never touch the host filesystem outside
 *     the project cwd, which is bind-mounted into the container at /workspace.
 *   - The agent runs as a non-root user (uid 1000) inside the container.
 *   - No host secrets are mounted (no $HOME, ~/.ssh, ~/.aws, ~/.config, no
 *     SSH agent, no Docker socket).
 *   - Network is enabled by default; the security proxy gates outbound traffic.
 *     Disable with --no-container-net.
 *     ⚠️  Apple container uses --no-dns + route deletion; Docker uses --network none (when disabled).
 *   - Resource caps (2 CPUs / 2 GiB RAM) limit blast radius of runaway code.
 *
 * Path safety:
 *   - Any tool path resolved outside of cwd is rejected. The agent literally
 *     cannot ask the sandbox to read /etc/passwd on the host.
 *
 * Usage:
 *   Docker: image is pulled automatically from Docker Hub on first run.
 *   Apple container: build manually first:
 *        container build -t thegreataxios/pi-sandbox:latest -f docker/Dockerfile docker
 *   Then run pi with the extension (sandbox is ON by default):
 *        pi -e ./index.ts
 *      Optional flags:
 *        --container-runtime docker|apple  (default: auto-detect, prefer apple)
 *        --container-image <name>          (default: thegreataxios/pi-sandbox:latest)
 *        --container-net                   (allow outbound network)
 *        --prawl, --browser                 (alias for --container-net)
 *        --container-keep                  (don't stop the container on exit)
 *        --container-mount-skills           (mount ~/.agents/skills & ~/.pi/agent/skills read-only at /skills; default: on)
 *        --container-mount-paths <paths>    (comma-separated extra host dirs to mount at /skills/<basename>)
 *        --no-container, --noc             (bypass entirely)
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
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
// Runtime abstraction (Apple `container` and Docker speak the same dialect)
// ---------------------------------------------------------------------------

type RuntimeKind = "apple" | "docker";

interface Runtime {
	kind: RuntimeKind;
	bin: string;
	/** Returns the container name actually used (may differ from args.name on collision). */
	run(args: RunArgs): Promise<string>;
	stop(name: string): void;
	exists(image: string): Promise<boolean>;
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
}

function randomSuffix(): string {
	return randomBytes(4).toString("hex");
}

function which(bin: string): boolean {
	const r = spawnSync("which", [bin], { stdio: "ignore" });
	return r.status === 0;
}

async function detectRuntimeWithFallback(prefer?: RuntimeKind, ctx?: any): Promise<Runtime | null> {
	const haveApple = which("container");
	const haveDocker = which("docker");

	if (!haveApple && !haveDocker) {
		return null;
	}

	// Determine order based on preference (Docker is preferred over Apple container)
	const tryOrder: RuntimeKind[] = prefer === "apple" ? ["apple", "docker"] : ["docker", "apple"];

	for (const kind of tryOrder) {
		if (kind === "apple" && !haveApple) continue;
		if (kind === "docker" && !haveDocker) continue;

		const runtime = kind === "apple" ? appleRuntime() : dockerRuntime();

		// Test the runtime with a quick 3s smoke test
		const testName = `pi-test-${randomSuffix()}`;
		try {
			const r = await spawnWithTimeout(runtime.bin, ["run", "-d", "--rm", "--name", testName, "debian:bookworm-slim", "sleep", "infinity"], 3000);
			if (r.code === 0 && !r.timedOut) {
				// Clean up test container
				runtime.stop(testName);
				if (ctx?.ui) {
					ctx.ui.notify(`Using ${kind} runtime (3s smoke test passed)`, "info");
				}
				return runtime;
			}
			if (r.timedOut) {
				if (ctx?.ui) {
					ctx.ui.notify(`${kind} runtime timed out (3s), trying fallback...`, "warning");
				}
			}
		} catch {
			// Fall through to next runtime
		}
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

function appleRuntime(): Runtime {
	const bin = "container";
	const forceDelete = (name: string) => {
		// Idempotent: ignore "not found" / non-zero exit. Apple's CLI doesn't
		// distinguish errors cleanly, so we just swallow.
		spawnSync(bin, ["delete", "--force", name], { stdio: "ignore" });
	};
	return {
		kind: "apple",
		bin,
		exists: async (image) => {
			const r = await spawnWithTimeout(bin, ["image", "inspect", image], 10000);
			return r.code === 0 && !r.timedOut;
		},
		stop: (name) => {
			spawnSync(bin, ["stop", name], { stdio: "ignore" });
			forceDelete(name);
		},
		run: async ({ name, image, hostCwd, allowNetwork, extraMounts }) => {
			const buildArgs = (n: string): string[] => {
				const a: string[] = [
					"run",
					"-d",
					"--rm",
					"--name", n,
					"--user", "1000:1000",
					"-m", "2g",
					"-c", "2",
					"--mount", `type=bind,source=${hostCwd},target=/workspace`,
					"-w", "/workspace",
				];
				if (extraMounts) {
					for (const m of extraMounts) {
						a.push("--mount", `type=bind,source=${m.source},target=${m.target},readonly`);
					}
				}
				if (!allowNetwork) a.push("--no-dns"); // best-effort: blocks DNS; post-start lockdown below
				a.push(image, "sleep", "infinity");
				return a;
			};

			// Best-effort: nuke any stale container with the same name from a
			// previously crashed session. Apple's `container` doesn't auto-clean
			// like docker --rm does on abnormal exits.
			forceDelete(name);

			let currentName = name;
			let lastErr = "";
			// Apple's `container` CLI has a known stale-state bug where a
			// container can simultaneously be reported as "not found" by
			// `delete` and "already exists" by `run`. When that happens,
			// retrying the same name is hopeless — generate a fresh name
			// instead. We try a few attempts before giving up.
			for (let attempt = 0; attempt < 5; attempt++) {
				const r = await spawnWithTimeout(bin, buildArgs(currentName), 60000);
				if (r.timedOut) {
					throw new Error(`apple container run timed out after 60s (command: container run ${currentName})`);
				}
				if (r.code === 0) return currentName;
				lastErr = (r.stderr || r.stdout || "").trim();
				if (!/already exists/i.test(lastErr)) {
					throw new Error(`apple container run failed: ${lastErr}`);
				}
				// On the first collision try a forced delete in case the
				// CLI can actually clean it up. If that doesn't work, switch
				// to a fresh name to sidestep the zombie registry entry.
				if (attempt === 0) {
					forceDelete(currentName);
				} else {
					currentName = `pi-sbx-${randomSuffix()}`;
				}
			}
			throw new Error(`apple container run failed: ${lastErr}`);
		},
	};
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
		run: async ({ name, image, hostCwd, allowNetwork, extraMounts }) => {
			const args: string[] = [
				"run",
				"-d",
				"--rm",
				"--name", name,
				"--user", "1000:1000",
				"--memory", "2g",
				"--cpus", "2",
				"--cap-drop", "ALL",
				"--security-opt", "no-new-privileges",
				"--pids-limit", "512",
				"-v", `${hostCwd}:/workspace`,
				"-w", "/workspace",
			];
			if (extraMounts) {
				for (const m of extraMounts) {
					args.push("-v", `${m.source}:${m.target}:ro`);
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
	return {
		readFile: (p) => execCapture(sbx, `cat ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`),
		access: (p) => execCapture(sbx, `test -r ${shq(toRemote(p, sbx.hostCwd, sbx.mounts))}`).then(() => {}),
		detectImageMimeType: async (p) => {
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
	pi.registerFlag("container-runtime", {
		description: "Container runtime: apple|docker (default: auto)",
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
			const runtime = await detectRuntimeWithFallback(pi.getFlag("container-runtime") as RuntimeKind | undefined, ctx);
			if (!runtime) {
				ctx.ui.notify("No working container runtime found (Apple container and Docker both unavailable or timed out). Running without sandbox.", "warning");
				return;
			}
			const image = (pi.getFlag("container-image") as string) || "thegreataxios/pi-sandbox:latest";
			const allowNetwork = (pi.getFlag("container-net") as boolean) || (pi.getFlag("prawl") as boolean) || (pi.getFlag("browser") as boolean);
			const keep = pi.getFlag("container-keep") as boolean;
			const mountSkills = pi.getFlag("container-mount-skills") as boolean;
			const extraPathsRaw = pi.getFlag("container-mount-paths") as string | undefined;
			const extraPaths = extraPathsRaw ? extraPathsRaw.split(",").map((p) => p.trim()).filter(Boolean) : undefined;

			// Discover skill directories on the host.
			const skillMounts = mountSkills ? discoverSkillDirs(extraPaths) : [];

			if (!(await runtime.exists(image))) {
				// Try pulling from registry (Docker only; Apple container has no pull command)
				let pulled = false;
				if (runtime.kind === "docker") {
					ctx.ui.notify(`Sandbox image "${image}" not found locally, pulling from registry...`);
					const pull = await spawnWithTimeout(runtime.bin, ["pull", image], 120000);
					pulled = pull.code === 0 && !pull.timedOut;
				}
				if (!pulled && !(await runtime.exists(image))) {
					ctx.ui.notify(
						`Sandbox image "${image}" not found.${
							runtime.kind === "docker"
								? " Pull failed. Build it manually:\n  docker build -t " + image + " -f docker/Dockerfile docker"
								: " Apple container does not support pulling. Build it first:\n  container build -t " + image + " -f docker/Dockerfile docker"
						} `,
						"error",
					);
					return;
				}
			}

			const requestedName = `pi-sbx-${randomSuffix()}`;
			const actualName = await runtime.run({ name: requestedName, image, hostCwd: localCwd, allowNetwork, extraMounts: skillMounts.length ? skillMounts : undefined });
			sandbox = { runtime, name: actualName, hostCwd: localCwd, keep, mounts: skillMounts };

			// Belt-and-braces cleanup for ungraceful exits (Apple `container`
			// has no equivalent of docker --rm on host-side kill). Docker's
			// --rm mostly handles this; the handler is a no-op there.
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

			// Post-start network lockdown for Apple containers.
			// --no-dns only blocks DNS resolution; the container can still
			// make outbound TCP/UDP connections by IP. We need a hard block.
			if (!allowNetwork && runtime.kind === "apple") {
				try {
					// Delete the default route so no outbound traffic leaves the container.
					// We run as uid 1000, but `ip` may be available and the container
					// may allow NET_ADMIN. If this fails, we warn but don't block startup.
					await execCapture(
						sandbox,
						"ip route del default 2>/dev/null; ip -6 route del default 2>/dev/null; echo done",
						5000,
					);
					// Verify network is actually blocked: try to reach an external IP.
					const probe = await execCapture(
						sandbox,
						"timeout 3 bash -c 'echo > /dev/tcp/1.1.1.1/443' 2>&1 || echo blocked",
						5000,
					);
					if (!probe.toString().includes("blocked")) {
					ctx.ui.notify(
						"⚠️  Sandbox network lockdown FAILED — container may have outbound access. "
							+ "Consider using Docker runtime (--container-runtime docker) for hard network isolation.",
						"warning",
					);
					}
				} catch {
					// Non-fatal: route deletion may not work in all Apple container configs.
					ctx.ui.notify(
						"⚠️  Could not enforce network isolation in Apple container. "
							+ "Use --container-runtime docker for guaranteed network blocking.",
						"warning",
					);
				}
			}

			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🛡  ${runtime.kind}:${actualName} (net=${allowNetwork ? "on" : "off"})`),
			);
			ctx.ui.notify(`Sandbox up: ${runtime.kind} ${actualName}\n${ok}${skillMounts.length ? `\nSkills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : ""}`, "info");
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
			ctx.ui.notify(
				`Sandbox: ${sbx.runtime.kind} container ${sbx.name}\nhost cwd: ${sbx.hostCwd}\n${info}`,
				"info",
			);
		},
	});
}
