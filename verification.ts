import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;
export const CHECK_KINDS = ["automated-test", "static-analysis", "build", "runtime-observation", "artifact-inspection"] as const;
export type CheckKind = typeof CHECK_KINDS[number];

export interface CheckRequest {
  argv: string[];
  cwd?: string;
  criterionIds: string[];
  kind: CheckKind;
  timeoutMs?: number;
}

export interface CheckReceipt {
  version: 1;
  id: string;
  runId: string;
  argv: string[];
  cwd: string;
  criterionIds: string[];
  kind: CheckKind;
  exitCode: number | null;
  signal: string | null;
  interrupted: boolean;
  outputLimitExceeded: boolean;
  outputDigest: string;
  snapshotBefore: string;
  snapshotAfter: string;
  startedAt: string;
  completedAt: string;
}

export interface VerificationEvidence {
  receipts: CheckReceipt[];
  snapshot: string;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Non-Git projects include all files: there is no implicit ignore policy. */
async function filesystemSnapshot(root: string): Promise<string> {
  const hash = createHash("sha256").update("filesystem\0").update(root);
  let entries = 0;
  let bytes = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 64 || ++entries > 20_000) throw new Error("Verification filesystem snapshot exceeds traversal limits.");
    if (relative === ".pi/pi-workbench" || path.basename(relative) === ".git") return;
    const file = path.join(root, relative);
    const stat = await fs.lstat(file);
    hash.update(relative).update("\0").update(String(stat.mode & 0o777)).update("\0");
    if (stat.isSymbolicLink()) hash.update("link\0").update(await fs.readlink(file));
    else if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const name of (await fs.readdir(file)).sort()) {
        // Creating only Workbench state must not affect the project snapshot.
        if (!relative && name === ".pi") {
          const piStat = await fs.lstat(path.join(root, name));
          if (piStat.isDirectory()) {
            const children = (await fs.readdir(path.join(root, name))).filter((child) => child !== "pi-workbench").sort();
            for (const child of children) await walk(path.join(name, child), depth + 1);
            continue;
          }
        }
        await walk(path.join(relative, name), depth + 1);
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (stat.size > 32 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error("Verification filesystem snapshot exceeds content limits.");
      hash.update("file\0").update(digest(await fs.readFile(file)));
    } else throw new Error("Verification snapshot requires ordinary files or symlinks.");
    hash.update("\0");
  };
  await walk("", 0);
  return hash.digest("hex");
}

/** Fingerprint current tracked and non-ignored untracked content, including dirty work.
 * Workbench's own state is excluded. Ignored build output is outside this claim.
 * Checked-out submodules are fingerprinted recursively; missing ones fail visibly.
 */
export async function workspaceSnapshot(root: string, depth = 0): Promise<string> {
  if (depth > 8) throw new Error("Verification submodule nesting exceeds eight levels.");
  root = await fs.realpath(root);
  const git = async (args: string[]) => (await exec("git", ["-C", root, ...args], {
    maxBuffer: MAX_OUTPUT, timeout: 30_000, env: { ...process.env, LC_ALL: "C" },
  })).stdout;
  try { await git(["rev-parse", "--show-toplevel"]); }
  catch (error) {
    if (depth === 0 && /not a git repository/.test(String((error as { stderr?: string }).stderr))) {
      for (let directory = root; ; directory = path.dirname(directory)) {
        let metadata = false;
        try { await fs.lstat(path.join(directory, ".git")); metadata = true; }
        catch (inspectionError) { if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError; }
        if (metadata) throw error; // A broken Git checkout is not a non-Git project.
        if (path.dirname(directory) === directory) break;
      }
      return filesystemSnapshot(root);
    }
    throw error;
  }
  const files = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .split("\0").filter(Boolean);
  const hash = createHash("sha256");
  const topLevel = await fs.realpath((await git(["rev-parse", "--show-toplevel"])).trim());
  if (depth > 0 && topLevel !== root) throw new Error("Verification requires initialized submodules.");
  hash.update(topLevel);
  const staged = await git(["ls-files", "--stage", "-z"]);
  hash.update(staged);
  const submodules = new Set(staged.split("\0").filter((entry) => entry.startsWith("160000 ")).map((entry) => entry.slice(entry.indexOf("\t") + 1)));
  for (const relative of [...new Set(files)].sort()) {
    if (relative === ".pi/pi-workbench" || relative.startsWith(".pi/pi-workbench/")) continue;
    const file = path.resolve(root, relative);
    if (!inside(root, file)) throw new Error("Snapshot path escaped the project.");
    hash.update(relative).update("\0");
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (submodules.has(relative)) throw new Error("Verification requires initialized submodules.");
      hash.update("deleted\0");
      continue;
    }
    if (submodules.has(relative) && !stat.isDirectory()) throw new Error("Verification requires initialized submodules.");
    if (stat.isSymbolicLink()) hash.update("symlink\0").update(await fs.readlink(file));
    else if (stat.isFile()) {
      if (stat.size > 32 * 1024 * 1024) throw new Error("Verification snapshot contains a file larger than 32 MiB.");
      const resolved = await fs.realpath(file);
      if (!inside(root, resolved)) throw new Error("Snapshot path resolves outside the project.");
      hash.update(String(stat.mode & 0o777)).update("\0").update(digest(await fs.readFile(file)));
    } else if (stat.isDirectory() && submodules.has(relative)) hash.update(await workspaceSnapshot(file, depth + 1));
    else throw new Error("Verification requires ordinary files or initialized submodules.");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function validateCheckRequest(request: CheckRequest): void {
  if (!Array.isArray(request.argv) || request.argv.length < 1 || request.argv.length > 128
    || request.argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 8_000)
    || !request.argv[0].trim()) throw new Error("Check argv must contain an executable and bounded literal arguments.");
  if (!Array.isArray(request.criterionIds) || request.criterionIds.length < 1 || request.criterionIds.length > 16
    || request.criterionIds.some((id) => !/^[a-z][a-z0-9-]{0,63}$/.test(id))
    || new Set(request.criterionIds).size !== request.criterionIds.length) throw new Error("Checks require unique acceptance criterion IDs.");
  if (!CHECK_KINDS.includes(request.kind)) throw new Error("Unknown evidence kind.");
  if (request.cwd !== undefined && (typeof request.cwd !== "string" || request.cwd.includes("\0"))) throw new Error("Invalid check cwd.");
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000)) throw new Error("Check timeout must be between 1 and 600000 ms.");
}

