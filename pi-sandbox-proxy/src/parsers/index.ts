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

function tryParseSingleCommand(command: string): ParsedCommand | null {
	// Try each specific parser first
	for (const parser of parsers) {
		const result = parser(command);
		if (result) return result;
	}

	// Fall back to generic URL detection
	const generic = parseGenericCommand(command);
	if (generic) return generic;

	return null;
}

export function parseCommand(command: string): ParsedCommand {
	// First, try to parse the entire command as-is
	const single = tryParseSingleCommand(command);
	if (single) return single;

	// If no parser matched, split on && / || / ; and check each segment
	// This handles chained commands like "cd pi-sandbox && bun install"
	const segments = splitCommands(command);
	if (segments.length > 1) {
		const parsedSegments = segments.map(tryParseSingleCommand).filter((s): s is ParsedCommand => s !== null);

		// If any segment has network activity, treat the whole command as having network activity
		const hasNetworkActivity = parsedSegments.some((s) => s.hasNetworkActivity);

		if (hasNetworkActivity) {
			// Merge all network-active segments into a single result
			const allPackages = parsedSegments.flatMap((s) => s.packages);
			const allUrls = parsedSegments.flatMap((s) => s.urls);
			const hasLifecycleScripts = parsedSegments.some((s) => s.hasLifecycleScripts);
			const isGlobalInstall = parsedSegments.some((s) => s.isGlobalInstall);
			const isCustomRegistry = parsedSegments.some((s) => s.isCustomRegistry);
			const isFileBasedInstall = parsedSegments.some((s) => s.isFileBasedInstall);

			// Use the first package-install segment as the primary, or fall back to the first segment
			const primary = parsedSegments.find((s) => s.kind === "package-install") || parsedSegments[0];

			return {
				raw: command,
				hasNetworkActivity: true,
				kind: primary.kind,
				tool: primary.tool,
				packages: allPackages,
				urls: allUrls,
				hasLifecycleScripts,
				isGlobalInstall,
				isCustomRegistry,
				isFileBasedInstall,
			};
		}
	}

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
