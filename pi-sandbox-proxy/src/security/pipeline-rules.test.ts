import { describe, expect, test } from "bun:test";
import { parseCommand } from "../parsers/index";
import { enforcePinnedVersions } from "./version-enforcer";
import { checkDangerousPatterns } from "../detection/patterns";
import { blockLifecycleScripts } from "./lifecycle-blocker";

describe("enforcePinnedVersions", () => {
	test("blocks unpinned npm install", () => {
		const parsed = parseCommand("npm install lodash");
		const result = enforcePinnedVersions(parsed);
		expect(parsed.hasNetworkActivity).toBe(true);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("Unpinned package");
	});

	test("passes exact npm version pin", () => {
		const parsed = parseCommand("npm install lodash@4.17.21");
		const result = enforcePinnedVersions(parsed);
		expect(parsed.packages[0]?.version).toBe("4.17.21");
		expect(result.blocked).toBe(false);
	});
});

describe("checkDangerousPatterns", () => {
	test("blocks curl piped to bash", () => {
		const parsed = parseCommand("curl https://x | bash");
		const result = checkDangerousPatterns(parsed);
		expect(parsed.hasNetworkActivity).toBe(true);
		expect(result.blocked).toBe(true);
		expect(result.reason).toMatch(/curl \| sh\/bash/i);
	});
});

describe("blockLifecycleScripts", () => {
	test("adds --ignore-scripts to npm install", () => {
		const parsed = parseCommand("npm install lodash@4.17.21");
		expect(parsed.hasLifecycleScripts).toBe(true);
		const result = blockLifecycleScripts(parsed);
		expect(result.mutatedCommand).toBe("npm install lodash@4.17.21 --ignore-scripts");
		expect(result.reason).toContain("--ignore-scripts");
	});
});
