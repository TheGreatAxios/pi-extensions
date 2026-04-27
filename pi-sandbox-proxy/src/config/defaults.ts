import type { ProxyConfig } from "./types";

export const DEFAULT_CONFIG: ProxyConfig = {
	enabled: true,
	maxApprovalDays: 30,
	strictMode: false,
	deepScan: false,
	autoApprove: false,
	defaultDomains: [
		"registry.npmjs.org",
		"registry.yarnpkg.com",
		"pypi.org",
		"files.pythonhosted.org",
		"github.com",
		"codeload.github.com",
		"api.github.com",
		"api.osv.dev",
		"bun.sh",
	],
	blockedDomains: [],
	blockedPackages: [],
	alwaysBlock: {
		curlPipeSh: true,
		unpinnedVersions: true,
		lifecycleScripts: true,
		globalInstalls: true,
		httpUrls: true,
		envVarExfil: true,
		customRegistries: false,
		fileBasedInstalls: true,
	},
};
