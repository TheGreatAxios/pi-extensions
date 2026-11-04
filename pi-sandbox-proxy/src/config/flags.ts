import type { ProxyConfig } from "./types";

export interface ProxyFlagOverrides {
	strict?: boolean;
	deepScan?: boolean;
	autoApprove?: boolean;
	maxApprovalDays?: number;
}

export function applyFlagOverrides(config: ProxyConfig, flags: ProxyFlagOverrides): ProxyConfig {
	const next = { ...config, alwaysBlock: { ...config.alwaysBlock } };
	if (flags.strict === true) {
		next.strictMode = true;
		next.defaultDomains = [];
	}
	if (flags.deepScan === true) next.deepScan = true;
	if (flags.autoApprove === true) next.autoApprove = true;
	if (typeof flags.maxApprovalDays === "number" && Number.isFinite(flags.maxApprovalDays)) {
		next.maxApprovalDays = Math.min(Math.max(1, Math.floor(flags.maxApprovalDays)), 30);
	}
	return next;
}
