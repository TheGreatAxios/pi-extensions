import { parseShellArgs } from "../util/shell-quote";
import type { ParsedCommand, PackageSpecifier } from "./types";

const BUN_COMMANDS = new Set(["add", "install"]);

function parseBunPackage(arg: string): PackageSpecifier {
	const raw = arg;

	let scope: string | null = null;
	let namePart = arg;

	if (arg.startsWith("@")) {
		const slashIdx = arg.indexOf("/");
		if (slashIdx > 0) {
			scope = arg.slice(0, slashIdx);
			namePart = arg.slice(slashIdx + 1);
		} else {
			scope = arg;
			namePart = "";
		}
	}

	let name = namePart;
	let version: string | null = null;

	const atIdx = namePart.lastIndexOf("@");
	if (atIdx > 0) {
		const potentialVersion = namePart.slice(atIdx + 1);
		if (/^[\d^~><=!.*+-]/.test(potentialVersion)) {
			version = potentialVersion;
			name = namePart.slice(0, atIdx);
		}
	}

	return { name, version, scope, registry: null, raw };
}

export function parseBunCommand(command: string): ParsedCommand | null {
	const args = parseShellArgs(command);
	if (args.length === 0) return null;

	const tool = args[0].value;
	if (tool !== "bun" && tool !== "bunx") return null;

	const subcommand = args[1]?.value ?? "";
	if (!BUN_COMMANDS.has(subcommand)) return null;

	const packages: PackageSpecifier[] = [];
	const urls: string[] = [];
	let hasLifecycleScripts = false; // bun doesn't run lifecycle scripts by default
	let isGlobalInstall = false;
	let isCustomRegistry = false;
	let isFileBasedInstall = false;

	for (let i = 2; i < args.length; i++) {
		const arg = args[i].value;

		if (arg === "-g" || arg === "--global") {
			isGlobalInstall = true;
			continue;
		}
		if (arg.startsWith("--registry")) {
			isCustomRegistry = true;
			continue;
		}
		if (arg.startsWith("http://") || arg.startsWith("https://")) {
			urls.push(arg);
			continue;
		}
		if (arg.startsWith("./") || arg.startsWith("/")) {
			isFileBasedInstall = true;
			continue;
		}
		if (arg.startsWith("-") && !arg.startsWith("@")) continue;

		packages.push(parseBunPackage(arg));
	}

	return {
		raw: command,
		hasNetworkActivity: true,
		kind: "package-install",
		tool,
		packages,
		urls,
		hasLifecycleScripts,
		isGlobalInstall,
		isCustomRegistry,
		isFileBasedInstall,
	};
}
