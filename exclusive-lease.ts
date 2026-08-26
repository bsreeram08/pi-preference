import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type WriterOperation = "start-work" | "autopilot" | "delegate-task" | "delegate-command" | "council-implement" | "workbench-update";
export type LeaseContentionKind = "live" | "stale" | "ambiguous" | "malformed";

export interface ExclusiveLeaseOwner {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly processStartIdentity: string;
  readonly operation: WriterOperation;
  readonly projectRoot: string;
  readonly acquiredAt: string;
}

export interface ExclusiveLease {
  readonly path: string;
  readonly owner: ExclusiveLeaseOwner;
  release(): Promise<void>;
}

export interface ProcessInspection {
  readonly kind: "live" | "missing" | "ambiguous";
  readonly startIdentity?: string;
}

export interface ExclusiveLeaseDependencies {
  readonly inspectProcess?: (pid: number) => Promise<ProcessInspection>;
  readonly token?: () => string;
  readonly pid?: number;
  readonly hostname?: string;
  readonly now?: () => Date;
  readonly agentDir?: string;
  readonly afterCoordinationCheck?: (role: "writer" | "updater") => Promise<void> | void;
}

export class ExclusiveLeaseError extends Error {
  readonly code: "owner_inspection_failed" | "writer_live" | "writer_stale" | "writer_ambiguous" | "writer_malformed" | "update_active" | "active_writers";
  readonly contention?: LeaseContentionKind;

  constructor(code: ExclusiveLeaseError["code"], contention?: LeaseContentionKind) {
    super(code === "owner_inspection_failed"
      ? "Could not establish the current writer process identity."
      : code === "update_active"
        ? "Project writer lease is unavailable while a Workbench update marker exists."
        : code === "active_writers"
          ? "Workbench update is unavailable while project writer markers exist."
          : `Project writer lease is unavailable (${contention}).`);
    this.name = "ExclusiveLeaseError";
    this.code = code;
    this.contention = contention;
  }
}

const OPERATIONS = new Set<WriterOperation>(["start-work", "autopilot", "delegate-task", "delegate-command", "council-implement", "workbench-update"]);
const MAX_PS_BYTES = 512;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function parseOwner(value: unknown): ExclusiveLeaseOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<ExclusiveLeaseOwner>;
  const keys = Object.keys(item);
  const allowed = new Set(["version", "token", "pid", "hostname", "processStartIdentity", "operation", "projectRoot", "acquiredAt"]);
  if (keys.some((key) => !allowed.has(key))) return undefined;
  if (item.version !== 1 || typeof item.token !== "string" || !/^[0-9a-f-]{16,}$/i.test(item.token)) return undefined;
  if (!Number.isSafeInteger(item.pid) || (item.pid ?? 0) <= 0) return undefined;
  if (typeof item.hostname !== "string" || !item.hostname.trim()) return undefined;
  if (typeof item.processStartIdentity !== "string" || !item.processStartIdentity.trim()) return undefined;
  if (typeof item.operation !== "string" || !OPERATIONS.has(item.operation as WriterOperation)) return undefined;
  if (typeof item.projectRoot !== "string" || !path.isAbsolute(item.projectRoot)) return undefined;
  if (!validIso(item.acquiredAt)) return undefined;
  return item as ExclusiveLeaseOwner;
}

export function inspectProcessStart(pid: number): Promise<ProcessInspection> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderrBytes = 0;
    const child = spawn("ps", ["-p", String(pid), "-o", "lstart="], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) < MAX_PS_BYTES) stdout += chunk.toString("utf8", 0, MAX_PS_BYTES - Buffer.byteLength(stdout));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
    child.once("error", () => resolve({ kind: "ambiguous" }));
    child.once("close", (code) => {
      const identity = stdout.replace(/\s+/g, " ").trim();
      if (code === 0 && identity && Buffer.byteLength(identity) <= MAX_PS_BYTES) resolve({ kind: "live", startIdentity: identity });
      else if ((code === 1 || code === 0) && !identity) resolve({ kind: "missing" });
      else resolve({ kind: "ambiguous" });
      void stderrBytes;
    });
  });
}

