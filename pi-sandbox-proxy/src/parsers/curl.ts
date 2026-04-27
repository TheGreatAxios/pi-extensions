import { parseShellArgs } from "../util/shell-quote";
import type { ParsedCommand } from "./types";

const NETWORK_TOOLS = new Set(["curl", "wget"]);

export function parseCurlCommand(command: string): ParsedCommand | null {
	const args = parseShellArgs(command);
	if (args.length === 0) return null;

	const tool = args[0].value;
	if (!NETWORK_TOOLS.has(tool)) return null;

	const urls: string[] = [];
	let method = "GET";
	let hasPipeToShell = false;

	for (let i = 1; i < args.length; i++) {
		const arg = args[i].value;

		if (arg === "-X" || arg === "--request") {
			method = (args[i + 1]?.value ?? "GET").toUpperCase();
			i++;
			continue;
		}
		if (arg.startsWith("-X") && arg.length > 2) {
			method = arg.slice(2).toUpperCase();
		}

		if (arg.startsWith("http://") || arg.startsWith("https://")) {
			urls.push(arg);
		}
	}

	// Detect pipe-to-shell: curl ... | sh / bash
	const pipeIdx = command.indexOf("|");
	if (pipeIdx >= 0) {
		const afterPipe = command.slice(pipeIdx + 1).trim();
		if (/^(sh|bash|zsh|ksh)\b/.test(afterPipe)) hasPipeToShell = true;
	}

	return {
		raw: command,
		hasNetworkActivity: true,
		kind: "download",
		tool,
		packages: [],
		urls,
		hasLifecycleScripts: false,
		isGlobalInstall: false,
		isCustomRegistry: false,
		isFileBasedInstall: false,
	};
}
