import { resolve as resolvePath } from "node:path";

export const REMOTE_ROOT = "/workspace";
export const SKILLS_ROOT = "/skills";

export interface MountSpec {
	/** Absolute path on the host. */
	source: string;
	/** Absolute path inside the container. */
	target: string;
}

/** Return the container-side path if it falls under a known extra mount, otherwise null. */
export function resolveExtraMountPath(containerPath: string, mounts: MountSpec[]): string | null {
	for (const m of mounts) {
		if (containerPath === m.target || containerPath.startsWith(`${m.target}/`)) {
			return containerPath;
		}
	}
	return null;
}

export function toRemote(hostPath: string, hostCwd: string, mounts?: MountSpec[]): string {
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
export function isReadOnlyMount(containerPath: string, mounts: MountSpec[]): boolean {
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
export function isAllowedExternalResource(hostPath: string, allowedPrefixes: string[]): boolean {
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
export function isInsideCwd(hostPath: string, hostCwd: string): boolean {
	// Tool calls may use container-absolute paths because the agent sees
	// the sandbox cwd as /workspace. Those paths are inside the project
	// mount even though resolvePath(hostCwd, "/workspace/...") would
	// otherwise look like an external host path and trigger approval.
	if (hostPath === REMOTE_ROOT || hostPath.startsWith(`${REMOTE_ROOT}/`)) return true;
	const abs = resolvePath(hostCwd, hostPath);
	return abs === hostCwd || abs.startsWith(`${hostCwd}/`);
}

export function rewritePromptCwd(systemPrompt: string, opts: {
	sandboxed: boolean;
	localCwd: string;
	remoteRoot?: string;
	runtimeKind?: string;
	containerName?: string;
	skillInfo?: string;
}): string {
	const remote = opts.remoteRoot ?? "/workspace";
	if (opts.sandboxed) {
		const skillLine = opts.skillInfo ?? "";
		const replacement = [
			`Current working directory: ${remote} (sandboxed in ${opts.runtimeKind} container ${opts.containerName}, host cwd ${opts.localCwd} mounted read-write)`,
			skillLine,
		].filter(Boolean).join("\n");
		return systemPrompt.replace(`Current working directory: ${opts.localCwd}`, replacement);
	}
	return systemPrompt.replace(
		/Current working directory: \/workspace \(sandboxed in[^\n]*\)\n?[^\n]*/,
		`Current working directory: ${opts.localCwd}`,
	);
}
