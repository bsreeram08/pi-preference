import { randomBytes, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunPaths } from "./agent-run-store.ts";
import { createCmuxOutputRunner, type CmuxOutputRunner } from "./cmux-workbench.ts";
import { deriveCmuxWorkIdentity } from "./cmux-naming.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const CMUX_AGENT_BRIDGE_PATH = path.join(ROOT, "agent-cmux-bridge.mjs");
export const CHILD_BRIDGE_EXTENSION_PATH = path.join(ROOT, "agent-child-bridge.ts");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_PATTERN = /^workspace:\d+$/;
const SURFACE_PATTERN = /^surface:\d+$/;
const PANE_PATTERN = /^pane:\d+$/;
const validWorkspaceEnvironment = (value: string): boolean => WORKSPACE_PATTERN.test(value) || UUID_PATTERN.test(value);
const validSurfaceEnvironment = (value: string): boolean => SURFACE_PATTERN.test(value) || UUID_PATTERN.test(value);

const CATEGORICAL_AGENT_TITLES: Readonly<Record<string, string>> = Object.freeze({
  "codebase-explorer": "Codebase Explorer",
  researcher: "Researcher",
  "technical-reviewer": "Technical Reviewer",
  "requirements-analyst": "Requirements Analyst",
  planner: "Planner",
  "quality-reviewer": "Quality Reviewer",
  "execution-manager": "Execution Manager",
  implementer: "Implementer",
  "task-implementer": "Task Implementer",
  "council-supervisor": "Council Supervisor",
  product: "Product Advisor",
  opponent: "Opponent",
  architect: "Architect",
  developer: "Developer",
  ux: "UX Advisor",
  security: "Security Reviewer",
  qa: "QA Reviewer",
  hiring: "Hiring Advisor",
});

export function categoricalAgentTitle(agentId: string): string {
  if (!Object.prototype.hasOwnProperty.call(CATEGORICAL_AGENT_TITLES, agentId)) return "Specialist";
  return CATEGORICAL_AGENT_TITLES[agentId] ?? "Specialist";
}

export interface CmuxSessionPreparation {
  readonly invocation: { readonly command: string; readonly args: string[] };
  readonly environment: NodeJS.ProcessEnv;
}

export interface CmuxSessionPrepareInput {
  readonly runId: string;
  readonly agentId: string;
  readonly paths: AgentRunPaths;
  readonly projectRoot: string;
  readonly task: string;
  readonly piInvocation: { readonly command: string; readonly args: string[] };
  readonly childEnvironment: NodeJS.ProcessEnv;
}

export interface AgentSessionHost {
  readonly interactive: true;
  prepare(input: CmuxSessionPrepareInput): Promise<CmuxSessionPreparation>;
  focus(runId: string): void;
}

interface SurfaceRecord {
  readonly version: 1;
  readonly runId: string;
  readonly workspace: string;
  readonly pane: string;
  readonly surface: string;
}

function text(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function cmuxExecutable(environment: NodeJS.ProcessEnv): string {
  const explicit = text(environment.CMUX_BUNDLED_CLI_PATH);
  if (explicit && path.isAbsolute(explicit)) return explicit;
  const agentDir = text(environment.PI_CODING_AGENT_DIR) ?? path.join(text(environment.HOME) ?? os.homedir(), ".pi", "agent");
  return path.join(agentDir, "bin", "cmux");
}

function bridgeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "CMUX_SOCKET_PATH", "CMUX_SOCKET", "CMUX_SOCKET_PASSWORD", "CMUX_SOCKET_CAPABILITY",
    "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TAB_ID",
  ];
  return {
    ...Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])),
    TMPDIR: source.TMPDIR ?? os.tmpdir(),
  };
}

