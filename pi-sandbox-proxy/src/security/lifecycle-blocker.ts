import type { ParsedCommand } from "../parsers/types";

export interface LifecycleResult {
	mutatedCommand?: string;
	reason?: string;
	blocked?: boolean;
}

export function blockLifecycleScripts(parsed: ParsedCommand): LifecycleResult {
	if (parsed.kind !== "package-install" || !parsed.hasLifecycleScripts) return {};

	let command = parsed.raw;

	switch (parsed.tool) {
		case "npm":
		case "npx":
			if (command.includes("--ignore-scripts")) return {};
			command += " --ignore-scripts";
			return { mutatedCommand: command, reason: "Lifecycle scripts blocked (--ignore-scripts added)" };

		case "pip":
		case "pip3": {
			const hasNoCacheDir = command.includes("--no-cache-dir");
			const newCmd = hasNoCacheDir
				? command
				: `${command} --no-cache-dir`;
			return {
				mutatedCommand: newCmd,
				reason: "Build isolation restricted (--no-cache-dir added)",
			};
		}

		case "bun":
			if (command.includes("--ignore-scripts")) return {};
			command += " --ignore-scripts";
			return { mutatedCommand: command, reason: "Lifecycle scripts blocked (--ignore-scripts added)" };

		default:
			return {};
	}
}
