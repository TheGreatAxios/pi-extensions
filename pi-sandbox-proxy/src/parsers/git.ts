import { parseShellArgs } from "../util/shell-quote";
import type { ParsedCommand } from "./types";

const GIT_NETWORK_COMMANDS = new Set(["clone", "fetch", "pull", "submodule"]);

export function parseGitCommand(command: string): ParsedCommand | null {
	const args = parseShellArgs(command);
	if (args.length === 0 || args[0].value !== "git") return null;

	const subcommand = args[1]?.value ?? "";
	if (!GIT_NETWORK_COMMANDS.has(subcommand)) return null;

	const urls: string[] = [];

	for (let i = 2; i < args.length; i++) {
		const arg = args[i].value;
		if (arg.startsWith("http://") || arg.startsWith("https://") || arg.startsWith("git@") || arg.startsWith("ssh://")) {
			urls.push(arg);
		}
	}

	return {
		raw: command,
		hasNetworkActivity: true,
		kind: "git-clone",
		tool: "git",
		packages: [],
		urls,
		hasLifecycleScripts: false,
		isGlobalInstall: false,
		isCustomRegistry: false,
		isFileBasedInstall: false,
	};
}
