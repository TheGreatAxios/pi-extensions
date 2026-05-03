/**
 * pi-thegreataxios-staples
 *
 * Personal staple extension for pi coding-agent.
 *
 * Features:
 * - Protected paths: blocks write/edit to sensitive files (.env, .env.* except .env.example, .dev.vars, .git/, node_modules/)
 * - pi-system-prompt: injects CUSTOM_SYSTEM_PROMPT_RULES.md into the system prompt on every turn
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { protectedPaths } from "./features/protected-paths.js";
import { piSystemPrompt } from "./features/pi-system-prompt/index.js";

export default function (pi: ExtensionAPI) {
	protectedPaths(pi);
	piSystemPrompt(pi);
}
