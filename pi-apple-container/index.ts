/**
 * pi-apple-container
 * ------------------
 * Drop-in alternative to pi-container-sandbox that runs every read/write/edit/bash
 * operation inside a per-session Apple container (https://github.com/apple/container).
 *
 * NOT Docker. Do not load this extension and pi-container-sandbox in the same
 * session — they share `--container` / `/sandbox`.
 *
 * Requirements:
 *   - Apple silicon
 *   - macOS 26+
 *   - `container` CLI installed
 *   - user must run `container system start` (this extension never auto-starts the VM)
 *
 * Threat model:
 *   - The agent's bash and file tools never touch the host filesystem outside
 *     the project cwd, which is bind-mounted into the container at /workspace.
 *   - The agent runs as a non-root user (uid 1000) inside the container.
 *   - No host secrets are mounted (no $HOME, ~/.ssh, ~/.aws, ~/.config, no
 *     SSH agent, no Docker socket).
 *   - Network is enabled by default. Apple has no Docker `--network none`.
 *     `--no-container-net` only passes `--no-dns`. The VM still has a NIC.
 *   - Resource caps: Apple honors --cpus and --memory only. Disk / swap / pids
 *     from size tiers are ignored silently.
 *
 * Path safety:
 *   - Any tool path resolved outside of cwd is rejected.
 *     EXCEPTION: pi clipboard temp files (basename "pi-clipboard-*") are read
 *     directly from the host. Additional paths via --container-allow-paths
 *     or /sandbox allow.
 *
 * Usage:
 *   Sandbox is OFF by default. Enable mid-session with `/sandbox on`,
 *   persist with `/sandbox default on`, or pass `--container`:
 *        pi -e ./index.ts
 *        pi -e ./index.ts --container
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
	CONFIG_DIR_NAME,
	getAgentDir,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
	isAllowedExternalResource,
	isInsideCwd,
	isReadOnlyMount,
	type MountSpec,
	REMOTE_ROOT,
	resolveExtraMountPath,
	rewritePromptCwd,
	SKILLS_ROOT,
	toRemote,
} from "./src/paths";
import { createInFlight, mergeSandboxEnabled, resolveAutoStart } from "./src/resolve";
import {
	DEFAULT_IMAGE,
	detectRuntime,
	type RunArgs,
	type Runtime,
	spawnWithTimeout,
} from "./src/runtime";

// ---------------------------------------------------------------------------
// Size tier configuration (cpus + memory honored; disk/swap/pids ignored)
// ---------------------------------------------------------------------------

type SizeTier = "xs" | "sm" | "md" | "lg" | "xlg" | "xxlg";

interface TierSpec {
	memory: string;
	cpus: string;
}

const TIER_SPECS: Record<SizeTier, TierSpec> = {
	xs: { memory: "512m", cpus: "0.5" },
	sm: { memory: "2g", cpus: "1" },
	md: { memory: "4g", cpus: "2" },
	lg: { memory: "8g", cpus: "4" },
	xlg: { memory: "16g", cpus: "8" },
	xxlg: { memory: "32g", cpus: "16" },
};

function parseSizeTier(tier: string): SizeTier | null {
	if (tier in TIER_SPECS) return tier as SizeTier;
	return null;
}

interface SandboxConfig {
	enabled?: boolean;
	size?: SizeTier;
	persist?: boolean;
	cacheVolume?: string;
}

function loadSandboxConfig(hostCwd: string): SandboxConfig | null {
	const configPath = resolvePath(hostCwd, CONFIG_DIR_NAME, "config.json");
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

function deriveContainerName(hostCwd: string): string {
	const basename = hostCwd.split("/").filter(Boolean).pop() || "project";
	const hash = createHash("sha256").update(hostCwd).digest("hex").slice(0, 6);
	return `pi-sbx-${basename}-${hash}`;
}

// ---------------------------------------------------------------------------
// Sandbox session: a single running Apple container per pi session
// ---------------------------------------------------------------------------

interface Sandbox {
	runtime: Runtime;
	name: string;
	hostCwd: string;
	keep: boolean;
	mounts: MountSpec[];
	allowedExternalPrefixes: string[];
	resources?: RunArgs["resources"];
	imageRef: string;
	isReusable: boolean;
	isReattached: boolean;
	allowNetwork: boolean;
	sizeTier: SizeTier;
	cacheVolume?: string;
}

let sandbox: Sandbox | null = null;
let pathApprovals: PathApprovalStore | null = null;
const inflight = createInFlight();
let cleanupRegistered = false;
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
			try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
		}
		const tmpPath = this.path + ".tmp";
		const data = Array.from(this.records.values());
		writeFileSync(tmpPath, JSON.stringify(data, null, 2));
		renameSync(tmpPath, this.path);
	}

	find(absPath: string): PathApprovalRecord | undefined {
		const exact = this.records.get(absPath);
		if (exact && (exact.expiresAt === Infinity || exact.expiresAt > Date.now())) return exact;

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
// Interactive approval flow for external paths
// ---------------------------------------------------------------------------

async function requestPathApproval(
	absPath: string,
	sessionPrefixes: string[],
	store: PathApprovalStore,
	ui: ExtensionUIContext,
): Promise<boolean> {
	for (const prefix of sessionPrefixes) {
		if (absPath === prefix || absPath.startsWith(prefix + "/")) return true;
	}

	const existing = store.find(absPath);
	if (existing) return true;

	const basename = absPath.split("/").pop() || "";
	if (basename.startsWith("pi-clipboard-")) return true;

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

function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Container exec helpers — Apple `container exec NAME sh -c ...` (no -i)
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

function getExternalPath(hostPath: string, hostCwd: string, mounts: MountSpec[]): string | null {
	if (isInsideCwd(hostPath, hostCwd)) return null;
	const abs = resolvePath(hostCwd, hostPath);
	const containerPath = hostPath.startsWith("/") ? hostPath : abs;
	if (resolveExtraMountPath(containerPath, mounts)) return null;
	return abs;
}

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

function discoverSkillDirs(additionalPaths?: string[]): MountSpec[] {
	const home = homedir();
	const skillRoots = [
		...additionalPaths ?? [],
		resolvePath(home, ".agents", "skills"),
		resolvePath(getAgentDir(), "skills"),
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
		description: "Enable Apple container sandbox at session start (default: off; use /sandbox on)",
		type: "boolean",
		default: false,
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
		description: "Sandbox size tier: xs, sm (default), md, lg, xlg, xxlg. Sets memory and cpu (Apple ignores disk/swap/pids).",
		type: "string",
		default: "sm",
	});
	pi.registerFlag("sandbox-name", {
		description: "Re-usable sandbox name. If container exists, reattaches; otherwise creates new.",
		type: "string",
	});
	pi.registerFlag("sandbox-persist", {
		description: "Keep sandbox container running after pi exits (for re-usable sandboxes)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-cache", {
		description: "Volume name for persistent cache at /cache (auto-created if needed)",
		type: "string",
	});
	pi.registerFlag("container-image", {
		description: `Image to use for the sandbox (default: ${DEFAULT_IMAGE}; aarch64 / Apple silicon)`,
		type: "string",
	});
	pi.registerFlag("container-net", {
		description: "Allow outbound network from the sandbox (default: on). Off passes --no-dns only; the VM still has a NIC.",
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
		description: "Memory limit for the container (e.g., 2g, 512m). Default: from size tier",
		type: "string",
	});
	pi.registerFlag("container-cpus", {
		description: "CPU limit for the container (e.g., 2, 0.5, 4.0). Default: from size tier",
		type: "string",
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	pathApprovals = new PathApprovalStore(getAgentDir());

	async function guardExternalRead(
		paramsPath: string,
		sbx: Sandbox,
		ctx: { ui: ExtensionUIContext; hasUI: boolean },
	): Promise<void> {
		const external = getExternalPath(paramsPath, sbx.hostCwd, sbx.mounts);
		if (!external) return;
		if (isAllowedExternalResource(external, sbx.allowedExternalPrefixes)) return;
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
			if (!sbx) return localRead.execute(id, params, signal, onUpdate);
			inflight.begin();
			try {
				await guardExternalRead(params.path, sbx, _ctx);
				const tool = createReadTool(localCwd, { operations: readOps(sbx) });
				return await tool.execute(id, params, signal, onUpdate);
			} finally {
				inflight.end();
			}
		},
	});
	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localWrite.execute(id, params, signal, onUpdate);
			inflight.begin();
			try {
				const tool = createWriteTool(localCwd, { operations: writeOps(sbx) });
				return await tool.execute(id, params, signal, onUpdate);
			} finally {
				inflight.end();
			}
		},
	});
	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localEdit.execute(id, params, signal, onUpdate);
			inflight.begin();
			try {
				const tool = createEditTool(localCwd, { operations: editOps(sbx) });
				return await tool.execute(id, params, signal, onUpdate);
			} finally {
				inflight.end();
			}
		},
	});
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localBash.execute(id, params, signal, onUpdate);
			inflight.begin();
			try {
				const tool = createBashTool(localCwd, { operations: bashOps(sbx) });
				return await tool.execute(id, params, signal, onUpdate);
			} finally {
				inflight.end();
			}
		},
	});

	pi.on("user_bash", () => {
		const sbx = getSbx();
		if (!sbx) return;
		const ops = bashOps(sbx);
		return {
			operations: {
				exec: (command, cwd, opts) => {
					inflight.begin();
					try {
						return Promise.resolve(ops.exec(command, cwd, opts)).finally(() => {
							inflight.end();
						});
					} catch (e) {
						inflight.end();
						throw e;
					}
				},
			},
		};
	});

	pi.on("before_agent_start", async (event) => {
		const sbx = getSbx();
		if (sbx) {
			const skillInfo = sbx.mounts.length
				? `Agent skills are mounted read-only at ${SKILLS_ROOT}/ (e.g. ${sbx.mounts.map((m) => m.target).join(", ")}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
				: "No skill directories are mounted.";

			return {
				systemPrompt: rewritePromptCwd(event.systemPrompt, {
					sandboxed: true,
					localCwd,
					remoteRoot: REMOTE_ROOT,
					runtimeKind: sbx.runtime.kind,
					containerName: sbx.name,
					skillInfo,
				}),
			};
		}

		const rewritten = rewritePromptCwd(event.systemPrompt, {
			sandboxed: false,
			localCwd,
		});
		if (rewritten !== event.systemPrompt) return { systemPrompt: rewritten };
		return;
	});

	async function enableSandbox(ctx: { ui: ExtensionUIContext }): Promise<boolean> {
		if (getSbx()) {
			ctx.ui.notify(`Sandbox is already on (${getSbx()!.name}).`, "info");
			return true;
		}

		try {
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "Sandbox starting…"));
			const runtime = await detectRuntime(ctx);
			if (!runtime) {
				ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "Sandbox off"));
				return false;
			}

			const config = loadSandboxConfig(localCwd);

			const sizeFlag = pi.getFlag("container-size") as string | undefined;
			const sizeTier = parseSizeTier(sizeFlag || config?.size || "sm") || "sm";
			const tierSpec = TIER_SPECS[sizeTier];

			const flagImage = pi.getFlag("container-image") as string | undefined;
			const image = flagImage || DEFAULT_IMAGE;
			const allowNetwork = (pi.getFlag("container-net") as boolean)
				|| (pi.getFlag("prawl") as boolean)
				|| (pi.getFlag("browser") as boolean);
			const keep = pi.getFlag("container-keep") as boolean;
			const persist = (pi.getFlag("sandbox-persist") as boolean) || config?.persist || false;
			const mountSkills = pi.getFlag("container-mount-skills") as boolean;
			const extraPathsRaw = pi.getFlag("container-mount-paths") as string | undefined;
			const extraPaths = extraPathsRaw ? extraPathsRaw.split(",").map((p) => p.trim()).filter(Boolean) : undefined;

			const nameFlag = pi.getFlag("sandbox-name") as string | undefined;
			const sandboxName = nameFlag || deriveContainerName(localCwd);
			const isReusable = !!nameFlag;

			const cacheFlag = pi.getFlag("sandbox-cache") as string | undefined;
			const cacheVolume = cacheFlag || config?.cacheVolume;

			if (cacheVolume) {
				await runtime.createVolume(cacheVolume);
			}

			const skillMounts = mountSkills ? discoverSkillDirs(extraPaths) : [];

			// Reattach if running; start if persist/reusable and stopped; else delete stale.
			let isReattached = false;
			{
				const running = await runtime.isRunning(sandboxName);
				if (running) {
					isReattached = true;
					ctx.ui.notify(`🔄 Reattaching to existing sandbox: ${sandboxName}`, "info");
				} else if (await runtime.inspectExists(sandboxName)) {
					if (isReusable || persist) {
						const started = await runtime.start(sandboxName);
						if (started) {
							isReattached = true;
							ctx.ui.notify(`♻️ Restarted existing sandbox: ${sandboxName}`, "info");
						} else {
							ctx.ui.notify(`Removing broken container ${sandboxName}, creating fresh...`, "warning");
							runtime.remove(sandboxName);
						}
					} else {
						ctx.ui.notify(`Cleaning up stale container ${sandboxName} for fresh sandbox`, "info");
						runtime.remove(sandboxName);
					}
				}
			}

			if (!(await runtime.exists(image))) {
				ctx.ui.notify(`Sandbox image "${image}" not found locally, pulling...`);
				const pull = await spawnWithTimeout(runtime.bin, ["image", "pull", image], 180000);
				if (!pull || pull.code !== 0 || pull.timedOut) {
					ctx.ui.notify(
						`Sandbox image "${image}" not found. Pull failed.\n` +
						`  container image pull ${image}\n` +
						`Image must be aarch64 (Apple silicon).`,
						"error",
					);
					ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "Sandbox off"));
					return false;
				}
			}

			const allowPathsRaw = pi.getFlag("container-allow-paths") as string | undefined;
			const allowedExternalPrefixes = allowPathsRaw
				? allowPathsRaw.split(",").map((p) => p.trim()).filter(Boolean).map((p) =>
					p.startsWith("~") ? resolvePath(homedir(), p.slice(1)) : resolvePath(p)
				)
				: [];

			const resources: RunArgs["resources"] = {
				memory: tierSpec.memory,
				cpus: tierSpec.cpus,
			};

			const memFlag = pi.getFlag("container-memory") as string | undefined;
			const cpusFlag = pi.getFlag("container-cpus") as string | undefined;
			if (memFlag) resources.memory = memFlag;
			if (cpusFlag) resources.cpus = cpusFlag;

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
				imageRef: image,
				isReusable,
				isReattached,
				allowNetwork,
				sizeTier,
				cacheVolume,
			};

			// Registered once so /sandbox on|off cannot stack handlers.
			if (!cleanupRegistered) {
				const cleanup = () => {
					const s = sandbox;
					if (!s || s.keep) return;
					try {
						s.runtime.stop(s.name);
						s.runtime.remove(s.name);
					} catch { /* ignore */ }
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
				cleanupRegistered = true;
			}

			const ok = (await execCapture(sandbox, "id -un && pwd", 10000)).toString().trim();

			const resParts: string[] = [
				`size=${sizeTier}`,
				`mem=${resources.memory}`,
				`cpu=${resources.cpus}`,
			];
			const resStr = ` (${resParts.join(", ")})`;

			const statusPrefix = isReattached ? "🔄 Reattached" : "🛡 Sandbox up";
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `${statusPrefix}: ${actualName} (net=${allowNetwork ? "on" : "off / --no-dns"})${resStr}`),
			);
			ctx.ui.notify(
				`${statusPrefix}: apple container ${actualName}${resStr}${isReusable ? " [re-usable]" : ""}\n${ok}` +
				`${skillMounts.length ? `\nSkills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : ""}` +
				`${cacheVolume ? `\nCache volume: ${cacheVolume} at /cache` : ""}` +
				`${allowNetwork ? "" : "\nNetwork: --no-dns only (VM still has a NIC; not Docker --network none)"}`,
				"info",
			);
			return true;
		} catch (e) {
			sandbox = null;
			ctx.ui.notify(`Sandbox init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "Sandbox off"));
			return false;
		}
	}

	async function disableSandbox(
		ctx: { ui: ExtensionUIContext },
		opts?: { silent?: boolean },
	): Promise<boolean> {
		if (inflight.busy) {
			ctx.ui.notify(`Cannot disable sandbox: ${inflight.count} operation(s) in flight`, "warning");
			return false;
		}
		const sbx = getSbx();
		if (!sbx) {
			if (!opts?.silent) ctx.ui.notify("Sandbox is already off.", "info");
			return true;
		}
		if (!sbx.keep) {
			sbx.runtime.stop(sbx.name);
			sbx.runtime.remove(sbx.name);
		}
		sandbox = null;
		ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "Sandbox off"));
		if (!opts?.silent) {
			ctx.ui.notify(
				sbx.keep
					? `Sandbox routing off. Container ${sbx.name} left running (persist/keep).`
					: `Sandbox off. Container ${sbx.name} stopped.`,
				"info",
			);
			ctx.ui.notify("CWD in the system prompt updates on the next agent turn.", "info");
		}
		return true;
	}

	function writeSandboxEnabled(enabled: boolean): string {
		const configPath = resolvePath(localCwd, CONFIG_DIR_NAME, "config.json");
		let parsed: Record<string, unknown> = {};
		if (existsSync(configPath)) {
			try {
				const raw = JSON.parse(readFileSync(configPath, "utf-8"));
				if (raw && typeof raw === "object") parsed = raw as Record<string, unknown>;
			} catch {
				parsed = {};
			}
		}
		const existing = parsed.sandbox && typeof parsed.sandbox === "object"
			? parsed.sandbox as Record<string, unknown>
			: null;
		const merged = mergeSandboxEnabled(existing, enabled);
		parsed.sandbox = merged.sandbox;
		mkdirSync(resolvePath(localCwd, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
		return configPath;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!resolveAutoStart({
			noContainer: pi.getFlag("no-container") as boolean,
			noc: pi.getFlag("noc") as boolean,
			containerFlag: pi.getFlag("container") as boolean,
			configEnabled: loadSandboxConfig(localCwd)?.enabled,
		})) return;
		await enableSandbox(ctx);
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

	async function cmdSandboxStatus(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
		const sbx = getSbx();
		if (!sbx) {
			ctx.ui.notify(
				[
					"Sandbox is not active.",
					"Requires the Apple `container` CLI (https://github.com/apple/container) and `container system start`.",
					"Enable with /sandbox on, persist with /sandbox default on, or pass --container.",
					`Default image: ${DEFAULT_IMAGE} (aarch64 / Apple silicon).`,
					"Do not load pi-container-sandbox in the same session.",
				].join("\n"),
				"info",
			);
			return;
		}
		const info = (await execCapture(sbx, "id; uname -a; df -h /workspace | tail -1")).toString();
		const resParts: string[] = [];
		if (sbx.resources?.memory) resParts.push(`memory: ${sbx.resources.memory}`);
		if (sbx.resources?.cpus) resParts.push(`cpus: ${sbx.resources.cpus}`);
		const resStr = resParts.length ? `\nresources: ${resParts.join(", ")}` : "";
		const reusableStr = sbx.isReusable ? ` [re-usable${sbx.isReattached ? ", reattached" : ""}]` : "";
		ctx.ui.notify(
			[
				`Sandbox: apple container ${sbx.name}${reusableStr}`,
				`host cwd: ${sbx.hostCwd}`,
				`image: ${sbx.imageRef}`,
				`network: ${sbx.allowNetwork ? "on (default)" : "off (--no-dns only; VM still has a NIC)"}`,
				`size tier: ${sbx.sizeTier}`,
				resStr.trim(),
				sbx.cacheVolume ? `cache: ${sbx.cacheVolume} → /cache` : "",
				info.trimEnd(),
			].filter(Boolean).join("\n"),
			"info",
		);
	}

	async function cmdSandboxAllow(raw: string, ctx: { ui: ExtensionUIContext }) {
		const sbx = getSbx();
		if (!sbx) {
			ctx.ui.notify("Sandbox is not active. Enable with /sandbox on (requires the `container` CLI).", "info");
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
		const flagImage = pi.getFlag("container-image") as string | undefined;
		const imageRef = flagImage || DEFAULT_IMAGE;

		const runtime = await detectRuntime(ctx);
		if (!runtime) return;

		if (await runtime.exists(imageRef)) {
			ctx.ui.notify(
				`✅ Already installed: ${imageRef}\n` +
				`   Run \`pi -e ./index.ts --container\` or /sandbox on.`,
				"info",
			);
			return;
		}

		ctx.ui.notify(`⬇ Pulling sandbox image: ${imageRef}...`);
		const pull = await spawnWithTimeout(runtime.bin, ["image", "pull", imageRef], 180000);
		if (pull.code !== 0 || pull.timedOut) {
			ctx.ui.notify(
				`❌ Failed to pull ${imageRef}.\n` +
				`   container image pull ${imageRef}\n` +
				`   Image must be aarch64 (Apple silicon).`,
				"error",
			);
			return;
		}

		ctx.ui.notify(
			`✅ Installed: ${imageRef}\n` +
			`   Run \`pi -e ./index.ts --container\` or /sandbox on.`,
			"info",
		);
	}

	async function cmdSandboxDoctor(_subArgs: string, ctx: { ui: ExtensionUIContext }) {
		const sbx = getSbx();
		if (!sbx) {
			ctx.ui.notify("Sandbox is not active. Enable with /sandbox on (requires the `container` CLI).", "info");
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
		const cfg = loadSandboxConfig(localCwd);
		const sbx = getSbx();
		const lines: string[] = [
			`📋 Apple container sandbox`,
			`  Runtime: Apple Containerization (macOS 26+, Apple silicon)`,
			`  Mutually exclusive with pi-container-sandbox`,
			`  Image: ${sbx?.imageRef ?? (pi.getFlag("container-image") as string | undefined) ?? DEFAULT_IMAGE}`,
			`  Active: ${sbx ? `yes (${sbx.name})` : "no"}`,
			`  .pi/config.json sandbox.enabled: ${cfg?.enabled === true ? "true" : cfg?.enabled === false ? "false" : "(unset → off)"}`,
			`  size: ${cfg?.size ?? "(unset → sm)"}`,
			`  persist: ${cfg?.persist ? "true" : "false"}`,
			`  cacheVolume: ${cfg?.cacheVolume ?? "(none)"}`,
			``,
			`Commands:`,
			`  /sandbox on              Enable sandbox for this session`,
			`  /sandbox off             Disable sandbox for this session`,
			`  /sandbox default on|off  Persist enabled default in .pi/config.json`,
			`  /sandbox status          Show container status`,
			`  /sandbox allow <path>    Grant session read access to a host path`,
			`  /sandbox paths [revoke <path>]  List/revoke path approvals`,
			`  /sandbox doctor          Check core tools inside the container`,
			`  /sandbox install         Pull sandbox image (container image pull)`,
			`  /sandbox config          Show this help`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	pi.registerCommand("sandbox", {
		description: "Apple container sandbox. Subcommands: on, off, default, status, doctor, allow, paths, install, config",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "status";

			switch (sub) {
				case "on":
				case "enable": {
					const ok = await enableSandbox(ctx);
					if (ok) {
						ctx.ui.notify("CWD in the system prompt updates on the next agent turn.", "info");
					}
					return;
				}
				case "off":
				case "disable":
					await disableSandbox(ctx);
					return;
				case "default": {
					const val = parts[1]?.toLowerCase();
					if (val !== "on" && val !== "off") {
						ctx.ui.notify("Usage: /sandbox default on|off", "warning");
						return;
					}
					const path = writeSandboxEnabled(val === "on");
					ctx.ui.notify(
						`Saved sandbox.enabled=${val === "on"} to ${path}. Takes effect on next session start (this session is unchanged).`,
						"info",
					);
					return;
				}
				case "status":
				case "info":
					await cmdSandboxStatus(parts.slice(1).join(" "), ctx);
					return;
				case "doctor":
				case "check":
					await cmdSandboxDoctor(parts.slice(1).join(" "), ctx);
					return;
				case "allow":
					await cmdSandboxAllow(parts.slice(1).join(" "), ctx);
					return;
				case "paths": {
					if (parts[1] === "revoke" && parts[2]) {
						await cmdSandboxPathsRevoke(parts.slice(2).join(" "), ctx);
						return;
					}
					await cmdSandboxPathsList(ctx);
					return;
				}
				case "install":
				case "setup":
					await cmdSandboxInstall(parts.slice(1).join(" "), ctx);
					return;
				case "config":
				case "settings":
					await cmdSandboxConfig(parts.slice(1).join(" "), ctx);
					return;
				default:
					ctx.ui.notify(
						`Unknown subcommand: ${sub}\n` +
						`Available: on, off, default, status, doctor, allow, paths [revoke], install, config`,
						"info",
					);
			}
		},
	});
}
