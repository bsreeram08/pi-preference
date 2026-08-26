import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { acquireExclusiveLeaseAtPath, type ExclusiveLease } from "./exclusive-lease.ts";
import type { Exec, ExecResult } from "./types.ts";

const TRUSTED_REPOSITORY = "https://github.com/bsreeram08/pi-preference.git";
const TRUSTED_ORIGIN_PATTERN = /^https:\/\/github\.com\/bsreeram08\/pi-preference(?:\.git)?\/?$/;
const RELEASES_URL = "https://api.github.com/repos/bsreeram08/pi-preference/releases?per_page=100";
const TRUSTED_REPROMPTER = "https://github.com/AytuncYildizli/reprompter.git";
const PRIVATE_REF = "refs/pi-workbench-updater/candidate";
const MAIN_REF = "refs/heads/main";
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_RELEASE_BYTES = 256 * 1024;
const MAX_RELEASE_PAGES = 10;
const RELEASE_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const SAFE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SAFE_GIT_ENV = [
  "-i",
  `HOME=${os.homedir()}`,
  `PATH=${SAFE_PATH}`,
  "LANG=C",
  "LC_ALL=C",
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_SYSTEM=/dev/null",
  "GIT_CONFIG_GLOBAL=/dev/null",
  "GIT_NO_REPLACE_OBJECTS=1",
  "GIT_ATTR_NOSYSTEM=1",
] as const;

const CONFIG_PATHS = [
  ["settings.json", "settings.json"],
  ["user-profile.json", "user-profile.json"],
  [path.join("skill-evolution", "config.json"), "skill-evolution-config.json"],
  ["statusline.json", "statusline.json"],
  [path.join("update", "pi-workbench", "profile.json"), "profile.json"],
] as const;

export type UpdateProfile = "default" | "full";
export type UpdateChannel = "stable" | "main-bootstrap";
export type UpdateCategory = "blocked" | "no-update" | "update-available" | "updated";
export type UpdateCode =
  | "READY"
  | "UPDATED"
  | "EQUAL"
  | "AHEAD"
  | "DIVERGED"
  | "INSTALL_UNSUPPORTED"
  | "ORIGIN_UNTRUSTED"
  | "CHECKOUT_DIRTY"
  | "SUBMODULE_DIRTY"
  | "PROFILE_REQUIRED"
  | "RELEASES_UNAVAILABLE"
  | "RELEASES_MALFORMED"
  | "RELEASES_OVERSIZE"
  | "CANDIDATE_INVALID"
  | "CANDIDATE_CHANGED"
  | "LOCK_BLOCKED"
  | "CONFIRMATION_REQUIRED"
  | "CANCELLED"
  | "BACKUP_FAILED"
  | "UPDATE_FAILED"
  | "ROLLED_BACK"
  | "ROLLBACK_INCOMPLETE"
  | "INVALID_ACTION";

export interface WorkbenchUpdateStatus {
  readonly category: UpdateCategory;
  readonly code: UpdateCode;
  readonly currentCommit?: string;
  readonly currentVersion?: string;
  readonly candidateCommit?: string;
  readonly candidate?: string;
  readonly channel?: UpdateChannel;
  readonly profile?: UpdateProfile;
}

export interface WorkbenchApplyResult extends WorkbenchUpdateStatus {
  readonly reload: boolean;
  readonly oldCommit?: string;
  readonly newCommit?: string;
  readonly backupId?: string;
}

interface Candidate {
  readonly sourceRef: string;
  readonly label: string;
  readonly channel: UpdateChannel;
}

interface FileSnapshot {
  readonly relativePath: string;
  readonly backupName: string;
  readonly exists: boolean;
  readonly mode?: number;
  readonly hash?: string;
  readonly bytes?: Buffer;
}

interface CheckoutSnapshot {
  readonly head: string;
  readonly rootStatus: string;
  readonly submoduleHead: string;
  readonly submoduleStatus: string;
}

interface BackupRecovery {
  readonly transactionRoot: string;
  readonly checkoutSnapshot: string;
  readonly failedCheckout: string;
  readonly configValues: Readonly<Record<string, string>>;
  failedCheckoutPreserved: boolean;
  configValuesPreserved: boolean;
}

interface BackupSnapshot {
  readonly id: string;
  readonly root: string;
  readonly oldCommit: string;
  readonly submodules: string;
  readonly checkout: CheckoutSnapshot;
  readonly files: readonly FileSnapshot[];
  readonly recovery: BackupRecovery;
}

interface RollbackInputs {
  readonly candidateCommit: string;
  readonly candidateSubmodule: string;
  readonly expectedFiles: readonly FileSnapshot[];
  readonly checkoutMutated: boolean;
}

interface Preflight {
  readonly currentCommit: string;
  readonly currentVersion: string;
  readonly profile: UpdateProfile;
  readonly submodules: string;
}

interface StatusInternal extends WorkbenchUpdateStatus {
  readonly sourceRef?: string;
  readonly submodules?: string;
}

export type RollbackCheckoutOperation = "preserve-failed-checkout" | "restore-checkout-snapshot";
export type RollbackConfigOperation = "preserve-current" | "restore-original";

export interface WorkbenchUpdaterDependencies {
  readonly root: string;
  readonly agentDir?: string;
  readonly exec: Exec;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly acquireLease?: (root: string, lockPath: string) => Promise<ExclusiveLease>;
  readonly afterInstallerSnapshot?: () => Promise<void> | void;
  readonly afterRollbackCheckoutAuthorization?: (operation: RollbackCheckoutOperation) => Promise<void> | void;
  readonly afterRollbackConfigAuthorization?: (relativePath: string, operation: RollbackConfigOperation) => Promise<void> | void;
}

export interface ApplyInteraction {
  readonly confirm: (title: string, message: string) => Promise<boolean>;
  readonly notify: (message: string, level: "info" | "warning" | "error") => void;
}

export interface WorkbenchUpdateRunner {
  status(): Promise<WorkbenchUpdateStatus>;
  apply(interaction: ApplyInteraction): Promise<WorkbenchApplyResult>;
}

class UpdateFailure extends Error {
  readonly code: UpdateCode;

  constructor(code: UpdateCode) {
    super(code);
    this.name = "UpdateFailure";
    this.code = code;
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedResult(result: ExecResult): ExecResult {
  if (byteLength(result.stdout) > MAX_COMMAND_BYTES || byteLength(result.stderr) > MAX_COMMAND_BYTES) {
    throw new UpdateFailure("UPDATE_FAILED");
  }
  return result;
}

function trimOneLine(value: string): string | undefined {
  const lines = value.replace(/\r/g, "").split("\n").filter((line) => line.length > 0);
  return lines.length === 1 ? lines[0] : undefined;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function blocked(code: UpdateCode, partial: Partial<WorkbenchUpdateStatus> = {}): StatusInternal {
  return { category: "blocked", code, ...partial };
}

function publicStatus(status: StatusInternal): WorkbenchUpdateStatus {
  const { sourceRef: _sourceRef, submodules: _submodules, ...visible } = status;
  return visible;
}

function semverParts(tag: string): readonly [bigint, bigint, bigint] {
  const [major, minor, patch] = tag.slice(1).split(".");
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

function compareTags(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RELEASE_BYTES)) {
    throw new UpdateFailure("RELEASES_OVERSIZE");
  }
  if (!response.body) throw new UpdateFailure("RELEASES_MALFORMED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_RELEASE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new UpdateFailure("RELEASES_OVERSIZE");
    }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseReleaseCandidate(value: unknown): Candidate {
  if (!Array.isArray(value) || value.length > 100 * MAX_RELEASE_PAGES) throw new UpdateFailure("RELEASES_MALFORMED");
  const stable: string[] = [];
  for (const release of value) {
    if (!release || typeof release !== "object" || Array.isArray(release)) throw new UpdateFailure("RELEASES_MALFORMED");
    const item = release as Record<string, unknown>;
    if (typeof item.draft !== "boolean" || typeof item.prerelease !== "boolean" || typeof item.tag_name !== "string") {
      throw new UpdateFailure("RELEASES_MALFORMED");
    }
    if (!item.draft && !item.prerelease && STABLE_TAG.test(item.tag_name)) {
      if (item.tag_name.length > 64) throw new UpdateFailure("RELEASES_MALFORMED");
      stable.push(item.tag_name);
    }
  }
  if (stable.length === 0) return { sourceRef: MAIN_REF, label: "main", channel: "main-bootstrap" };
  stable.sort(compareTags);
  const tag = stable.at(-1)!;
  return { sourceRef: `refs/tags/${tag}`, label: tag, channel: "stable" };
}

function parseProfile(value: unknown): UpdateProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => key !== "version" && key !== "profile")) return undefined;
  if (item.version !== 1 || (item.profile !== "default" && item.profile !== "full")) return undefined;
  return item.profile;
}

