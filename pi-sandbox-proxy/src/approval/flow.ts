import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { ParsedCommand } from "../parsers/types";
import type { ApprovalStore, ApprovalScope } from "./store";
import type { ProxyConfig } from "../config/types";

export interface ApprovalResult {
	blocked?: boolean;
	approved?: boolean;
	mutatedCommand?: string;
	reason?: string;
	approvalSource?: "cache" | "user-7d" | "user-30d" | "user-once" | "auto";
	approvedDomains?: string[];
	scope?: ApprovalScope;
}

export async function requestApproval(
	parsed: ParsedCommand,
	store: ApprovalStore,
	config: ProxyConfig,
	ctx: ExtensionUIContext,
	vulnInfo?: string,
	typosquatWarning?: string,
): Promise<ApprovalResult> {
	// Check cache first
	const cacheKey = parsed.kind === "package-install"
		? parsed.packages.map((p) => `${p.name}@${p.version}`).join(",")
		: parsed.urls.join(",");

	const cached = store.find(cacheKey);
	if (cached) {
		return { approved: true, approvalSource: "cache" };
	}

	// Determine if we have URL-based requests (eligible for domain wildcards)
	const isUrlBased = parsed.kind !== "package-install" && parsed.urls.length > 0;
	const domains = isUrlBased
		? [...new Set(parsed.urls.map((u) => {
			try { return new URL(u).hostname; } catch { return null; }
		}).filter(Boolean) as string[])]
		: [];

	// Build approval message
	const lines: string[] = [];

	if (parsed.kind === "package-install") {
		lines.push(`Package Install Request:`);
		lines.push("");
		for (const pkg of parsed.packages) {
			lines.push(`  Package: ${pkg.name}@${pkg.version ?? "?"}`);
			if (pkg.scope) lines.push(`  Scope: ${pkg.scope}`);
		}
	} else if (parsed.urls.length > 0) {
		lines.push(`Network Request:`);
		lines.push("");
		for (const url of parsed.urls) {
			lines.push(`  URL: ${url}`);
		}
		if (domains.length > 0) {
			lines.push(`  Domain: ${domains.join(", ")}`);
		}
	}

	if (typosquatWarning) {
		lines.push("");
		lines.push(`WARNING: ${typosquatWarning}`);
	}

	if (vulnInfo) {
		lines.push("");
		lines.push(vulnInfo);
	}

	if (parsed.hasLifecycleScripts) {
		lines.push("");
		lines.push("Lifecycle scripts will be BLOCKED (--ignore-scripts)");
	}

	lines.push("");

	// Build options based on whether this is URL-based (eligible for domain wildcard)
	const options: string[] = [];
	if (isUrlBased && domains.length > 0) {
		const domainLabel = domains.length === 1 ? domains[0] : `${domains.length} domains`;
		options.push(
			`Approve URL for 30 days`,
			`Approve URL for 7 days`,
			`Approve entire domain (${domainLabel}/*) for 30 days`,
			`Approve entire domain (${domainLabel}/*) for 7 days`,
		);
	} else {
		options.push(
			`Approve for 30 days`,
			`Approve for 7 days`,
		);
	}
	options.push(`Use once`);
	options.push(`Deny`);

	let choice: string | undefined;
	try {
		choice = await ctx.select(
			"Security Approval Required",
			options,
		);
	} catch {
		return { blocked: true, reason: "Security approval cancelled" };
	}

	if (!choice || choice.includes("Deny")) {
		return { blocked: true, reason: "User denied approval" };
	}

	if (choice.includes("once")) {
		return {
			approved: true,
			approvalSource: "user-once",
		};
	}

	const isDomainWildcard = choice.includes("entire domain");
	const days = choice.includes("30") ? 30 : 7;

	if (isDomainWildcard) {
		// Approve each domain as a wildcard
		for (const domain of domains) {
			store.add(domain, "*", days, `User approved domain wildcard via UI`, "domain");
		}
		return {
			approved: true,
			approvalSource: choice.includes("30") ? "user-30d" : "user-7d",
			approvedDomains: domains,
			scope: "domain",
		};
	} else {
		store.add(cacheKey, cacheKey, days, `User approved via UI`, "exact");
		return {
			approved: true,
			approvalSource: choice.includes("30") ? "user-30d" : "user-7d",
			scope: "exact",
		};
	}
}
