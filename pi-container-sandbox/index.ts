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
 *     --container-allow-paths or /sandbox allow.
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
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
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
	type ExtensionUIContext,
	getAgentDir,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

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
// Runtime abstraction (Apple `container` and Docker)
// ---------------------------------------------------------------------------

type RuntimeKind = "apple" | "docker";

interface Runtime {
	kind: RuntimeKind;
	bin: string;
	/** Returns the container name actually used (may differ from args.name on collision). */
	run(args: RunArgs): Promise<string>;
	stop(name: string): void;
	/** Remove a container forcefully (docker rm -f). */
	remove(name: string): void;
	exists(image: string): Promise<boolean>;
	/** Check if a container with the given name is running. */
	isRunning(name: string): Promise<boolean>;
	/** Start an existing stopped container. */
	start(name: string): Promise<boolean>;
	/** Create a volume if it doesn't exist. */
	createVolume(name: string): Promise<boolean>;
	/** Pull an image from the registry. */
	pull(image: string, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }>;
	/** Does a container (running or stopped) with this name exist? */
	containerExists(name: string): Promise<boolean>;
	/** Cheap liveness check of the runtime daemon (no image pull, no container start). */
	ready(): Promise<boolean>;
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
	/** Optional volume to mount at /cache for persistent caching. */
	cacheVolume?: string;
	/** Apple runtime: paths (relative to /workspace) mounted read-only inside the container. */
	protectedPaths?: string[];
	/** Apple runtime: named network to attach to (used for the no-egress `--internal` network). */
	network?: string;
	/** Apple runtime: HTTP(S) proxy URL exported to the container (http_proxy/https_proxy). */
	proxy?: string;
	/** Apple runtime: DNS server for the container (default network only). */
	dns?: string;
}

function randomSuffix(): string {
	return randomBytes(4).toString("hex");
}

/**
 * Derive a deterministic container name from the project directory.
 * Format: pi-sbx-<dirname>-<hash6>
 * This is unique per project and allows container reuse/recovery.
 */
function deriveContainerName(hostCwd: string): string {
	const basename = hostCwd.split("/").filter(Boolean).pop() || "project";
	const hash = createHash("sha256").update(hostCwd).digest("hex").slice(0, 6);
	return `pi-sbx-${basename}-${hash}`;
}

function which(bin: string): boolean {
	const r = spawnSync("which", [bin], { stdio: "ignore" });
	return r.status === 0;
}

