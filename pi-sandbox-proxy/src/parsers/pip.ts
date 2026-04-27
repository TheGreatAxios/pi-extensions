import { parseShellArgs } from "../util/shell-quote";
import type { ParsedCommand, PackageSpecifier } from "./types";

function parsePipPackage(arg: string): PackageSpecifier {
	const raw = arg;

	let name = arg;
	let version: string | null = null;

	for (const op of [">=", "<=", "~=", "!=", "==", "> ", "< ", "~ ", "!="]) {
		const idx = name.indexOf(op);
		if (idx > 0) {
			version = name.slice(idx + op.length).trim();
			name = name.slice(0, idx).trim();
			break;
		}
	}

	// handle extras like package[extra]
	const bracketIdx = name.indexOf("[");
	if (bracketIdx > 0) name = name.slice(0, bracketIdx);

	return { name, version, scope: null, registry: null, raw };
}

export function parsePipCommand(command: string): ParsedCommand | null {
	const args = parseShellArgs(command);
	if (args.length === 0) return null;

	const tool = args[0].value;
	if (!["pip", "pip3", "python", "python3"].includes(tool)) return null;

	// python -m pip install ...
	const subcommandIdx = tool === "python" || tool === "python3" ? 3 : 1;
	const subcommand = args[subcommandIdx]?.value ?? "";

	if (subcommand !== "install") return null;

	const packages: PackageSpecifier[] = [];
	const urls: string[] = [];
	let hasLifecycleScripts = true; // pip can run build scripts
	let isGlobalInstall = false;
	let isCustomRegistry = false;
	let isFileBasedInstall = false;

	for (let i = subcommandIdx + 1; i < args.length; i++) {
		const arg = args[i].value;

		if (arg === "--user" || arg === "--global") {
			isGlobalInstall = true;
			continue;
		}
		if (arg === "--index-url" || arg === "--extra-index-url") {
			isCustomRegistry = true;
			i++;
			continue;
		}
		if (arg.startsWith("--index-url=") || arg.startsWith("--extra-index-url=")) {
			isCustomRegistry = true;
			continue;
		}
		if (arg === "-r" || arg === "--requirement") {
			isFileBasedInstall = true;
			i++;
			continue;
		}
		if (arg.startsWith("git+") || arg.startsWith("hg+")) {
			urls.push(arg);
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

		packages.push(parsePipPackage(arg));
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
