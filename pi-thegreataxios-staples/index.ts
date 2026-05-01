/**
 * pi-thegreataxios-staples
 *
 * Personal staple extension for pi coding-agent.
 *
 * Features:
 * - Protected paths: blocks write/edit to sensitive files (.env, .env.* except .env.example, .dev.vars, .git/, node_modules/)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { protectedPaths } from "./features/protected-paths.js";

export default function (pi: ExtensionAPI) {
	protectedPaths(pi);
}