function safeRelativeSubmodule(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function parseSubmoduleStatus(status: string): { readonly commit: string; readonly path: string } {
  const rows = status.replace(/\r/g, "").split("\n").filter(Boolean);
  if (rows.length !== 1) throw new UpdateFailure("SUBMODULE_DIRTY");
  const match = /^ ([0-9a-f]{40,64}) ([^\s]+)(?: .*)?$/.exec(rows[0]);
  if (!match || match[2] !== "reprompter" || !safeRelativeSubmodule(match[2])) throw new UpdateFailure("SUBMODULE_DIRTY");
  return { commit: match[1], path: match[2] };
}

function parseCandidateGitlink(tree: string): string {
  const match = /^160000 commit ([0-9a-f]{40,64})\treprompter\0$/.exec(tree);
  if (!match) throw new UpdateFailure("CANDIDATE_INVALID");
  return match[1];
}

function gitmodulesAreTrusted(content: string): boolean {
  const lines = content.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length === 3
    && lines[0] === '[submodule "reprompter"]'
    && lines[1] === "path = reprompter"
    && lines[2] === `url = ${TRUSTED_REPROMPTER}`;
}

const SAFE_LOCAL_CONFIG_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "remote.origin.url",
  "remote.origin.fetch",
  "branch.main.remote",
  "branch.main.merge",
  "user.name",
  "user.email",
  "submodule.reprompter.active",
  "submodule.reprompter.url",
]);

const SAFE_SUBMODULE_CONFIG_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.worktree",
  "remote.origin.url",
  "remote.origin.fetch",
  "branch.main.remote",
  "branch.main.merge",
]);

function sameCheckout(left: CheckoutSnapshot, right: CheckoutSnapshot): boolean {
  return left.head === right.head
    && left.rootStatus === right.rootStatus
    && left.submoduleHead === right.submoduleHead
    && left.submoduleStatus === right.submoduleStatus;
}

function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.relativePath === right.relativePath
    && left.exists === right.exists
    && left.mode === right.mode
    && left.hash === right.hash
    && ((!left.exists && !right.exists) || (left.bytes !== undefined && right.bytes !== undefined && left.bytes.equals(right.bytes)));
}

function validBackupId(value: string): boolean {
  return /^[0-9TZ.-]{10,40}-[0-9a-f-]{16,40}$/i.test(value);
}

async function ensureRealDirectory(directory: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory).catch((error) => {
    if (isMissing(error)) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UpdateFailure("INSTALL_UNSUPPORTED");
  const real = await fs.realpath(directory);
  if (real !== path.resolve(directory)) throw new UpdateFailure("INSTALL_UNSUPPORTED");
}

async function assertSafeParents(base: string, pathname: string): Promise<void> {
  const relative = path.relative(base, pathname);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new UpdateFailure("INSTALL_UNSUPPORTED");
  let current = base;
  for (const part of path.dirname(relative).split(path.sep).filter((item) => item && item !== ".")) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UpdateFailure("INSTALL_UNSUPPORTED");
  }
}

async function assertSafeFile(pathname: string, allowMissing: boolean): Promise<Stats | undefined> {
  try {
    const stat = await fs.lstat(pathname);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    return stat;
  } catch (error) {
    if (allowMissing && isMissing(error)) return undefined;
    throw error;
  }
}

