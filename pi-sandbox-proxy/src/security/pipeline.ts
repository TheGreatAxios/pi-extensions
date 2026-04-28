import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { ParsedCommand } from "../parsers/types";
import { checkPackageNames, enforcePinnedVersions } from "./version-enforcer";
import { blockLifecycleScripts } from "./lifecycle-blocker";
import { VulnerabilityScanner } from "./scanner";
import { checkTyposquatting } from "./typosquat";
import { checkDangerousPatterns } from "../detection/patterns";
import { detectEncoding } from "../detection/encoding";
import { requestApproval } from "../approval/flow";
import type { ApprovalStore } from "../approval/store";
import type { ProxyConfig } from "../config/types";
import type { AuditLog } from "../util/log";

import type { ApprovalScope } from "../approval/store";

export interface PipelineResult {
	blocked: boolean;
	reason?: string;
	mutatedCommand?: string;
	approved?: boolean;
	approvalSource?: string;
	approvedDomains?: string[];
	scope?: ApprovalScope;
}

export class SecurityPipeline {
	private config: ProxyConfig;
	private store: ApprovalStore;
	private auditLog: AuditLog;
	private scanner: VulnerabilityScanner;

	constructor(config: ProxyConfig, store: ApprovalStore, auditLog: AuditLog) {
		this.config = config;
		this.store = store;
		this.auditLog = auditLog;
		this.scanner = new VulnerabilityScanner();
	}

	async check(parsed: ParsedCommand, ctx: ExtensionUIContext): Promise<PipelineResult> {
		// 1. Shell metacharacters in package names
		const nameCheck = checkPackageNames(parsed);
		if (nameCheck.blocked) return nameCheck;

		// 2. Encoding/obfuscation detection
		const encodingCheck = detectEncoding(parsed.raw);
		if (encodingCheck.blocked) return encodingCheck;

		// 3. Dangerous patterns (curl|sh, env exfil, global installs, etc.)
		const patternCheck = checkDangerousPatterns(parsed);
		if (patternCheck.blocked) return patternCheck;

		// 4-5. Version pin enforcement
		const versionCheck = enforcePinnedVersions(parsed);
		if (versionCheck.blocked) return versionCheck;

		// 6. Typosquatting detection
		let typosquatWarning: string | undefined;
		for (const pkg of parsed.packages) {
			const ecosystem = parsed.tool === "pip" ? "pypi" : "npm";
			const warning = checkTyposquatting(pkg.name, ecosystem);
			if (warning) {
				typosquatWarning = warning;
				break;
			}
		}

		// 7. Lifecycle script blocking
		const lifecycleResult = blockLifecycleScripts(parsed);
		let mutatedCommand = lifecycleResult.mutatedCommand;

		// 8. Check approval cache
		const cacheKey = parsed.kind === "package-install"
			? parsed.packages.map((p: { name: string; version: string | null }) => `${p.name}@${p.version}`).join(",")
			: parsed.urls.join(",");

		const cached = this.store.find(cacheKey);
		if (cached) {
			return {
				blocked: false,
				mutatedCommand,
				approved: true,
				approvalSource: "cache",
			};
		}

		// 9. Vulnerability scan (for package installs)
		let vulnInfo: string | undefined;
		if (parsed.kind === "package-install" && parsed.packages.length > 0) {
			const pkg = parsed.packages[0];
			if (pkg.version) {
				const ecosystem = parsed.tool === "pip" ? "PyPI" : "npm";
				const scanResult = await this.scanner.scan(pkg.name, pkg.version, ecosystem);
				vulnInfo = this.scanner.formatScanResult(scanResult);

				const maxCvss = this.scanner.getMaxCvss(scanResult);
				if (maxCvss >= 9 && !this.config.autoApprove) {
					return {
						blocked: true,
						reason: `CRITICAL vulnerability detected (CVSS ${maxCvss}) in ${pkg.name}@${pkg.version}. Must acknowledge risk to proceed.`,
					};
				}
			}
		}

		// 10. Interactive approval
		const approvalResult = await requestApproval(
			parsed,
			this.store,
			this.config,
			ctx,
			vulnInfo,
			typosquatWarning,
		);

		if (approvalResult.blocked) return { blocked: true, reason: approvalResult.reason };

		return {
			blocked: false,
			mutatedCommand: mutatedCommand ?? approvalResult.mutatedCommand,
			approved: true,
			approvalSource: approvalResult.approvalSource,
			approvedDomains: approvalResult.approvedDomains,
			scope: approvalResult.scope,
		};
	}

	async auditResult(event: { content: Array<{ type: string; text?: string }>; toolName: string }): Promise<void> {
		const output = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join("\n");

		if (!output) return;

		const { detectPromptInjection } = await import("../detection/prompt-injection");
		const injections = detectPromptInjection(output);

		if (injections.length > 0) {
			this.auditLog.log({
				action: "prompt-injection-detected",
				subject: event.toolName,
				matches: injections.map((m: { pattern: string }) => m.pattern),
			});
		}
	}
}
