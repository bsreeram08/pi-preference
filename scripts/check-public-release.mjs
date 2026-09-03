#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const includeHistory = process.argv.includes("--history");
const failures = [];

function fail(message) {
  failures.push(message);
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

const requiredFiles = [
  "agent-child-bridge.ts",
  "agent-cmux-bridge.mjs",
  "agent-cmux-session.ts",
  "cmux-naming.ts",
  "child-fast-mode.ts",
  "child-tools.ts",
  "LICENSE",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "bun.lock",
  "setup/capabilities.v1.json",
  "scripts/check-capabilities.py",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/pull_request_template.md",
];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) fail(`missing required public-release file: ${file}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.license !== "MIT") fail("package.json license must be MIT");
if (manifest.private !== true) fail("package.json must remain private to prevent accidental npm publication");
if (manifest.author !== "Sreeram Balamurugan") fail("package.json author does not match the approved public identity");
if (manifest.repository?.url !== "git+https://github.com/bsreeram08/pi-workbench.git") {
  fail("package.json repository URL is missing or unexpected");
}
for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`development dependency must be exact: ${name}@${version}`);
}

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
if (!readme.startsWith("# Sreeram's Pi Workbench\n")) fail("README title does not use the approved public name");
if (/private GitHub repository|git@github\.com:bsreeram08\/pi-workbench/.test(readme)) {
  fail("README still contains private or SSH-only distribution guidance");
}

const settings = JSON.parse(fs.readFileSync(path.join(root, "setup/defaults/settings.json"), "utf8"));
if (Array.isArray(settings.packages) && settings.packages.length > 0) {
  fail("portable settings must not enroll companion packages");
}

const capabilities = JSON.parse(fs.readFileSync(path.join(root, "setup/capabilities.v1.json"), "utf8"));
const approvedPackagePolicies = [
  ["@imsus/pi-extension-minimax-coding-plan-mcp", "^1.0.2", "1.0.2", "sha512-71T4A16Eiv9lp8o8Qfn1F63strEVRi9IGtMTwtDrje34yR+VtxYVUwRB+PmBg49rIWf22I5yWxk5LhIDuhF/zw=="],
  ["pi-lmstudio", "^1.5.0", "1.5.0", "sha512-Bnl9c4pmm1BrjUVI7DSPPH78H/md3XqLAx87hjMDzDnntTS5btryrXB3wLPPqgD93EsUzbfm7E9jlwmh8ChPIA=="],
  ["@vigolium/piolium", "^0.0.13", "0.0.13", "sha512-FrrGJR/XnAwUVdNsnAXEPS6mpHoUBS3nt8s5SKHOKM8P/8DOynYw+EGgEfbXPcaLHNjMnXChUMAlKN8G6ma8SA=="],
  ["context-mode", "^1.0.169", "1.0.169", "sha512-94JIaFuLjF9SO2BsGTrbGtyT44K95+9OC8BdbaL/UT76xOkanJLfUR5CzmNw+GELXZQqH4nBrKg9wjBnSFkVnQ=="],
  ["pi-background-tasks", "^2.4.2", "2.4.2", "sha512-KDH2yv5yKnc2slUNMSsysVZleriuv8tbhe5L+AeplVAfijQsECN5YAWOz5TDbStCXLdJC15GaUQ1P87BXGk5Hg=="],
].map(([name, dependency, version, integrity]) => ({ source: `npm:${name}`, dependency, version, integrity }));
const approvedCapabilities = {
  schemaVersion: 1,
  inventoryVersion: 1,
  scope: "user-agent",
  inventory: {
    packages: approvedPackagePolicies.map(({ source }) => source),
    packagePolicies: approvedPackagePolicies,
    extensions: ["cmux-session.ts", "cmux-workbench.ts", "pi-look", "pi-workbench", "startup-header.ts"],
    extensionLinks: {
      "cmux-workbench.ts": "pi-workbench/setup/cmux-workbench.ts",
      "pi-look": "pi-workbench/setup/pi-look",
      "startup-header.ts": "pi-workbench/startup-header.ts",
    },
    themes: ["ember.json"],
    themeLinks: { "ember.json": "extensions/pi-workbench/setup/themes/ember.json" },
  },
  runtimeExclusions: { packages: ["npm:pi-autoresearch", "npm:@dietrichgebert/ponytail", "npm:@capyup/pi-goal", "npm:@juicesharp/rpiv-ask-user-question", "npm:@juicesharp/rpiv-todo", "npm:pi-subagents"] },
};
if (JSON.stringify(capabilities) !== JSON.stringify(approvedCapabilities)) {
  fail("capability manifest must contain only the approved ordered inventory and runtime exclusions");
}

const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
if (/pull_request_target\s*:/.test(workflow)) fail("CI must not use pull_request_target");
if (!/permissions:\s*\n\s+contents:\s*read/.test(workflow)) fail("CI must declare contents: read permissions");
for (const match of workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)) {
  if (!match[1].startsWith("./") && !/^[0-9a-f]{40}$/.test(match[2])) {
    fail(`GitHub Action is not pinned to a full commit SHA: ${match[1]}@${match[2]}`);
  }
}

const candidateFiles = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
const forbiddenPath = /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|auth\.json$|credentials?\.json$|secrets?\.json$|sessions?(?:\/|$)|backups?(?:\/|$)|node_modules(?:\/|$)|\.pi(?:\/|$))/i;
for (const file of candidateFiles) {
  if (forbiddenPath.test(file)) fail(`forbidden runtime or credential path is present: ${file}`);
}

const credentialPatterns = [
  ["private-key", /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
  ["aws-access-key", /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g],
  ["github-token", /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["slack-token", /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{20,}/g],
  ["google-api-key", /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g],
  ["anthropic-key", /(?:^|[^A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /(?:^|[^A-Za-z0-9])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
];

function scanText(file, text) {
  if (text.includes("\0")) return;
  for (const [label, pattern] of credentialPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[0].toLowerCase();
      const line = text.slice(0, match.index).split("\n").length;
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const lineEnd = text.indexOf("\n", match.index);
      const sourceLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      const fixture = file.startsWith("tests/") && (
        value.includes("test")
        || value.includes("fixture")
        || /rejects\.toThrow\(["']credential or secret/.test(sourceLine)
      );
      if (!fixture) fail(`possible ${label} in ${file}:${line}`);
    }
  }
}

for (const file of candidateFiles) {
  const absolute = path.join(root, file);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    continue;
  }
  if (!stats.isFile() || stats.size > 5 * 1024 * 1024) continue;
  scanText(file, fs.readFileSync(absolute, "utf8"));
}

const gitlink = git(["ls-files", "-s", "reprompter"]).trim().split(/\s+/);
const submoduleHead = git(["-C", "reprompter", "rev-parse", "HEAD"]).trim();
if (gitlink[0] !== "160000" || gitlink[1] !== submoduleHead) {
  fail("RePrompter checkout does not match the tracked gitlink");
}
if (git(["-C", "reprompter", "status", "--porcelain", "--untracked-files=all"]).trim()) {
  fail("RePrompter checkout contains local changes or untracked files");
}
if (!fs.existsSync(path.join(root, "reprompter/LICENSE"))) fail("RePrompter license is not present");

if (includeHistory) {
  if (git(["status", "--porcelain", "--untracked-files=all"]).trim()) {
    fail("history release check requires a clean working tree and index");
  }
  const objects = git(["rev-list", "--objects", "--all"]).trim().split("\n").filter(Boolean);
  const seen = new Set();
  for (const row of objects) {
    const [objectId, ...pathParts] = row.split(" ");
    if (seen.has(objectId) || git(["cat-file", "-t", objectId]).trim() !== "blob") continue;
    seen.add(objectId);
    const file = pathParts.join(" ") || `<blob:${objectId.slice(0, 12)}>`;
    const contents = git(["cat-file", "-p", objectId], { encoding: "utf8" });
    scanText(file, contents);
  }
  const commits = git(["log", "--all", "--format=%H%x00%ae%x00%ce"]).trim().split("\n").filter(Boolean);
  const isNoreply = (email) => email.endsWith("@users.noreply.github.com") || email.toLowerCase() === "noreply@github.com";
  for (const row of commits) {
    const [commit, authorEmail, committerEmail] = row.split("\0");
    if (![authorEmail, committerEmail].every(isNoreply)) {
      fail(`commit metadata is not noreply-only: ${commit.slice(0, 12)}`);
    }
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`error: ${message}`);
  process.exit(1);
}
console.log(`Sreeram's Pi Workbench public-release check passed${includeHistory ? " with history" : ""}.`);
