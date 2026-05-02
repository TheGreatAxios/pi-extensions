/**
 * pi-sandbox-proxy
 * ----------------
 * Security proxy extension for pi coding-agent.
 *
 * Intercepts every bash command before execution, identifies network operations
 * (package installs, curl/wget, git clone), runs them through a security pipeline:
 *   1. Shell metacharacter / encoding detection → BLOCK
 *   2. Dangerous patterns (curl|sh, env exfil) → BLOCK
 *   3. Version pin enforcement → BLOCK (unpinned) / MUTATE (ranges)
 *   4. Lifecycle script blocking → MUTATE (--ignore-scripts)
 *   5. Typosquatting detection → WARN in approval UI
 *   6. Approval cache lookup → PASS if not expired
 *   7. Vulnerability scan (OSV.dev API) → show in UI, block CVSS≥9
 *   8. Interactive approval (7-day / 30-day options)
 *   9. Proxy whitelist update
 *
 * Post-execution: scans tool results for prompt injection attempts.
 *
 * Works standalone (host-level auditing) or alongside pi-sandbox (container-aware).
 */

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type {
	ExtensionAPI,
	BashToolCallEvent,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./src/config/loader";
import { parseCommand } from "./src/parsers/index";
import { ApprovalStore } from "./src/approval/store";
import { SecurityPipeline, type PipelineResult } from "./src/security/pipeline";
import { detectPromptInjection } from "./src/detection/prompt-injection";
import { AuditLog } from "./src/util/log";
import { DomainWhitelist } from "./src/proxy/whitelist";

/** Promise race with a timeout — rejects if the promise takes longer than ms */
function timeoutPromise<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message ?? "Timed out")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SECURITY_APPENDIX = `

## Security Proxy Active

All network operations are monitored by pi-sandbox-proxy:
- Package installations require exact version pins (e.g., npm install pkg@1.2.3)
- Lifecycle scripts (postinstall, preinstall) are automatically blocked
- All network requests require user approval
- Never pipe network content to shell execution (curl | bash is blocked)
- Vulnerability scanning is performed on all installed packages
- Typosquatting detection is active

When you need to install packages:
1. Always specify exact versions: npm install package@x.y.z
2. Prefer npm ci over npm install for deterministic builds
3. Report any installation failures clearly so the user can diagnose
`;

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd());
	const agentDir = getAgentDir();
	const store = new ApprovalStore(agentDir);
	const auditLog = new AuditLog(agentDir);
	const pipeline = new SecurityPipeline(config, store, auditLog);
	const domainWhitelist = new DomainWhitelist(config.defaultDomains);

	// Seed whitelist from any existing wildcard approvals
	for (const domain of store.listWildcardDomains()) {
		domainWhitelist.add(domain);
	}

	let pendingApprovals = 0;
	const MAX_PENDING_APPROVALS = 20;
	const APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes max per approval dialog

	// --- Flags ---

	pi.registerFlag("proxy", {
		description: "Enable security proxy for network operations (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-proxy", {
		description: "Disable the security proxy entirely",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("proxy-strict", {
		description: "Block all network unless explicitly approved (no default domains)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("proxy-approve-max-days", {
		description: "Maximum approval duration in days (default: 30)",
		type: "string",
		default: "30",
	});
	pi.registerFlag("proxy-deep-scan", {
		description: "Enable deep vulnerability scanning of transitive dependencies",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("proxy-auto-approve", {
		description: "Auto-approve packages with zero known vulnerabilities (for CI/non-interactive)",
		type: "boolean",
		default: false,
	});

	// --- Primary gate: intercept every bash tool_call ---

	pi.on("tool_call", async (event, ctx) => {
		if (!pi.getFlag("proxy") || pi.getFlag("no-proxy")) return;
		if (event.toolName !== "bash") return;

		const cmdEvent = event as BashToolCallEvent;
		const command = cmdEvent.input.command;
		const parsed = parseCommand(command);

		if (!parsed.hasNetworkActivity) return;

		// If the sandbox extension is active but networking is disabled,
		// no amount of proxy approval will help — the container literally
		// has no network stack (--network none / --no-dns). Short-circuit
		// with a clear message instead of running the approval gauntlet.
		//
		// We detect "sandbox is loaded" by checking whether any of its flags
		// are registered (they'll be undefined if the sandbox extension isn't
		// loaded at all).
		const containerOn = pi.getFlag("container") as boolean | undefined;
		const noContainer = pi.getFlag("no-container") as boolean | undefined;
		const noc = pi.getFlag("noc") as boolean | undefined;
		const containerNet = pi.getFlag("container-net") as boolean | undefined;
		const sandboxLoaded =
			containerOn !== undefined ||
			noContainer !== undefined ||
			noc !== undefined ||
			containerNet !== undefined;
		const inSandboxWithoutNet =
			sandboxLoaded &&
			containerOn !== false &&
			!(noContainer || noc) &&
			!containerNet;
		if (inSandboxWithoutNet) {
			const reason =
				"Sandbox is running without network access (container has --network none). " +
				"Restart pi with --container-net to enable outbound connectivity, " +
				"then the security proxy will prompt you to approve each domain.";
			auditLog.log({ action: "blocked", subject: parsed.raw, reason: "sandbox-no-network" });
			return { block: true, reason };
		}

		if (pendingApprovals >= MAX_PENDING_APPROVALS) {
			return {
				block: true,
				reason: `Security proxy: too many pending approvals (${MAX_PENDING_APPROVALS}). Address existing approvals before continuing.`,
			};
		}

		pendingApprovals++;
		let result: PipelineResult;
		try {
			result = await timeoutPromise(
				pipeline.check(parsed, ctx.ui),
				APPROVAL_TIMEOUT_MS,
				"Approval dialog timed out (2 min)",
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			auditLog.log({ action: "blocked", subject: parsed.raw, reason });
			return { block: true, reason: reason || "Security approval cancelled" };
		} finally {
			pendingApprovals--;
		}

		if (result.blocked) {
			auditLog.log({ action: "blocked", subject: parsed.raw, reason: result.reason });
			return { block: true, reason: result.reason };
		}

		if (result.mutatedCommand) {
			cmdEvent.input.command = result.mutatedCommand;
			auditLog.log({
				action: "mutated",
				subject: parsed.raw,
				mutatedTo: result.mutatedCommand,
				reason: result.reason ?? "lifecycle scripts blocked",
			});
		}

		if (result.approved) {
			// If domain wildcard was approved, add to proxy whitelist
			if (result.approvedDomains) {
				for (const domain of result.approvedDomains) {
					domainWhitelist.add(domain);
				}
			}

			auditLog.log({
				action: "approved",
				subject: parsed.kind === "package-install"
					? parsed.packages.map((p: { name: string; version: string | null }) => `${p.name}@${p.version}`).join(", ")
					: parsed.urls.join(", "),
				source: result.approvalSource,
				scope: result.scope,
			});
		}
	});

	// --- Post-execution audit: prompt injection detection ---

	pi.on("tool_result", async (event) => {
		if (!pi.getFlag("proxy") || pi.getFlag("no-proxy")) return;
		if (event.toolName !== "bash") return;

		const resultEvent = event as ToolResultEvent;
		if (!isBashToolResult(resultEvent)) return;

		const output = resultEvent.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join("\n");

		if (!output) return;

		const injections = detectPromptInjection(output);
		if (injections.length > 0) {
			auditLog.log({
				action: "prompt-injection-detected",
				subject: "tool_result",
				matches: injections.map((i: { pattern: string }) => i.pattern),
			});
		}
	});

	// --- System prompt augmentation ---

	pi.on("before_agent_start", async (event) => {
		if (!pi.getFlag("proxy") || pi.getFlag("no-proxy")) return event;
		return { systemPrompt: event.systemPrompt + SECURITY_APPENDIX };
	});

	// --- Slash commands ---

		pi.registerCommand("proxy", {
		description: "Show security proxy status (approvals, blocked count, config)",
		handler: async (_args, ctx) => {
			const approvals = store.list();
			const active = approvals.filter((a: { expiresAt: number }) => a.expiresAt > Date.now());
			const wildcards = store.listWildcardDomains();
			ctx.ui.notify(
				[
					"Proxy Status:",
					`  Mode: ${config.strictMode ? "strict" : "standard"}`,
					`  Active approvals: ${active.length}`,
					`  Max duration: ${config.maxApprovalDays} days`,
					`  Deep scan: ${config.deepScan ? "on" : "off"}`,
					wildcards.length > 0
						? `\n  Wildcard domains:\n${wildcards.map((d: string) => `    - ${d}/*`).join("\n")}`
						: "",
					active.length > 0
						? `\n  Approved:\n${active.map((a: { subject: string; specifier: string; scope: string; expiresAt: number }) => {
							const scopeTag = a.scope === "domain" ? " [domain]" : "";
							return `    - ${a.subject}${a.specifier !== a.subject ? ":" + a.specifier : ""}${scopeTag} (expires ${new Date(a.expiresAt).toISOString()})`;
						}).join("\n")}`
						: "",
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("proxy-approve", {
		description: "Pre-approve a package or domain for N days (usage: /proxy-approve <pkg@ver|domain> [days] [--wildcard])",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subject = parts[0];
			if (!subject) {
				ctx.ui.notify("Usage: /proxy-approve <package@version|domain> [days] [--wildcard]", "warning");
				return;
			}
			const isWildcard = parts.includes("--wildcard") || parts.includes("-w");
			const dayArg = parts.find((p: string) => /^\d+$/.test(p));
			const days = Math.min(
				parseInt(dayArg || String(config.maxApprovalDays), 10),
				config.maxApprovalDays,
			);

			if (isWildcard) {
				// Extract domain from URL if needed
				let domain = subject;
				try {
					const url = new URL(subject.startsWith("http") ? subject : `https://${subject}`);
					domain = url.hostname;
				} catch {
					// assume it's already a bare domain
				}
				store.add(domain, "*", days, "manual wildcard pre-approval", "domain");
				domainWhitelist.add(domain);
				ctx.ui.notify(`Approved domain wildcard "${domain}/*" for ${days} days`, "info");
			} else {
				store.add(subject, subject, days, "manual pre-approval", "exact");
				ctx.ui.notify(`Approved "${subject}" for ${days} days`, "info");
			}
		},
	});

	pi.registerCommand("proxy-revoke", {
		description: "Revoke a previously granted approval (usage: /proxy-revoke <subject>)",
		handler: async (args, ctx) => {
			const subject = args.trim();
			if (!subject) {
				ctx.ui.notify("Usage: /proxy-revoke <subject>", "warning");
				return;
			}
			store.revoke(subject);
			ctx.ui.notify(`Revoked approval for "${subject}"`, "info");
		},
	});

	pi.registerCommand("proxy-flush", {
		description: "Reset the pending approval counter (use if approvals appear stuck)",
		handler: async (_args, ctx) => {
			const before = pendingApprovals;
			pendingApprovals = 0;
			ctx.ui.notify(`Reset pending approval counter from ${before} to 0`, "info");
		},
	});

	pi.registerCommand("proxy-audit", {
		description: "Show recent security events from the audit log",
		handler: async (_args, ctx) => {
			const entries = auditLog.recent(20);
			if (entries.length === 0) {
				ctx.ui.notify("No audit entries yet.", "info");
				return;
			}
			ctx.ui.notify(
				entries.map((e: { ts: string; action: string; subject: string; reason?: string }) =>
					`[${e.ts}] ${e.action}: ${e.subject}${e.reason ? ` (${e.reason})` : ""}`
				).join("\n"),
				"info",
			);
		},
	});
}
