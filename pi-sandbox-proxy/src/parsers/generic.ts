import type { ParsedCommand } from "./types";

const URL_PATTERN = /https?:\/\/[^\s"'`\\]+/gi;

export function parseGenericCommand(command: string): ParsedCommand | null {
	const matches = command.match(URL_PATTERN);
	if (!matches || matches.length === 0) return null;

	return {
		raw: command,
		hasNetworkActivity: true,
		kind: "network-request",
		tool: "unknown",
		packages: [],
		urls: matches,
		hasLifecycleScripts: false,
		isGlobalInstall: false,
		isCustomRegistry: false,
		isFileBasedInstall: false,
	};
}