async function atomicWrite(pathname: string, bytes: Uint8Array, mode: number): Promise<void> {
  const parent = path.dirname(pathname);
  await ensureRealDirectory(parent, true);
  const temporary = path.join(parent, `.${path.basename(pathname)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, pathname);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function installFileNoReplace(pathname: string, bytes: Uint8Array, mode: number): Promise<void> {
  const parent = path.dirname(pathname);
  await ensureRealDirectory(parent, false);
  const temporary = path.join(parent, `.${path.basename(pathname)}.${randomUUID()}.restore`);
  const handle = await fs.open(temporary, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, pathname);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

const RENAME_NO_REPLACE_PROGRAM = [
  "import ctypes, os, sys",
  "source = os.fsencode(sys.argv[1])",
  "target = os.fsencode(sys.argv[2])",
  "libc = ctypes.CDLL(None, use_errno=True)",
  "if sys.platform == 'darwin':",
  "    result = libc.renamex_np(source, target, 4)",
  "else:",
  "    result = libc.renameat2(-100, source, -100, target, 1)",
  "if result != 0:",
  "    error = ctypes.get_errno()",
  "    raise OSError(error, os.strerror(error), sys.argv[2])",
].join("\n");

export class WorkbenchUpdater {
  readonly root: string;
  readonly agentDir: string;
  private readonly exec: Exec;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly acquireLease: (root: string, lockPath: string) => Promise<ExclusiveLease>;
  private readonly afterInstallerSnapshot?: () => Promise<void> | void;
  private readonly afterRollbackCheckoutAuthorization?: (operation: RollbackCheckoutOperation) => Promise<void> | void;
  private readonly afterRollbackConfigAuthorization?: (relativePath: string, operation: RollbackConfigOperation) => Promise<void> | void;

  constructor(dependencies: WorkbenchUpdaterDependencies) {
    const requestedRoot = path.resolve(dependencies.root);
    try {
      this.root = realpathSync(requestedRoot);
    } catch {
      this.root = requestedRoot;
    }
    this.agentDir = path.resolve(dependencies.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
    this.exec = dependencies.exec;
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
    this.acquireLease = dependencies.acquireLease ?? ((root, lockPath) => acquireExclusiveLeaseAtPath(root, lockPath, "workbench-update"));
    this.afterInstallerSnapshot = dependencies.afterInstallerSnapshot;
    this.afterRollbackCheckoutAuthorization = dependencies.afterRollbackCheckoutAuthorization;
    this.afterRollbackConfigAuthorization = dependencies.afterRollbackConfigAuthorization;
  }

  private async command(command: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<ExecResult> {
    return boundedResult(await this.exec(command, args, { timeout }));
  }

  private async gitAt(directory: string, args: string[], accepted: readonly number[] = [0]): Promise<ExecResult> {
    const result = await this.command("env", [
      ...SAFE_GIT_ENV,
      "git",
      "--no-replace-objects",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "-C",
      directory,
      ...args,
    ]);
    if (!accepted.includes(result.code) || result.killed) throw new UpdateFailure("UPDATE_FAILED");
    return result;
  }

  private git(args: string[], accepted: readonly number[] = [0]): Promise<ExecResult> {
    return this.gitAt(this.root, args, accepted);
  }

  private async renameNoReplace(source: string, target: string): Promise<void> {
    const result = await this.command("env", [
      "-i",
      `HOME=${os.homedir()}`,
      `PATH=${SAFE_PATH}`,
      "LANG=C",
      "LC_ALL=C",
      "PYTHONNOUSERSITE=1",
      "PYTHONDONTWRITEBYTECODE=1",
      "python3",
      "-I",
      "-S",
      "-c",
      RENAME_NO_REPLACE_PROGRAM,
      source,
      target,
    ]);
    if (result.code !== 0 || result.killed) throw new UpdateFailure("UPDATE_FAILED");
  }

  private async assertRepositoryTrustAt(root: string): Promise<void> {
    for (const pathname of [path.join(root, ".git", "info", "grafts"), path.join(root, ".git", "info", "attributes")]) {
      if (await fs.lstat(pathname).then(() => true, (error) => isMissing(error) ? false : Promise.reject(error))) {
        throw new UpdateFailure("INSTALL_UNSUPPORTED");
      }
    }
    const excludePath = path.join(root, ".git", "info", "exclude");
    const exclude = await fs.readFile(excludePath, "utf8").catch((error) => isMissing(error) ? "" : Promise.reject(error));
    if (exclude.split(/\r?\n/).some((line) => line.trim() && !line.trimStart().startsWith("#"))) {
      throw new UpdateFailure("INSTALL_UNSUPPORTED");
    }
    const replacements = await this.gitAt(root, ["for-each-ref", "--format=%(refname)", "refs/replace"]);
    if (replacements.stdout !== "") throw new UpdateFailure("INSTALL_UNSUPPORTED");
    const config = await this.gitAt(root, ["config", "--local", "--name-only", "--null", "--list"]);
    const keys = config.stdout.split("\0").filter(Boolean).map((key) => key.toLowerCase());
    if (keys.some((key) => !SAFE_LOCAL_CONFIG_KEYS.has(key))) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    const submoduleUrls = (await this.gitAt(root, ["config", "--local", "--get-all", "submodule.reprompter.url"], [0, 1])).stdout
      .replace(/\r/g, "").split("\n").filter(Boolean);
    if (submoduleUrls.length > 1 || (submoduleUrls.length === 1 && submoduleUrls[0] !== TRUSTED_REPROMPTER)) {
      throw new UpdateFailure("INSTALL_UNSUPPORTED");
    }
  }

  private assertRepositoryTrust(): Promise<void> {
    return this.assertRepositoryTrustAt(this.root);
  }

  private async assertSubmoduleLayoutAt(root: string): Promise<string> {
    const checkout = path.join(root, "reprompter");
    const checkoutStat = await fs.lstat(checkout).catch(() => undefined);
    if (!checkoutStat?.isDirectory() || checkoutStat.isSymbolicLink() || await fs.realpath(checkout) !== checkout) {
      throw new UpdateFailure("SUBMODULE_DIRTY");
    }
    const expectedMetadata = path.join(root, ".git", "modules", "reprompter");
    let metadataResult: ExecResult;
    try {
      metadataResult = await this.gitAt(checkout, ["rev-parse", "--absolute-git-dir"]);
    } catch {
      throw new UpdateFailure("SUBMODULE_DIRTY");
    }
    const metadataValue = trimOneLine(metadataResult.stdout);
    const metadataStat = await fs.lstat(expectedMetadata).catch(() => undefined);
    if (!metadataValue
      || path.resolve(metadataValue) !== expectedMetadata
      || !metadataStat?.isDirectory()
      || metadataStat.isSymbolicLink()
      || await fs.realpath(expectedMetadata) !== expectedMetadata) {
      throw new UpdateFailure("SUBMODULE_DIRTY");
    }
    if (await fs.lstat(path.join(checkout, ".gitmodules")).then(() => true, (error) => isMissing(error) ? false : Promise.reject(error))) {
      throw new UpdateFailure("SUBMODULE_DIRTY");
    }
    for (const pathname of [path.join(expectedMetadata, "info", "grafts"), path.join(expectedMetadata, "info", "attributes")]) {
      if (await fs.lstat(pathname).then(() => true, (error) => isMissing(error) ? false : Promise.reject(error))) {
        throw new UpdateFailure("INSTALL_UNSUPPORTED");
      }
    }
    const excludePath = path.join(expectedMetadata, "info", "exclude");
    const exclude = await fs.readFile(excludePath, "utf8").catch((error) => isMissing(error) ? "" : Promise.reject(error));
    if (exclude.split(/\r?\n/).some((line) => line.trim() && !line.trimStart().startsWith("#"))) {
      throw new UpdateFailure("INSTALL_UNSUPPORTED");
    }
    const replacements = await this.gitAt(checkout, ["for-each-ref", "--format=%(refname)", "refs/replace"]);
    if (replacements.stdout !== "") throw new UpdateFailure("INSTALL_UNSUPPORTED");
    const config = await this.gitAt(checkout, ["config", "--local", "--name-only", "--null", "--list"]);
    const keys = config.stdout.split("\0").filter(Boolean).map((key) => key.toLowerCase());
    if (keys.some((key) => !SAFE_SUBMODULE_CONFIG_KEYS.has(key))) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    const origins = (await this.gitAt(checkout, ["config", "--local", "--get-all", "remote.origin.url"], [0, 1])).stdout
      .replace(/\r/g, "").split("\n").filter(Boolean);
    if (origins.length !== 1 || origins[0] !== TRUSTED_REPROMPTER) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    const worktrees = (await this.gitAt(checkout, ["config", "--local", "--get-all", "core.worktree"], [0, 1])).stdout
      .replace(/\r/g, "").split("\n").filter(Boolean);
    if (worktrees.length !== 1 || path.resolve(expectedMetadata, worktrees[0]) !== checkout) {
      throw new UpdateFailure("INSTALL_UNSUPPORTED");
    }
    return checkout;
  }

  private assertSubmoduleLayout(): Promise<string> {
    return this.assertSubmoduleLayoutAt(this.root);
  }

  private async inspectSubmodulesAt(root: string): Promise<string> {
    const result = await this.gitAt(root, ["submodule", "status"]);
    parseSubmoduleStatus(result.stdout);
    const checkout = await this.assertSubmoduleLayoutAt(root);
    const status = await this.gitAt(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status.stdout !== "") throw new UpdateFailure("SUBMODULE_DIRTY");
    return result.stdout;
  }

  private inspectSubmodules(): Promise<string> {
    return this.inspectSubmodulesAt(this.root);
  }

  private async captureCheckoutAt(root: string, ignoreSubmodules: boolean): Promise<CheckoutSnapshot> {
    const checkout = await this.assertSubmoduleLayoutAt(root);
    const head = trimOneLine((await this.gitAt(root, ["rev-parse", "HEAD"])).stdout);
    const submoduleHead = trimOneLine((await this.gitAt(checkout, ["rev-parse", "HEAD"])).stdout);
    if (!head || !submoduleHead || !COMMIT.test(head) || !COMMIT.test(submoduleHead)) throw new UpdateFailure("UPDATE_FAILED");
    const rootStatus = (await this.gitAt(root, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all", ...(ignoreSubmodules ? ["--ignore-submodules=all"] : []),
    ])).stdout;
    const submoduleStatus = (await this.gitAt(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    return { head, rootStatus, submoduleHead, submoduleStatus };
  }

  private captureCheckout(): Promise<CheckoutSnapshot> {
    return this.captureCheckoutAt(this.root, false);
  }

  private managedSources(profile: UpdateProfile): Array<readonly [string, "file" | "directory"]> {
    const sources: Array<readonly [string, "file" | "directory"]> = [
      ["setup/cmux-workbench.ts", "file"],
      ["setup/pi-look", "directory"],
      ["setup/themes/ember.json", "file"],
    ];
    if (profile === "full") sources.push(["startup-header.ts", "file"]);
    return sources;
  }

  private async validateManagedSourcesAtCommit(commit: string, profile: UpdateProfile): Promise<void> {
    const sources = this.managedSources(profile);
    const result = await this.git(["ls-tree", "-z", commit, "--", ...sources.map(([relative]) => relative)]);
    const records = result.stdout.split("\0").filter(Boolean);
    if (records.length !== sources.length) throw new UpdateFailure("CANDIDATE_INVALID");
    const actual = new Map<string, { mode: string; type: string }>();
    for (const record of records) {
      const match = /^(\d{6}) (blob|tree) [0-9a-f]{40,64}\t(.+)$/.exec(record);
      if (!match || actual.has(match[3])) throw new UpdateFailure("CANDIDATE_INVALID");
      actual.set(match[3], { mode: match[1], type: match[2] });
    }
    for (const [relative, kind] of sources) {
      const item = actual.get(relative);
      if (!item
        || (kind === "file" && (item.type !== "blob" || (item.mode !== "100644" && item.mode !== "100755")))
        || (kind === "directory" && (item.type !== "tree" || item.mode !== "040000"))) {
        throw new UpdateFailure("CANDIDATE_INVALID");
      }
    }
  }

  private async assertExpectedLinks(profile: UpdateProfile): Promise<void> {
    const extensionLink = path.join(this.agentDir, "extensions", "pi-workbench");
    if (extensionLink !== this.root) {
      await assertSafeParents(this.agentDir, extensionLink);
      const extensionStat = await fs.lstat(extensionLink).catch(() => undefined);
      if (!extensionStat?.isSymbolicLink() || path.resolve(path.dirname(extensionLink), await fs.readlink(extensionLink)) !== this.root) {
        throw new UpdateFailure("INSTALL_UNSUPPORTED");
      }
    }
    const linkFor = (relative: string): string => relative === "setup/themes/ember.json"
      ? path.join(this.agentDir, "themes", "ember.json")
      : path.join(this.agentDir, "extensions", relative === "startup-header.ts" ? relative : path.basename(relative));
    for (const [relative, kind] of this.managedSources(profile)) {
      const link = linkFor(relative);
      const expected = path.join(this.root, relative);
      await assertSafeParents(this.agentDir, link);
      const stat = await fs.lstat(link).catch(() => undefined);
      if (!stat?.isSymbolicLink()) throw new UpdateFailure("INSTALL_UNSUPPORTED");
      const target = await fs.readlink(link);
      if (path.resolve(path.dirname(link), target) !== expected) throw new UpdateFailure("INSTALL_UNSUPPORTED");
      const expectedStat = await fs.lstat(expected).catch(() => undefined);
      if (!expectedStat
        || expectedStat.isSymbolicLink()
        || (kind === "file" && !expectedStat.isFile())
        || (kind === "directory" && !expectedStat.isDirectory())) {
        throw new UpdateFailure("INSTALL_UNSUPPORTED");
      }
    }
  }

  private async readProfile(): Promise<UpdateProfile> {
    const marker = path.join(this.agentDir, "update", "pi-workbench", "profile.json");
    try {
      await ensureRealDirectory(this.agentDir, false);
      await assertSafeParents(this.agentDir, marker);
    } catch {
      throw new UpdateFailure("PROFILE_REQUIRED");
    }
    const stat = await assertSafeFile(marker, true);
    if (!stat || stat.size > 4_096) throw new UpdateFailure("PROFILE_REQUIRED");
    try {
      const profile = parseProfile(JSON.parse(await fs.readFile(marker, "utf8")));
      if (!profile) throw new UpdateFailure("PROFILE_REQUIRED");
      return profile;
    } catch (error) {
      if (error instanceof UpdateFailure) throw error;
      throw new UpdateFailure("PROFILE_REQUIRED");
    }
  }

  private async preflight(): Promise<Preflight> {
    await ensureRealDirectory(this.root, false);
    await fs.access(this.root, fs.constants.R_OK | fs.constants.W_OK);
    const gitDirectory = path.join(this.root, ".git");
    const gitStat = await assertSafeFile(gitDirectory, true).catch((error) => {
      if (error instanceof UpdateFailure) return undefined;
      throw error;
    });
    if (gitStat) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    const actualGit = await fs.lstat(gitDirectory).catch(() => undefined);
    if (!actualGit?.isDirectory() || actualGit.isSymbolicLink()) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    await fs.access(gitDirectory, fs.constants.R_OK | fs.constants.W_OK);
    await this.validateGitmodules();

    const topLevel = trimOneLine((await this.git(["rev-parse", "--show-toplevel"])).stdout);
    if (!topLevel || await fs.realpath(topLevel) !== this.root) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    const branch = trimOneLine((await this.git(["symbolic-ref", "--quiet", "HEAD"], [0, 1])).stdout);
    if (branch !== "refs/heads/main") throw new UpdateFailure("INSTALL_UNSUPPORTED");

    const remotes = (await this.git(["remote"])).stdout.replace(/\r/g, "").split("\n").filter(Boolean);
    if (remotes.length !== 1 || remotes[0] !== "origin") throw new UpdateFailure("ORIGIN_UNTRUSTED");
    const configuredOrigins = (await this.git(["config", "--get-all", "remote.origin.url"])).stdout.replace(/\r/g, "").split("\n").filter(Boolean);
    if (configuredOrigins.length !== 1 || !TRUSTED_ORIGIN_PATTERN.test(configuredOrigins[0])) throw new UpdateFailure("ORIGIN_UNTRUSTED");
    const pushUrls = await this.git(["config", "--get-all", "remote.origin.pushurl"], [0, 1]);
    if (pushUrls.stdout !== "") throw new UpdateFailure("ORIGIN_UNTRUSTED");
    await this.assertRepositoryTrust();

    const submodules = await this.inspectSubmodules();
    const tree = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (tree.stdout !== "") throw new UpdateFailure("CHECKOUT_DIRTY");
    const currentCommit = trimOneLine((await this.git(["rev-parse", "HEAD"])).stdout);
    if (!currentCommit || !COMMIT.test(currentCommit)) throw new UpdateFailure("INSTALL_UNSUPPORTED");

    const packagePath = path.join(this.root, "package.json");
    const packageStat = await assertSafeFile(packagePath, false);
    if (!packageStat || packageStat.size > 1024 * 1024) throw new UpdateFailure("INSTALL_UNSUPPORTED");
    let currentVersion: string;
    try {
      const manifest = JSON.parse(await fs.readFile(packagePath, "utf8")) as { version?: unknown };
      if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error();
      currentVersion = manifest.version;
    } catch {
      throw new UpdateFailure("INSTALL_UNSUPPORTED");
    }
    const profile = await this.readProfile();
    await this.assertExpectedLinks(profile);
    return { currentCommit, currentVersion, profile, submodules };
  }

  private async releaseCandidate(): Promise<Candidate> {
    const signal = AbortSignal.timeout(RELEASE_TIMEOUT_MS);
    const releases: unknown[] = [];
    let totalBytes = 0;
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      let response: Response;
      try {
        const url = page === 1 ? RELEASES_URL : `${RELEASES_URL}&page=${page}`;
        response = await this.fetchImpl(url, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-workbench-updater" },
          redirect: "error",
          signal,
        });
      } catch {
        throw new UpdateFailure("RELEASES_UNAVAILABLE");
      }
      if (response.status !== 200) throw new UpdateFailure("RELEASES_UNAVAILABLE");
      const text = await readBoundedResponse(response);
      totalBytes += byteLength(text);
      if (totalBytes > MAX_RELEASE_BYTES) throw new UpdateFailure("RELEASES_OVERSIZE");
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new UpdateFailure("RELEASES_MALFORMED");
      }
      if (!Array.isArray(value) || value.length > 100) throw new UpdateFailure("RELEASES_MALFORMED");
      releases.push(...value);
      const hasNext = /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:\s*(?:,|$))/.test(response.headers.get("link") ?? "");
      if (!hasNext) return parseReleaseCandidate(releases);
      if (page === MAX_RELEASE_PAGES) throw new UpdateFailure("RELEASES_OVERSIZE");
    }
    throw new UpdateFailure("RELEASES_OVERSIZE");
  }

  private async fetchCandidate(candidate: Candidate): Promise<string> {
    const refspec = `+${candidate.sourceRef}:${PRIVATE_REF}`;
    await this.git(["fetch", "--no-tags", "--force", "--no-recurse-submodules", TRUSTED_REPOSITORY, refspec]);
    const commit = trimOneLine((await this.git(["rev-parse", "--verify", `${PRIVATE_REF}^{commit}`])).stdout);
    if (!commit || !COMMIT.test(commit)) throw new UpdateFailure("CANDIDATE_INVALID");
    return commit;
  }

  private async computeStatus(): Promise<StatusInternal> {
    let partial: Partial<StatusInternal> = {};
    try {
      const local = await this.preflight();
      partial = {
        currentCommit: local.currentCommit,
        currentVersion: local.currentVersion,
        profile: local.profile,
        submodules: local.submodules,
      };
      const candidate = await this.releaseCandidate();
      partial = { ...partial, candidate: candidate.label, channel: candidate.channel, sourceRef: candidate.sourceRef };
      const candidateCommit = await this.fetchCandidate(candidate);
      partial = { ...partial, candidateCommit };
      await this.validateGitmodules(candidateCommit);
      await this.validateManagedSourcesAtCommit(candidateCommit, local.profile);
      if (candidateCommit === local.currentCommit) return { category: "no-update", code: "EQUAL", ...partial };

      const candidateBehind = await this.git(["merge-base", "--is-ancestor", candidateCommit, local.currentCommit], [0, 1]);
      if (candidateBehind.code === 0) return { category: "no-update", code: "AHEAD", ...partial };
      const candidateAhead = await this.git(["merge-base", "--is-ancestor", local.currentCommit, candidateCommit], [0, 1]);
      if (candidateAhead.code === 0) return { category: "update-available", code: "READY", ...partial };
      return { category: "blocked", code: "DIVERGED", ...partial };
    } catch (error) {
      return blocked(error instanceof UpdateFailure ? error.code : "UPDATE_FAILED", partial);
    }
  }

  private async acquireUpdateLease(lockPath: string): Promise<ExclusiveLease> {
    await ensureRealDirectory(this.agentDir, false);
    await assertSafeParents(this.agentDir, lockPath);
    return this.acquireLease(this.root, lockPath);
  }

  async status(): Promise<WorkbenchUpdateStatus> {
    const lockPath = path.join(this.agentDir, "update", "pi-workbench", "update.lock");
    let lease: ExclusiveLease;
    try {
      lease = await this.acquireUpdateLease(lockPath);
    } catch {
      return { category: "blocked", code: "LOCK_BLOCKED" };
    }
    try {
      return publicStatus(await this.computeStatus());
    } finally {
      await lease.release();
    }
  }

  private sameCandidate(first: StatusInternal, second: StatusInternal): boolean {
    return first.category === "update-available"
      && second.category === "update-available"
      && first.currentCommit === second.currentCommit
      && first.candidateCommit === second.candidateCommit
      && first.candidate === second.candidate
      && first.channel === second.channel
      && first.profile === second.profile
      && first.sourceRef === second.sourceRef
      && first.submodules === second.submodules;
  }

  private async snapshotFileAt(base: string, relativePath: string, backupName: string): Promise<FileSnapshot> {
    const pathname = path.join(base, relativePath);
    await assertSafeParents(base, pathname);
    const stat = await assertSafeFile(pathname, true);
    if (!stat) return { relativePath, backupName, exists: false };
    if (stat.size > 5 * 1024 * 1024) throw new UpdateFailure("BACKUP_FAILED");
    const bytes = await fs.readFile(pathname);
    return { relativePath, backupName, exists: true, mode: stat.mode & 0o7777, hash: hash(bytes), bytes };
  }

  private snapshotFile(relativePath: string, backupName: string): Promise<FileSnapshot> {
    return this.snapshotFileAt(this.agentDir, relativePath, backupName);
  }

  private async snapshotManagedFilesAt(base: string): Promise<FileSnapshot[]> {
    const files: FileSnapshot[] = [];
    for (const [relative, name] of CONFIG_PATHS) files.push(await this.snapshotFileAt(base, relative, name));
    return files;
  }

  private snapshotManagedFiles(): Promise<FileSnapshot[]> {
    return this.snapshotManagedFilesAt(this.agentDir);
  }

  private async validateTrustedCheckout(root: string, expected: CheckoutSnapshot, submodules: string): Promise<void> {
    await ensureRealDirectory(root, false);
    if (await fs.realpath(root) !== root) throw new UpdateFailure("BACKUP_FAILED");
    const gitDirectory = path.join(root, ".git");
    const gitStat = await fs.lstat(gitDirectory);
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink() || await fs.realpath(gitDirectory) !== gitDirectory) {
      throw new UpdateFailure("BACKUP_FAILED");
    }
    const topLevel = trimOneLine((await this.gitAt(root, ["rev-parse", "--show-toplevel"])).stdout);
    const branch = trimOneLine((await this.gitAt(root, ["symbolic-ref", "--quiet", "HEAD"], [0, 1])).stdout);
    const remotes = (await this.gitAt(root, ["remote"])).stdout.replace(/\r/g, "").split("\n").filter(Boolean);
    const origins = (await this.gitAt(root, ["config", "--get-all", "remote.origin.url"])).stdout.replace(/\r/g, "").split("\n").filter(Boolean);
    const pushUrls = await this.gitAt(root, ["config", "--get-all", "remote.origin.pushurl"], [0, 1]);
    if (topLevel !== root
      || branch !== "refs/heads/main"
      || remotes.length !== 1
      || remotes[0] !== "origin"
      || origins.length !== 1
      || !TRUSTED_ORIGIN_PATTERN.test(origins[0])
      || pushUrls.stdout !== "") {
      throw new UpdateFailure("BACKUP_FAILED");
    }
    await this.assertRepositoryTrustAt(root);
    await this.validateGitmodulesAt(root);
    const captured = await this.captureCheckoutAt(root, false);
    const capturedSubmodules = await this.inspectSubmodulesAt(root);
    if (!sameCheckout(captured, expected) || capturedSubmodules !== submodules) throw new UpdateFailure("BACKUP_FAILED");
  }

  private async createBackup(status: StatusInternal): Promise<BackupSnapshot> {
    if (!status.currentCommit || !status.submodules) throw new UpdateFailure("BACKUP_FAILED");
    try {
      await ensureRealDirectory(this.agentDir, false);
      const id = `${this.now().toISOString().replace(/:/g, "-")}-${this.createId()}`;
      if (!validBackupId(id)) throw new UpdateFailure("BACKUP_FAILED");
      const backupParent = path.join(this.agentDir, "backups", "update");
      const backupRoot = path.join(backupParent, id);
      await assertSafeParents(this.agentDir, backupRoot);
      await ensureRealDirectory(backupParent, true);
      await fs.mkdir(backupRoot, { mode: 0o700 });
      const files = await this.snapshotManagedFiles();
      const configRoot = path.join(backupRoot, "config");
      const configRecoveryRoot = path.join(backupRoot, "recovery", "config");
      await ensureRealDirectory(configRoot, true);
      await ensureRealDirectory(configRecoveryRoot, true);
      for (const item of files) {
        if (item.exists && item.bytes && item.mode !== undefined) {
          await atomicWrite(path.join(configRoot, item.backupName), item.bytes, item.mode);
        }
      }
      const checkout = await this.captureCheckout();
      const backedUpSubmodule = parseSubmoduleStatus(status.submodules).commit;
      if (checkout.head !== status.currentCommit
        || checkout.submoduleHead !== backedUpSubmodule
        || checkout.rootStatus !== ""
        || checkout.submoduleStatus !== "") {
        throw new UpdateFailure("BACKUP_FAILED");
      }

      const resolvedRoot = await fs.realpath(this.root);
      if (resolvedRoot !== this.root) throw new UpdateFailure("BACKUP_FAILED");
      const rootParent = path.dirname(resolvedRoot);
      await ensureRealDirectory(rootParent, false);
      const transactionName = `.pi-workbench-update-${hash(Buffer.from(id)).slice(0, 24)}`;
      const transactionRoot = path.join(rootParent, transactionName);
      if (path.dirname(transactionRoot) !== rootParent || path.basename(transactionRoot) !== transactionName) {
        throw new UpdateFailure("BACKUP_FAILED");
      }
      const transactionStat = await fs.lstat(transactionRoot).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
      if (transactionStat) throw new UpdateFailure("BACKUP_FAILED");
      await fs.mkdir(transactionRoot, { mode: 0o700 });
      const rootDevice = (await fs.stat(resolvedRoot)).dev;
      if ((await fs.stat(transactionRoot)).dev !== rootDevice || await fs.realpath(rootParent) !== rootParent) {
        throw new UpdateFailure("BACKUP_FAILED");
      }
      const checkoutSnapshot = path.join(transactionRoot, "checkout-snapshot");
      const failedCheckout = path.join(transactionRoot, "failed-checkout");
      for (const pathname of [checkoutSnapshot, failedCheckout]) {
        if (path.dirname(pathname) !== transactionRoot || await fs.lstat(pathname).catch((error) => isMissing(error) ? undefined : Promise.reject(error))) {
          throw new UpdateFailure("BACKUP_FAILED");
        }
      }
      await fs.cp(resolvedRoot, checkoutSnapshot, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      await this.validateTrustedCheckout(checkoutSnapshot, checkout, status.submodules);
      const recovery: BackupRecovery = {
        transactionRoot,
        checkoutSnapshot,
        failedCheckout,
        configValues: Object.fromEntries(files.map((item) => [item.backupName, path.join(configRecoveryRoot, `${item.backupName}.current`)])),
        failedCheckoutPreserved: false,
        configValuesPreserved: false,
      };
      const manifest = {
        version: 2,
        oldCommit: status.currentCommit,
        submodules: status.submodules,
        checkout,
        files: files.map(({ relativePath, backupName, exists, mode, hash: digest }) => ({ relativePath, backupName, exists, mode, hash: digest })),
        recovery: {
          transactionRoot: recovery.transactionRoot,
          checkoutSnapshot: recovery.checkoutSnapshot,
          failedCheckout: recovery.failedCheckout,
          configValues: recovery.configValues,
        },
      };
      await atomicWrite(path.join(backupRoot, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o600);
      return { id, root: backupRoot, oldCommit: status.currentCommit, submodules: status.submodules, checkout, files, recovery };
    } catch (error) {
      if (error instanceof UpdateFailure) throw error;
      throw new UpdateFailure("BACKUP_FAILED");
    }
  }

  private async validateGitmodulesAt(root: string, commit?: string): Promise<void> {
    let content: string;
    if (commit) {
      const shown = await this.gitAt(root, ["show", `${commit}:.gitmodules`]);
      content = shown.stdout;
    } else {
      const pathname = path.join(root, ".gitmodules");
      const stat = await assertSafeFile(pathname, false);
      if (!stat || stat.size > 8_192) throw new UpdateFailure("UPDATE_FAILED");
      content = await fs.readFile(pathname, "utf8");
    }
    if (byteLength(content) > 8_192 || !gitmodulesAreTrusted(content)) throw new UpdateFailure("UPDATE_FAILED");
  }

  private validateGitmodules(commit?: string): Promise<void> {
    return this.validateGitmodulesAt(this.root, commit);
  }

  private async candidateSubmodule(commit: string): Promise<string> {
    const tree = await this.git(["ls-tree", "-z", commit, "--", "reprompter"]);
    return parseCandidateGitlink(tree.stdout);
  }

  private async materializeExpectedInstallerFiles(backup: BackupSnapshot, profile: UpdateProfile): Promise<FileSnapshot[]> {
    const simulationRoot = path.join(backup.root, "installer-simulation");
    const simulatedAgent = path.join(simulationRoot, "agent");
    const simulatedBackup = path.join(simulationRoot, "backup");
    const simulatedHome = path.join(simulationRoot, "home");
    await ensureRealDirectory(simulationRoot, true);
    await fs.chmod(simulationRoot, 0o700);
    await ensureRealDirectory(simulatedAgent, true);
    await ensureRealDirectory(simulatedBackup, true);
    await ensureRealDirectory(simulatedHome, true);
    for (const item of backup.files) {
      if (!item.exists) continue;
      if (!item.bytes || item.mode === undefined) throw new UpdateFailure("BACKUP_FAILED");
      const pathname = path.join(simulatedAgent, item.relativePath);
      await assertSafeParents(simulatedAgent, pathname);
      await atomicWrite(pathname, item.bytes, item.mode);
    }

    const script = path.join(this.root, "scripts", "install-config.py");
    await assertSafeParents(this.root, script);
    const scriptStat = await assertSafeFile(script, false);
    if (!scriptStat || scriptStat.size > 1024 * 1024) throw new UpdateFailure("UPDATE_FAILED");
    const args = [
      "-i",
      `HOME=${simulatedHome}`,
      `PATH=${SAFE_PATH}`,
      "LANG=C",
      "LC_ALL=C",
      "NO_COLOR=1",
      "PYTHONNOUSERSITE=1",
      "PYTHONDONTWRITEBYTECODE=1",
      `PI_CODING_AGENT_DIR=${simulatedAgent}`,
      "python3",
      script,
      "apply",
      "--agent-dir", simulatedAgent,
      "--root", this.root,
      "--backup-root", simulatedBackup,
      ...(profile === "full" ? ["--full"] : []),
    ];
    const result = await this.command("env", args, INSTALL_TIMEOUT_MS);
    if (result.code !== 0 || result.killed) throw new UpdateFailure("UPDATE_FAILED");
    return this.snapshotManagedFilesAt(simulatedAgent);
  }

  private async assertLiveFilesOriginal(files: readonly FileSnapshot[]): Promise<void> {
    const current = await this.snapshotManagedFiles();
    if (current.length !== files.length || current.some((item, index) => !sameFile(item, files[index]))) {
      throw new UpdateFailure("UPDATE_FAILED");
    }
  }

  private async assertLiveFilesExpected(
    original: readonly FileSnapshot[],
    expected: readonly FileSnapshot[],
  ): Promise<void> {
    const current = await this.snapshotManagedFiles();
    if (current.length !== original.length
      || expected.length !== original.length
      || current.some((item, index) => !sameFile(item, original[index]) && !sameFile(item, expected[index]))) {
      throw new UpdateFailure("UPDATE_FAILED");
    }
  }

  private async postverify(candidateCommit: string, profile: UpdateProfile): Promise<void> {
    const head = trimOneLine((await this.git(["rev-parse", "HEAD"])).stdout);
    if (head !== candidateCommit) throw new UpdateFailure("UPDATE_FAILED");
    const tree = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (tree.stdout !== "") throw new UpdateFailure("UPDATE_FAILED");
    await this.inspectSubmodules();
    if (await this.readProfile() !== profile) throw new UpdateFailure("UPDATE_FAILED");
    await this.assertExpectedLinks(profile);
  }

  private async verifyFileAt(pathname: string, item: FileSnapshot): Promise<boolean> {
    try {
      const stat = await fs.lstat(pathname);
      if (!item.exists || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== item.mode) return false;
      return hash(await fs.readFile(pathname)) === item.hash;
    } catch (error) {
      return !item.exists && isMissing(error);
    }
  }

  private async restoreFile(backup: BackupSnapshot, item: FileSnapshot, expected: FileSnapshot): Promise<boolean> {
    const pathname = path.join(this.agentDir, item.relativePath);
    const preserved = backup.recovery.configValues[item.backupName];
    if (!preserved) return false;
    try {
      let current = await this.snapshotFile(item.relativePath, item.backupName);
      if (sameFile(current, item)) return true;
      if (!sameFile(current, expected)) return false;
      await assertSafeParents(this.agentDir, pathname);
      await assertSafeParents(backup.root, preserved);
      await ensureRealDirectory(path.dirname(preserved), false);

      if (current.exists) {
        if (await fs.lstat(preserved).catch((error) => isMissing(error) ? undefined : Promise.reject(error))) return false;
        await this.afterRollbackConfigAuthorization?.(item.relativePath, "preserve-current");
        await ensureRealDirectory(this.agentDir, false);
        await ensureRealDirectory(path.dirname(preserved), false);
        if (await fs.lstat(preserved).catch((error) => isMissing(error) ? undefined : Promise.reject(error))) return false;
        current = await this.snapshotFile(item.relativePath, item.backupName);
        if (!sameFile(current, expected)) return false;
        await this.renameNoReplace(pathname, preserved);
        if (!await this.verifyFileAt(preserved, expected)) return false;
        backup.recovery.configValuesPreserved = true;
      }

      if (!item.exists) return await this.verifyFileAt(pathname, item);
      if (!item.bytes || item.mode === undefined) return false;
      await this.afterRollbackConfigAuthorization?.(item.relativePath, "restore-original");
      await ensureRealDirectory(this.agentDir, false);
      await assertSafeParents(this.agentDir, pathname);
      const canonical = await fs.lstat(pathname).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
      if (canonical) return false;
      await installFileNoReplace(pathname, item.bytes, item.mode);
      return await this.verifyFileAt(pathname, item);
    } catch {
      return false;
    }
  }

  private async verifyRestoredFile(item: FileSnapshot): Promise<boolean> {
    const pathname = path.join(this.agentDir, item.relativePath);
    try {
      await assertSafeParents(this.agentDir, pathname);
      return await this.verifyFileAt(pathname, item);
    } catch {
      return false;
    }
  }

  private captureRollbackCheckout(root = this.root): Promise<CheckoutSnapshot> {
    return this.captureCheckoutAt(root, true);
  }

  private rollbackStateIsExpected(current: CheckoutSnapshot, backup: BackupSnapshot, inputs: RollbackInputs): boolean {
    if (current.rootStatus !== "" || current.submoduleStatus !== "") return false;
    const oldSubmodule = backup.checkout.submoduleHead;
    return (current.head === backup.oldCommit && current.submoduleHead === oldSubmodule)
      || (current.head === inputs.candidateCommit && current.submoduleHead === oldSubmodule)
      || (current.head === inputs.candidateCommit && current.submoduleHead === inputs.candidateSubmodule);
  }

  private async transactionDirectoryIsTrusted(backup: BackupSnapshot): Promise<boolean> {
    try {
      const stat = await fs.lstat(backup.recovery.transactionRoot);
      return stat.isDirectory()
        && !stat.isSymbolicLink()
        && await fs.realpath(backup.recovery.transactionRoot) === backup.recovery.transactionRoot
        && path.dirname(backup.recovery.transactionRoot) === path.dirname(this.root)
        && (await fs.stat(backup.recovery.transactionRoot)).dev === (await fs.stat(path.dirname(this.root))).dev;
    } catch {
      return false;
    }
  }

  private async restoreCheckoutBySwap(backup: BackupSnapshot, inputs: RollbackInputs): Promise<boolean> {
    if (!inputs.checkoutMutated) {
      try {
        const current = await this.captureCheckout();
        const submodules = await this.inspectSubmodules();
        return sameCheckout(current, backup.checkout) && submodules === backup.submodules;
      } catch {
        return false;
      }
    }

    let classified = false;
    try {
      classified = this.rollbackStateIsExpected(await this.captureRollbackCheckout(), backup, inputs);
    } catch {
      classified = false;
    }
    try {
      if (!await this.transactionDirectoryIsTrusted(backup)) return false;
      if (await fs.lstat(backup.recovery.failedCheckout).catch((error) => isMissing(error) ? undefined : Promise.reject(error))) return false;
      await this.validateTrustedCheckout(backup.recovery.checkoutSnapshot, backup.checkout, backup.submodules);

      await this.afterRollbackCheckoutAuthorization?.("preserve-failed-checkout");
      try {
        if (!this.rollbackStateIsExpected(await this.captureRollbackCheckout(), backup, inputs)) classified = false;
      } catch {
        classified = false;
      }
      if (!await this.transactionDirectoryIsTrusted(backup)) return false;
      if (await fs.lstat(backup.recovery.failedCheckout).catch((error) => isMissing(error) ? undefined : Promise.reject(error))) return false;
      await this.renameNoReplace(this.root, backup.recovery.failedCheckout);
      backup.recovery.failedCheckoutPreserved = true;

      await this.afterRollbackCheckoutAuthorization?.("restore-checkout-snapshot");
      if (!await this.transactionDirectoryIsTrusted(backup)) return false;
      if (await fs.lstat(this.root).catch((error) => isMissing(error) ? undefined : Promise.reject(error))) return false;
      await this.validateTrustedCheckout(backup.recovery.checkoutSnapshot, backup.checkout, backup.submodules);
      await this.renameNoReplace(backup.recovery.checkoutSnapshot, this.root);
      await this.validateTrustedCheckout(this.root, backup.checkout, backup.submodules);
      return classified;
    } catch {
      return false;
    }
  }

  private async cleanupCheckoutSnapshot(backup: BackupSnapshot): Promise<boolean> {
    try {
      const stat = await fs.lstat(backup.recovery.checkoutSnapshot).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
      if (!stat) return true;
      await this.validateTrustedCheckout(backup.recovery.checkoutSnapshot, backup.checkout, backup.submodules);
      await fs.rm(backup.recovery.checkoutSnapshot, { recursive: true });
      return !await fs.lstat(backup.recovery.checkoutSnapshot).then(() => true, (error) => isMissing(error) ? false : Promise.reject(error));
    } catch {
      return false;
    }
  }

  private async rollback(backup: BackupSnapshot, inputs: RollbackInputs): Promise<boolean> {
    let complete = await this.restoreCheckoutBySwap(backup, inputs);
    for (const [index, item] of backup.files.entries()) {
      const expected = inputs.expectedFiles[index];
      if (!expected || !await this.restoreFile(backup, item, expected)) complete = false;
    }
    try {
      await this.validateTrustedCheckout(this.root, backup.checkout, backup.submodules);
    } catch {
      complete = false;
    }
    for (const item of backup.files) {
      if (!await this.verifyRestoredFile(item)) complete = false;
    }
    if (complete && !backup.recovery.failedCheckoutPreserved) await this.cleanupCheckoutSnapshot(backup);
    return complete;
  }

  private async audit(
    outcome: "SUCCESS" | "ROLLED_BACK" | "ROLLBACK_INCOMPLETE",
    status: StatusInternal,
    backup: BackupSnapshot,
  ): Promise<void> {
    const directory = path.join(this.agentDir, "update", "pi-workbench");
    await ensureRealDirectory(directory, true);
    const auditPath = path.join(directory, "audit.jsonl");
    const existing = await fs.lstat(auditPath).catch((error) => isMissing(error) ? undefined : Promise.reject(error));
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new UpdateFailure("UPDATE_FAILED");
    const record = {
      version: 1,
      timestamp: this.now().toISOString(),
      outcome,
      oldCommit: backup.oldCommit,
      candidateCommit: status.candidateCommit,
      profile: status.profile,
      channel: status.channel,
      tag: status.candidate,
      backupId: backup.id,
      checkoutRecovery: backup.recovery.failedCheckoutPreserved
        ? "FAILED_CHECKOUT_PRESERVED"
        : outcome === "SUCCESS"
          ? "SNAPSHOT_PENDING_CLEANUP"
          : "SNAPSHOT_RETAINED",
      configRecovery: backup.recovery.configValuesPreserved ? "PRESERVED" : "NONE",
    };
    const encoded = `${JSON.stringify(record)}\n`;
    if (byteLength(encoded) > 2_048) throw new UpdateFailure("UPDATE_FAILED");
    const handle = await fs.open(
      auditPath,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new UpdateFailure("UPDATE_FAILED");
      await handle.chmod(0o600);
      const secured = await handle.stat();
      if ((secured.mode & 0o7777) !== 0o600) throw new UpdateFailure("UPDATE_FAILED");
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async auditSnapshotCleanup(backup: BackupSnapshot, result: "REMOVED" | "RETAINED"): Promise<void> {
    const directory = path.join(this.agentDir, "update", "pi-workbench");
    const auditPath = path.join(directory, "audit.jsonl");
    const record = {
      version: 1,
      timestamp: this.now().toISOString(),
      event: "CHECKOUT_SNAPSHOT_CLEANUP",
      result,
      backupId: backup.id,
    };
    const encoded = `${JSON.stringify(record)}\n`;
    const handle = await fs.open(
      auditPath,
      fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600) throw new UpdateFailure("UPDATE_FAILED");
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async apply(interaction: ApplyInteraction): Promise<WorkbenchApplyResult> {
    const lockPath = path.join(this.agentDir, "update", "pi-workbench", "update.lock");
    let lease: ExclusiveLease;
    try {
      lease = await this.acquireUpdateLease(lockPath);
    } catch {
      return { category: "blocked", code: "LOCK_BLOCKED", reload: false };
    }
    try {
      const initial = await this.computeStatus();
      if (initial.category !== "update-available") return { ...publicStatus(initial), reload: false };
      interaction.notify(formatApplySummary(initial), "warning");
      const confirmed = await interaction.confirm(
        "Apply Pi Workbench update?",
        formatApplySummary(initial),
      );
      if (!confirmed) return { ...publicStatus(initial), category: "blocked", code: "CANCELLED", reload: false };

      const revalidated = await this.computeStatus();
      if (!this.sameCandidate(initial, revalidated)) {
        return { ...publicStatus(revalidated), category: "blocked", code: "CANDIDATE_CHANGED", reload: false };
      }

      let backup: BackupSnapshot;
      try {
        backup = await this.createBackup(revalidated);
      } catch (error) {
        return { ...publicStatus(revalidated), category: "blocked", code: error instanceof UpdateFailure ? error.code : "BACKUP_FAILED", reload: false };
      }

      let rollbackInputs: RollbackInputs | undefined = revalidated.candidateCommit ? {
        candidateCommit: revalidated.candidateCommit,
        candidateSubmodule: backup.checkout.submoduleHead,
        expectedFiles: backup.files,
        checkoutMutated: false,
      } : undefined;
      try {
        const finalPreflight = await this.computeStatus();
        if (!this.sameCandidate(revalidated, finalPreflight)
          || !finalPreflight.candidateCommit
          || !revalidated.profile) throw new UpdateFailure("CANDIDATE_CHANGED");
        await this.validateGitmodules(finalPreflight.candidateCommit);
        const preparedRollback = rollbackInputs;
        if (!preparedRollback) throw new UpdateFailure("UPDATE_FAILED");
        const candidateSubmodule = await this.candidateSubmodule(finalPreflight.candidateCommit);
        let activeRollback: RollbackInputs = { ...preparedRollback, candidateSubmodule, checkoutMutated: true };
        rollbackInputs = activeRollback;
        await this.git(["merge", "--ff-only", finalPreflight.candidateCommit]);
        const mergedHead = trimOneLine((await this.git(["rev-parse", "HEAD"])).stdout);
        if (mergedHead !== finalPreflight.candidateCommit) throw new UpdateFailure("UPDATE_FAILED");
        await this.validateGitmodules();
        await this.git(["submodule", "sync", "--", "reprompter"]);
        await this.git(["submodule", "update", "--init", "--checkout", "--force", "--", "reprompter"]);
        const updatedTree = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        if (updatedTree.stdout !== "") throw new UpdateFailure("UPDATE_FAILED");
        await this.inspectSubmodules();
        const expectedFiles = await this.materializeExpectedInstallerFiles(backup, revalidated.profile);
        activeRollback = { ...activeRollback, expectedFiles };
        rollbackInputs = activeRollback;
        await this.assertLiveFilesOriginal(backup.files);
        const installerPath = path.join(this.root, "install.sh");
        await assertSafeParents(this.root, installerPath);
        const installerStat = await assertSafeFile(installerPath, false);
        if (!installerStat || (installerStat.mode & 0o111) === 0) throw new UpdateFailure("UPDATE_FAILED");
        const installerArgs = revalidated.profile === "full" ? ["--full"] : [];
        let install: ExecResult | undefined;
        let installFailure: unknown;
        try {
          install = await this.command(installerPath, installerArgs, INSTALL_TIMEOUT_MS);
        } catch (error) {
          installFailure = error;
        }
        await this.assertLiveFilesExpected(backup.files, expectedFiles);
        await this.afterInstallerSnapshot?.();
        if (installFailure || !install || install.code !== 0 || install.killed) throw new UpdateFailure("UPDATE_FAILED");
        await this.postverify(finalPreflight.candidateCommit, revalidated.profile);
        await this.audit("SUCCESS", revalidated, backup);
        const snapshotCleanup = await this.cleanupCheckoutSnapshot(backup) ? "REMOVED" : "RETAINED";
        await this.auditSnapshotCleanup(backup, snapshotCleanup).catch(() => undefined);
        return {
          ...publicStatus(revalidated),
          category: "updated",
          code: "UPDATED",
          reload: true,
          oldCommit: backup.oldCommit,
          newCommit: finalPreflight.candidateCommit,
          backupId: backup.id,
        };
      } catch {
        const restored = rollbackInputs ? await this.rollback(backup, rollbackInputs) : false;
        const outcome = restored ? "ROLLED_BACK" : "ROLLBACK_INCOMPLETE";
        await this.audit(outcome, revalidated, backup).catch(() => undefined);
        return {
          ...publicStatus(revalidated),
          category: "blocked",
          code: restored ? "ROLLED_BACK" : "ROLLBACK_INCOMPLETE",
          reload: false,
          oldCommit: backup.oldCommit,
          newCommit: revalidated.candidateCommit,
          backupId: backup.id,
        };
      }
    } finally {
      await lease.release();
    }
  }
}

export function formatUpdateStatus(status: WorkbenchUpdateStatus): string {
  const current = status.currentCommit ?? "unknown";
  const candidate = status.candidateCommit ?? "unknown";
  const lines = [
    `Result: ${status.category} (${status.code})`,
    `Current: ${current} (version ${status.currentVersion ?? "unknown"})`,
    `Candidate: ${status.candidate ?? "unknown"} (${candidate})`,
    `Channel: ${status.channel ?? "unknown"}`,
    `Profile: ${status.profile ?? "unknown"}`,
  ];
  if ("backupId" in status && typeof status.backupId === "string") lines.push(`Backup: ${status.backupId}`);
  if (status.code === "PROFILE_REQUIRED") {
    lines.push("Action: rerun ./install.sh or ./install.sh --full once for the desired profile, then retry.");
  }
  if (status.code === "ROLLBACK_INCOMPLETE") {
    lines.push("Action: inspect the preserved update backup before another attempt.");
  }
  return lines.join("\n");
}

export function formatApplySummary(status: WorkbenchUpdateStatus): string {
  return [
    `Old commit: ${status.currentCommit ?? "unknown"}`,
    `New commit: ${status.candidateCommit ?? "unknown"}`,
    `Channel: ${status.channel ?? "unknown"}`,
    `Profile: ${status.profile ?? "unknown"}`,
  ].join("\n");
}

export interface RegisterUpdateOptions {
  readonly root: string;
  readonly agentDir?: string;
  readonly exec: Exec;
  readonly fetch?: typeof fetch;
  readonly updater?: WorkbenchUpdateRunner;
}

function notifyStatus(ctx: ExtensionCommandContext, status: WorkbenchUpdateStatus): void {
  const level = status.category === "blocked" ? "error" : status.category === "update-available" ? "warning" : "info";
  ctx.ui.notify(formatUpdateStatus(status), level);
}

export function registerWorkbenchUpdate(pi: ExtensionAPI, options: RegisterUpdateOptions): void {
  const updater = options.updater ?? new WorkbenchUpdater(options);
  pi.registerCommand("workbench-update", {
    description: "Show or explicitly apply a trusted Pi Workbench update",
    getArgumentCompletions(prefix) {
      return ["status", "apply"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim();
      if (action !== "" && action !== "status" && action !== "apply") {
        notifyStatus(ctx, { category: "blocked", code: "INVALID_ACTION" });
        return;
      }
      if (action !== "apply") {
        notifyStatus(ctx, await updater.status());
        return;
      }
      if (!ctx.hasUI) {
        notifyStatus(ctx, { category: "blocked", code: "CONFIRMATION_REQUIRED" });
        return;
      }
      const result = await updater.apply({
        confirm: (title, message) => ctx.ui.confirm(title, message),
        notify: (message, level) => ctx.ui.notify(message, level),
      });
      notifyStatus(ctx, result);
      if (!result.reload) return;
      try {
        await ctx.reload();
      } catch {
        ctx.ui.notify(
          "Pi Workbench was installed on disk, but the live runtime did not reload. Run /reload or restart Pi before using the update.",
          "warning",
        );
      }
      return;
    },
  });
}
