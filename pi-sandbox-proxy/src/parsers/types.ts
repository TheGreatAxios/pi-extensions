export interface PackageSpecifier {
	name: string;
	version: string | null;
	scope: string | null;
	registry: string | null;
	raw: string;
}

export type CommandKind =
	| "package-install"
	| "download"
	| "git-clone"
	| "network-request"
	| "unknown";

export interface ParsedCommand {
	raw: string;
	hasNetworkActivity: boolean;
	kind: CommandKind;
	tool: string;
	packages: PackageSpecifier[];
	urls: string[];
	hasLifecycleScripts: boolean;
	isGlobalInstall: boolean;
	isCustomRegistry: boolean;
	isFileBasedInstall: boolean;
}