/** Executes an explicitly requested check. Exit zero proves execution, not test quality. */
export async function runCheck(
  request: CheckRequest,
  options: { projectRoot: string; evidenceDir: string; runId: string; signal?: AbortSignal },
): Promise<{ receipt: CheckReceipt; output: string }> {
  validateCheckRequest(request);
  const root = await fs.realpath(options.projectRoot);
  const cwd = await fs.realpath(path.resolve(root, request.cwd ?? "."));
  if (!inside(root, cwd)) throw new Error("Check cwd must stay inside the delegated project.");
  options.signal?.throwIfAborted();
  await fs.mkdir(options.evidenceDir, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(options.evidenceDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error("Check evidence directory must be private and ordinary.");
  const snapshotBefore = await workspaceSnapshot(root);
  options.signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let interrupted = false;
  let outputLimitExceeded = false;
  const outcome = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    const child = spawn(request.argv[0], request.argv.slice(1), { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    };
    const stop = () => {
      interrupted = true;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1_000);
    };
    const timeout = setTimeout(stop, request.timeoutMs ?? 120_000);
    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { outputLimitExceeded = true; stop(); }
      else chunks.push(chunk);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stop);
      // Do not leave a check's background descendants alive after its leader exits.
      kill("SIGKILL");
    };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (exitCode, signal) => { cleanup(); resolve({ exitCode, signal }); });
  });
  const output = Buffer.concat(chunks);
  const receipt: CheckReceipt = {
    version: 1, id: randomUUID(), runId: options.runId,
    argv: [...request.argv], cwd, criterionIds: [...request.criterionIds], kind: request.kind,
    ...outcome, interrupted, outputLimitExceeded, outputDigest: digest(output),
    snapshotBefore, snapshotAfter: await workspaceSnapshot(root), startedAt, completedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(options.evidenceDir, `${receipt.id}.log`), output, { mode: 0o600, flag: "wx" });
  await fs.writeFile(path.join(options.evidenceDir, `${receipt.id}.json`), JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  return { receipt, output: output.toString("utf8").slice(-12_000) };
}

export function checkPassed(receipt: CheckReceipt, snapshot: string): boolean {
  return receipt.exitCode === 0 && receipt.signal === null && receipt.interrupted === false && receipt.outputLimitExceeded === false
    && receipt.snapshotBefore === snapshot && receipt.snapshotAfter === snapshot;
}

/** Accept only receipts from correlated native tool events and their unchanged files. */
export async function validateCheckReceipt(
  value: unknown, request: CheckRequest,
  options: { projectRoot: string; evidenceDir: string; runId: string },
): Promise<CheckReceipt> {
  if (!value || typeof value !== "object") throw new Error("Missing native check receipt.");
  const receipt = value as CheckReceipt;
  const directory = await fs.lstat(options.evidenceDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error("Unsafe check evidence directory.");
  if (receipt.version !== 1 || !/^[a-f0-9-]{36}$/.test(receipt.id) || receipt.runId !== options.runId
    || (receipt.exitCode !== null && (!Number.isInteger(receipt.exitCode) || receipt.exitCode < 0))
    || (receipt.signal !== null && typeof receipt.signal !== "string")
    || typeof receipt.interrupted !== "boolean" || typeof receipt.outputLimitExceeded !== "boolean"
    || ![receipt.outputDigest, receipt.snapshotBefore, receipt.snapshotAfter].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.completedAt))
    || JSON.stringify(receipt.argv) !== JSON.stringify(request.argv)
    || JSON.stringify(receipt.criterionIds) !== JSON.stringify(request.criterionIds)
    || receipt.kind !== request.kind
    || receipt.cwd !== await fs.realpath(path.resolve(options.projectRoot, request.cwd ?? "."))) throw new Error("Check receipt does not match its invocation.");
  for (const extension of ["json", "log"]) {
    const file = path.join(options.evidenceDir, `${receipt.id}.${extension}`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > MAX_OUTPUT) throw new Error("Unsafe check evidence artifact.");
    const bytes = await fs.readFile(file);
    if (extension === "json" ? bytes.toString() !== JSON.stringify(receipt) : digest(bytes) !== receipt.outputDigest) throw new Error("Check evidence artifact changed.");
  }
  return receipt;
}