async function removeOwnedLease(lockPath: string, token: string): Promise<void> {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const persisted = parseOwner(JSON.parse(await fs.readFile(lockPath, "utf8")));
    if (persisted?.token === token) await fs.unlink(lockPath);
  } catch {
    // Missing, replaced, or malformed ownership is never removed automatically.
  }
}

async function classifyExisting(
  lockPath: string,
  canonicalRoot: string,
  localHostname: string,
  inspect: (pid: number) => Promise<ProcessInspection>,
): Promise<LeaseContentionKind> {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return "malformed";
    const owner = parseOwner(JSON.parse(await fs.readFile(lockPath, "utf8")));
    if (!owner || owner.projectRoot !== canonicalRoot) return "malformed";
    if (owner.hostname !== localHostname) return "ambiguous";
    const process = await inspect(owner.pid);
    if (process.kind === "ambiguous") return "ambiguous";
    if (process.kind === "missing" || process.startIdentity !== owner.processStartIdentity) return "stale";
    return "live";
  } catch (error) {
    return isEnoent(error) ? "ambiguous" : "malformed";
  }
}

async function ensureRealDirectory(directory: string, privateDirectory = false): Promise<void> {
  let existingAncestor = directory;
  for (;;) {
    try {
      const ancestorStat = await fs.lstat(existingAncestor);
      if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink() || await fs.realpath(existingAncestor) !== path.resolve(existingAncestor)) {
        throw new ExclusiveLeaseError("writer_malformed", "malformed");
      }
      break;
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw new ExclusiveLeaseError("writer_malformed", "malformed");
      existingAncestor = parent;
    }
  }
  await fs.mkdir(directory, { recursive: true, mode: privateDirectory ? 0o700 : 0o755 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || await fs.realpath(directory) !== path.resolve(directory)
    || (privateDirectory && (stat.mode & 0o077) !== 0)) {
    throw new ExclusiveLeaseError("writer_malformed", "malformed");
  }
}

async function acquireLeaseAtPath(
  projectRoot: string,
  lockPath: string,
  operation: WriterOperation,
  dependencies: ExclusiveLeaseDependencies,
): Promise<ExclusiveLease> {
  if (!OPERATIONS.has(operation)) throw new TypeError("Unsupported writer operation.");
  if (!path.isAbsolute(lockPath) || path.resolve(lockPath) !== lockPath) throw new TypeError("Lease path must be absolute and normalized.");
  const canonicalRoot = await fs.realpath(projectRoot);
  const inspect = dependencies.inspectProcess ?? inspectProcessStart;
  const pid = dependencies.pid ?? process.pid;
  const localHostname = dependencies.hostname ?? os.hostname();
  const current = await inspect(pid);
  if (current.kind !== "live" || !current.startIdentity) throw new ExclusiveLeaseError("owner_inspection_failed");

  const lockDirectory = path.dirname(lockPath);
  await ensureRealDirectory(lockDirectory);
  const owner: ExclusiveLeaseOwner = {
    version: 1,
    token: dependencies.token?.() ?? randomUUID(),
    pid,
    hostname: localHostname,
    processStartIdentity: current.startIdentity,
    operation,
    projectRoot: canonicalRoot,
    acquiredAt: (dependencies.now?.() ?? new Date()).toISOString(),
  };

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (!isEexist(error)) throw error;
    const contention = await classifyExisting(lockPath, canonicalRoot, localHostname, inspect);
    throw new ExclusiveLeaseError(`writer_${contention}` as ExclusiveLeaseError["code"], contention);
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeOwnedLease(lockPath, owner.token);
    throw error;
  }
  await handle.close();

  let released = false;
  return {
    path: lockPath,
    owner,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await removeOwnedLease(lockPath, owner.token);
    },
  };
}

