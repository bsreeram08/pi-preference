import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Exec } from "./types.ts";

export interface WorkerWorkspace {
  id: string;
  role: string;
  path: string;
}

function isCouncilStatePath(line: string): boolean {
  const normalized = line.slice(3).trim().replaceAll("\\", "/");
  return normalized === ".pi/pi-workbench" || normalized.startsWith(".pi/pi-workbench/");
}

export async function assertSafeForParallelWorktrees(projectRoot: string, exec: Exec): Promise<void> {
  const rootCheck = await exec("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
  if (rootCheck.code !== 0) throw new Error("Parallel implementation requires a Git repository.");

  const status = await exec("git", ["-C", projectRoot, "status", "--porcelain", "--untracked-files=all"], {
    timeout: 20_000,
  });
  if (status.code !== 0) throw new Error(status.stderr || "Could not inspect Git working tree status.");

  const unsafe = status.stdout
    .split("\n")
    .filter(Boolean)
    .filter((line) => !isCouncilStatePath(line));
  if (unsafe.length > 0) {
    throw new Error(
      `Parallel implementation uses isolated Git worktrees and requires a clean project tree. Commit or stash these changes first:\n${unsafe.slice(0, 20).join("\n")}`,
    );
  }
}

export async function createWorkerWorkspaces(
  projectRoot: string,
  roles: string[],
  exec: Exec,
): Promise<{ root: string; workers: WorkerWorkspace[] }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-workers-"));
  const workers: WorkerWorkspace[] = [];

  try {
    for (let index = 0; index < roles.length; index++) {
      const role = roles[index];
      const id = `worker-${index + 1}`;
      const workerPath = path.join(tempRoot, id);
      const result = await exec("git", ["-C", projectRoot, "worktree", "add", "--detach", workerPath, "HEAD"], {
        timeout: 60_000,
      });
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || `Could not create worktree for ${role}`);
      workers.push({ id, role, path: workerPath });
    }
    return { root: tempRoot, workers };
  } catch (error) {
    await cleanupWorkerWorkspaces(projectRoot, { root: tempRoot, workers }, exec);
    throw error;
  }
}

export async function cleanupWorkerWorkspaces(
  projectRoot: string,
  group: { root: string; workers: WorkerWorkspace[] },
  exec: Exec,
): Promise<void> {
  for (const worker of group.workers) {
    try {
      await exec("git", ["-C", projectRoot, "worktree", "remove", "--force", worker.path], { timeout: 60_000 });
    } catch {
      // Best effort; the final prune and rm handle stale metadata/files.
    }
  }
  try {
    await exec("git", ["-C", projectRoot, "worktree", "prune"], { timeout: 30_000 });
  } catch {
    // Best effort cleanup.
  }
  await fs.rm(group.root, { recursive: true, force: true });
}

export async function describeWorkspaceChanges(workspace: WorkerWorkspace, exec: Exec): Promise<string> {
  const status = await exec("git", ["-C", workspace.path, "status", "--short", "--untracked-files=all"], {
    timeout: 20_000,
  });
  const diff = await exec("git", ["-C", workspace.path, "diff", "--stat"], { timeout: 20_000 });
  return [`Role: ${workspace.role}`, `Path: ${workspace.path}`, "Status:", status.stdout || "(clean)", "Diff stat:", diff.stdout || "(none)"].join("\n");
}
