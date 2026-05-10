/**
 * Protected Paths Feature
 *
 * Blocks write, edit, AND read operations to sensitive files and directories.
 * Every path added here has a clear security rationale — no false sense of safety.
 *
 * Write/edit protection: Intercepts write/edit tool calls (native pi operations).
 * Read protection:       Intercepts bash tool calls that try to read protected
 *                        files via cat, grep, cp, input redirection, sourcing, etc.
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

import type { ExtensionAPI, BashToolCallEvent } from "@earendil-works/pi-coding-agent";

export function protectedPaths(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = event.input.path as string;

			if (isProtected(path)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
				}
				return { block: true, reason: `Path "${path}" is protected` };
			}

			return undefined;
		}

		// ── Bash read protection ────────────────────────────────────────
		// Agents commonly bypass write/edit restrictions by using bash tools
		// (cat, grep, rg, head, cp, etc.) to read protected files.
		// We detect the protected path in the command string and block it.
		if (event.toolName === "bash") {
			const bashEvent = event as BashToolCallEvent;
			const violation = detectProtectedRead(bashEvent.input.command);

			if (violation) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Blocked read of protected path via bash: ${violation.path}`,
						"warning",
					);
				}
				return {
					block: true,
					reason: `Reading protected path "${violation.path}" via bash is not allowed (${violation.reason})`,
				};
			}

			return undefined;
		}

		return undefined;
	});
}

/**
 * Check whether a file path matches any protected pattern.
 * Used for write/edit protection AND for bash read detection.
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
	if (
		filename === "id_rsa" || filename === "id_dsa" || filename === "id_ed25519" ||
		filename === "id_ecdsa" || filename === "id_ecdsa_sk" || filename === "id_ed25519_sk"
	) {
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

// ── Bash read detection ────────────────────────────────────────────────────

/**
 * Detect if a bash command attempts to read a protected file.
 *
 * Handles these patterns:
 *   1. Read commands with protected path as argument  — cat .env, grep KEY .env
 *   2. Input redirection                               — < .env, <./.env
 *   3. Shell sourcing                                  — source .env, . ./.env
 *   4. Copy/Move of protected files                    — cp .env /tmp/, mv .env ../backup
 *   5. Command substitution referencing protected path — echo $(cat .env)
 *   6. Bare protected path in positional arguments     — rsync -av .env host:/dest
 *   7. Sandbox-prefixed paths                          — cat /workspace/.env
 *
 * Returns the matched path and reason, or null if no violation.
 */
function detectProtectedRead(
	command: string,
): { path: string; reason: string } | null {
	// Normalize: strip shell comments, collapse whitespace
	const cmd = command.replace(/#.*$/, "").trim();
	if (!cmd) return null;

	const tokens = tokenize(cmd);
	if (tokens.length === 0) return null;

	// Identify output redirection targets (> file, >> file)
	const writeTargets = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		if ((tokens[i] === ">" || tokens[i] === ">>") && i + 1 < tokens.length) {
			writeTargets.add(stripQuotes(tokens[i + 1]));
		}
	}

	// ── Scan tokens for protected paths ─────────────────────────────────
	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i];
		const clean = stripQuotes(raw);

		// Skip non-file tokens
		if (isShellReserved(raw)) continue;
		if (raw.startsWith("-")) continue; // flag
		if (isVariableAssignment(raw)) continue;

		// Skip write targets (handled by write/edit hooks)
		if (writeTargets.has(clean)) continue;

		if (isProtected(clean)) {
			return { path: clean, reason: describeContext(tokens, i) };
		}

		// Check for protected filename embedded in a token via separator
		// (e.g. git ref:path like HEAD:.env, or tar file: .env)
		const embedded = extractEmbeddedProtectedPath(clean);
		if (embedded) {
			return { path: clean, reason: `embedded reference: ${embedded}` };
		}
	}

	// ── Input redirection: < protected_path ──────────────────────────────
	const inputRedirect = matchRedirect(cmd, "<");
	if (inputRedirect) {
		const clean = stripQuotes(inputRedirect);
		if (isProtected(clean)) {
			return { path: clean, reason: "input redirection" };
		}
	}

	// ── Command substitution: $(cat .env), $(< .env), etc. ──────────────
	const subMatch = cmd.match(/\$\([^)]*\)/g);
	if (subMatch) {
		for (const sub of subMatch) {
			// Recursively check the substitution body
			const inner = sub.slice(2, -1); // strip $( and )
			const innerResult = detectProtectedRead(inner);
			if (innerResult) return innerResult;
		}
	}

	// ── Here-string / here-doc with protected path source ────────────────
	//   cat <<< "$(cat .env)"           — recursive sub handles this
	//   bash -c "cat .env"              — the string content has .env
	//   ssh host "cat .env"             — remote read of .env (still a read op)
	// We don't catch this perfectly but the sub check above covers many cases.

	return null;
}

/** Commands that read file contents (not just metadata or executables). */
const READ_CMDS = new Set([
	"cat", "grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack",
	"less", "more", "most", "head", "tail",
	"sort", "cut", "awk", "sed", "diff", "comm", "wc", "uniq",
	"tac", "rev", "fold", "pr", "paste", "column",
	"bat", "batcat", "batgrep",
	"nl", "od", "xxd", "hexdump", "strings",
	"tsort", "look", "ptx",
	"source",
	"cp", "rsync", "scp", // file copy → reads source
]);

