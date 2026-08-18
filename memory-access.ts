import * as os from "node:os";
import * as path from "node:path";
import { canonicalMemoryPath, type MemoryRoots } from "./memory-store.ts";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveToolPath(cwd: string, value: string | undefined): string {
  const raw = (value?.startsWith("@") ? value.slice(1) : value)?.trim() || cwd;
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return canonicalMemoryPath(path.resolve(cwd, expanded));
}

export function protectedMemoryPathAccess(
  roots: MemoryRoots,
  cwd: string,
  value: string | undefined,
  recursive: boolean,
): boolean {
  const candidate = resolveToolPath(cwd, value);
  if (isInside(roots.globalRoot, candidate)) return true;
  return recursive && isInside(candidate, roots.globalRoot);
}

export function bashTouchesProtectedMemory(roots: MemoryRoots, agentDir: string, command: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  const absoluteRoots = [roots.globalRoot, roots.projectRoot, path.join(canonicalMemoryPath(agentDir), "memory")]
    .map((value) => value.replaceAll("\\", "/"));
  if (absoluteRoots.some((root) => normalized.includes(root))) return true;

  const projectPath = roots.projectPath.replaceAll("\\", "/");
  const withoutProjectPaths = normalized.split(projectPath).join("<PROJECT>");
  const homePath = canonicalMemoryPath(os.homedir()).replaceAll("\\", "/");
  if (withoutProjectPaths.includes(homePath)) return true;
  if (/\$(?:\{)?(?:HOME|PI_CODING_AGENT_DIR)(?:\})?/.test(normalized)
    || /(?:^|[\s"'=])~(?:\/|[\s"']|$)/.test(normalized)) {
    return true;
  }

  return /(?:^|[\s"'=])(?:\.\/)?\.pi\/agent(?:\/|[\s"']|$)/.test(normalized)
    || /(?:^|[\s"'=])(?:\.\/)?\.pi\/pi-workbench\/memory(?:\/|$)/.test(normalized)
    || /memory\/pi-workbench(?:\/|$)/.test(normalized);
}
