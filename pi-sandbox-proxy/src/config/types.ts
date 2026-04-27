export interface ProxyConfig {
	enabled: boolean;
	maxApprovalDays: number;
	strictMode: boolean;
	deepScan: boolean;
	autoApprove: boolean;
	defaultDomains: string[];
	blockedDomains: string[];
	blockedPackages: string[];
	alwaysBlock: AlwaysBlockRules;
}

export interface AlwaysBlockRules {
	curlPipeSh: boolean;
	unpinnedVersions: boolean;
	lifecycleScripts: boolean;
	globalInstalls: boolean;
	httpUrls: boolean;
	envVarExfil: boolean;
	customRegistries: boolean;
	fileBasedInstalls: boolean;
}