async function atomicPrivateWrite(file: string, content: string, mode: number): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | (fsSync.constants.O_NOFOLLOW ?? 0), mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    await fs.chmod(file, mode);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readSurfaceRecord(file: string, runId: string): Promise<SurfaceRecord | undefined> {
  try {
    const handle = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    let raw: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8_192 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return undefined;
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const value = JSON.parse(raw) as Partial<SurfaceRecord>;
    if (value.version !== 1 || value.runId !== runId || !WORKSPACE_PATTERN.test(value.workspace ?? "")
      || !PANE_PATTERN.test(value.pane ?? "") || !SURFACE_PATTERN.test(value.surface ?? "")) return undefined;
    return value as SurfaceRecord;
  } catch {
    return undefined;
  }
}

export class CmuxAgentSessionHost implements AgentSessionHost {
  readonly interactive = true as const;
  private readonly runRoots = new Map<string, string>();

  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly runner: CmuxOutputRunner = createCmuxOutputRunner(environment),
  ) {}

  async prepare(input: CmuxSessionPrepareInput): Promise<CmuxSessionPreparation> {
    const rootStat = await fs.lstat(input.paths.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.platform !== "win32" && (rootStat.mode & 0o077) !== 0)) {
      throw new Error("Interactive cmux run root is not a private ordinary directory.");
    }
    const configPath = path.join(input.paths.root, "cmux-bridge.json");
    const surfaceRecord = path.join(input.paths.root, "cmux-surface.json");
    const questionStateFile = path.join(input.paths.root, "question-state.json");
    const launcherPath = path.join(input.paths.root, "launch-pi-tui.sh");
    // Darwin limits Unix-domain socket paths to roughly 104 bytes; durable run
    // roots intentionally include long project/run identifiers. Keep only the
    // authenticated transport endpoint in the short system temp directory.
    const socketPath = path.join(os.tmpdir(), `pi-wb-${randomBytes(8).toString("hex")}.sock`);
    const identity = deriveCmuxWorkIdentity({
      cwd: input.projectRoot,
      task: input.task,
      role: categoricalAgentTitle(input.agentId),
    });
    const config = {
      version: 1,
      runId: input.runId,
      title: identity.title,
      description: identity.description,
      projectRoot: input.projectRoot,
      runRoot: input.paths.root,
      launcherPath,
      socketPath,
      surfaceRecord,
      questionStateFile,
      authToken: randomBytes(32).toString("hex"),
      cmuxCommand: cmuxExecutable(this.environment),
      piCommand: input.piInvocation.command,
      piArgs: input.piInvocation.args,
      childEnvironment: input.childEnvironment,
    };
    await atomicPrivateWrite(configPath, `${JSON.stringify(config)}\n`, 0o600);
    this.runRoots.set(input.runId, input.paths.root);
    return {
      invocation: { command: process.execPath, args: [CMUX_AGENT_BRIDGE_PATH, configPath] },
      environment: bridgeEnvironment(this.environment),
    };
  }

  focus(runId: string): void {
    const root = this.runRoots.get(runId);
    if (!root) return;
    void readSurfaceRecord(path.join(root, "cmux-surface.json"), runId).then(async (record) => {
      if (!record) return;
      await this.runner([
        "move-surface", "--surface", record.surface, "--pane", record.pane,
        "--workspace", record.workspace, "--focus", "true",
      ]);
    }).catch(() => undefined);
  }
}

export function createCmuxAgentSessionHost(
  environment: NodeJS.ProcessEnv = process.env,
  runner?: CmuxOutputRunner,
): AgentSessionHost | undefined {
  const workspace = text(environment.CMUX_WORKSPACE_ID);
  const surface = text(environment.CMUX_SURFACE_ID) ?? text(environment.CMUX_TAB_ID);
  const cmuxPresent = Boolean(workspace || surface || text(environment.CMUX_SOCKET_PATH) || text(environment.CMUX_SOCKET)
    || text(environment.CMUX_SOCKET_PASSWORD) || text(environment.CMUX_SOCKET_CAPABILITY));
  if (!cmuxPresent) return undefined;
  if (!workspace || !validWorkspaceEnvironment(workspace) || !surface || !validSurfaceEnvironment(surface)) {
    throw new Error("cmux is present but its caller workspace/surface identity is missing or malformed.");
  }
  return new CmuxAgentSessionHost(environment, runner);
}
