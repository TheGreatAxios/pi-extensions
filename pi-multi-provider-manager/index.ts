/**
 * pi-accounts: Multi-account providers for pi.
 *
 * Extends /login with account switching for Codex, Fireworks, and Z.ai.
 * Instead of registering N providers (laggy), this registers 3 providers
 * (one per service) with internal account selection during OAuth.
 *
 * Usage:
 *   /accounts add codex <label>
 *   /accounts add fireworks <label> [API_KEY_ENV]
 *   /accounts add z.ai <label> [API_KEY_ENV]
 *   /login  → pick "Codex: <label>", "Fireworks: <label>", or "Z.ai: <label>"
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai";

// Get Codex models from the built-in provider
const CODEX_MODELS = getModels("openai-codex");

// ---------------------------------------------------------------------------
// Config: ~/.pi/agent/accounts.json
// ---------------------------------------------------------------------------

const STORAGE_PATH = `${process.env.HOME ?? ""}/.pi/agent/accounts.json`;

type AccountKind = "codex" | "chatgpt" | "fireworks" | "zai";

interface StoredAccount {
	kind?: AccountKind; // undefined = legacy ChatGPT account
	label: string;
	apiKeyEnv?: string;
}

interface AccountCredentials extends OAuthCredentials {
	accountLabel: string;
	kind: AccountKind;
}

function accountKind(account: StoredAccount): AccountKind {
	// Legacy: undefined or "chatgpt" both mean Codex
	if (!account.kind || account.kind === "chatgpt") return "codex";
	return account.kind;
}

function loadAccounts(): StoredAccount[] {
	try {
		const { readFileSync } = require("node:fs");
		const parsed = JSON.parse(readFileSync(STORAGE_PATH, "utf-8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveAccounts(accounts: StoredAccount[]): void {
	const { writeFileSync, mkdirSync } = require("node:fs");
	mkdirSync(STORAGE_PATH.substring(0, STORAGE_PATH.lastIndexOf("/")), { recursive: true });
	writeFileSync(STORAGE_PATH, JSON.stringify(accounts, null, 2));
}

function getAccountsByKind(kind: AccountKind): StoredAccount[] {
	return loadAccounts().filter((a) => accountKind(a) === kind);
}

// Models from SDK (dynamically loaded to stay in sync)
// ---------------------------------------------------------------------------

const FIREWORKS_MODELS = getModels("fireworks");
const ZAI_MODELS = getModels("zai");

// ---------------------------------------------------------------------------
// Multi-Account OAuth Flows
// ---------------------------------------------------------------------------

async function chatgptMultiLogin(callbacks: OAuthLoginCallbacks): Promise<AccountCredentials> {
	const accounts = getAccountsByKind("codex");

	// If no accounts configured, use default Codex login
	if (accounts.length === 0) {
		return await withLoginTimeout("default", callbacks);
	}

	// Pick account first
	let label: string | undefined;
	if (accounts.length === 1) {
		label = accounts[0]!.label;
	} else {
		label = await callbacks.onPrompt({
			message: "Select Codex account:",
			options: accounts.map((a) => a.label),
		} as any);
	}

	if (!label) throw new Error("No account selected");

	const account = accounts.find((a) => a.label === label);
	if (!account) throw new Error(`Account "${label}" not found`);

	// Perform OAuth with timeout and signal handling
	return await withLoginTimeout(label, callbacks);
}

// Helper to wrap login with timeout and signal handling
async function withLoginTimeout(
	label: string,
	callbacks: OAuthLoginCallbacks,
): Promise<AccountCredentials> {
	const { loginOpenAICodex } = require("@earendil-works/pi-ai/oauth");
	
	const abortController = new AbortController();
	const timeoutMs = 30 * 1000; // 30 second timeout
	const timeoutId = setTimeout(() => {
		abortController.abort();
		console.log("\n\n⏱️  Login timed out after 30 seconds. Run /login again to retry.");
	}, timeoutMs);
	
	// Handle SIGINT during login - allow immediate exit
	const sigintHandler = () => {
		abortController.abort();
		console.log("\n\n⚠️  Login cancelled. Press Ctrl+C again to exit pi, or run /login to retry.");
		clearTimeout(timeoutId);
		process.removeListener("SIGINT", sigintHandler);
		// Re-raise for second Ctrl+C to exit
		process.once("SIGINT", () => process.exit(0));
	};
	process.on("SIGINT", sigintHandler);
	
	try {
		const creds = await loginOpenAICodex({ ...callbacks, signal: abortController.signal });
		return { ...creds, accountLabel: label, kind: "codex" };
	} finally {
		clearTimeout(timeoutId);
		process.removeListener("SIGINT", sigintHandler);
	}
}

async function chatgptRefreshToken(credentials: AccountCredentials): Promise<AccountCredentials> {
	const { refreshOpenAICodexToken } = require("@earendil-works/pi-ai/oauth");
	const creds = await refreshOpenAICodexToken(credentials.refresh);
	return { ...creds, accountLabel: credentials.accountLabel, kind: "codex" };
}

async function apiKeyMultiLogin(
	kind: AccountKind,
	callbacks: OAuthLoginCallbacks,
): Promise<AccountCredentials> {
	const accounts = getAccountsByKind(kind);

	let label: string | undefined;
	if (accounts.length === 0) {
		// No accounts - prompt for label and key
		label = await callbacks.onPrompt({ message: "Account label:" });
		if (!label) throw new Error("Label required");
	} else if (accounts.length === 1) {
		label = accounts[0]!.label;
	} else {
		label = await callbacks.onPrompt({
			message: `Select ${displayKind(kind)} account:`,
			options: accounts.map((a) => a.label),
		} as any);
	}

	if (!label) throw new Error("No account selected");

	const account = accounts.find((a) => a.label === label);
	const envVar = account?.apiKeyEnv;

	// Use env var if configured, otherwise prompt
	let access: string;
	if (envVar && process.env[envVar]) {
		access = process.env[envVar]!;
	} else {
		access = (await callbacks.onPrompt({ message: `Enter API key for ${displayKind(kind)}: ${label}` }))?.trim();
		if (!access) throw new Error("API key is required");
	}

	return {
		access,
		refresh: access,
		expires: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10,
		accountLabel: label,
		kind,
	};
}

async function apiKeyRefresh(credentials: AccountCredentials): Promise<AccountCredentials> {
	// API keys don't expire, but check if env var was updated
	const accounts = getAccountsByKind(credentials.kind);
	const account = accounts.find((a) => a.label === credentials.accountLabel);

	if (account?.apiKeyEnv && process.env[account.apiKeyEnv]) {
		const access = process.env[account.apiKeyEnv]!;
		return { ...credentials, access, refresh: access };
	}

	return credentials;
}

function displayKind(kind: AccountKind): string {
	if (kind === "zai") return "Z.ai";
	if (kind === "fireworks") return "Fireworks";
	return "Codex"; // codex or chatgpt
}

// ---------------------------------------------------------------------------
// Model labeling with account info
// ---------------------------------------------------------------------------

function withAccountLabel<T extends { name: string }>(label: string, models: T[]) {
	return models.map((model) => ({
		...model,
		name: `${label} · ${model.name}`,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function parseKind(raw: string | undefined): AccountKind | undefined {
	const value = raw?.toLowerCase();
	if (value === "chatgpt" || value === "codex" || value === "openai") return "codex";
	if (value === "fireworks" || value === "fw") return "fireworks";
	if (value === "z.ai" || value === "zai" || value === "z-ai" || value === "z") return "zai";
	return undefined;
}

function findAccount(accounts: StoredAccount[], kind: AccountKind | undefined, label: string): StoredAccount | undefined {
	return accounts.find((account) => account.label === label && (!kind || accountKind(account) === kind));
}

function usage(): string {
	return [
		"Usage:",
		"  /accounts add codex <label>",
		"  /accounts add fireworks <label> [API_KEY_ENV]",
		"  /accounts add z.ai <label> [API_KEY_ENV]",
		"  /accounts relogin <provider> <label>",
		"  /accounts remove [provider] <label>",
		"  /accounts list",
		"",
		"Legacy: /accounts add chatgpt <label> adds a Codex account.",
		"",
		"Then run /login and select your specific account name to authenticate.",
	].join("\n");
}

// Provider ID helpers
function getChatGptProviderId(label: string): string {
	return `codex-${label}`;
}

function getFireworksProviderId(label: string): string {
	return `fireworks-${label.replace(/@/g, "-at-")}`;
}

function getZaiProviderId(label: string): string {
	return `zai-${label.replace(/@/g, "-at-")}`;
}

function getProviderId(account: StoredAccount): string {
	const kind = accountKind(account);
	if (kind === "codex" || kind === "chatgpt") return getChatGptProviderId(account.label);
	if (kind === "fireworks") return getFireworksProviderId(account.label);
	return getZaiProviderId(account.label);
}

// Register a single Codex account provider
function registerCodexProvider(pi: ExtensionAPI, account: StoredAccount) {
	const providerId = getProviderId(account);
	const kind = accountKind(account);
	const models = CODEX_MODELS.map((m) => ({ ...m, name: `${account.label} · ${m.name}`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));

	pi.registerProvider(providerId, {
		baseUrl: "https://chatgpt.com/backend-api",
		api: "openai-codex-responses",
		models,
		oauth: {
			name: `${displayKind(kind)}: ${account.label}`, // Show type + account name on /login
			login: (callbacks: OAuthLoginCallbacks) => chatgptSingleAccountLogin(account.label, callbacks),
			refreshToken: chatgptRefreshToken,
			getApiKey: (cred: AccountCredentials) => cred.access,
		},
	});
}

// Single account login flows (skip the account selection prompt)
async function chatgptSingleAccountLogin(
	label: string,
	callbacks: OAuthLoginCallbacks,
): Promise<AccountCredentials> {
	return await withLoginTimeout(label, callbacks);
}

async function apiKeySingleAccountLogin(
	kind: AccountKind,
	account: StoredAccount,
	callbacks: OAuthLoginCallbacks,
): Promise<AccountCredentials> {
	const envVar = account.apiKeyEnv;

	// Use env var if configured, otherwise prompt
	let access: string;
	if (envVar && process.env[envVar]) {
		access = process.env[envVar]!;
	} else {
		access = (await callbacks.onPrompt({ message: `Enter API key for ${displayKind(kind)}: ${account.label}` }))?.trim();
		if (!access) throw new Error("API key is required");
	}

	return {
		access,
		refresh: access,
		expires: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10,
		accountLabel: account.label,
		kind,
	};
}

// Track registered providers for cleanup
let registeredProviderIds: string[] = [];

function unregisterAllAccountProviders(pi: ExtensionAPI) {
	for (const id of registeredProviderIds) {
		pi.unregisterProvider(id);
	}
	registeredProviderIds = [];
}

function refreshAccountProviders(pi: ExtensionAPI) {
	unregisterAllAccountProviders(pi);
	const accounts = loadAccounts();
	for (const account of accounts) {
		const providerId = getProviderId(account);
		const kind = accountKind(account);
		registeredProviderIds.push(providerId);
		// Register only this account's provider
		if (kind === "codex" || kind === "chatgpt") {
			registerCodexProvider(pi, account);
		} else if (kind === "fireworks") {
			// Always use this single model; hides all SDK default models
			const models = [{
				name: `${account.label} · accounts/fireworks/routers/kimi-k2p6-turbo`,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}];
			pi.registerProvider(providerId, {
				baseUrl: "https://api.fireworks.ai/inference/v1",
				api: "openai-completions",
				models,
				oauth: {
					name: `${displayKind(kind)}: ${account.label}`,
					login: (callbacks: OAuthLoginCallbacks) => apiKeySingleAccountLogin("fireworks", account, callbacks),
					refreshToken: apiKeyRefresh,
					getApiKey: (cred: AccountCredentials) => cred.access,
				},
			});
		} else if (kind === "zai") {
			pi.registerProvider(providerId, {
				baseUrl: "https://api.z.ai/api/paas/v4",
				api: "openai-completions",
				models: ZAI_MODELS.map((m) => ({ ...m, name: `${account.label} · ${m.name}`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
				oauth: {
					name: `${displayKind(kind)}: ${account.label}`,
					login: (callbacks: OAuthLoginCallbacks) => apiKeySingleAccountLogin("zai", account, callbacks),
					refreshToken: apiKeyRefresh,
					getApiKey: (cred: AccountCredentials) => cred.access,
				},
			});
		}
	}
}

export default function accountsExtension(pi: ExtensionAPI) {
	// Register account providers on startup
	refreshAccountProviders(pi);

	// Account management command - fully guided interactive flow
	pi.registerCommand("accounts", {
		description: "Manage ChatGPT, Fireworks, and Z.ai accounts",
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			// If no subcommand, show interactive main menu
			if (!sub) {
				const accounts = loadAccounts();
				const choices = [
					...(accounts.length ? ["📋 List accounts"] : []),
					"➕ Add account",
					...(accounts.length ? ["🗑️ Remove account"] : []),
					...(accounts.length ? ["🔁 Re-login to account"] : []),
					"❌ Cancel",
				];

				const choice = await ctx.ui.select("Account management", choices);
				if (!choice || choice === "❌ Cancel") {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}

					if (choice === "📋 List accounts") {
					ctx.ui.notify(accounts.map((account) => {
						const kind = accountKind(account);
						const suffix = account.apiKeyEnv ? ` ($${account.apiKeyEnv})` : "";
						return `${displayKind(kind)}: ${account.label}${suffix}`;
					}).join("\n"), "info");
					return;
				}

				if (choice === "➕ Add account") {
					return handleAddInteractive(ctx);
				}

				if (choice === "🗑️ Remove account") {
					return handleRemoveInteractive(ctx);
				}

				if (choice === "🔁 Re-login to account") {
					return handleReloginInteractive(ctx);
				}
				return;
			}

			// Legacy CLI-style commands still work
			if (sub === "add") return handleAdd(parts.slice(1), ctx);
			if (sub === "remove") return handleRemove(parts.slice(1), ctx);
			if (sub === "relogin") return handleRelogin(parts.slice(1), ctx);
			if (sub === "list") {
				const accounts = loadAccounts();
				if (!accounts.length) {
					ctx.ui.notify("No accounts configured.", "info");
					return;
				}
				ctx.ui.notify(accounts.map((account) => {
					const kind = accountKind(account);
					const suffix = account.apiKeyEnv ? ` ($${account.apiKeyEnv})` : "";
					return `${displayKind(kind)}: ${account.label}${suffix}`;
				}).join("\n"), "info");
				return;
			}
			if (sub === "help") {
				ctx.ui.notify(usage(), "info");
				return;
			}

			ctx.ui.notify(`Unknown command: ${sub}\n\n${usage()}`, "error");
		},
	});

	// Interactive handlers
	async function handleAddInteractive(ctx: ExtensionCommandContext): Promise<void> {
		const kindChoice = await ctx.ui.select("Select provider", [
			"Codex (OAuth login)",
			"Fireworks AI (API key)",
			"Z.ai (API key)",
			"❌ Cancel",
		]);

		if (!kindChoice || kindChoice === "❌ Cancel") {
			ctx.ui.notify("Cancelled.", "info");
			return;
		}

		let kind: AccountKind;
		if (kindChoice.startsWith("Codex")) kind = "codex";
		else if (kindChoice.startsWith("Fireworks")) kind = "fireworks";
		else kind = "zai";

		const kindPrompt = kind as AccountKind;
		const promptLabel = kindPrompt === "codex" || kindPrompt === "chatgpt" ? "Codex account label" : `${displayKind(kindPrompt)} account label`;
		const label = (await ctx.ui.input(promptLabel, ""))?.trim();
		if (!label) { ctx.ui.notify("Cancelled.", "warning"); return; }

		let apiKeyEnv: string | undefined;
		if (kindPrompt !== "codex" && kindPrompt !== "chatgpt") {
			const useEnv = await ctx.ui.select("API key source", [
				"Use environment variable",
				"I'll enter the key when logging in",
				"❌ Cancel",
			]);
			if (!useEnv || useEnv === "❌ Cancel") { ctx.ui.notify("Cancelled.", "warning"); return; }

			if (useEnv === "Use environment variable") {
				apiKeyEnv = (await ctx.ui.input("Environment variable name (e.g., FIREWORKS_API_KEY)", `${displayKind(kind).toUpperCase().replace(".", "")}_API_KEY`))?.trim();
				if (!apiKeyEnv) { ctx.ui.notify("Cancelled.", "warning"); return; }
			}
		}

		const accounts = loadAccounts();
		if (findAccount(accounts, kind, label)) {
			ctx.ui.notify(`${displayKind(kind)} "${label}" already exists.`, "warning");
			return;
		}

		const account: StoredAccount = { kind, label: label!, ...(apiKeyEnv ? { apiKeyEnv } : {}) };
		accounts.push(account);
		saveAccounts(accounts);
		refreshAccountProviders(pi);

		const kindForNotify = kind as AccountKind;
		if (kindForNotify === "codex" || kindForNotify === "chatgpt") {
			ctx.ui.notify(`✅ Added "${label}". Run /login and select "${label}" to authenticate.`, "info");
		} else if (apiKeyEnv) {
			ctx.ui.notify(`✅ Added ${displayKind(kindForNotify)} "${label}" using $${apiKeyEnv}. Export that variable, then run /login and select "${label}".`, "info");
		} else {
			ctx.ui.notify(`✅ Added ${displayKind(kindForNotify)} "${label}". Run /login and select "${label}" to enter its API key.`, "info");
		}
	}

	async function handleRemoveInteractive(ctx: ExtensionCommandContext): Promise<void> {
		const accounts = loadAccounts();
		if (!accounts.length) {
			ctx.ui.notify("No accounts to remove.", "info");
			return;
		}

		const choices = accounts.map((a) => `${displayKind(accountKind(a))}: ${a.label}`);
		const picked = await ctx.ui.select("Select account to remove", [...choices, "❌ Cancel"]);
		if (!picked || picked === "❌ Cancel") { ctx.ui.notify("Cancelled.", "info"); return; }

		const index = choices.indexOf(picked);
		if (index < 0) return;

		const account = accounts[index];
		const newAccounts = accounts.filter((_, i) => i !== index);
		saveAccounts(newAccounts);
		refreshAccountProviders(pi);
		ctx.ui.notify(`✅ Removed ${displayKind(accountKind(account))} "${account.label}".`, "info");
	}

	async function handleReloginInteractive(ctx: ExtensionCommandContext): Promise<void> {
		const accounts = loadAccounts().filter((a) => !a.apiKeyEnv); // Only OAuth accounts can relogin
		if (!accounts.length) {
			ctx.ui.notify("No OAuth accounts available for re-login. API key accounts use environment variables.", "info");
			return;
		}

		const choices = accounts.map((a) => `${displayKind(accountKind(a))}: ${a.label}`);
		const picked = await ctx.ui.select("Select account to re-login", [...choices, "❌ Cancel"]);
		if (!picked || picked === "❌ Cancel") { ctx.ui.notify("Cancelled.", "info"); return; }

		const index = choices.indexOf(picked);
		if (index < 0) return;

		const account = accounts[index];
		const kind = accountKind(account);

		const { AuthStorage } = require("@earendil-works/pi-coding-agent");
		const authStorage = AuthStorage.create();
		authStorage.remove(getProviderId(account));
		ctx.ui.notify(`✅ Cleared credentials for "${account.label}". Run /login and select "${account.label}" to re-authenticate.`, "info");
	}

	// Legacy CLI handlers
	async function handleAdd(parts: string[], ctx: ExtensionCommandContext): Promise<void> {
		let kind = parseKind(parts[0]);
		let label: string | undefined = kind ? parts[1] : parts[0];
		let apiKeyEnv = kind && kind !== "codex" && kind !== "chatgpt" ? parts[2] : undefined;

		if (!kind) kind = "codex";
		if (!label) {
			label = (await ctx.ui.input(kind === "codex" || kind === "chatgpt" ? "Codex account label" : `${displayKind(kind)} account label`, ""))?.trim();
		}
		if (!label) { ctx.ui.notify("Cancelled.", "warning"); return; }

		const accounts = loadAccounts();
		if (findAccount(accounts, kind, label!)) {
			ctx.ui.notify(`${displayKind(kind)} "${label!}" already exists.`, "warning");
			return;
		}

		const account: StoredAccount = { kind, label: label!, ...(apiKeyEnv ? { apiKeyEnv } : {}) };
		accounts.push(account);
		saveAccounts(accounts);
		refreshAccountProviders(pi);

		if (kind === "codex" || kind === "chatgpt") ctx.ui.notify(`Added "${label!}". Run /login and select "${label!}" to authenticate.`, "info");
		else if (apiKeyEnv) ctx.ui.notify(`Added ${displayKind(kind)} "${label!}" using $${apiKeyEnv}. Export that variable, then run /login and select "${label!}".`, "info");
		else ctx.ui.notify(`Added ${displayKind(kind)} "${label!}". Run /login and select "${label!}" to enter its API key.`, "info");
	}

	async function handleRemove(parts: string[], ctx: ExtensionCommandContext): Promise<void> {
		const maybeKind = parseKind(parts[0]);
		let label = maybeKind ? parts[1] : parts[0];
		let accounts = loadAccounts();

		if (!label) {
			if (!accounts.length) { ctx.ui.notify("No accounts.", "info"); return; }
			const choices = accounts.map((a) => `${displayKind(accountKind(a))}: ${a.label}`);
			const picked = await ctx.ui.select("Remove account", choices);
			const index = picked ? choices.indexOf(picked) : -1;
			if (index < 0) return;
			const account = accounts[index];
			accounts = accounts.filter((_, i) => i !== index);
			saveAccounts(accounts);
			refreshAccountProviders(pi);
			ctx.ui.notify(`Removed ${displayKind(accountKind(account))} "${account.label}".`, "info");
			return;
		}

		const idx = accounts.findIndex((account) => account.label === label && (!maybeKind || accountKind(account) === maybeKind));
		if (idx < 0) { ctx.ui.notify(`"${label}" not found.`, "warning"); return; }
		const account = accounts[idx];
		accounts.splice(idx, 1);
		saveAccounts(accounts);
		refreshAccountProviders(pi);
		ctx.ui.notify(`Removed ${displayKind(accountKind(account))} "${account.label}".`, "info");
	}

	async function handleRelogin(parts: string[], ctx: ExtensionCommandContext): Promise<void> {
		const maybeKind = parseKind(parts[0]);
		const kind = maybeKind ?? "codex";
		let label = maybeKind ? parts[1] : parts[0];
		const accounts = loadAccounts().filter((account) => accountKind(account) === kind);

		if (!label) {
			if (!accounts.length) { ctx.ui.notify(`No ${displayKind(kind)} accounts.`, "info"); return; }
			label = await ctx.ui.select("Re-login to account", accounts.map((a) => a.label)) ?? "";
		}
		if (!label) return;

		const account = findAccount(loadAccounts(), kind, label);
		if (!account) { ctx.ui.notify(`${displayKind(kind)} "${label}" not found.`, "warning"); return; }
		if (account.apiKeyEnv) { ctx.ui.notify(`${displayKind(kind)} "${label}" uses $${account.apiKeyEnv}; update the env var and restart pi.`, "info"); return; }

		const { AuthStorage } = require("@earendil-works/pi-coding-agent");
		const authStorage = AuthStorage.create();
		authStorage.remove(getProviderId(account));
		ctx.ui.notify(`Cleared credentials. Run /login and select "${account.label}" to re-authenticate.`, "info");
	}
}
