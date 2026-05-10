/**
 * pi-protected-paths
 *
 * Blocks write/edit/READ operations to sensitive files and directories:
 *  - Secrets & environment   (.env, .dev.vars)
 *  - Auth & credentials      (.npmrc, .netrc, service-account.json, credentials.json)
 *  - SSH & private keys      (.ssh/, *.pem, *.key, id_rsa, etc.)
 *  - Cloud platform config   (.aws/, .docker/, .gnupg/)
 *  - Secrets management      (.sops.yaml, .vault-token, secrets/)
 *  - Version control         (.git/, .gitconfig, .git-credentials)
 *  - Dependencies            (node_modules/)
 *
 * Read protection intercepts bash commands (cat, grep, head, cp, etc.)
 * that try to read protected files — closing the gap agents exploit
 * by bypassing write/edit restrictions with shell tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { protectedPaths } from "./features/protected-paths.js";

export default function (pi: ExtensionAPI) {
	protectedPaths(pi);
}
