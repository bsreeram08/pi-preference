import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { AgentResult, AgentSpec } from "./types.ts";
import type { WorkbenchDashboardController } from "./dashboard-controller.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const CHILD_TOOLS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-tools.ts");
let jobSequence = 0;

type Progress = (message: string) => void;

export interface AgentRunContext {
  dashboard?: WorkbenchDashboardController;
  groupId?: string;
  groupTitle?: string;
  jobId?: string;
  memoryProjectRoot?: string;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function truncate(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return text;
  let result = text.slice(0, MAX_OUTPUT_BYTES);
  while (Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES) result = result.slice(0, -1);
  return `${result}\n\n[Agent output truncated at 50KB.]`;
}

function sendRpc(child: ChildProcessWithoutNullStreams, command: Record<string, unknown>): void {
  if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams | undefined, signal: NodeJS.Signals): void {
  if (!child) return;
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function extractAssistantText(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
}

function extractToolText(result: any): string {
  if (!result?.content || !Array.isArray(result.content)) return "";
  return result.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
}

function discoverFilesAndTests(toolName: string, args: Record<string, unknown>, command?: string): { files: string[]; tests: string[] } {
  const files = new Set<string>();
  const tests = new Set<string>();
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof args[key] === "string") files.add(args[key] as string);
  }
  if (toolName === "bash" && command) {
    for (const match of command.matchAll(/(?:bun|npm|pnpm|yarn|pytest|xcodebuild)\s+(?:run\s+)?(?:test|tests|check|build|lint|typecheck)\b[^;&|]*/g)) {
      tests.add(match[0].trim());
    }
    for (const match of command.matchAll(/(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|swift|kt|java|py|rs|go))(?=$|\s)/g)) files.add(match[1]);
  }
  return { files: [...files], tests: [...tests] };
}

