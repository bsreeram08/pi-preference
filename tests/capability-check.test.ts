import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const script = path.resolve(import.meta.dir, "../scripts/check-capabilities.py");
const packages = [
  "@imsus/pi-extension-minimax-coding-plan-mcp", "@capyup/pi-goal", "pi-lmstudio", "pi-subagents",
  "@vigolium/piolium", "context-mode", "pi-background-tasks", "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo",
];
const extensions = ["cmux-session.ts", "pi-look", "pi-workbench", "startup-header.ts"];
const packagePolicies = [
  ["@imsus/pi-extension-minimax-coding-plan-mcp", "^1.0.2", "1.0.2", "sha512-71T4A16Eiv9lp8o8Qfn1F63strEVRi9IGtMTwtDrje34yR+VtxYVUwRB+PmBg49rIWf22I5yWxk5LhIDuhF/zw=="],
  ["@capyup/pi-goal", "^0.6.0", "0.6.0", "sha512-Ohn5YjnYi2CcQuxyRAAXIZPQuKQMt+ED5GGBUX28W7YH9L6WXw+7rh35dFF+Z6CSL1fYnVSZ4S08ezZS7wSBRA=="],
  ["pi-lmstudio", "^1.5.0", "1.5.0", "sha512-Bnl9c4pmm1BrjUVI7DSPPH78H/md3XqLAx87hjMDzDnntTS5btryrXB3wLPPqgD93EsUzbfm7E9jlwmh8ChPIA=="],
  ["pi-subagents", "^0.52.1", "0.52.1", "sha512-9K9tICAbDBJ82op5wvFAIZFhg7K5Cv6du5hEsnf4o6/qhoslla1WcV11cOyB4tzKAHUIXA2GLA6kfxxLXzIpyg=="],
  ["@vigolium/piolium", "^0.0.13", "0.0.13", "sha512-FrrGJR/XnAwUVdNsnAXEPS6mpHoUBS3nt8s5SKHOKM8P/8DOynYw+EGgEfbXPcaLHNjMnXChUMAlKN8G6ma8SA=="],
  ["context-mode", "^1.0.169", "1.0.169", "sha512-94JIaFuLjF9SO2BsGTrbGtyT44K95+9OC8BdbaL/UT76xOkanJLfUR5CzmNw+GELXZQqH4nBrKg9wjBnSFkVnQ=="],
  ["pi-background-tasks", "^2.4.2", "2.4.2", "sha512-KDH2yv5yKnc2slUNMSsysVZleriuv8tbhe5L+AeplVAfijQsECN5YAWOz5TDbStCXLdJC15GaUQ1P87BXGk5Hg=="],
  ["@juicesharp/rpiv-ask-user-question", "^2.6.2", "2.6.2", "sha512-DS9yZHcaPr+/nf0x2CCfiXBod/1aWjGyakGM3lZAObuGDhYI0nFRE5gxTcCOfQug6JtJXjt1GlzyX8Pljefdzg=="],
  ["@juicesharp/rpiv-todo", "^2.6.2", "2.6.2", "sha512-Lt2HzNaKWgOl7/nEJrxtRsKoIQJTZd32BeckDxJ0JGvoUmwYvqOicSpXbgKVZwyGqGBw90WBKYWkEggo9U/Q4Q=="],
] as const;

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capability-check-"));
  const configured = packages.map((name) => `npm:${name}`);
  await fs.mkdir(path.join(root, "npm"), { recursive: true });
  await fs.writeFile(path.join(root, "settings.json"), `${JSON.stringify({ packages: configured, extensions: [], themes: [] })}\n`);
  await fs.writeFile(path.join(root, "npm", "package.json"), `${JSON.stringify({ dependencies: Object.fromEntries(packagePolicies.map(([name, dependency]) => [name, dependency])) })}\n`);
  const lockPackages: Record<string, unknown> = { "": { name: "pi-extensions", dependencies: Object.fromEntries(packagePolicies.map(([name, dependency]) => [name, dependency])) } };
  for (const [name, _dependency, version, integrity] of packagePolicies) {
    const directory = path.join(root, "npm", "node_modules", ...name.split("/"));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
    lockPackages[`node_modules/${name}`] = { version, integrity };
  }
  await fs.writeFile(path.join(root, "npm", "package-lock.json"), `${JSON.stringify({ name: "pi-extensions", lockfileVersion: 3, packages: lockPackages })}\n`);
  const extensionRoot = path.join(root, "extensions");
  const workbench = path.join(extensionRoot, "pi-workbench");
  await fs.mkdir(path.join(workbench, "setup", "pi-look"), { recursive: true });
  await fs.mkdir(path.join(workbench, "setup", "themes"), { recursive: true });
  await fs.writeFile(path.join(extensionRoot, "cmux-session.ts"), "export {};\n");
  await fs.writeFile(path.join(workbench, "startup-header.ts"), "export {};\n");
  await fs.writeFile(path.join(workbench, "setup", "themes", "ember.json"), "{}\n");
  await fs.symlink(path.join(workbench, "setup", "pi-look"), path.join(extensionRoot, "pi-look"), "dir");
  await fs.symlink(path.join(workbench, "startup-header.ts"), path.join(extensionRoot, "startup-header.ts"), "file");
  await fs.mkdir(path.join(root, "themes"));
  await fs.symlink(path.join(workbench, "setup", "themes", "ember.json"), path.join(root, "themes", "ember.json"), "file");
  await fs.writeFile(path.join(root, "auth.json"), "SECRET_SENTINEL_DO_NOT_READ\n");
  return root;
}

