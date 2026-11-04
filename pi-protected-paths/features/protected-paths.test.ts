import { describe, expect, test } from "bun:test";
import { detectProtectedRead, isProtected, shouldBlockTool } from "./protected-paths";

describe("isProtected", () => {
	test("protects .env", () => {
		expect(isProtected(".env")).toBe(true);
	});

	test("allows .env.example", () => {
		expect(isProtected(".env.example")).toBe(false);
	});

	test("protects .env.local", () => {
		expect(isProtected(".env.local")).toBe(true);
	});

	test("protects .git/HEAD", () => {
		expect(isProtected(".git/HEAD")).toBe(true);
	});

	test("protects node_modules/x", () => {
		expect(isProtected("node_modules/x")).toBe(true);
	});

	test("protects nested directory paths without trailing slashes", () => {
		expect(isProtected("foo/node_modules")).toBe(true);
		expect(isProtected("deep/.git")).toBe(true);
	});

	test("protects id_rsa", () => {
		expect(isProtected("id_rsa")).toBe(true);
	});

	test("protects foo.pem", () => {
		expect(isProtected("foo.pem")).toBe(true);
	});

	test("protects foo.key", () => {
		expect(isProtected("foo.key")).toBe(true);
	});

	test("allows README.md", () => {
		expect(isProtected("README.md")).toBe(false);
	});

	test("protects .ssh/id_rsa", () => {
		expect(isProtected(".ssh/id_rsa")).toBe(true);
	});

	test("protects .aws/credentials", () => {
		expect(isProtected(".aws/credentials")).toBe(true);
	});

	test("protects secrets/foo", () => {
		expect(isProtected("secrets/foo")).toBe(true);
	});

	test("protects foo.p12", () => {
		expect(isProtected("foo.p12")).toBe(true);
	});

	test("protects foo.pfx", () => {
		expect(isProtected("foo.pfx")).toBe(true);
	});

	test("protects foo.jks", () => {
		expect(isProtected("foo.jks")).toBe(true);
	});

	test("protects .npmrc", () => {
		expect(isProtected(".npmrc")).toBe(true);
	});

	test("protects .dev.vars", () => {
		expect(isProtected(".dev.vars")).toBe(true);
	});

	test("allows src/app.ts", () => {
		expect(isProtected("src/app.ts")).toBe(false);
	});

	test("protects /workspace/app/.env by filename", () => {
		expect(isProtected("/workspace/app/.env")).toBe(true);
	});
});

describe("shouldBlockTool", () => {
	test("blocks native read of .env", () => {
		const decision = shouldBlockTool("read", { path: ".env" });
		expect(decision).not.toBeNull();
		expect(decision?.block).toBe(true);
		expect(decision?.path).toBe(".env");
	});

	test("allows native read of README.md", () => {
		expect(shouldBlockTool("read", { path: "README.md" })).toBeNull();
	});

	test("blocks write of .env", () => {
		const decision = shouldBlockTool("write", { path: ".env" });
		expect(decision).not.toBeNull();
		expect(decision?.block).toBe(true);
		expect(decision?.path).toBe(".env");
	});

	test("blocks bash cat .env", () => {
		const decision = shouldBlockTool("bash", { command: "cat .env" });
		expect(decision).not.toBeNull();
		expect(decision?.block).toBe(true);
		expect(decision?.path).toBe(".env");
	});

	test("allows bash cat .env.example", () => {
		expect(shouldBlockTool("bash", { command: "cat .env.example" })).toBeNull();
	});

	test("blocks bash grep KEY .env", () => {
		const decision = shouldBlockTool("bash", { command: "grep KEY .env" });
		expect(decision).not.toBeNull();
		expect(decision?.block).toBe(true);
		expect(decision?.path).toBe(".env");
	});

	test("blocks bash source .env", () => {
		const decision = shouldBlockTool("bash", { command: "source .env" });
		expect(decision).not.toBeNull();
		expect(decision?.block).toBe(true);
		expect(decision?.path).toBe(".env");
	});

	test("blocks bash git show HEAD:.env", () => {
		const decision = shouldBlockTool("bash", { command: "git show HEAD:.env" });
		expect(decision).not.toBeNull();
		expect(decision?.block).toBe(true);
		expect(decision?.path).toBe("HEAD:.env");
	});

	test("allows bash cat README.md", () => {
		expect(shouldBlockTool("bash", { command: "cat README.md" })).toBeNull();
	});

	test("blocks native read of .git/config", () => {
		const decision = shouldBlockTool("read", { path: ".git/config" });
		expect(decision).not.toBeNull();
		expect(decision?.block).toBe(true);
		expect(decision?.path).toBe(".git/config");
	});

	test("blocks edit of id_ed25519", () => {
		const decision = shouldBlockTool("edit", { path: "id_ed25519" });
		expect(decision).not.toBeNull();
		expect(decision?.block).toBe(true);
		expect(decision?.path).toBe("id_ed25519");
	});
});

describe("detectProtectedRead", () => {
	test("hits on cat .env", () => {
		const violation = detectProtectedRead("cat .env");
		expect(violation).not.toBeNull();
		expect(violation?.path).toBe(".env");
	});

	test("returns null for echo hi", () => {
		expect(detectProtectedRead("echo hi")).toBeNull();
	});

	test("hits on grep KEY .env", () => {
		const violation = detectProtectedRead("grep KEY .env");
		expect(violation).not.toBeNull();
		expect(violation?.path).toBe(".env");
	});

	test("hits on source .env", () => {
		const violation = detectProtectedRead("source .env");
		expect(violation).not.toBeNull();
		expect(violation?.path).toBe(".env");
	});

	test("hits on git show HEAD:.env", () => {
		const violation = detectProtectedRead("git show HEAD:.env");
		expect(violation).not.toBeNull();
		expect(violation?.path).toBe("HEAD:.env");
	});

	test("returns null for cat README.md", () => {
		expect(detectProtectedRead("cat README.md")).toBeNull();
	});
});
