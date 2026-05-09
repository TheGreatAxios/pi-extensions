/**
 * pi-protected-paths
 *
 * Blocks write/edit operations to sensitive files and directories:
 *  - Secrets & environment   (.env, .dev.vars)
 *  - Auth & credentials      (.npmrc, .netrc, service-account.json, credentials.json)
 *  - SSH & private keys      (.ssh/, *.pem, *.key, id_rsa, etc.)
 *  - Cloud platform config   (.aws/, .docker/, .gnupg/)
 *  - Secrets management      (.sops.yaml, .vault-token, secrets/)
 *  - Version control         (.git/, .gitconfig, .git-credentials)
 *  - Dependencies            (node_modules/)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { protectedPaths } from "./features/protected-paths.js";

export default function (pi: ExtensionAPI) {
	protectedPaths(pi);
}