async function run(root: string, json = true): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["python3", script, "--agent-dir", root, ...(json ? ["--json"] : [])], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

async function snapshot(root: string): Promise<string> {
  const rows: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const info = await fs.lstat(file);
      const relative = path.relative(root, file);
      if (info.isSymbolicLink()) rows.push(`${relative}:link:${await fs.readlink(file)}`);
      else if (info.isDirectory()) { rows.push(`${relative}:dir`); await walk(file); }
      else rows.push(`${relative}:file:${await fs.readFile(file, "hex")}`);
    }
  }
  await walk(root);
  return rows.join("\n");
}

describe("validate-only capability inventory", () => {
  test("accepts the exact inventory including installer-style extension symlinks without mutation or secret inspection", async () => {
    const root = await makeFixture();
    try {
      const before = await snapshot(root);
      const first = await run(root);
      const second = await run(root);
      expect(first.code).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      expect(first.stdout).not.toContain("SECRET_SENTINEL");
      expect(JSON.parse(first.stdout)).toEqual({ counts: { findings: 0 }, findings: [], inventoryVersion: 1, schemaVersion: 1, status: "exact" });
      expect(await snapshot(root)).toBe(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("reports missing, unexpected, filtered, and excluded capabilities as deterministic drift", async () => {
    const root = await makeFixture();
    try {
      const settings = JSON.parse(await fs.readFile(path.join(root, "settings.json"), "utf8"));
      settings.packages = [
        ...settings.packages.slice(1),
        { source: `npm:${packages[1]}`, autoload: false },
        "npm:extra-package",
        "npm:pi-autoresearch",
        "npm:@dietrichgebert/ponytail",
      ];
      await fs.writeFile(path.join(root, "settings.json"), `${JSON.stringify(settings)}\n`);
      await fs.rm(path.join(root, "extensions", "cmux-session.ts"));
      await fs.writeFile(path.join(root, "extensions", "extra.ts"), "export {};\n");
      await fs.rm(path.join(root, "themes", "ember.json"));
      await fs.writeFile(path.join(root, "themes", "extra.json"), "{}\n");
      const result = await run(root);
      const parsed = JSON.parse(result.stdout);
      const codes = parsed.findings.map((item: { code: string }) => item.code);
      expect(result.code).toBe(1);
      expect(codes).toContain("missing-package-config");
      expect(codes).toContain("filtered-package");
      expect(codes).toContain("duplicate-package-config");
      expect(codes).toContain("unexpected-package-config");
      expect(codes.filter((code: string) => code === "forbidden-package-configured")).toHaveLength(2);
      expect(codes).toContain("missing-extension");
      expect(codes).toContain("unexpected-extension");
      expect(codes).toContain("missing-theme");
      expect(codes).toContain("unexpected-theme");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("requires both manifests and detects unlisted physical packages", async () => {
    const missingManifest = await makeFixture();
    const unlistedPhysical = await makeFixture();
    try {
      await fs.rm(path.join(missingManifest, "npm", "package.json"));
      expect((await run(missingManifest)).code).toBe(2);
      const extra = path.join(unlistedPhysical, "npm", "node_modules", "unlisted-package");
      await fs.mkdir(extra);
      await fs.writeFile(path.join(extra, "package.json"), `${JSON.stringify({ name: "unlisted-package", version: "1.0.0" })}\n`);
      const result = await run(unlistedPhysical);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).findings.map((item: { code: string }) => item.code)).toContain("unlisted-physical-package");
    } finally {
      await Promise.all([missingManifest, unlistedPhysical].map((root) => fs.rm(root, { recursive: true, force: true })));
    }
  });

  test("rejects hostile package sources and redacts unexpected resource identities", async () => {
    const hostileSource = await makeFixture();
    const hostileNames = await makeFixture();
    const sentinel = "SECRET_SENTINEL_IN_IDENTITY";
    try {
      const settings = JSON.parse(await fs.readFile(path.join(hostileSource, "settings.json"), "utf8"));
      settings.packages[0] = `${settings.packages[0]}@https://attacker.test/pkg.tgz`;
      await fs.writeFile(path.join(hostileSource, "settings.json"), `${JSON.stringify(settings)}\n`);
      const unsafe = await run(hostileSource);
      expect(unsafe.code).toBe(2);
      expect(unsafe.stdout).not.toContain("attacker.test");

      await fs.writeFile(path.join(hostileNames, "extensions", `${sentinel}.ts`), "export {};\n");
      await fs.writeFile(path.join(hostileNames, "themes", `${sentinel}.json`), "{}\n");
      const hostileSettings = JSON.parse(await fs.readFile(path.join(hostileNames, "settings.json"), "utf8"));
      hostileSettings.extensions = [`/tmp/${sentinel}/pi-workbench`];
      hostileSettings.themes = [`/tmp/${sentinel}/ember.json`];
      await fs.writeFile(path.join(hostileNames, "settings.json"), `${JSON.stringify(hostileSettings)}\n`);
      const drift = await run(hostileNames);
      const codes = JSON.parse(drift.stdout).findings.map((item: { code: string }) => item.code);
      expect(drift.code).toBe(1);
      expect(codes).toContain("unexpected-extension-config");
      expect(codes).toContain("unexpected-theme-config");
      expect(drift.stdout).not.toContain(sentinel);
      expect(drift.stdout).toContain("sha256:");
    } finally {
      await Promise.all([hostileSource, hostileNames].map((root) => fs.rm(root, { recursive: true, force: true })));
    }
  });

  test("rejects package symlinks, wrong extension kinds, and links detached from manifest targets", async () => {
    const packageLink = await makeFixture();
    const extensionKind = await makeFixture();
    const extensionLink = await makeFixture();
    const nestedTargetLink = await makeFixture();
    const regularTheme = await makeFixture();
    try {
      const packagePath = path.join(packageLink, "npm", "node_modules", "pi-lmstudio");
      const moved = `${packagePath}-real`;
      await fs.rename(packagePath, moved);
      await fs.symlink(moved, packagePath, "dir");
      expect((await run(packageLink)).code).toBe(2);

      await fs.rm(path.join(extensionKind, "extensions", "cmux-session.ts"));
      await fs.mkdir(path.join(extensionKind, "extensions", "cmux-session.ts"));
      const kindResult = await run(extensionKind);
      expect(kindResult.code).toBe(1);
      expect(JSON.parse(kindResult.stdout).findings.map((item: { code: string }) => item.code)).toContain("extension-kind-mismatch");

      await fs.rm(path.join(extensionLink, "extensions", "pi-look"));
      const detached = path.join(extensionLink, "detached-pi-look");
      await fs.mkdir(detached);
      await fs.symlink(detached, path.join(extensionLink, "extensions", "pi-look"), "dir");
      const result = await run(extensionLink);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).findings.map((item: { code: string }) => item.code)).toContain("extension-link-target-mismatch");

      const approvedTarget = path.join(nestedTargetLink, "extensions", "pi-workbench", "setup", "pi-look");
      const externalTarget = path.join(nestedTargetLink, "external-pi-look");
      await fs.rename(approvedTarget, externalTarget);
      await fs.symlink(externalTarget, approvedTarget, "dir");
      const nestedResult = await run(nestedTargetLink);
      expect(nestedResult.code).toBe(1);
      expect(JSON.parse(nestedResult.stdout).findings.map((item: { code: string }) => item.code)).toContain("extension-approved-target-unsafe");

      const themePath = path.join(regularTheme, "themes", "ember.json");
      await fs.rm(themePath);
      await fs.writeFile(themePath, "{}\n");
      const themeResult = await run(regularTheme);
      expect(themeResult.code).toBe(1);
      expect(JSON.parse(themeResult.stdout).findings.map((item: { code: string }) => item.code)).toContain("missing-theme-link");
    } finally {
      await Promise.all([packageLink, extensionKind, extensionLink, nestedTargetLink, regularTheme].map((root) => fs.rm(root, { recursive: true, force: true })));
    }
  });

  test("detects each excluded package in managed dependencies and physical paths", async () => {
    const root = await makeFixture();
    try {
      const npm = JSON.parse(await fs.readFile(path.join(root, "npm", "package.json"), "utf8"));
      for (const name of ["pi-autoresearch", "@dietrichgebert/ponytail"]) {
        npm.dependencies[name] = "1.0.0";
        const directory = path.join(root, "npm", "node_modules", ...name.split("/"));
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "package.json"), `${JSON.stringify({ name, version: "1.0.0" })}\n`);
      }
      await fs.writeFile(path.join(root, "npm", "package.json"), `${JSON.stringify(npm)}\n`);
      const result = await run(root);
      const parsed = JSON.parse(result.stdout);
      expect(result.code).toBe(1);
      expect(parsed.findings.filter((item: { code: string }) => item.code === "forbidden-package-installed")).toHaveLength(2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("fails closed for malformed or symlinked configuration and malformed package metadata", async () => {
    const malformed = await makeFixture();
    const linked = await makeFixture();
    const metadata = await makeFixture();
    try {
      await fs.writeFile(path.join(malformed, "settings.json"), "{broken\n");
      expect((await run(malformed)).code).toBe(2);
      await fs.rename(path.join(linked, "settings.json"), path.join(linked, "settings.real.json"));
      await fs.symlink(path.join(linked, "settings.real.json"), path.join(linked, "settings.json"));
      expect((await run(linked)).code).toBe(2);
      await fs.writeFile(path.join(metadata, "npm", "node_modules", "pi-lmstudio", "package.json"), "{broken\n");
      expect((await run(metadata)).code).toBe(2);
    } finally {
      await Promise.all([malformed, linked, metadata].map((root) => fs.rm(root, { recursive: true, force: true })));
    }
  });

  test("bundled manifest is versioned, ordered, duplicate-free, and exact", async () => {
    const manifest = JSON.parse(await fs.readFile(path.resolve(import.meta.dir, "../setup/capabilities.v1.json"), "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.inventoryVersion).toBe(1);
    expect(manifest.inventory.packages.map((value: string) => value.slice(4))).toEqual(packages);
    expect(manifest.inventory.extensions).toEqual(extensions);
    expect(manifest.inventory.packagePolicies).toHaveLength(packages.length);
    expect(manifest.inventory.extensionLinks).toEqual({ "pi-look": "pi-workbench/setup/pi-look", "startup-header.ts": "pi-workbench/startup-header.ts" });
    expect(manifest.inventory.themeLinks).toEqual({ "ember.json": "extensions/pi-workbench/setup/themes/ember.json" });
    expect(new Set(manifest.inventory.packages).size).toBe(manifest.inventory.packages.length);
    expect(manifest.runtimeExclusions.packages).toEqual(["npm:pi-autoresearch", "npm:@dietrichgebert/ponytail"]);
  });
});