async function runPiAgent(
  projectRoot: string,
  agent: AgentSpec,
  systemPrompt: string,
  task: string,
  signal?: AbortSignal,
  progress?: Progress,
  runContext?: AgentRunContext,
): Promise<AgentResult> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-workbench-"));
  const systemPromptPath = path.join(tempDir, `${agent.id}-system.md`);
  await fsp.writeFile(systemPromptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });

  const researchTools = agent.researchTools ? ["research_search", "research_fetch", "research_browser"] : [];
  const tools = agent.readOnly
    ? ["read", "grep", "find", "ls", "qmd_search", "workbench_memory", ...researchTools, ...(agent.allowBash ? ["bash"] : [])]
    : ["read", "write", "edit", "grep", "find", "ls", "bash", "qmd_search", "workbench_memory", ...researchTools];
  const args = [
    "--mode", "rpc", "--no-session", "--no-extensions", "--extension", CHILD_TOOLS_PATH,
    "--no-prompt-templates", "--append-system-prompt", systemPromptPath,
    ...(agent.model ? ["--model", agent.model] : []),
    "--tools", tools.join(","),
  ];
  const jobId = runContext?.jobId ?? `${runContext?.groupId ?? "agent"}-${agent.id}-${++jobSequence}`;
  const groupId = runContext?.groupId ?? "agents";
  const groupTitle = runContext?.groupTitle ?? "Agents";
  runContext?.dashboard?.addJob(jobId, agent.title, groupId, groupTitle);
  progress?.(`${agent.title} started`);

  let restartRequested = false;
  let cancelled = false;
  let activeChild: ChildProcessWithoutNullStreams | undefined;
  let activeSend: ((message: string) => void) | undefined;

  const control = {
    steer(message: string) {
      if (!activeChild || !activeSend || cancelled) return;
      activeSend(message);
      const job = runContext?.dashboard?.state.getJob(jobId);
      if (job) {
        runContext?.dashboard?.updateJob(jobId, {
          status: "steering",
          latestActivity: "Steering message queued",
          queuedMessages: [...job.queuedMessages, message],
        });
      }
    },
    pause() {
      if (!activeChild || cancelled) return;
      signalProcessGroup(activeChild, "SIGSTOP");
      runContext?.dashboard?.updateJob(jobId, { status: "paused", latestActivity: "Process suspended" });
    },
    resume() {
      if (!activeChild || cancelled) return;
      signalProcessGroup(activeChild, "SIGCONT");
      runContext?.dashboard?.updateJob(jobId, { status: "running", latestActivity: "Process resumed" });
    },
    cancel() {
      if (!activeChild || cancelled) return;
      cancelled = true;
      sendRpc(activeChild, { type: "abort" });
      runContext?.dashboard?.updateJob(jobId, { status: "cancelled", latestActivity: "Cancellation requested" });
      setTimeout(() => signalProcessGroup(activeChild, "SIGTERM"), 1500).unref();
    },
    restart() {
      if (!activeChild || cancelled) return;
      restartRequested = true;
      sendRpc(activeChild, { type: "abort" });
      runContext?.dashboard?.updateJob(jobId, { status: "retrying", latestActivity: "Restarting agent" });
      setTimeout(() => signalProcessGroup(activeChild, "SIGTERM"), 1500).unref();
    },
  };
  runContext?.dashboard?.setControl(jobId, control);

  try {
    let finalResult: AgentResult | undefined;
    do {
      restartRequested = false;
      cancelled = false;
      const invocation = getPiInvocation(args);
      const attempt = await new Promise<AgentResult>((resolve) => {
        const child = spawn(invocation.command, [...invocation.args], {
          cwd: projectRoot,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PI_WORKBENCH_AGENT: agent.id,
            PI_WORKBENCH_PROJECT_ROOT: runContext?.memoryProjectRoot ?? projectRoot,
          },
        });
        activeChild = child;
        let stdoutBuffer = "";
        const decoder = new StringDecoder("utf8");
        let stderr = "";
        let latestAssistant = "";
        let currentAssistant = "";
        let settled = false;
        let exitCode = 0;
        const queuedMessages: string[] = [];
        const finish = (code: number, error?: string) => {
          if (settled) return;
          settled = true;
          const status = cancelled ? "cancelled" : code === 0 ? "completed" : "failed";
          runContext?.dashboard?.finishJob(jobId, status, {
            output: truncate(latestAssistant || currentAssistant || error || stderr),
            error: error || (code === 0 ? undefined : stderr || `Agent exited with code ${code}`),
            exitCode: code,
            latestActivity: status,
          });
          resolve({ agentId: agent.id, title: agent.title, output: truncate(latestAssistant || currentAssistant || stderr || "(agent produced no text output)"), exitCode: code, error: error || (code === 0 ? undefined : stderr) });
        };
        const processLine = (line: string) => {
          if (!line.trim()) return;
          let event: any;
          try { event = JSON.parse(line); } catch { return; }
          const job = runContext?.dashboard?.state.getJob(jobId);
          if (event.type === "agent_start") {
            runContext?.dashboard?.updateJob(jobId, { status: "running", startedAt: job?.startedAt ?? Date.now(), latestActivity: "Agent started" });
          } else if (event.type === "message_update") {
            const delta = event.assistantMessageEvent;
            if (delta?.type === "text_delta") currentAssistant += delta.delta ?? "";
            const partial = extractAssistantText(event.message);
            if (partial) currentAssistant = partial;
            runContext?.dashboard?.updateJob(jobId, { status: "running", output: truncate(currentAssistant), latestActivity: "Generating response" });
          } else if (event.type === "message_end" && event.message) {
            const text = extractAssistantText(event.message);
            if (text) {
              latestAssistant = text;
              currentAssistant = text;
              runContext?.dashboard?.addTranscript(jobId, { kind: "assistant", text, timestamp: Date.now() });
              runContext?.dashboard?.updateJob(jobId, { output: truncate(text), latestActivity: "Assistant message complete" });
            }
          } else if (event.type === "tool_execution_start") {
            const args = (event.args ?? {}) as Record<string, unknown>;
            const discovered = discoverFilesAndTests(event.toolName ?? "tool", args, args.command as string | undefined);
            const files = [...new Set([...(job?.files ?? []), ...discovered.files])];
            const tests = [...new Set([...(job?.tests ?? []), ...discovered.tests])];
            runContext?.dashboard?.addTool(jobId, { id: event.toolCallId ?? `${Date.now()}`, name: event.toolName ?? "tool", args, startedAt: Date.now() });
            runContext?.dashboard?.updateJob(jobId, { status: "running", latestActivity: `${event.toolName ?? "tool"} running`, files, tests });
          } else if (event.type === "tool_execution_update") {
            const output = extractToolText(event.partialResult);
            runContext?.dashboard?.addTool(jobId, { id: event.toolCallId, name: event.toolName ?? "tool", args: event.args ?? {}, output });
            runContext?.dashboard?.updateJob(jobId, { latestActivity: `${event.toolName ?? "tool"} output` });
          } else if (event.type === "tool_execution_end") {
            const output = extractToolText(event.result);
            runContext?.dashboard?.addTool(jobId, { id: event.toolCallId, name: event.toolName ?? "tool", args: event.args ?? {}, output, isError: event.isError, finishedAt: Date.now() });
            runContext?.dashboard?.updateJob(jobId, { latestActivity: event.isError ? `${event.toolName ?? "tool"} failed` : `${event.toolName ?? "tool"} complete` });
          } else if (event.type === "queue_update") {
            const steering = Array.isArray(event.steering) ? event.steering : queuedMessages;
            runContext?.dashboard?.state.setQueuedMessages(jobId, steering);
            runContext?.dashboard?.updateJob(jobId, { status: "steering", latestActivity: steering.length ? "Steering queued" : "Agent resumed" });
          } else if (event.type === "extension_error") {
            runContext?.dashboard?.updateJob(jobId, { status: "failed", error: event.error, latestActivity: "Extension error" });
          } else if (event.type === "agent_settled") {
            sendRpc(child, { type: "get_last_assistant_text", id: `final-${jobId}` });
            child.stdin.end();
          } else if (event.type === "response" && event.command === "get_last_assistant_text") {
            const text = event.data?.text;
            if (typeof text === "string" && text) latestAssistant = text;
          }
        };
        const onChunk = (chunk: Buffer) => {
          stdoutBuffer += decoder.write(chunk);
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        };
        child.stdout.on("data", onChunk);
        child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        child.on("error", (error) => finish(1, error.message));
        child.on("close", (code) => {
          stdoutBuffer += decoder.end();
          if (stdoutBuffer.trim()) processLine(stdoutBuffer);
          exitCode = code ?? 1;
          finish(exitCode);
        });
        activeSend = (message: string) => sendRpc(child, { type: "steer", message });
        sendRpc(child, { type: "prompt", id: `initial-${jobId}`, message: `Task: ${task}` });
        const abort = () => control.cancel();
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      finalResult = attempt;
      if (restartRequested) {
        runContext?.dashboard?.updateJob(jobId, { status: "retrying", latestActivity: "Starting replacement agent" });
        progress?.(`${agent.title} restarting`);
      }
    } while (restartRequested);

    progress?.(`${agent.title} ${finalResult?.exitCode === 0 ? "completed" : "failed"}`);
    return finalResult!;
  } finally {
    runContext?.dashboard?.setControl(jobId, undefined);
    activeChild = undefined;
    activeSend = undefined;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

export async function runAgentsParallel(
  projectRoot: string,
  agents: AgentSpec[],
  systemPromptFor: (agent: AgentSpec) => string,
  taskFor: (agent: AgentSpec) => string,
  signal?: AbortSignal,
  progress?: Progress,
  runContext?: Omit<AgentRunContext, "jobId">,
): Promise<AgentResult[]> {
  return Promise.all(agents.map((agent, index) => runPiAgent(
    projectRoot,
    agent,
    systemPromptFor(agent),
    taskFor(agent),
    signal,
    progress,
    { ...runContext, jobId: `${runContext?.groupId ?? "agents"}-${agent.id}-${++jobSequence}-${index}` },
  )));
}

export async function runSingleAgent(
  projectRoot: string,
  agent: AgentSpec,
  systemPrompt: string,
  task: string,
  signal?: AbortSignal,
  progress?: Progress,
  runContext?: AgentRunContext,
): Promise<AgentResult> {
  return runPiAgent(projectRoot, agent, systemPrompt, task, signal, progress, runContext);
}
