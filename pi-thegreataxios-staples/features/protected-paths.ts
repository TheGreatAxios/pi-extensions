/**
 * Protected Paths Feature
 *
 * Blocks write and edit operations to sensitive files.
 * - .env and .env.* variants (except .env.example)
 * - .dev.vars
 * - .git/ contents
 * - node_modules/ contents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

function isProtected(path: string): boolean {
	// Block .git/ and node_modules/ directories
	if (path.includes("/.git/") || path === ".git" || path.startsWith(".git/")) return true;
	if (path.includes("/node_modules/") || path === "node_modules" || path.startsWith("node_modules/")) return true;

	const filename = path.split("/").pop() ?? path;

	// Block .env and .env.* except .env.example (which is a template, not secrets)
	if (filename === ".env") return true;
	if (filename.startsWith(".env.") && filename !== ".env.example") return true;

	// Block .dev.vars (Cloudflare Workers secrets file)
	if (filename === ".dev.vars") return true;

	return false;
}
