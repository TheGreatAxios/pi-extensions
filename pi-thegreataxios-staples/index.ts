/**
 * pi-thegreataxios-staples
 *
 * Bundle of personal staple extensions for pi coding-agent.
 *
 * Features:
 * - Protected paths: blocks write/edit to sensitive files (.env, .git/, node_modules/)
 * - Plan mode: read-only exploration with step tracking and progress widgets
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { protectedPaths } from "./features/protected-paths.js";
import { planMode } from "./features/plan-mode/index.js";

export default function (pi: ExtensionAPI) {
	protectedPaths(pi);
	planMode(pi);
}
