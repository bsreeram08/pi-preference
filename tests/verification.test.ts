import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { checkPassed, runCheck, validateCheckReceipt, workspaceSnapshot, type CheckRequest } from "../verification.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-evidence-"));
  directories.push(base);
  const projectRoot = path.join(base, "project");
  await fs.mkdir(projectRoot);
  execFileSync("git", ["init", "-q", projectRoot]);
  await fs.writeFile(path.join(projectRoot, "code.txt"), "original\n");
  const options = { projectRoot, evidenceDir: path.join(base, "checks"), runId: "test-run" };
  const request: CheckRequest = { argv: [process.execPath, "-e", 'console.log("actual evidence")'], criterionIds: ["behavior"], kind: "automated-test" };
  return { ...options, options, request };
}

describe("host-observed verification", () => {
  test("verifies non-Git projects and detects file changes without following symlinks", async () => {
    const { options, request } = await fixture();
    await fs.rm(path.join(options.projectRoot, ".git"), { recursive: true });
    const result = await runCheck(request, options);
    expect(checkPassed(result.receipt, await workspaceSnapshot(options.projectRoot))).toBe(true);
    await fs.mkdir(path.join(options.projectRoot, ".pi/pi-workbench"), { recursive: true });
    await fs.writeFile(path.join(options.projectRoot, ".pi/pi-workbench/current.json"), "{}");
    expect(await workspaceSnapshot(options.projectRoot)).toBe(result.receipt.snapshotAfter);
    await fs.symlink(options.evidenceDir, path.join(options.projectRoot, "outside"));
    const linked = await workspaceSnapshot(options.projectRoot);
    await fs.writeFile(path.join(options.evidenceDir, "unrelated.txt"), "outside");
    expect(await workspaceSnapshot(options.projectRoot)).toBe(linked);
    await fs.writeFile(path.join(options.projectRoot, "code.txt"), "changed");
    expect(checkPassed(result.receipt, await workspaceSnapshot(options.projectRoot))).toBe(false);
    await fs.writeFile(path.join(options.projectRoot, ".git"), "gitdir: /missing-workbench-git-directory\n");
    await expect(workspaceSnapshot(options.projectRoot)).rejects.toThrow();
  });
  test("records the actual process, literal argv, output and current dirty code", async () => {
    const { options, request } = await fixture();
    const result = await runCheck(request, options);
    expect(result.receipt.exitCode).toBe(0);
    expect(result.output).toContain("actual evidence");
    expect(checkPassed(result.receipt, await workspaceSnapshot(options.projectRoot))).toBe(true);
    expect(await validateCheckReceipt(result.receipt, request, options)).toEqual(result.receipt);
    const literal = await runCheck({ ...request, argv: [process.execPath, "-e", "console.log(process.argv[1])", "$(touch should-not-exist)"] }, options);
    expect(literal.output).toContain("$(touch should-not-exist)");
    expect(await fs.readdir(options.projectRoot)).not.toContain("should-not-exist");
  });

  test("does not accept nonzero exit or modifications during/after a check", async () => {
    const { options, request } = await fixture();
    const failed = await runCheck({ ...request, argv: [process.execPath, "-e", "process.exit(3)"] }, options);
    expect(failed.receipt.exitCode).toBe(3);
    expect(checkPassed(failed.receipt, failed.receipt.snapshotAfter)).toBe(false);
    const changed = await runCheck({ ...request, argv: [process.execPath, "-e", 'require("fs").writeFileSync("code.txt", "modified")'] }, options);
    expect(changed.receipt.snapshotAfter).not.toBe(changed.receipt.snapshotBefore);
    expect(checkPassed(changed.receipt, changed.receipt.snapshotAfter)).toBe(false);
    const clean = await runCheck(request, options);
    await fs.writeFile(path.join(options.projectRoot, "code.txt"), "later modification");
    expect(checkPassed(clean.receipt, await workspaceSnapshot(options.projectRoot))).toBe(false);
  });

  test("kills timed-out and cancelled checks and cannot report success", async () => {
    const { options, request } = await fixture();
    const slow = { ...request, argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeoutMs: 50 };
    const result = await runCheck(slow, options);
    expect(result.receipt.interrupted).toBe(true);
    expect(checkPassed(result.receipt, result.receipt.snapshotAfter)).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(runCheck(request, { ...options, signal: controller.signal })).rejects.toThrow();
  });

  test("rejects escaped cwd and missing or changed evidence artifacts", async () => {
    const { options, request } = await fixture();
    await expect(runCheck({ ...request, cwd: ".." }, options)).rejects.toThrow(/inside/);
    const { receipt } = await runCheck(request, options);
    await expect(validateCheckReceipt({ ...receipt, runId: "other-run" }, request, options)).rejects.toThrow(/invocation/);
    await expect(validateCheckReceipt(receipt, { ...request, argv: ["true"] }, options)).rejects.toThrow(/invocation/);
    await fs.writeFile(path.join(options.evidenceDir, `${receipt.id}.log`), "tampered");
    await expect(validateCheckReceipt(receipt, request, options)).rejects.toThrow(/changed/);
  });

  test("untracked contents matter while Workbench state does not", async () => {
    const { projectRoot } = await fixture();
    const before = await workspaceSnapshot(projectRoot);
    const state = path.join(projectRoot, ".pi", "pi-workbench");
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, "current.json"), "{}");
    expect(await workspaceSnapshot(projectRoot)).toBe(before);
    await fs.writeFile(path.join(projectRoot, "new.txt"), "new behavior");
    expect(await workspaceSnapshot(projectRoot)).not.toBe(before);
  });

  test("fingerprints initialized submodule contents and fails on an unavailable submodule", async () => {
    const { projectRoot } = await fixture();
    const child = path.join(projectRoot, "child");
    execFileSync("git", ["init", "-q", child]);
    execFileSync("git", ["-C", projectRoot, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},child`]);
    await fs.writeFile(path.join(child, "module.txt"), "before");
    const before = await workspaceSnapshot(projectRoot);
    await fs.writeFile(path.join(child, "module.txt"), "after");
    expect(await workspaceSnapshot(projectRoot)).not.toBe(before);
    await fs.rm(path.join(child, ".git"), { recursive: true, force: true });
    await expect(workspaceSnapshot(projectRoot)).rejects.toThrow(/initialized submodules/);
  });
});
