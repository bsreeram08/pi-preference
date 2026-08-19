import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "install-config.py");
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-install-"));
  temporaryRoots.push(root);
  return root;
}

function cleanEnvironment(agentDir: string): NodeJS.ProcessEnv {
  return {
    HOME: os.homedir(),
    PATH: process.env.PATH,
    TMPDIR: os.tmpdir(),
    PI_CODING_AGENT_DIR: agentDir,
    NO_COLOR: "1",
  };
}

function runConfig(action: "preflight" | "apply", agentDir: string, backupRoot?: string) {
  const args = [SCRIPT, action, "--agent-dir", agentDir, "--root", ROOT, "--full"];
  if (backupRoot) args.push("--backup-root", backupRoot);
  return spawnSync("python3", args, {
    cwd: ROOT,
    env: cleanEnvironment(agentDir),
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("public installer configuration safety", () => {
  test("fails closed on malformed existing JSON without mutating the installation", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const settingsPath = path.join(agentDir, "settings.json");
    const original = Buffer.from('{"theme":');
    await fs.writeFile(settingsPath, original);

    const result = spawnSync("bash", [path.join(ROOT, "install.sh"), "--full"], {
      cwd: ROOT,
      env: cleanEnvironment(agentDir),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid JSON");
    expect(await fs.readFile(settingsPath)).toEqual(original);
    expect(await fs.stat(path.join(agentDir, "extensions")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(agentDir, "backups")).catch(() => undefined)).toBeUndefined();
  });

  test("backs up and merges the explicitly requested opinionated profile", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const evolutionDir = path.join(agentDir, "skill-evolution");
    const backupRoot = path.join(root, "backup");
    await fs.mkdir(evolutionDir, { recursive: true });

    const originalSettings = '{"theme":"custom","customSetting":true}\n';
    const originalProfile = '{"version":1,"preferences":[{"id":"local","statement":"Keep local."}]}\n';
    const originalEvolution = '{"version":1,"enabled":false,"trustedSources":[]}\n';
    await fs.writeFile(path.join(agentDir, "settings.json"), originalSettings);
    await fs.writeFile(path.join(agentDir, "user-profile.json"), originalProfile);
    await fs.writeFile(path.join(evolutionDir, "config.json"), originalEvolution);

    expect(runConfig("preflight", agentDir).status).toBe(0);
    const applied = runConfig("apply", agentDir, backupRoot);
    expect(applied.status).toBe(0);

    const settings = JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"));
    const profile = JSON.parse(await fs.readFile(path.join(agentDir, "user-profile.json"), "utf8"));
    const evolution = JSON.parse(await fs.readFile(path.join(evolutionDir, "config.json"), "utf8"));
    expect(settings).toEqual({ theme: "ember", customSetting: true });
    expect(profile.preferences.some((item: { id: string }) => item.id === "local")).toBe(true);
    expect(profile.preferences.length).toBeGreaterThan(1);
    expect(evolution.enabled).toBe(false);
    expect(evolution.trustedSources.map((item: { source: string }) => item.source)).toEqual([
      "mattpocock/skills",
      "emilkowalski/skills",
    ]);
    expect(await fs.readFile(path.join(backupRoot, "config", "settings.json"), "utf8")).toBe(originalSettings);
    expect(await fs.readFile(path.join(backupRoot, "config", "user-profile.json"), "utf8")).toBe(originalProfile);
    expect(await fs.readFile(path.join(backupRoot, "config", "skill-evolution-config.json"), "utf8")).toBe(originalEvolution);

    const repeated = runConfig("apply", agentDir, backupRoot);
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain("already current");
  });

  test("rejects symlinked configuration paths", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const external = path.join(root, "external-settings.json");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(external, "{}\n");
    await fs.symlink(external, path.join(agentDir, "settings.json"));

    const result = runConfig("preflight", agentDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not be a symbolic link");
    expect(await fs.readFile(external, "utf8")).toBe("{}\n");
  });

  // This exercises the complete installer subprocess and can exceed Bun's 5 s
  // default test timeout on a loaded macOS CI runner.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("restores replaced resources when a later link fails", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const binDir = path.join(root, "bin");
    const extensionsDir = path.join(agentDir, "extensions");
    const themesDir = path.join(agentDir, "themes");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.mkdir(themesDir, { recursive: true });

    const locate = (name: string) => {
      const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Missing test executable: ${name}`);
      return result.stdout.trim();
    };
    await fs.symlink(process.execPath, path.join(binDir, "node"));
    await fs.symlink(locate("python3"), path.join(binDir, "python3"));
    await fs.symlink(locate("pi"), path.join(binDir, "pi"));
    await fs.writeFile(path.join(extensionsDir, "pi-workbench"), "original-extension\n");
    await fs.writeFile(path.join(extensionsDir, "pi-look"), "original-look\n");
    await fs.chmod(themesDir, 0o500);

    let result;
    try {
      result = spawnSync("bash", [path.join(ROOT, "install.sh")], {
        cwd: ROOT,
        env: {
          ...cleanEnvironment(agentDir),
          PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        },
        encoding: "utf8",
      });
    } finally {
      await fs.chmod(themesDir, 0o700);
    }

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restoring replaced links");
    expect(await fs.readFile(path.join(extensionsDir, "pi-workbench"), "utf8")).toBe("original-extension\n");
    expect(await fs.readFile(path.join(extensionsDir, "pi-look"), "utf8")).toBe("original-look\n");
    expect((await fs.lstat(path.join(extensionsDir, "pi-workbench"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(extensionsDir, "pi-look"))).isSymbolicLink()).toBe(false);
  }, 20_000);

  test("keeps the default profile non-invasive", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const result = spawnSync("python3", [SCRIPT, "apply", "--agent-dir", agentDir, "--root", ROOT], {
      cwd: ROOT,
      env: cleanEnvironment(agentDir),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not requested");
    expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
  });
});
