/**
 * pi-system-prompt — system prompt injection for pi coding-agent
 *
 * Part of pi-thegreataxios-staples.
 *
 * Scans for CUSTOM_SYSTEM_PROMPT_RULES.md in discovery order and injects
 * its content into the system prompt on every turn.
 *
 * Resolution order (first found wins):
 *   1. .pi/CUSTOM_SYSTEM_PROMPT_RULES.md (project-level override)
 *   2. ~/.pi/agent/CUSTOM_SYSTEM_PROMPT_RULES.md (global fallback)
 *
 * Within the markdown file, special directives are supported:
 *   - `skill:<skill-name>` — injects the full content of a loaded skill
 *   - `skill:path/to/skill/SKILL.md` — injects a skill by filesystem path
 *
 * Usage:
 *   Create ~/.pi/agent/CUSTOM_SYSTEM_PROMPT_RULES.md or .pi/CUSTOM_SYSTEM_PROMPT_RULES.md
 *   with your persistent system prompt additions.
 */

import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CONFIG_FILE = "CUSTOM_SYSTEM_PROMPT_RULES.md";

/**
 * Resolve config file paths in order of priority.
 * Project-level (cwd) takes precedence over global (~/.pi/agent).
 */
function configPaths(cwd: string): string[] {
	const home = homedir();
	return [
		join(cwd, ".pi", CONFIG_FILE),
		join(home, ".pi", "agent", CONFIG_FILE),
		join(cwd, CONFIG_FILE),
	];
}

/**
 * Find the first config file that actually exists on disk.
 */
async function findConfig(cwd: string): Promise<string | null> {
	for (const p of configPaths(cwd)) {
		try {
			await access(p);
			return p;
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Parse directives like `skill:<name>` and `<skill:path>` from a markdown line.
 * Returns the raw text with directives replaced by resolved content.
 */
async function resolveDirectives(line: string, cwd: string): Promise<string> {
	const skillMatch = line.match(/^(?:skill|skill-file):\s*(.+)$/i);
	if (!skillMatch) return line;

	const ref = skillMatch[1].trim();

	// If it's an absolute or relative file path, read directly
	const possiblePaths = isAbsolute(ref)
		? [ref]
		: [join(cwd, ".pi", "skills", ref), join(homedir(), ".pi", "agent", "skills", ref), resolve(cwd, ref)];

	for (const p of possiblePaths) {
		try {
			const content = await readFile(p, "utf-8");
			return content;
		} catch {
			continue;
		}
	}

	// Reference wasn't resolvable — leave the directive in place as a comment
	return `<!-- pi-system-prompt: skill not found: ${ref} -->`;
}

/**
 * Load and process the config file content.
 * Returns the resolved markdown content, or null if no config file exists.
 */
async function loadConfigContent(cwd: string): Promise<string | null> {
	const configPath = await findConfig(cwd);
	if (!configPath) return null;

	const raw = await readFile(configPath, "utf-8");
	const lines = raw.split("\n");
	const resolved = await Promise.all(lines.map((line) => resolveDirectives(line, cwd)));

	return resolved.join("\n");
}

export function piSystemPrompt(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const content = await loadConfigContent(ctx.cwd);
		if (!content || content.trim().length === 0) return;

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Custom System Prompt Rules\n\nThe following system prompt rules have been configured for this project. Follow them carefully.\n\n${content}\n`,
		};
	});
}
