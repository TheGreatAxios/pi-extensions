import { parseShellArgs, splitCommands } from "../util/shell-quote";
import type { ParsedCommand, PackageSpecifier } from "./types";

const NPM_COMMANDS = new Set(["install", "i", "ci", "add"]);
const LIFECYCLE_SCRIPTS = new Set(["run", "preinstall", "postinstall", "prepublish", "prepack", "postpack"]);

function parseNpmPackage(arg: string): PackageSpecifier {
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
		if (/^[\d^~><=!.*+-]/.test(potentialVersion) || potentialVersion.includes("next") || potentialVersion.includes("canary")) {
			version = potentialVersion;
			name = namePart.slice(0, atIdx);
		}
	}

	return { name, version, scope, registry: null, raw };
}

export function parseNpmCommand(command: string): ParsedCommand | null {
	const args = parseShellArgs(command);
	if (args.length === 0) return null;

	const tool = args[0].value;
	if (!["npm", "npx"].includes(tool)) return null;

	const subcommand = args[1]?.value ?? "";

	if (LIFECYCLE_SCRIPTS.has(subcommand)) {
		return {
			raw: command,
			hasNetworkActivity: false,
			kind: "unknown",
			tool,
			packages: [],
			urls: [],
			hasLifecycleScripts: true,
			isGlobalInstall: false,
			isCustomRegistry: false,
			isFileBasedInstall: false,
		};
	}

	if (!NPM_COMMANDS.has(subcommand)) return null;

	const packages: PackageSpecifier[] = [];
	const urls: string[] = [];
	let hasLifecycleScripts = true; // npm runs scripts by default
	let isGlobalInstall = false;
	let isCustomRegistry = false;
	let isFileBasedInstall = false;

	for (let i = 2; i < args.length; i++) {
		const arg = args[i].value;

		if (arg === "-g" || arg === "--global") {
			isGlobalInstall = true;
			continue;
		}
		if (arg === "--ignore-scripts") {
			hasLifecycleScripts = false;
			continue;
		}
		if (arg === "--registry") {
			isCustomRegistry = true;
			i++; // skip next arg (registry URL)
			continue;
		}
		if (arg.startsWith("--registry=")) {
			isCustomRegistry = true;
			continue;
		}
		if (arg.startsWith("http://") || arg.startsWith("https://")) {
			urls.push(arg);
			continue;
		}
		if (arg.startsWith("./") || arg.startsWith("/") || arg.endsWith(".tgz") || arg.endsWith(".tar.gz")) {
			isFileBasedInstall = true;
			continue;
		}
		if (arg.startsWith("-") && !arg.startsWith("@")) continue; // skip flags

		// package specifier
		packages.push(parseNpmPackage(arg));
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
