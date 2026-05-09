/**
 * Protected Paths Feature
 *
 * Blocks write and edit operations to sensitive files and directories.
 * Every path added here has a clear security rationale — no false sense of safety.
 *
 * Categories:
 *   - Secrets & environment   (.env, .dev.vars)
 *   - Auth & credentials      (.npmrc, .netrc, service-account.json)
 *   - SSH & private keys      (.ssh/, *.pem, *.key, id_rsa)
 *   - Cloud platform config   (.aws/, .docker/, credentials.json)
 *   - Secrets management      (.sops.yaml, .vault-token, secrets/)
 *   - Version control         (.git/, .gitconfig, .git-credentials)
 *   - Dependencies            (node_modules/)
 *   - GPG                     (.gnupg/)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function protectedPaths(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const path = event.input.path as string;

		if (isProtected(path)) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
			}
			return { block: true, reason: `Path "${path}" is protected` };
		}

		return undefined;
	});
}

/**
 * Check whether a file path matches any protected pattern.
 */
function isProtected(path: string): boolean {
	// ── Directories (block any file inside) ──────────────────────────────
	const protections: Array<{ dir: string; reason: string }> = [
		{ dir: ".git", reason: "version control internals" },
		{ dir: "node_modules", reason: "dependency tree stability" },
		{ dir: ".ssh", reason: "SSH keys and configuration" },
		{ dir: ".aws", reason: "AWS credentials and configuration" },
		{ dir: ".docker", reason: "Docker registry auth and TLS certs" },
		{ dir: ".gnupg", reason: "GPG private keys" },
		{ dir: "secrets", reason: "secrets storage" },
	];

	for (const { dir } of protections) {
		if (isInsideDir(path, dir)) return true;
	}

	const filename = path.split("/").pop() ?? path;
	const ext = filename.split(".").pop()?.toLowerCase();

	// ── Secrets & environment ────────────────────────────────────────────
	if (filename === ".env") return true;
	if (filename.startsWith(".env.") && filename !== ".env.example") return true;
	if (filename === ".dev.vars") return true; // Cloudflare Workers

	// ── Auth & credentials ───────────────────────────────────────────────
	if (filename === ".npmrc") return true; // npm registry tokens
	if (filename === ".yarnrc.yml" || filename === ".yarnrc") return true; // Yarn auth
	if (filename === ".netrc" || filename === "_netrc") return true; // machine credentials
	if (filename === "credentials.json") return true; // generic cloud credentials
	if (filename === "service-account.json") return true; // GCP service account keys

	// ── SSH private keys at project root ─────────────────────────────────
	if (filename === "id_rsa" || filename === "id_dsa" || filename === "id_ed25519" || filename === "id_ecdsa" || filename === "id_ecdsa_sk" || filename === "id_ed25519_sk") {
		return true;
	}

	// ── Secrets management ──────────────────────────────────────────────
	if (filename === ".sops.yaml" || filename === ".sops.yml") return true; // SOPS encryption config
	if (filename === ".vault-token" || filename === ".vault-token.json") return true; // Vault tokens

	// ── Git config & credentials ────────────────────────────────────────
	if (filename === ".gitconfig") return true; // git config (signing keys, credential helpers)
	if (filename === ".git-credentials") return true; // git stored plaintext credentials

	// ── Keys & certificates (by extension) ──────────────────────────────
	if (ext === "pem" || ext === "key") return true; // PEM private keys / certs
	if (ext === "p12" || ext === "pfx") return true; // PKCS12 keystores
	if (ext === "jks" || ext === "keystore") return true; // Java keystores

	return false;
}

/**
 * Returns true if `path` is `dir`, starts with `dir/`, or contains `/dir/`.
 */
function isInsideDir(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`) || path.includes(`/${dir}/`);
}