interface CoordinationLayout {
  readonly root: string;
  readonly gate: string;
  readonly update: string;
  readonly writers: string;
}

async function coordinationLayout(dependencies: ExclusiveLeaseDependencies): Promise<CoordinationLayout> {
  const agentDir = path.resolve(dependencies.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
  const root = path.join(agentDir, "update", "pi-workbench");
  const writers = path.join(root, "writers");
  await ensureRealDirectory(root);
  await ensureRealDirectory(writers, true);
  return {
    root,
    gate: path.join(root, "coordination.lock"),
    update: path.join(root, "update.lock"),
    writers,
  };
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.lstat(pathname);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw new ExclusiveLeaseError("writer_malformed", "malformed");
  }
}

function writerMarkerPath(writersDirectory: string, canonicalRoot: string): string {
  return path.join(writersDirectory, `${createHash("sha256").update(canonicalRoot).digest("hex")}.lock`);
}

export async function acquireExclusiveLease(
  projectRoot: string,
  operation: WriterOperation,
  dependencies: ExclusiveLeaseDependencies = {},
): Promise<ExclusiveLease> {
  const canonicalRoot = await fs.realpath(projectRoot);
  const projectLease = await acquireLeaseAtPath(
    canonicalRoot,
    path.join(canonicalRoot, ".pi", "pi-workbench", "writer.lock"),
    operation,
    dependencies,
  );
  let writerMarker: ExclusiveLease | undefined;
  try {
    const layout = await coordinationLayout(dependencies);
    const gate = await acquireLeaseAtPath(layout.root, layout.gate, operation, dependencies);
    try {
      if (await pathExists(layout.update)) throw new ExclusiveLeaseError("update_active");
      await dependencies.afterCoordinationCheck?.("writer");
      writerMarker = await acquireLeaseAtPath(
        canonicalRoot,
        writerMarkerPath(layout.writers, canonicalRoot),
        operation,
        dependencies,
      );
    } finally {
      await gate.release();
    }
  } catch (error) {
    try {
      await writerMarker?.release();
    } finally {
      await projectLease.release();
    }
    throw error;
  }

  let released = false;
  return {
    path: projectLease.path,
    owner: projectLease.owner,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await writerMarker?.release();
      } finally {
        await projectLease.release();
      }
    },
  };
}

export async function acquireUpdateExclusiveLease(
  projectRoot: string,
  dependencies: ExclusiveLeaseDependencies = {},
): Promise<ExclusiveLease> {
  const canonicalRoot = await fs.realpath(projectRoot);
  const layout = await coordinationLayout(dependencies);
  const gate = await acquireLeaseAtPath(layout.root, layout.gate, "workbench-update", dependencies);
  let updateMarker: ExclusiveLease | undefined;
  try {
    updateMarker = await acquireLeaseAtPath(canonicalRoot, layout.update, "workbench-update", dependencies);
    const writers = await fs.readdir(layout.writers);
    if (writers.length > 0) throw new ExclusiveLeaseError("active_writers");
    await dependencies.afterCoordinationCheck?.("updater");
    return updateMarker;
  } catch (error) {
    await updateMarker?.release();
    throw error;
  } finally {
    await gate.release();
  }
}

export async function acquireExclusiveLeaseAtPath(
  projectRoot: string,
  lockPath: string,
  operation: WriterOperation,
  dependencies: ExclusiveLeaseDependencies = {},
): Promise<ExclusiveLease> {
  return acquireLeaseAtPath(projectRoot, lockPath, operation, dependencies);
}

export async function withExclusiveLease<T>(
  projectRoot: string,
  operation: WriterOperation,
  work: () => Promise<T>,
  dependencies: ExclusiveLeaseDependencies = {},
): Promise<T> {
  const lease = await acquireExclusiveLease(projectRoot, operation, dependencies);
  try {
    return await work();
  } finally {
    await lease.release();
  }
}
