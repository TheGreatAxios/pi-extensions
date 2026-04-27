import type { ParsedCommand } from "../parsers/types";

export interface PatternResult {
	blocked: boolean;
	reason?: string;
}

const ENV_VAR_PATTERN = /\$[A-Za-z_][A-Za-z0-9_]*/;
const ENV_VAR_BRACED_PATTERN = /\$\{[^}]+\}/;

export function checkDangerousPatterns(parsed: ParsedCommand): PatternResult {
	const raw = parsed.raw.toLowerCase();

	// curl | sh / bash — always block
	if (/curl.*\|\s*(sh|bash|zsh|ksh)/.test(raw)) {
		return { blocked: true, reason: "Blocked: piping network content to shell execution (curl | sh/bash)" };
	}
	if (/wget.*\|\s*(sh|bash|zsh|ksh)/.test(raw)) {
		return { blocked: true, reason: "Blocked: piping network content to shell execution (wget | sh/bash)" };
	}

	// Global installs
	if (parsed.isGlobalInstall) {
		return { blocked: true, reason: "Blocked: global installs are not allowed (-g/--global)" };
	}

	// File-based installs
	if (parsed.isFileBasedInstall) {
		return { blocked: true, reason: "Blocked: file-based installs are not allowed (use registry only)" };
	}

	// HTTP (non-TLS) URLs for packages
	for (const url of parsed.urls) {
		if (url.startsWith("http://")) {
			return { blocked: true, reason: `Blocked: insecure HTTP URL: ${url}` };
		}
	}

	// Env var exfiltration in network commands
	if (ENV_VAR_PATTERN.test(parsed.raw) || ENV_VAR_BRACED_PATTERN.test(parsed.raw)) {
		if (parsed.hasNetworkActivity) {
			return { blocked: true, reason: "Blocked: environment variable reference in network command (possible exfiltration)" };
		}
	}

	return { blocked: false };
}
