import { describe, expect, test } from "bun:test";
import { parseCommand } from "./index";

describe("parseCommand", () => {
	test("npm install lodash@1.0.0 is a pinned package-install", () => {
		const parsed = parseCommand("npm install lodash@1.0.0");
		expect(parsed.hasNetworkActivity).toBe(true);
		expect(parsed.kind).toBe("package-install");
		expect(parsed.packages[0]?.name).toBe("lodash");
		expect(parsed.packages[0]?.version).toBe("1.0.0");
	});

	test("npm install lodash is unpinned", () => {
		const parsed = parseCommand("npm install lodash");
		expect(parsed.hasNetworkActivity).toBe(true);
		expect(parsed.kind).toBe("package-install");
		expect(parsed.packages[0]?.name).toBe("lodash");
		expect(parsed.packages[0]?.version).toBeNull();
	});

	test("curl URL includes the example host", () => {
		const parsed = parseCommand("curl https://example.com");
		expect(parsed.hasNetworkActivity).toBe(true);
		expect(parsed.urls.some((url) => url.includes("example"))).toBe(true);
	});

	test("echo hello has no network activity", () => {
		const parsed = parseCommand("echo hello");
		expect(parsed.hasNetworkActivity).toBe(false);
	});

	test("git clone is network activity", () => {
		const parsed = parseCommand("git clone https://github.com/x/y");
		expect(parsed.hasNetworkActivity).toBe(true);
		expect(parsed.kind).toBe("git-clone");
		expect(parsed.urls).toContain("https://github.com/x/y");
	});
});
