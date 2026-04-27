import { parseNpmCommand } from "./npm";
import { parsePipCommand } from "./pip";
import { parseBunCommand } from "./bun";
import { parseCurlCommand } from "./curl";
import { parseGitCommand } from "./git";
import { parseGenericCommand } from "./generic";
import { splitCommands } from "../util/shell-quote";
import type { ParsedCommand } from "./types";

const parsers = [
	parseNpmCommand,
	parsePipCommand,
	parseBunCommand,
	parseCurlCommand,
	parseGitCommand,
];

export function parseCommand(command: string): ParsedCommand {
	// Try each specific parser first
	for (const parser of parsers) {
		const result = parser(command);
		if (result) return result;
	}

	// Fall back to generic URL detection
	const generic = parseGenericCommand(command);
	if (generic) return generic;

	// No network activity detected
	return {
		raw: command,
		hasNetworkActivity: false,
		kind: "unknown",
		tool: "unknown",
		packages: [],
		urls: [],
		hasLifecycleScripts: false,
		isGlobalInstall: false,
		isCustomRegistry: false,
		isFileBasedInstall: false,
	};
}

export function parseAllCommands(command: string): ParsedCommand[] {
	const parts = splitCommands(command);
	return parts.map(parseCommand);
}
