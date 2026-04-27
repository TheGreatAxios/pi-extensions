import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { ParsedCommand } from "../parsers/types";
import type { ApprovalStore } from "./store";
import type { ProxyConfig } from "../config/types";

export interface ApprovalResult {
	blocked?: boolean;
	approved?: boolean;
	mutatedCommand?: string;
	reason?: string;
	approvalSource?: "cache" | "user-7d" | "user-30d" | "user-once" | "auto";
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

	const choice = await ctx.select(
		"Security Approval Required",
		[
			`Approve for 30 days`,
			`Approve for 7 days`,
			`Use once`,
			`Deny`,
		],
	);

	if (!choice || choice.includes("Deny")) {
		return { blocked: true, reason: "User denied approval" };
	}

	if (choice.includes("once")) {
		return {
			approved: true,
			approvalSource: "user-once",
		};
	}

	const days = choice.includes("30") ? 30 : 7;
	store.add(cacheKey, cacheKey, days, `User approved via UI`);

	return {
		approved: true,
		approvalSource: choice.includes("30") ? "user-30d" : "user-7d",
	};
}