/** Generate a human-readable reason for the block. */
function describeContext(tokens: string[], index: number): string {
	// Check if previous token is a known read command
	if (index > 0) {
		const prev = tokens[index - 1];
		if (READ_CMDS.has(prev)) {
			return `command: ${prev}`;
		}
		if (prev === ".") {
			return "shell sourcing";
		}
	}

	// Check if inside a protected directory
	const clean = stripQuotes(tokens[index]);
	if (
		clean.includes("/.git/") || clean.startsWith(".git/") ||
		clean.includes("/node_modules/") || clean.startsWith("node_modules/")
	) {
		return "protected directory access";
	}

	// Check if it's a secrets file
	const filename = clean.split("/").pop() ?? clean;
	if (filename === ".env" || filename.startsWith(".env.") || filename === ".dev.vars") {
		return "secrets file access";
	}

	return "protected path access";
}

/**
 * Simple shell-aware tokenizer. Handles single-quoted, double-quoted,
 * and $'...' strings as single tokens.
 */
function tokenize(cmd: string): string[] {
	const tokens: string[] = [];
	let i = 0;

	while (i < cmd.length) {
		// Skip whitespace
		if (cmd[i] === " " || cmd[i] === "\t") {
			i++;
			continue;
		}

		// Single-quoted string
		if (cmd[i] === "'") {
			const end = cmd.indexOf("'", i + 1);
			tokens.push(cmd.slice(i, end === -1 ? cmd.length : end + 1));
			i = end === -1 ? cmd.length : end + 1;
			continue;
		}

		// Double-quoted string
		if (cmd[i] === '"') {
			let end = i + 1;
			while (end < cmd.length && cmd[end] !== '"') {
				if (cmd[end] === "\\") end++; // skip escaped char
				end++;
			}
			tokens.push(cmd.slice(i, end + 1 >= cmd.length ? cmd.length : end + 1));
			i = end + 1 >= cmd.length ? cmd.length : end + 1;
			continue;
		}

		// Shell operator (2-char)
		if (i + 1 < cmd.length) {
			const two = cmd.slice(i, i + 2);
			if (["&&", "||", ";;", ">>", "<<", "<>", ">&", "<&", "|&"].includes(two)) {
				tokens.push(two);
				i += 2;
				continue;
			}
		}

		// Shell operator (1-char)
		if (["|", "&", ";", ">", "<", "(", ")", "$", "`"].includes(cmd[i])) {
			tokens.push(cmd[i]);
			i++;
			continue;
		}

		// Regular word: read until next whitespace or operator
		let word = "";
		while (i < cmd.length && cmd[i] !== " " && cmd[i] !== "\t") {
			if ("|&;><()$`'\"".includes(cmd[i])) break;
			word += cmd[i];
			i++;
		}
		if (word) tokens.push(word);
	}

	return tokens;
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if (first === last && (first === "'" || first === '"')) {
			return s.slice(1, -1);
		}
	}
	return s;
}

function isShellReserved(s: string): boolean {
	return [
		"|", "||", "&", "&&", ";", ";;", ">", ">>", "<", "<<", "<>",
		">&", "<&", "|&", "(", ")", "$", "`",
		"if", "then", "else", "elif", "fi",
		"for", "while", "until", "do", "done",
		"case", "esac", "in",
		"function", "declare", "local", "export", "unset",
		"return", "exit", "break", "continue",
		"cd", "pushd", "popd", "dirs",
		"pwd", "echo", "printf",
		"test", "[", "[[", "]]",
		"let", "eval", "exec", "shift",
		"read", "readonly", "typeset",
		"time", "coproc",
	].includes(s);
}

function isVariableAssignment(s: string): boolean {
	return /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(s) && !s.includes("/");
}

/**
 * Match a shell redirection operator and return the target path.
 */
function matchRedirect(cmd: string, op: "<" | ">"): string | null {
	// Pattern: <path (no space) or < path (with space)
	const escapedOp = op === "<" ? "<" : ">";
	const re = new RegExp(`${escapedOp}\\s*(\\S+)`);
	const m = cmd.match(re);
	return m ? m[1] : null;
}

/**
 * Extract a protected path that's embedded in a token via a separator.
 *
 * This catches patterns like:
 *   - git show HEAD:.env         (ref:path syntax — reads .env at that commit)
 *   - git diff HEAD~1:.env.local (versioned secrets file reference)
 *   - docker run --env-file .env (not really embedded, but the token after
 *     --env-file is the path; already caught via isProtected)
 *
 * The key pattern is `:<protected-filename>` (colon separator) which
 * git uses for ref:path references.
 */
function extractEmbeddedProtectedPath(
	token: string,
): string | null {
	// Check for colon-separated patterns like HEAD:.env or HEAD:path/to/.env
	// This usually appears in git ref:path syntax
	const colonIdx = token.indexOf(":");
	if (colonIdx !== -1 && colonIdx < token.length - 1) {
		// The part after the last colon is the path reference
		const afterColon = token.slice(colonIdx + 1);
		// Handle stacked ref:path like HEAD~3:.env
		const parts = token.split(":");
		const lastPart = parts[parts.length - 1];

		// Check if the post-colon part is a protected path
		if (isProtected(afterColon) || isProtected(lastPart)) {
			return "git ref:path";
		}

		// Also check for nested paths: HEAD:subdir/.env
		const filename = afterColon.split("/").pop() ?? afterColon;
		if (isProtected(filename)) {
			return "git ref:path";
		}
	}

	// Check for . as a path prefix that might conceal a protected file
	// e.g., ./.env — this is already caught by isProtected("./.env") → true
	// because filename is ".env", but some edge cases might not be caught:
	// e.g., app.env (not a real scenario, just being thorough)

	return null;
}
