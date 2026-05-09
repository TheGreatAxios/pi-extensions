import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./defaults";
import type { ProxyConfig } from "./types";

function deepMerge(base: ProxyConfig, override: Partial<ProxyConfig>): ProxyConfig {
	return {
		...base,
		...override,
		alwaysBlock: { ...base.alwaysBlock, ...override.alwaysBlock },
		defaultDomains: override.defaultDomains ?? base.defaultDomains,
		blockedDomains: override.blockedDomains ?? base.blockedDomains,
		blockedPackages: override.blockedPackages ?? base.blockedPackages,
	};
}

export function loadConfig(cwd: string): ProxyConfig {
	let config = { ...DEFAULT_CONFIG };

	const globalPath = join(getAgentDir(), "proxy.json");
	const projectPath = join(cwd, ".pi", "proxy.json");

	for (const path of [globalPath, projectPath]) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8"));
			config = deepMerge(config, raw);
		} catch {
			// malformed config file — skip silently
		}
	}

	if (process.env.PROXY_MAX_DAYS) {
		config.maxApprovalDays = Math.min(
			parseInt(process.env.PROXY_MAX_DAYS, 10),
			30,
		);
	}

	return config;
}
