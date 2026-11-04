import { describe, expect, test } from "bun:test";
import {
	buildRunArgs,
	looksLikeSystemNotRunning,
	parseListRunning,
} from "./runtime";

describe("parseListRunning", () => {
	test("top-level id + status running", () => {
		const json = JSON.stringify([{ id: "foo", status: "running" }]);
		expect(parseListRunning("foo", json)).toBe(true);
		expect(parseListRunning("bar", json)).toBe(false);
	});

	test("configuration.id + status running", () => {
		const json = JSON.stringify([
			{ configuration: { id: "foo" }, status: "running" },
		]);
		expect(parseListRunning("foo", json)).toBe(true);
		expect(parseListRunning("bar", json)).toBe(false);
	});

	test("unknown shape → false, not throw", () => {
		expect(parseListRunning("foo", JSON.stringify({ weird: true }))).toBe(false);
		expect(parseListRunning("foo", "not-json")).toBe(false);
		expect(parseListRunning("foo", "")).toBe(false);
		expect(parseListRunning("foo", "null")).toBe(false);
		expect(parseListRunning("foo", "42")).toBe(false);
		expect(parseListRunning("foo", JSON.stringify([1, "x", null]))).toBe(false);
	});

	test("status started counts as running; stopped does not", () => {
		expect(parseListRunning("foo", JSON.stringify([{ id: "foo", status: "started" }]))).toBe(true);
		expect(parseListRunning("foo", JSON.stringify([{ id: "foo", state: "running" }]))).toBe(true);
		expect(parseListRunning("foo", JSON.stringify([{ id: "foo", status: "stopped" }]))).toBe(false);
		expect(parseListRunning("foo", JSON.stringify([{ id: "foo", status: "exited" }]))).toBe(false);
	});

	test("name / hostname fields", () => {
		expect(parseListRunning("foo", JSON.stringify([{ name: "foo", status: "running" }]))).toBe(true);
		expect(
			parseListRunning(
				"foo",
				JSON.stringify([{ configuration: { hostname: "foo" }, status: "running" }]),
			),
		).toBe(true);
	});

	test("nested status object", () => {
		expect(
			parseListRunning("foo", JSON.stringify([{ id: "foo", status: { state: "running" } }])),
		).toBe(true);
	});

	test("wrapped { containers: [...] }", () => {
		const json = JSON.stringify({
			containers: [{ configuration: { id: "foo" }, status: "running" }],
		});
		expect(parseListRunning("foo", json)).toBe(true);
		expect(parseListRunning("missing", json)).toBe(false);
	});

	test("empty array", () => {
		expect(parseListRunning("foo", "[]")).toBe(false);
	});
});

describe("looksLikeSystemNotRunning", () => {
	test("matches Apple-style messages", () => {
		expect(looksLikeSystemNotRunning("Error: system is not running")).toBe(true);
		expect(looksLikeSystemNotRunning("system-not-running")).toBe(true);
		expect(looksLikeSystemNotRunning("The container system is not running. Run `container system start`")).toBe(true);
	});

	test("does not match unrelated failures", () => {
		expect(looksLikeSystemNotRunning("image not found")).toBe(false);
		expect(looksLikeSystemNotRunning("permission denied")).toBe(false);
	});
});

describe("buildRunArgs", () => {
	const base = {
		name: "pi-sbx-demo-abc123",
		image: "thegreataxios/pi-sandbox:latest",
		hostCwd: "/Users/me/proj",
		allowNetwork: true,
	};

	test("workspace bind, user, workdir, sleep infinity", () => {
		const argv = buildRunArgs(base);
		expect(argv[0]).toBe("run");
		expect(argv).toContain("-d");
		expect(argv.slice(argv.indexOf("--name"), argv.indexOf("--name") + 2)).toEqual([
			"--name",
			base.name,
		]);
		expect(argv).toContain("--user");
		expect(argv).toContain("1000:1000");
		expect(argv).toContain("--mount");
		expect(argv).toContain("type=bind,source=/Users/me/proj,target=/workspace");
		expect(argv).toContain("-w");
		expect(argv).toContain("/workspace");
		expect(argv.slice(-2)).toEqual(["sleep", "infinity"]);
		expect(argv[argv.length - 3]).toBe(base.image);
	});

	test("allowNetwork true omits --no-dns; false includes it", () => {
		expect(buildRunArgs({ ...base, allowNetwork: true })).not.toContain("--no-dns");
		expect(buildRunArgs({ ...base, allowNetwork: false })).toContain("--no-dns");
	});

	test("skill mounts are readonly binds", () => {
		const argv = buildRunArgs({
			...base,
			extraMounts: [
				{ source: "/home/user/.agents/skills/demo", target: "/skills/demo" },
			],
		});
		expect(argv).toContain("type=bind,source=/home/user/.agents/skills/demo,target=/skills/demo,readonly");
	});

	test("cache volume uses -v name:/cache", () => {
		const argv = buildRunArgs({ ...base, cacheVolume: "my-cache" });
		const i = argv.indexOf("-v");
		expect(i).toBeGreaterThan(-1);
		expect(argv[i + 1]).toBe("my-cache:/cache");
	});

	test("cpus and memory pass through; disk/swap/pids are omitted", () => {
		const argv = buildRunArgs({
			...base,
			resources: {
				cpus: "4",
				memory: "8g",
				disk: "20g",
				swap: "4g",
				pidsLimit: 512,
			},
		});
		expect(argv.slice(argv.indexOf("--cpus"), argv.indexOf("--cpus") + 2)).toEqual(["--cpus", "4"]);
		expect(argv.slice(argv.indexOf("--memory"), argv.indexOf("--memory") + 2)).toEqual(["--memory", "8g"]);
		expect(argv.join(" ")).not.toMatch(/pids|swap|disk|storage-opt|memory-swap/i);
	});

	test("includes --cap-drop ALL and --init", () => {
		const argv = buildRunArgs(base);
		expect(argv).toContain("--cap-drop");
		expect(argv).toContain("ALL");
		expect(argv).toContain("--init");
	});
});
