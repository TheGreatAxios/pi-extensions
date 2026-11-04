import { spawn, spawnSync } from "node:child_process";
import type { MountSpec } from "./paths";

export type RuntimeKind = "apple";

export const CONTAINER_BIN = "container";
export const DEFAULT_IMAGE = "thegreataxios/pi-sandbox:latest";

export interface RunResources {
	memory?: string;
	cpus?: string;
	/** Ignored by Apple container CLI. */
	pidsLimit?: number;
	/** Ignored by Apple container CLI. */
	swap?: string;
	/** Ignored by Apple container CLI. */
	disk?: string;
}

export interface RunArgs {
	name: string;
	image: string;
	hostCwd: string;
	allowNetwork: boolean;
	extraMounts?: MountSpec[];
	resources?: RunResources;
	cacheVolume?: string;
}

export interface Runtime {
	kind: RuntimeKind;
	bin: string;
	/** Returns the container name actually used. */
	run(args: RunArgs): Promise<string>;
	stop(name: string): void;
	/** Remove a container forcefully (`container delete --force`). */
	remove(name: string): void;
	exists(image: string): Promise<boolean>;
	isRunning(name: string): Promise<boolean>;
	start(name: string): Promise<boolean>;
	createVolume(name: string): Promise<boolean>;
	/** True if a named container exists (running or stopped). */
	inspectExists(name: string): Promise<boolean>;
}

export interface DetectNotify {
	ui?: {
		notify(message: string, level?: string): void;
	};
}

export function which(bin: string): boolean {
	const r = spawnSync("which", [bin], { stdio: "ignore" });
	return r.status === 0;
}

export function spawnWithTimeout(
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

/** Detect Apple's "container system is not running" class of errors. */
export function looksLikeSystemNotRunning(text: string): boolean {
	const t = text.toLowerCase();
	if (t.includes("system-not-running")) return true;
	if (t.includes("system is not running")) return true;
	if (t.includes("system isn't running")) return true;
	if (t.includes("container system start")) return true;
	if (/\bsystem\b/.test(t) && /not running/.test(t)) return true;
	return false;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	if (v && typeof v === "object" && !Array.isArray(v)) {
		return v as Record<string, unknown>;
	}
	return null;
}

function runningHint(v: unknown): boolean {
	if (typeof v === "string") {
		const s = v.toLowerCase();
		return s.includes("running") || s.includes("started");
	}
	const rec = asRecord(v);
	if (!rec) return false;
	for (const key of ["status", "state"]) {
		const inner = rec[key];
		if (typeof inner === "string") {
			const s = inner.toLowerCase();
			if (s.includes("running") || s.includes("started")) return true;
		}
	}
	return false;
}

function collectNames(entry: Record<string, unknown>): string[] {
	const names: string[] = [];
	const push = (v: unknown) => {
		if (typeof v === "string" && v.length > 0) names.push(v);
	};
	push(entry.id);
	push(entry.name);
	const cfg = asRecord(entry.configuration);
	if (cfg) {
		push(cfg.id);
		push(cfg.name);
		push(cfg.hostname);
	}
	return names;
}

function listEntries(parsed: unknown): unknown[] | null {
	if (Array.isArray(parsed)) return parsed;
	const rec = asRecord(parsed);
	if (!rec) return null;
	for (const key of ["containers", "list", "items", "data"]) {
		if (Array.isArray(rec[key])) return rec[key] as unknown[];
	}
	return null;
}

/**
 * Parse `container list --format json` output and report whether `name` looks running.
 * Never throws: unknown / corrupt shapes return false.
 */
export function parseListRunning(name: string, json: string): boolean {
	if (!name || typeof json !== "string") return false;
	const trimmed = json.trim();
	if (!trimmed) return false;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return false;
	}

	const entries = listEntries(parsed);
	if (!entries) return false;

	for (const item of entries) {
		const rec = asRecord(item);
		if (!rec) continue;
		const names = collectNames(rec);
		if (!names.includes(name)) continue;
		if (runningHint(rec.status) || runningHint(rec.state)) return true;
		const cfg = asRecord(rec.configuration);
		if (cfg && (runningHint(cfg.status) || runningHint(cfg.state))) return true;
	}
	return false;
}

