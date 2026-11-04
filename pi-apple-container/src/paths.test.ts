import { describe, expect, test } from "bun:test";
import {
	isAllowedExternalResource,
	isInsideCwd,
	isReadOnlyMount,
	type MountSpec,
	REMOTE_ROOT,
	rewritePromptCwd,
	toRemote,
} from "./paths";

const hostCwd = "/tmp/pi-sbx-project";
const skillMounts: MountSpec[] = [
	{ source: "/home/user/.agents/skills/demo", target: "/skills/demo" },
];

describe("toRemote", () => {
	test("relative path → /workspace/rel", () => {
		expect(toRemote("src/index.ts", hostCwd)).toBe(`${REMOTE_ROOT}/src/index.ts`);
		expect(toRemote("rel", hostCwd)).toBe(`${REMOTE_ROOT}/rel`);
	});

	test("already /workspace/... passthrough", () => {
		expect(toRemote(REMOTE_ROOT, hostCwd)).toBe(REMOTE_ROOT);
		expect(toRemote(`${REMOTE_ROOT}/src/index.ts`, hostCwd)).toBe(`${REMOTE_ROOT}/src/index.ts`);
	});

	test("/skills via mounts", () => {
		expect(toRemote("/skills/demo", hostCwd, skillMounts)).toBe("/skills/demo");
		expect(toRemote("/skills/demo/SKILL.md", hostCwd, skillMounts)).toBe("/skills/demo/SKILL.md");
	});

	test("outside cwd throws", () => {
		expect(() => toRemote("/etc/passwd", hostCwd)).toThrow(
			`sandbox: refusing to access /etc/passwd: outside of project cwd ${hostCwd}`,
		);
		expect(() => toRemote("../outside", hostCwd)).toThrow(/outside of project cwd/);
	});

	test("host cwd itself maps to /workspace", () => {
		expect(toRemote(hostCwd, hostCwd)).toBe(REMOTE_ROOT);
	});
});

describe("isInsideCwd", () => {
	test("/workspace/foo true", () => {
		expect(isInsideCwd(`${REMOTE_ROOT}/foo`, hostCwd)).toBe(true);
		expect(isInsideCwd(REMOTE_ROOT, hostCwd)).toBe(true);
	});

	test("host path inside cwd true", () => {
		expect(isInsideCwd(`${hostCwd}/src/index.ts`, hostCwd)).toBe(true);
		expect(isInsideCwd(hostCwd, hostCwd)).toBe(true);
		expect(isInsideCwd("src/index.ts", hostCwd)).toBe(true);
	});

	test("/etc/passwd false", () => {
		expect(isInsideCwd("/etc/passwd", hostCwd)).toBe(false);
	});
});

describe("isAllowedExternalResource", () => {
	test("pi-clipboard-* true", () => {
		expect(isAllowedExternalResource("/tmp/pi-clipboard-abc123", [])).toBe(true);
		expect(isAllowedExternalResource("/var/folders/xx/pi-clipboard-xyz", [])).toBe(true);
	});

	test("prefix match", () => {
		const prefixes = ["/home/user/allowed"];
		expect(isAllowedExternalResource("/home/user/allowed", prefixes)).toBe(true);
		expect(isAllowedExternalResource("/home/user/allowed/file.txt", prefixes)).toBe(true);
		expect(isAllowedExternalResource("/home/user/allowed-other/file.txt", prefixes)).toBe(false);
	});

	test("deny others", () => {
		expect(isAllowedExternalResource("/etc/passwd", [])).toBe(false);
		expect(isAllowedExternalResource("/etc/passwd", ["/home/user/allowed"])).toBe(false);
		expect(isAllowedExternalResource("/tmp/not-clipboard", [])).toBe(false);
	});
});

describe("isReadOnlyMount", () => {
	test("true for extra mount target and descendants", () => {
		expect(isReadOnlyMount("/skills/demo", skillMounts)).toBe(true);
		expect(isReadOnlyMount("/skills/demo/SKILL.md", skillMounts)).toBe(true);
	});

	test("false for workspace and sibling skill paths", () => {
		expect(isReadOnlyMount(`${REMOTE_ROOT}/src/index.ts`, skillMounts)).toBe(false);
		expect(isReadOnlyMount("/skills/other/SKILL.md", skillMounts)).toBe(false);
		expect(isReadOnlyMount("/skills/demo-extra", skillMounts)).toBe(false);
	});
});

describe("rewritePromptCwd", () => {
	const localCwd = "/Users/me/proj";
	const hostLine = `Current working directory: ${localCwd}`;
	const sandboxLine =
		`Current working directory: /workspace (sandboxed in apple container pi-sbx-proj-a1b2c3, host cwd ${localCwd} mounted read-write)`;
	const skillLine = "No skill directories are mounted.";

	test("host → sandbox", () => {
		const prompt = `${hostLine}\nOther context`;
		expect(
			rewritePromptCwd(prompt, {
				sandboxed: true,
				localCwd,
				runtimeKind: "apple",
				containerName: "pi-sbx-proj-a1b2c3",
				skillInfo: skillLine,
			}),
		).toBe(`${sandboxLine}\n${skillLine}\nOther context`);
	});

	test("sandbox → host", () => {
		const prompt = `${sandboxLine}\n${skillLine}\nOther context`;
		expect(
			rewritePromptCwd(prompt, {
				sandboxed: false,
				localCwd,
			}),
		).toBe(`${hostLine}\nOther context`);
	});

	test("no-op if already host", () => {
		const prompt = `${hostLine}\nOther context`;
		expect(
			rewritePromptCwd(prompt, {
				sandboxed: false,
				localCwd,
			}),
		).toBe(prompt);
	});
});
