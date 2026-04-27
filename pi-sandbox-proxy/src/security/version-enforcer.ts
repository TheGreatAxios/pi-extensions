import type { ParsedCommand } from "../parsers/types";

const VALID_PACKAGE_NAME = /^[a-zA-Z0-9@\/_.-]+$/;
const NPM_RANGE_PATTERN = /[\^~><=!*+]/;
const PIP_RANGE_PATTERN = /[><=!~]/;

export interface VersionCheckResult {
	blocked: boolean;
	reason?: string;
}

export function checkPackageNames(parsed: ParsedCommand): VersionCheckResult {
	for (const pkg of parsed.packages) {
		if (!VALID_PACKAGE_NAME.test(pkg.name)) {
			return {
				blocked: true,
				reason: `Package name "${pkg.name}" contains invalid characters (possible shell injection)`,
			};
		}
	}
	return { blocked: false };
}

export function enforcePinnedVersions(parsed: ParsedCommand): VersionCheckResult {
	if (parsed.kind !== "package-install") return { blocked: false };

	for (const pkg of parsed.packages) {
		if (!pkg.version || pkg.version.length === 0) {
			return {
				blocked: true,
				reason: `Unpinned package: ${pkg.raw}. Specify exact version (${parsed.tool} install ${pkg.name}@<version>)`,
			};
		}

		const rangePattern = parsed.tool === "pip" ? PIP_RANGE_PATTERN : NPM_RANGE_PATTERN;
		if (rangePattern.test(pkg.version)) {
			return {
				blocked: true,
				reason: `Version range not allowed: ${pkg.raw}. Use exact pin only (${parsed.tool} install ${pkg.name}@<exact-version>)`,
			};
		}
	}

	return { blocked: false };
}