/**
 * Build argv for `container run ...` (does not include the binary).
 * Disk / swap / pids are ignored: Apple honors --cpus and --memory only.
 * allowNetwork false → `--no-dns` only. The VM still has a NIC.
 */
export function buildRunArgs(args: RunArgs): string[] {
	const memory = args.resources?.memory ?? "2g";
	const cpus = args.resources?.cpus ?? "1";

	const argv: string[] = [
		"run",
		"-d",
		"--name", args.name,
		"--user", "1000:1000",
		"--cpus", cpus,
		"--memory", memory,
		"--mount", `type=bind,source=${args.hostCwd},target=/workspace`,
	];

	if (args.extraMounts) {
		for (const m of args.extraMounts) {
			argv.push("--mount", `type=bind,source=${m.source},target=${m.target},readonly`);
		}
	}

	if (args.cacheVolume) {
		argv.push("-v", `${args.cacheVolume}:/cache`);
	}

	argv.push("-w", "/workspace");

	if (!args.allowNetwork) {
		argv.push("--no-dns");
	}

	argv.push("--cap-drop", "ALL", "--init", args.image, "sleep", "infinity");
	return argv;
}

export function appleRuntime(): Runtime {
	const bin = CONTAINER_BIN;
	return {
		kind: "apple",
		bin,
		exists: async (image) => {
			const r = await spawnWithTimeout(bin, ["image", "inspect", image], 10000);
			return r.code === 0 && !r.timedOut;
		},
		stop: (name) => {
			spawnSync(bin, ["stop", name], { stdio: "ignore" });
		},
		remove: (name) => {
			spawnSync(bin, ["delete", "--force", name], { stdio: "ignore" });
		},
		isRunning: async (name) => {
			const r = await spawnWithTimeout(bin, ["list", "--format", "json"], 5000);
			if (r.code !== 0 || r.timedOut) return false;
			return parseListRunning(name, r.stdout);
		},
		start: async (name) => {
			const r = await spawnWithTimeout(bin, ["start", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		createVolume: async (name) => {
			const r = await spawnWithTimeout(bin, ["volume", "create", name], 10000);
			return r.code === 0 && !r.timedOut;
		},
		inspectExists: async (name) => {
			const r = await spawnWithTimeout(bin, ["inspect", name], 5000);
			return r.code === 0 && !r.timedOut;
		},
		run: async (args) => {
			const argv = buildRunArgs(args);
			// Apple VMs can take longer than Docker containers to come up.
			const r = await spawnWithTimeout(bin, argv, 180000);
			if (r.timedOut) {
				throw new Error(`container run timed out after 180s (command: container run ${args.name})`);
			}
			if (r.code !== 0) {
				throw new Error(`container run failed: ${r.stderr || r.stdout}`);
			}
			return args.name;
		},
	};
}

/**
 * Locate a usable Apple `container` CLI.
 * Never auto-starts the VM service (`container system start` is the user's job).
 */
export async function detectRuntime(ctx?: DetectNotify): Promise<Runtime | null> {
	if (!which(CONTAINER_BIN)) {
		ctx?.ui?.notify(
			"Apple container CLI not found. Install from https://github.com/apple/container (Apple silicon, macOS 26+).",
			"warning",
		);
		return null;
	}

	const list = await spawnWithTimeout(CONTAINER_BIN, ["list"], 5000);
	if (list.code !== 0 || list.timedOut) {
		const text = `${list.stdout}\n${list.stderr}`;
		if (list.timedOut || looksLikeSystemNotRunning(text)) {
			ctx?.ui?.notify("Apple container system is not running. Run: container system start", "warning");
		} else {
			ctx?.ui?.notify(
				`Apple container CLI failed (\`container list\`): ${(list.stderr || list.stdout || "unknown error").trim()}`,
				"warning",
			);
		}
		return null;
	}

	return appleRuntime();
}
