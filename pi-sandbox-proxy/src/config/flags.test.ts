import { describe, expect, test } from "bun:test";
import { applyFlagOverrides } from "./flags";
import { DEFAULT_CONFIG } from "./defaults";
import type { ProxyConfig } from "./types";

function fileConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
	return {
		...DEFAULT_CONFIG,
		...overrides,
		alwaysBlock: { ...DEFAULT_CONFIG.alwaysBlock, ...overrides.alwaysBlock },
		defaultDomains: overrides.defaultDomains ?? [...DEFAULT_CONFIG.defaultDomains],
	};
}

describe("applyFlagOverrides", () => {
	test("strict true sets strictMode and clears defaultDomains", () => {
		const config = fileConfig({
			strictMode: false,
			defaultDomains: ["registry.npmjs.org", "github.com"],
		});

		const next = applyFlagOverrides(config, { strict: true });

		expect(next.strictMode).toBe(true);
		expect(next.defaultDomains).toEqual([]);
		expect(config.defaultDomains).toEqual(["registry.npmjs.org", "github.com"]);
	});

	test("false and undefined flags do not clobber file config", () => {
		const config = fileConfig({
			strictMode: true,
			deepScan: true,
			autoApprove: true,
			maxApprovalDays: 7,
			defaultDomains: ["example.com"],
		});

		const fromFalse = applyFlagOverrides(config, {
			strict: false,
			deepScan: false,
			autoApprove: false,
		});
		expect(fromFalse.strictMode).toBe(true);
		expect(fromFalse.deepScan).toBe(true);
		expect(fromFalse.autoApprove).toBe(true);
		expect(fromFalse.maxApprovalDays).toBe(7);
		expect(fromFalse.defaultDomains).toEqual(["example.com"]);

		const fromUndefined = applyFlagOverrides(config, {});
		expect(fromUndefined.strictMode).toBe(true);
		expect(fromUndefined.deepScan).toBe(true);
		expect(fromUndefined.autoApprove).toBe(true);
		expect(fromUndefined.maxApprovalDays).toBe(7);
		expect(fromUndefined.defaultDomains).toEqual(["example.com"]);
	});

	test("maxApprovalDays is clamped to 1..30", () => {
		const config = fileConfig({ maxApprovalDays: 14 });

		expect(applyFlagOverrides(config, { maxApprovalDays: 0 }).maxApprovalDays).toBe(1);
		expect(applyFlagOverrides(config, { maxApprovalDays: -4 }).maxApprovalDays).toBe(1);
		expect(applyFlagOverrides(config, { maxApprovalDays: 1 }).maxApprovalDays).toBe(1);
		expect(applyFlagOverrides(config, { maxApprovalDays: 15 }).maxApprovalDays).toBe(15);
		expect(applyFlagOverrides(config, { maxApprovalDays: 30 }).maxApprovalDays).toBe(30);
		expect(applyFlagOverrides(config, { maxApprovalDays: 100 }).maxApprovalDays).toBe(30);
		expect(applyFlagOverrides(config, { maxApprovalDays: 1.9 }).maxApprovalDays).toBe(1);
		expect(applyFlagOverrides(config, { maxApprovalDays: Number.NaN }).maxApprovalDays).toBe(14);
		expect(applyFlagOverrides(config, { maxApprovalDays: Number.POSITIVE_INFINITY }).maxApprovalDays).toBe(14);
	});
});
