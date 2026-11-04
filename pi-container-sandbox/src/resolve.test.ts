import { describe, expect, test } from "bun:test";
import { createInFlight, mergeSandboxEnabled, resolveAutoStart } from "./resolve";

describe("resolveAutoStart", () => {
	test("noContainer true → false even if containerFlag and configEnabled", () => {
		expect(
			resolveAutoStart({
				noContainer: true,
				noc: false,
				containerFlag: true,
				configEnabled: true,
			}),
		).toBe(false);
	});

	test("noc true → false", () => {
		expect(
			resolveAutoStart({
				noContainer: false,
				noc: true,
				containerFlag: true,
				configEnabled: true,
			}),
		).toBe(false);
	});

	test("containerFlag true, no disable flags → true", () => {
		expect(
			resolveAutoStart({
				noContainer: false,
				noc: false,
				containerFlag: true,
				configEnabled: false,
			}),
		).toBe(true);
	});

	test("only configEnabled true → true", () => {
		expect(
			resolveAutoStart({
				noContainer: false,
				noc: false,
				containerFlag: false,
				configEnabled: true,
			}),
		).toBe(true);
	});

	test("all false/undefined → false", () => {
		expect(
			resolveAutoStart({
				noContainer: false,
				noc: false,
				containerFlag: false,
			}),
		).toBe(false);
		expect(
			resolveAutoStart({
				noContainer: false,
				noc: false,
				containerFlag: false,
				configEnabled: undefined,
			}),
		).toBe(false);
		expect(
			resolveAutoStart({
				noContainer: false,
				noc: false,
				containerFlag: false,
				configEnabled: false,
			}),
		).toBe(false);
	});
});

describe("mergeSandboxEnabled", () => {
	test("preserves size/persist/cacheVolume and sets enabled", () => {
		expect(
			mergeSandboxEnabled(
				{ size: "lg", persist: true, cacheVolume: "my-cache" },
				true,
			),
		).toEqual({
			sandbox: {
				size: "lg",
				persist: true,
				cacheVolume: "my-cache",
				enabled: true,
			},
		});
	});

	test("creates sandbox.enabled when existing is null", () => {
		expect(mergeSandboxEnabled(null, false)).toEqual({
			sandbox: { enabled: false },
		});
	});

	test("overwrites previous enabled without clobbering other keys", () => {
		expect(
			mergeSandboxEnabled({ enabled: true, size: "sm", persist: false }, false),
		).toEqual({
			sandbox: { enabled: false, size: "sm", persist: false },
		});
	});
});

describe("createInFlight", () => {
	test("tracks begin/end and never goes negative", () => {
		const inflight = createInFlight();
		expect(inflight.count).toBe(0);
		expect(inflight.busy).toBe(false);
		inflight.begin();
		inflight.begin();
		expect(inflight.count).toBe(2);
		expect(inflight.busy).toBe(true);
		inflight.end();
		expect(inflight.count).toBe(1);
		inflight.end();
		inflight.end();
		expect(inflight.count).toBe(0);
		expect(inflight.busy).toBe(false);
	});
});