async function detectRuntime(prefer: string | undefined, ctx?: any): Promise<Runtime | null> {
	const order: RuntimeKind[] = prefer === "docker" ? ["docker"] : prefer === "apple" ? ["apple"] : ["apple", "docker"];
	for (const kind of order) {
		const bin = kind === "apple" ? "container" : "docker";
		if (!which(bin)) continue;
		const runtime = kind === "apple" ? appleRuntime() : dockerRuntime();
		// Liveness only. The old 3s "pull and run debian" smoke test failed whenever the image wasn't
		// cached and made the extension silently run without a sandbox.
		if (await runtime.ready()) {
			ctx?.ui?.notify(`Using ${kind} runtime`, "info");
			return runtime;
		}
		ctx?.ui?.notify(`${kind} runtime found but not ready (${kind === "apple" ? "run `container system start`" : "is Docker running?"})`, "warning");
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

/** Internal (host-only, no internet) network used when the sandbox has network disabled. */
const APPLE_INTERNAL_NET = "pi-sbx-internal";

function appleRuntime(): Runtime {
	const bin = "container";
	const forceDelete = (name: string) => {
		spawnSync(bin, ["delete", "--force", name], { stdio: "ignore" });
	};
	const inspectState = async (name: string): Promise<string | null> => {
		const r = await spawnWithTimeout(bin, ["inspect", name], 8000);
		if (r.code !== 0 || r.timedOut) return null;
		try {
			const d = JSON.parse(r.stdout);
			return d?.[0]?.status?.state ?? "unknown";
		} catch {
			return "unknown";
		}
	};
	return {
		kind: "apple",
		bin,
		ready: async () => {
			const r = await spawnWithTimeout(bin, ["system", "status"], 8000);
			return r.code === 0 && !r.timedOut;
		},
		exists: async (image) => {
			const r = await spawnWithTimeout(bin, ["image", "inspect", image], 10000);
			return r.code === 0 && !r.timedOut;
		},
		pull: async (image, timeoutMs) => {
			const r = await spawnWithTimeout(bin, ["image", "pull", "--platform", "linux/arm64", "--progress", "none", image], timeoutMs);
			return { code: r.code, timedOut: r.timedOut };
		},
		containerExists: async (name) => (await inspectState(name)) !== null,
		stop: (name) => {
			spawnSync(bin, ["stop", name], { stdio: "ignore" });
		},
		remove: (name) => forceDelete(name),
		isRunning: async (name) => (await inspectState(name)) === "running",
		start: async (name) => {
			const r = await spawnWithTimeout(bin, ["start", name], 30000);
			return r.code === 0 && !r.timedOut;
		},
		createVolume: async (name) => {
			const r = await spawnWithTimeout(bin, ["volume", "create", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		run: async ({ name, image, hostCwd, allowNetwork, extraMounts, resources, cacheVolume, protectedPaths, network, proxy, dns }) => {
			const memory = resources?.memory ?? "2g";
			const cpus = resources?.cpus ?? "2";
			const pidsLimit = resources?.pidsLimit ?? 512;

			// Network: default network when allowed; otherwise an --internal network
			// (no internet route; host gateway only, see README for pf hardening).
			let netName = network;
			if (!allowNetwork && !netName) {
				netName = APPLE_INTERNAL_NET;
				const c = await spawnWithTimeout(bin, ["network", "create", "--internal", netName], 15000);
				if (c.code !== 0 && !/already exists/i.test(c.stderr + c.stdout)) {
					throw new Error(`could not create internal network ${netName}: ${(c.stderr || c.stdout).trim()}`);
				}
			}

			const buildArgs = (n: string): string[] => {
				const a: string[] = [
					"run", "-d",
					"--name", n,
					"--user", "1000:1000",
					"-m", memory,
					"-c", cpus,
					"--cap-drop", "ALL",
					"--ulimit", `nproc=${pidsLimit}:${pidsLimit}`,
					"--mount", `type=bind,source=${hostCwd},target=/workspace`,
					"-w", "/workspace",
				];
				// Protected paths must exist before start (each becomes its own mount).
				for (const rel of protectedPaths ?? []) {
					if (existsSync(resolvePath(hostCwd, rel))) a.push("--read-only-path", `/workspace/${rel}`);
				}
				for (const m of extraMounts ?? []) {
					a.push("--mount", `type=bind,source=${m.source},target=${m.target},readonly`);
				}
				if (cacheVolume) a.push("-v", `${cacheVolume}:/cache`);
				if (netName) a.push("--network", netName);
				if (!allowNetwork || proxy) a.push("--no-dns");
				else if (dns) a.push("--dns", dns);
				if (proxy) {
					for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) a.push("-e", `${k}=${proxy}`);
					a.push("-e", "no_proxy=localhost,127.0.0.1");
				}
				a.push(image, "sleep", "infinity");
				return a;
			};

			// Apple's CLI can report a container as "not found" for delete and
			// "already exists" for run; retry with a fresh name in that case.
			forceDelete(name);
			let currentName = name;
			let lastErr = "";
			for (let attempt = 0; attempt < 5; attempt++) {
				const r = await spawnWithTimeout(bin, buildArgs(currentName), 90000);
				if (r.timedOut) throw new Error(`container run timed out after 90s (${currentName})`);
				if (r.code === 0) return currentName;
				lastErr = (r.stderr || r.stdout || "").trim();
				if (!/already exists/i.test(lastErr)) throw new Error(`container run failed: ${lastErr}`);
				if (attempt === 0) forceDelete(currentName);
				else currentName = `pi-sbx-${randomSuffix()}`;
			}
			throw new Error(`container run failed: ${lastErr}`);
		},
	};
}

function dockerRuntime(): Runtime {
	const bin = "docker";
	return {
		kind: "docker",
		bin,
		pull: async (image, timeoutMs) => {
			const r = await spawnWithTimeout(bin, ["pull", image], timeoutMs);
			return { code: r.code, timedOut: r.timedOut };
		},
		containerExists: async (name) => {
			const r = await spawnWithTimeout(bin, ["inspect", "--format", "exists", name], 5000);
			return r.code === 0 && !r.timedOut;
		},
		ready: async () => {
			const r = await spawnWithTimeout(bin, ["info", "--format", "{{.ServerVersion}}"], 8000);
			return r.code === 0 && !r.timedOut;
		},
		exists: async (image) => {
			const r = await spawnWithTimeout(bin, ["image", "inspect", image], 10000);
			return r.code === 0 && !r.timedOut;
		},
		stop: (name) => {
			spawnSync(bin, ["stop", name], { stdio: "ignore" });
		},
		remove: (name) => {
			spawnSync(bin, ["rm", "-f", name], { stdio: "ignore" });
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
	/** Image reference used for this sandbox, e.g. thegreataxios/pi-sandbox:latest. */
	imageRef: string;
	/** Project image config in effect when the sandbox started. */
	projectConfig: SandboxProjectConfig;
	/** Whether this sandbox is re-usable across sessions. */
	isReusable: boolean;
	/** Whether this sandbox was reattached (vs newly created). */
	isReattached: boolean;
}

let sandbox: Sandbox | null = null;
/** Fail-closed: when true and no sandbox is running, tools refuse to run instead of falling back to the host. */
let sandboxRequired = false;
let sandboxError: string | null = null;
let pathApprovals: PathApprovalStore | null = null;
const getSbx = () => sandbox;

// ---------------------------------------------------------------------------
// External path approval store (persisted across sessions)
// ---------------------------------------------------------------------------

interface PathApprovalRecord {
	path: string;
	approvedAt: number;
	expiresAt: number; // Infinity = forever
}

class PathApprovalStore {
	private path: string;
	private records: Map<string, PathApprovalRecord> = new Map();

	constructor(agentDir: string) {
		this.path = resolvePath(agentDir, "path-approvals.json");
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf-8")) as PathApprovalRecord[];
			const now = Date.now();
			for (const r of raw) {
				if (r.expiresAt === Infinity || r.expiresAt > now) {
					this.records.set(r.path, r);
				}
			}
		} catch {
			// corrupt file — start fresh
		}
	}

	private save(): void {
		const dir = this.path.slice(0, this.path.lastIndexOf("/"));
		if (!existsSync(dir)) {
			try { mkdirSync(dir, { recursive: true }); } catch {}
		}
		const tmpPath = this.path + ".tmp";
		const data = Array.from(this.records.values());
		writeFileSync(tmpPath, JSON.stringify(data, null, 2));
		renameSync(tmpPath, this.path);
	}

	/** Check if a path (or any parent prefix) is approved. Returns the matching record or undefined. */
	find(absPath: string): PathApprovalRecord | undefined {
		// Exact match
		const exact = this.records.get(absPath);
		if (exact && (exact.expiresAt === Infinity || exact.expiresAt > Date.now())) return exact;

		// Prefix match (e.g. approved /foo/bar matches /foo/bar/baz.txt)
		for (const [, record] of this.records) {
			if (
				(absPath === record.path || absPath.startsWith(record.path + "/")) &&
				(record.expiresAt === Infinity || record.expiresAt > Date.now())
			) {
				return record;
			}
		}

		return undefined;
	}

	add(absPath: string, days: number | typeof Infinity): void {
		const now = Date.now();
		const record: PathApprovalRecord = {
			path: absPath,
			approvedAt: now,
			expiresAt: days === Infinity ? Infinity : now + days * 24 * 60 * 60 * 1000,
		};
		this.records.set(absPath, record);
		this.save();
	}

	revoke(absPath: string): boolean {
		if (this.records.delete(absPath)) {
			this.save();
			return true;
		}
		return false;
	}

	list(): PathApprovalRecord[] {
		return Array.from(this.records.values()).filter(
			(r) => r.expiresAt === Infinity || r.expiresAt > Date.now(),
		);
	}
}

// ---------------------------------------------------------------------------
// Per-project sandbox config (.pi/agent/sandbox.json)
// ---------------------------------------------------------------------------

interface SandboxProjectConfig {
	image: string;
	tag: string;
	pinned: boolean;
	lastDigest: string | null;
	lastCheckedAt: number | null;
}

const DEFAULT_SANDBOX_PROJECT_CONFIG: SandboxProjectConfig = {
	image: "thegreataxios/pi-sandbox",
	tag: "latest",
	pinned: false,
	lastDigest: null,
	lastCheckedAt: null,
};

function getSandboxConfigPath(hostCwd: string): string {
	return resolvePath(hostCwd, ".pi", "agent", "sandbox.json");
}

function loadSandboxProjectConfig(hostCwd: string): SandboxProjectConfig {
	const configPath = getSandboxConfigPath(hostCwd);
	if (!existsSync(configPath)) {
		return { ...DEFAULT_SANDBOX_PROJECT_CONFIG };
	}
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			image: parsed.image ?? DEFAULT_SANDBOX_PROJECT_CONFIG.image,
			tag: parsed.tag ?? DEFAULT_SANDBOX_PROJECT_CONFIG.tag,
			pinned: parsed.pinned ?? DEFAULT_SANDBOX_PROJECT_CONFIG.pinned,
			lastDigest: parsed.lastDigest ?? null,
			lastCheckedAt: parsed.lastCheckedAt ?? null,
		};
	} catch {
		return { ...DEFAULT_SANDBOX_PROJECT_CONFIG };
	}
}

function saveSandboxProjectConfig(hostCwd: string, config: SandboxProjectConfig): void {
	const configPath = getSandboxConfigPath(hostCwd);
	const dir = resolvePath(configPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tmpPath = configPath + ".tmp";
	writeFileSync(tmpPath, JSON.stringify(config, null, 2));
	renameSync(tmpPath, configPath);
}

function imageRefForTag(image: string, tag: string): string {
	return `${image}:${tag}`;
}

async function inspectLocalImageDigest(runtime: Runtime, imageRef: string): Promise<string | null> {
	if (runtime.kind === "apple") {
		const r = await spawnWithTimeout(runtime.bin, ["image", "inspect", imageRef], 10000);
		if (r.code !== 0 || r.timedOut) return null;
		return r.stdout.match(/"digest"\s*:\s*"(sha256:[0-9a-f]{64})"/)?.[1] ?? null;
	}
	const result = await spawnWithTimeout(runtime.bin, ["image", "inspect", imageRef, "--format", "{{json .RepoDigests}}"], 10000);
	if (result.code !== 0 || result.timedOut) return null;
	try {
		const digests = JSON.parse(result.stdout.trim()) as string[];
		const digest = digests.find((d) => d.includes("@sha256:")) ?? null;
		return digest?.split("@", 2)[1] ?? null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Docker Hub version checker
// ---------------------------------------------------------------------------

interface TagInfo {
	name: string;
	digest: string | null;
	lastUpdated: string | null;
}

/**
 * Fetch tag info from Docker Hub v2 API for a public repository.
 * Returns null on network error or if the image repo isn't on Docker Hub.
 */
async function fetchTagDigest(image: string, tag: string): Promise<TagInfo | null> {
	try {
		const url = `https://hub.docker.com/v2/repositories/${image}/tags/${tag}`;
		const r = await spawnWithTimeout("curl", ["-s", "-f", "-L", url], 10000);
		if (r.code !== 0 || r.timedOut) return null;
		const data = JSON.parse(r.stdout);
		const digest = data?.images?.[0]?.digest ?? null;
		return {
			name: tag,
			digest,
			lastUpdated: data?.last_updated ?? null,
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Interactive approval flow for external paths
// ---------------------------------------------------------------------------

/**
 * Check if a host path needs approval and request it interactively.
 * Returns true if approved (path is added to the session allowlist), false if denied.
 */
async function requestPathApproval(
	absPath: string,
	sessionPrefixes: string[],
	store: PathApprovalStore,
	ui: ExtensionUIContext,
): Promise<boolean> {
	// 1. Check session-level prefixes (--container-allow-paths, /sandbox allow)
	for (const prefix of sessionPrefixes) {
		if (absPath === prefix || absPath.startsWith(prefix + "/")) return true;
	}

	// 2. Check persisted approvals
	const existing = store.find(absPath);
	if (existing) return true;

	// 3. Default: pi clipboard files (auto-approved)
	const basename = absPath.split("/").pop() || "";
	if (basename.startsWith("pi-clipboard-")) return true;

	// 4. Interactive approval
	const options = [
		`Approve once`,
		`Approve always`,
		`Approve for 7 days`,
		`Approve for 30 days`,
		`Deny`,
	];

	let choice: string | undefined;
	try {
		choice = await ui.select(
			`Sandbox: External File Access`,
			options,
		);
	} catch {
		return false;
	}

	if (!choice || choice.includes("Deny")) return false;

	if (choice.includes("once")) {
		// Session-only, not persisted — add to session prefixes
		sessionPrefixes.push(absPath);
		return true;
	}

	if (choice.includes("always")) {
		store.add(absPath, Infinity);
		sessionPrefixes.push(absPath);
		ui.notify(`Approved read access (always): ${absPath}`, "info");
		return true;
	}

	const days = choice.includes("30") ? 30 : 7;
	store.add(absPath, days);
	sessionPrefixes.push(absPath);
	ui.notify(`Approved read access (${days} days): ${absPath}`, "info");
	return true;
}


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
 * Additional prefixes can be added via --container-allow-paths or /sandbox allow.
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
	// Tool calls may use container-absolute paths because the agent sees
	// the sandbox cwd as /workspace. Those paths are inside the project
	// mount even though resolvePath(hostCwd, "/workspace/...") would
	// otherwise look like an external host path and trigger approval.
	if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) return true;
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

/**
 * Check whether a host path is external to the sandbox cwd and needs approval.
 * Returns the absolute external path, or null if the path is inside cwd or a known mount.
 */
function getExternalPath(hostPath: string, hostCwd: string, mounts: MountSpec[]): string | null {
	if (isInsideCwd(hostPath, hostCwd)) return null;
	const abs = resolvePath(hostCwd, hostPath);
	// Already covered by an extra mount (e.g. /skills)
	const containerPath = hostPath.startsWith("/") ? hostPath : abs;
	if (resolveExtraMountPath(containerPath, mounts)) return null;
	return abs;
}

/**
 * Ensure an external path is approved for read access.
 * Checks session allowlist, persisted store, then prompts interactively.
 * Throws if denied. On approval, adds path to session allowlist so readOps can use it.
 */
async function ensureExternalReadApproved(
	absPath: string,
	sbx: Sandbox,
	store: PathApprovalStore,
	ui: ExtensionUIContext,
): Promise<void> {
	const approved = await requestPathApproval(absPath, sbx.allowedExternalPrefixes, store, ui);
	if (!approved) {
		throw new Error(`sandbox: access denied to ${absPath}`);
	}
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
		description: "Container runtime: apple | docker (default: auto, prefers apple)",
		type: "string",
	});
	pi.registerFlag("container-optional", {
		description: "If the sandbox can\'t start, run tools on the HOST instead of refusing (unsafe; default: refuse)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-protect", {
		description: "Apple runtime: comma-separated /workspace-relative paths mounted read-only (default: .git,.envrc,.vscode,.pi)",
		type: "string",
	});
	pi.registerFlag("container-git-writable", {
		description: "Apple runtime: don\'t protect .git (lets the agent commit, but allows hook/config planting)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-network", {
		description: "Apple runtime: attach to this existing container network (e.g. an --internal net paired with --container-proxy)",
		type: "string",
	});
	pi.registerFlag("container-proxy", {
		description: "Apple runtime: HTTP(S) proxy URL for the sandbox (implies --no-dns; pair with an --internal network + pf)",
		type: "string",
	});
	pi.registerFlag("container-dns", {
		description: "Apple runtime: DNS server for the sandbox on the default network (e.g. 1.1.1.1)",
		type: "string",
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
	pi.registerFlag("container-offline", {
		description: "Disable sandbox networking (Apple: runs on an --internal network with no internet route). Same as --container-net=false.",
		type: "boolean",
		default: false,
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

	/** Throws when the sandbox is required but not running, so tools never silently touch the host. */
	function assertNotFailClosed(): void {
		if (sandboxRequired) {
			throw new Error(
				`sandbox is required but not running${sandboxError ? ` (${sandboxError})` : ""}. Refusing to run on the host. ` +
				`Fix the sandbox or start pi with --container-optional / --no-container.`,
			);
		}
	}

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	// Initialize the persistent path approval store
	pathApprovals = new PathApprovalStore(getAgentDir());

	/**
	 * Shared guard for read tools: if the path is external, check approvals
	 * and prompt interactively before delegating to sandbox readOps.
	 */
	async function guardExternalRead(
		paramsPath: string,
		sbx: Sandbox,
		ctx: { ui: ExtensionUIContext; hasUI: boolean },
	): Promise<void> {
		const external = getExternalPath(paramsPath, sbx.hostCwd, sbx.mounts);
		if (!external) return;
		// Already in session allowlist?
		if (isAllowedExternalResource(external, sbx.allowedExternalPrefixes)) return;
		// Need UI for interactive prompt
		if (!ctx.hasUI) {
			throw new Error(
				`sandbox: refusing to access ${external}: outside of project cwd ${sbx.hostCwd}. ` +
				`Use --container-allow-paths or /sandbox allow to grant access.`,
			);
		}
		await ensureExternalReadApproved(external, sbx, pathApprovals!, ctx.ui);
	}

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) { assertNotFailClosed(); return localRead.execute(id, params, signal, onUpdate); }
			await guardExternalRead(params.path, sbx, _ctx);
			const tool = createReadTool(localCwd, { operations: readOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) { assertNotFailClosed(); return localWrite.execute(id, params, signal, onUpdate); }
			const tool = createWriteTool(localCwd, { operations: writeOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) { assertNotFailClosed(); return localEdit.execute(id, params, signal, onUpdate); }
			const tool = createEditTool(localCwd, { operations: editOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) { assertNotFailClosed(); return localBash.execute(id, params, signal, onUpdate); }
			const tool = createBashTool(localCwd, { operations: bashOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		const sbx = getSbx();
		if (!sbx) {
			if (sandboxRequired) {
				return {
					operations: {
						exec: async () => {
							assertNotFailClosed();
							return { exitCode: 1 };
						},
					} as any,
				};
			}
			return;
		}
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

		sandboxRequired = !(pi.getFlag("container-optional") as boolean);
		sandboxError = null;
		const failStart = (msg: string) => {
			sandboxError = msg;
			ctx.ui.notify(
				sandboxRequired
					? `Sandbox unavailable: ${msg}\nTools will REFUSE to run (fail-closed). Use --container-optional or --no-container to run on the host.`
					: `Sandbox unavailable: ${msg}\nRunning WITHOUT sandbox (--container-optional).`,
				sandboxRequired ? "error" : "warning",
			);
		};

		let createdName: string | null = null;
		let createdRuntime: Runtime | null = null;
		try {
			const runtime = await detectRuntime(pi.getFlag("container-runtime") as string | undefined, ctx);
			if (!runtime) {
				failStart("no working container runtime (Apple `container` or Docker)");
				return;
			}

			// Load sandbox config from .pi/config.json and .pi/agent/sandbox.json
			const config = loadSandboxConfig(localCwd);
			const projectConfig = loadSandboxProjectConfig(localCwd);

			// Determine size tier (flag > config > default)
			const sizeFlag = pi.getFlag("container-size") as string | undefined;
			const sizeTier = parseSizeTier(sizeFlag || config?.size || "sm") || "sm";
			const tierSpec = TIER_SPECS[sizeTier];

			// Resolve image: flag > .pi/agent/sandbox.json > default
			const flagImage = pi.getFlag("container-image") as string | undefined;
			const configImageRef = imageRefForTag(projectConfig.image, projectConfig.tag);
			const image = flagImage || configImageRef || "thegreataxios/pi-sandbox:latest";
			// pi has no `--no-<flag>` negation, and `--container-net=false` arrives as the truthy string "false".
			const asBool = (v: unknown) => v === true || (typeof v === "string" && !/^(false|0|off|no|)$/i.test(v));
			const offline = asBool(pi.getFlag("container-offline"));
			const allowNetwork = !offline && (asBool(pi.getFlag("container-net")) || asBool(pi.getFlag("prawl")) || asBool(pi.getFlag("browser")));
			const keep = pi.getFlag("container-keep") as boolean;
			const persist = pi.getFlag("sandbox-persist") as boolean || config?.persist || false;
			const mountSkills = pi.getFlag("container-mount-skills") as boolean;
			const extraPathsRaw = pi.getFlag("container-mount-paths") as string | undefined;
			const extraPaths = extraPathsRaw ? extraPathsRaw.split(",").map((p) => p.trim()).filter(Boolean) : undefined;

			// Determine sandbox name:
			//   --sandbox-name <name>  → use as-is (reusable)
			//   default                → pi-sbx-<dirname>-<hash6> (deterministic, project-scoped)
			const nameFlag = pi.getFlag("sandbox-name") as string | undefined;
			const sandboxName = nameFlag || deriveContainerName(localCwd);
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

			// Check if a container with this name already exists:
			//   - Running  → reattach (crash recovery, persist mode, or concurrent session)
			//   - Stopped  → start if reusable/persist, otherwise remove for fresh slate
			//   - Missing  → create new
			let isReattached = false;
			{
				const running = await runtime.isRunning(sandboxName);
				if (running) {
					isReattached = true;
					ctx.ui.notify(`🔄 Reattaching to existing sandbox: ${sandboxName}`, "info");
				} else {
					// Check if container exists at all (stopped state)
					if (await runtime.containerExists(sandboxName)) {
						// Container exists but is not running
						if (isReusable || persist) {
							// Reusable or persist mode → start the stopped container
							const started = await runtime.start(sandboxName);
							if (started) {
								isReattached = true;
								ctx.ui.notify(`♻️ Restarted existing sandbox: ${sandboxName}`, "info");
							} else {
								// Start failed — remove it and create fresh
								ctx.ui.notify(`Removing broken container ${sandboxName}, creating fresh...`, "warning");
								runtime.remove(sandboxName);
							}
						} else {
							// Non-reusable, non-persist → remove stale container for clean slate
							ctx.ui.notify(`Cleaning up stale container ${sandboxName} for fresh sandbox`, "info");
							runtime.remove(sandboxName);
						}
					}
				}
			}

			if (!(await runtime.exists(image))) {
				ctx.ui.notify(`Sandbox image "${image}" not found locally, pulling from registry...`);
				const pull = await runtime.pull(image, 900000);
				if (!pull || pull.code !== 0 || pull.timedOut) {
					failStart(`image "${image}" not found and pull failed. Build it: ${runtime.bin} build -t ${image} -f docker/Dockerfile docker`);
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

			// Read-only paths inside /workspace (Apple runtime). A nested read-only path can be bypassed by
			// renaming its parent, so protecting `.git` as a whole is what actually stops hook/config planting.
			const protectFlag = pi.getFlag("container-protect") as string | undefined;
			let protectedPaths = protectFlag
				? protectFlag.split(",").map((p) => p.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean)
				: [".git", ".envrc", ".vscode", ".pi"];
			if (pi.getFlag("container-git-writable") as boolean) protectedPaths = protectedPaths.filter((p) => p !== ".git");

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
					protectedPaths,
					network: (pi.getFlag("container-network") as string | undefined) || undefined,
					proxy: (pi.getFlag("container-proxy") as string | undefined) || undefined,
					dns: (pi.getFlag("container-dns") as string | undefined) || undefined,
				});
				createdName = actualName;
				createdRuntime = runtime;
			}

			sandbox = {
				runtime,
				name: actualName,
				hostCwd: localCwd,
				keep: keep || persist,
				mounts: skillMounts,
				allowedExternalPrefixes,
				resources,
				imageRef: image,
				projectConfig,
				isReusable,
				isReattached,
			};

			// Cleanup handler — stop & remove container unless keep/persist is set
			// In default (non-reusable) mode, the container is fully removed.
			// In reusable/persist mode, the container is kept for future sessions.
			const cleanup = () => {
				const s = sandbox;
				if (!s || s.keep) return;
				try {
					s.runtime.stop(s.name);
					s.runtime.remove(s.name);
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
				`${statusPrefix}: ${runtime.kind} ${actualName}${resStr}${isReusable ? " [re-usable]" : ""}\n${ok}${skillMounts.length ? `\nSkills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : ""}${cacheVolume ? `\nCache volume: ${cacheVolume} at /cache` : ""}`,
				"info"
			);

			// ── Background version check ─────────────────────────────────────
			// Check Docker Hub for a newer image digest (non-blocking, fire & forget).
			// Only checks if:
			//   - not using a flag-override image (which takes priority)
			//   - the tag is not explicitly pinned in sandbox.json
			//   - at least 24 hours since last check (avoids hammering Docker Hub)
			if (!flagImage && projectConfig && !projectConfig.pinned) {
				const now = Date.now();
				const oneDay = 24 * 60 * 60 * 1000;
				const lastCheck = projectConfig.lastCheckedAt ?? 0;
				if (now - lastCheck >= oneDay) {
					// Fire-and-forget async check — never blocks session start
					(async () => {
						try {
							const tagInfo = await fetchTagDigest(projectConfig.image, projectConfig.tag);
							if (!tagInfo?.digest) return;

							// Update last-checked timestamp
							projectConfig.lastCheckedAt = now;
							if (projectConfig.lastDigest && projectConfig.lastDigest !== tagInfo.digest) {
								ctx.ui.notify(
									`📦 New sandbox image available: ${imageRefForTag(projectConfig.image, projectConfig.tag)}\n` +
									`  Last digest: ${projectConfig.lastDigest.slice(0, 19)}...\n` +
									`  New digest:  ${tagInfo.digest.slice(0, 19)}...\n` +
									`  Run \`/sandbox update\` to pull the update.`,
									"info",
								);
							} else if (!projectConfig.lastDigest && tagInfo.digest) {
								// First check — store the digest for future comparison
								projectConfig.lastDigest = tagInfo.digest;
							}
							projectConfig.lastCheckedAt = Date.now();
							saveSandboxProjectConfig(localCwd, projectConfig);
						} catch {
							// Silently ignore — network may be unavailable
						}
					})();
				}
			}
		} catch (e) {
			if (createdName && createdRuntime) {
				try { createdRuntime.stop(createdName); createdRuntime.remove(createdName); } catch {}
			}
			sandbox = null;
			failStart(`init failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	});

	pi.on("session_shutdown", async () => {
		const sbx = getSbx();
		if (!sbx) return;
		if (!sbx.keep) {
			sbx.runtime.stop(sbx.name);
			sbx.runtime.remove(sbx.name);
		}
		sandbox = null;
	});

	// ── Shared subcommand handlers ────────────────────────────────────────

	async function cmdSandboxStatus(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
		const sbx = getSbx();
		if (!sbx) {
			const cfg = loadSandboxProjectConfig(localCwd);
			ctx.ui.notify(
				`Sandbox is not active. Start pi with --container.\nconfigured image: ${imageRefForTag(cfg.image, cfg.tag)} (${cfg.pinned ? "pinned" : "unpinned"})`,
				"info",
			);
			return;
		}
		const info = (await execCapture(sbx, "id; uname -a; df -h /workspace | tail -1")).toString();
		const localDigest = await inspectLocalImageDigest(sbx.runtime, sbx.imageRef);
		const resParts: string[] = [];
		if (sbx.resources?.memory) resParts.push(`memory: ${sbx.resources.memory}`);
		if (sbx.resources?.cpus) resParts.push(`cpus: ${sbx.resources.cpus}`);
		if (sbx.resources?.disk) resParts.push(`disk: ${sbx.resources.disk}`);
		if (sbx.resources?.swap !== undefined) resParts.push(`swap: ${sbx.resources.swap}`);
		if (sbx.resources?.pidsLimit !== undefined) resParts.push(`pids-limit: ${sbx.resources.pidsLimit}`);
		const resStr = resParts.length ? `\nresources: ${resParts.join(", ")}` : "";
		const reusableStr = sbx.isReusable ? ` [re-usable${sbx.isReattached ? ", reattached" : ""}]` : "";
		const cfg = sbx.projectConfig;
		ctx.ui.notify(
			[
				`Sandbox: ${sbx.runtime.kind} container ${sbx.name}${reusableStr}`,
				`host cwd: ${sbx.hostCwd}`,
				`image: ${sbx.imageRef} (${cfg.pinned ? "pinned" : "unpinned"})`,
				`local digest: ${localDigest ?? "unknown"}`,
				`last seen remote digest: ${cfg.lastDigest ?? "unknown"}`,
				`last update check: ${cfg.lastCheckedAt ? new Date(cfg.lastCheckedAt).toISOString() : "never"}`,
				`update: run /sandbox update, then restart pi to use the new image`,
				resStr.trim(),
				info.trimEnd(),
			].filter(Boolean).join("\n"),
			"info",
		);
	}

	async function cmdSandboxAllow(raw: string, ctx: { ui: ExtensionUIContext }) {
		const sbx = getSbx();
		if (!sbx) {
			ctx.ui.notify("Sandbox is not active.", "info");
			return;
		}
		if (!raw) {
			ctx.ui.notify("Usage: /sandbox allow <host-path>\nAdds a host path prefix for read access from the sandbox.", "info");
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
	}

	async function cmdSandboxPathsList(ctx: { ui: ExtensionUIContext }) {
		const store = pathApprovals;
		if (!store) {
			ctx.ui.notify("Path approval store not initialized.", "info");
			return;
		}
		const records = store.list();
		if (records.length === 0) {
			ctx.ui.notify("No persisted path approvals. External reads will prompt interactively.", "info");
			return;
		}
		const lines = records.map((r) => {
			const expiry = r.expiresAt === Infinity ? "always" : `expires ${new Date(r.expiresAt).toISOString()}`;
			return `  ${r.path} (${expiry})`;
		});
		ctx.ui.notify(
			[
				`Persisted path approvals (${records.length}):`,
				...lines,
				"",
				"Use /sandbox paths revoke <path> to revoke an approval.",
			].join("\n"),
			"info",
		);
	}

	async function cmdSandboxPathsRevoke(target: string, ctx: { ui: ExtensionUIContext }) {
		const store = pathApprovals;
		if (!store) {
			ctx.ui.notify("Path approval store not initialized.", "info");
			return;
		}
		if (!target) {
			ctx.ui.notify("Usage: /sandbox paths revoke <path>", "info");
			return;
		}
		const abs = target.startsWith("~") ? resolvePath(homedir(), target.slice(1)) : resolvePath(target);
		if (store.revoke(abs)) {
			ctx.ui.notify(`Revoked path approval: ${abs}`, "info");
		} else {
			ctx.ui.notify(`No approval found for: ${abs}`, "warning");
		}
	}

	async function cmdSandboxInstall(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
		const hostCwd = localCwd;
		const cfg = loadSandboxProjectConfig(hostCwd);
		const imageRef = imageRefForTag(cfg.image, cfg.tag);

		// Detect runtime — works without an active sandbox container
		const runtime = await detectRuntime(pi.getFlag("container-runtime") as string | undefined, ctx);
		if (!runtime) {
			ctx.ui.notify("No working container runtime (Apple `container` or Docker).", "error");
			return;
		}

		// 1. Check if image already exists locally
		const localDigest = await inspectLocalImageDigest(runtime, imageRef);
		if (localDigest) {
			ctx.ui.notify(
				`✅ Already installed: ${imageRef}\n` +
				`   Digest: ${localDigest.slice(0, 19)}...\n` +
				`   Run \`pi -e ./index.ts\` to start the sandbox.`,
				"info",
			);
			return;
		}

		// 2. Pull the image
		ctx.ui.notify(`⬇ Installing sandbox image: ${imageRef}...`);
		const pull = await runtime.pull(imageRef, 900000);
		if (pull.code !== 0 || pull.timedOut) {
			ctx.ui.notify(
				`❌ Failed to pull ${imageRef}.\n` +
				`   Check Docker connectivity or build manually:\n` +
				`   docker build -t ${imageRef} -f docker/Dockerfile docker`,
				"error",
			);
			return;
		}

		// 3. Record the digest
		const tagInfo = await fetchTagDigest(cfg.image, cfg.tag);
		if (tagInfo?.digest) {
			cfg.lastDigest = tagInfo.digest;
		}
		cfg.lastCheckedAt = Date.now();
		saveSandboxProjectConfig(hostCwd, cfg);

		// 4. Quick smoke test — run a throwaway container to verify the image works
		const testName = `pi-install-test-${randomSuffix()}`;
		const smoke = await spawnWithTimeout(
			runtime.bin,
			["run", "--rm", "--name", testName, imageRef, "sh", "-c", "id -un && pwd"],
			15000,
		);
		if (smoke.code === 0 && !smoke.timedOut) {
			ctx.ui.notify(
				`✅ Installed: ${imageRef}\n` +
				`   Digest: ${tagInfo?.digest?.slice(0, 19) ?? "unknown"}...\n` +
				`   Smoke test: ${smoke.stdout.trim()}\n` +
				`   Run \`pi -e ./index.ts\` to start using the sandbox.`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`⚠ Installed ${imageRef} but smoke test failed.\n` +
				`   The image may be incomplete. Try /sandbox update or build manually.`,
				"warning",
			);
		}
	}

	async function cmdSandboxUpdate(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
		const sbx = getSbx();
		if (!sbx) {
			ctx.ui.notify("Sandbox is not active.", "info");
			return;
		}
		const hostCwd = sbx.hostCwd;
		const cfg = loadSandboxProjectConfig(hostCwd);
		const imageRef = imageRefForTag(cfg.image, cfg.tag);

		ctx.ui.notify(`⬇ Pulling ${imageRef}...`);
		const pull = await sbx.runtime.pull(imageRef, 900000);
		if (pull.code !== 0 || pull.timedOut) {
			ctx.ui.notify(`❌ Failed to pull ${imageRef}.`, "error");
			return;
		}

		// Record the new digest
		const tagInfo = await fetchTagDigest(cfg.image, cfg.tag);
		if (tagInfo?.digest) {
			cfg.lastDigest = tagInfo.digest;
		}
		cfg.lastCheckedAt = Date.now();
		saveSandboxProjectConfig(hostCwd, cfg);

		ctx.ui.notify(
			`✅ Updated sandbox image: ${imageRef}\n` +
			`   Restart pi (exit and re-run) to use the new image.`,
			"info",
		);
	}

	async function cmdSandboxDoctor(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
		const sbx = getSbx();
		if (!sbx) {
			ctx.ui.notify("Sandbox is not active. Start pi with --container.", "info");
			return;
		}
		const script = [
			"set -u",
			"for cmd in sh bash git rg fd bat eza jq yq ast-grep uv python python3 bun bunx node npm chromium; do",
			"  if command -v $cmd >/dev/null 2>&1; then printf 'ok   %s -> %s\\n' $cmd $(command -v $cmd); else printf 'MISS %s\\n' $cmd; fi",
			"done",
			"echo",
			"bun --version 2>&1 | sed 's/^/bun: /'",
			"node --version 2>&1 | sed 's/^/node: /'",
			"npm --version 2>&1 | sed 's/^/npm: /'",
			"python --version 2>&1 | sed 's/^/python: /'",
			"uv --version 2>&1 | sed 's/^/uv: /'",
			"chromium --version 2>&1 | sed 's/^/chromium: /'",
			"echo",
			"ldd $(command -v node) | sed 's/^/node ldd: /'",
		].join("\n");
		const out = (await execCapture(sbx, script, 20000)).toString();
		ctx.ui.notify(`Sandbox doctor:\n${out}`, "info");
	}

	async function cmdSandboxConfig(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
		const sbx = getSbx();
		const hostCwd = sbx?.hostCwd ?? localCwd;
		const cfg = loadSandboxProjectConfig(hostCwd);
		const imageRef = imageRefForTag(cfg.image, cfg.tag);
		const lines: string[] = [
			`📋 Sandbox project config (.pi/agent/sandbox.json):`,
			`  Image:  ${imageRef}`,
			`  Pinned: ${cfg.pinned ? "yes" : "no"}`,
			`  Last digest: ${cfg.lastDigest?.slice(0, 19) ?? "—"}...`,
			`  Last checked: ${cfg.lastCheckedAt ? new Date(cfg.lastCheckedAt).toISOString() : "never"}`,
			``,
			`Commands:`,
			`  /sandbox status        Show container status`,
			`  /sandbox allow <path>  Grant session read access to a host path`,
			`  /sandbox paths [revoke <path>]  List/revoke path approvals`,
			`  /sandbox doctor       Check core tools inside the container`,
			`  /sandbox install      Pull sandbox image (no running container needed)`,
			`  /sandbox update       Pull the latest image (requires active sandbox)`,
			`  /sandbox pin <tag>     Pin to a specific version tag (e.g. v1.0.0)`,
			`  /sandbox unpin         Unpin and follow the default tag again`,
		];

		const configPath = getSandboxConfigPath(hostCwd);
		if (!existsSync(configPath)) {
			lines.push(`(no config file yet — will be created on first pin/update)`);
		}

		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function cmdSandboxPin(tag: string, ctx: { ui: ExtensionUIContext }) {
		if (!tag) {
			ctx.ui.notify("Usage: /sandbox pin <tag>\n  e.g. /sandbox pin v1.0.0", "info");
			return;
		}
		const hostCwd = getSbx()?.hostCwd ?? localCwd;
		const cfg = loadSandboxProjectConfig(hostCwd);
		// If tag looks like a full image ref (contains a slash), extract just the tag part
		const cleanTag = tag.replace(/^.*?\//, "");
		cfg.tag = cleanTag;
		cfg.pinned = true;
		saveSandboxProjectConfig(hostCwd, cfg);
		ctx.ui.notify(
			`📌 Pinned sandbox image to ${imageRefForTag(cfg.image, cfg.tag)}\n` +
			`   Set ${getSandboxConfigPath(hostCwd)}`,
			"info",
		);
	}

	async function cmdSandboxUnpin(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
		const hostCwd = getSbx()?.hostCwd ?? localCwd;
		const cfg = loadSandboxProjectConfig(hostCwd);
		if (!cfg.pinned) {
			ctx.ui.notify("Sandbox image is not pinned. Nothing to unpin.", "info");
			return;
		}
		cfg.tag = DEFAULT_SANDBOX_PROJECT_CONFIG.tag;
		cfg.pinned = false;
		saveSandboxProjectConfig(hostCwd, cfg);
		ctx.ui.notify(
			`🔓 Unpinned sandbox image — will follow tag "${cfg.tag}"\n` +
			`   Run \`/sandbox update\` to pull the latest.`,
			"info",
		);
	}

	// ── Main /sandbox command with subcommands ────────────────────────────

	pi.registerCommand("sandbox", {
		description: "Sandbox management. Subcommands: status, doctor, allow, paths, install, update, config, pin, unpin",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "status";

			switch (sub) {
				case "status":
				case "info":
					return cmdSandboxStatus(parts.slice(1).join(" "), ctx);
				case "doctor":
				case "check":
					return cmdSandboxDoctor(parts.slice(1).join(" "), ctx);
				case "allow":
					return cmdSandboxAllow(parts.slice(1).join(" "), ctx);
				case "paths": {
					if (parts[1] === "revoke" && parts[2]) {
						return cmdSandboxPathsRevoke(parts.slice(2).join(" "), ctx);
					}
					return cmdSandboxPathsList(ctx);
				}
				case "install":
				case "setup":
					return cmdSandboxInstall(parts.slice(1).join(" "), ctx);
				case "update":
				case "upgrade":
					return cmdSandboxUpdate(parts.slice(1).join(" "), ctx);
				case "config":
				case "settings":
					return cmdSandboxConfig(parts.slice(1).join(" "), ctx);
				case "pin":
					return cmdSandboxPin(parts.slice(1).join(" "), ctx);
				case "unpin":
					return cmdSandboxUnpin(parts.slice(1).join(" "), ctx);
				default:
					ctx.ui.notify(
						`Unknown subcommand: ${sub}\n` +
						`Available: status, doctor, allow, paths [revoke], install, update, config, pin, unpin`,
						"info",
					);
			}
		},
	});

}
