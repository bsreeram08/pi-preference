import * as fs from "node:fs";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_CHILD_BRIDGE_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class BoundedJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly maximum = MAX_CHILD_BRIDGE_FRAME_BYTES) {}

  push(chunk: Buffer | string): Record<string, unknown>[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const frames: Record<string, unknown>[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > this.maximum) throw new Error("Child bridge frame exceeded its byte limit.");
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Child bridge frame must be an object.");
      frames.push(value as Record<string, unknown>);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maximum) throw new Error("Child bridge frame exceeded its byte limit.");
    return frames;
  }
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "assistant" || !Array.isArray(value.content)) return "";
  return value.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object"
      && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function writeFrame(socket: net.Socket, frame: Record<string, unknown>): void {
  const encoded = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_CHILD_BRIDGE_FRAME_BYTES) throw new Error("Child bridge outbound frame exceeded its byte limit.");
  socket.write(encoded);
}

function validEnvironment(): { socketPath: string; token: string; runId: string; expectedModel: string; expectedThinking: string } | undefined {
  const socketPath = process.env.PI_WORKBENCH_BRIDGE_SOCKET?.trim();
  const token = process.env.PI_WORKBENCH_BRIDGE_TOKEN?.trim();
  const runId = process.env.PI_WORKBENCH_RUN_ID?.trim();
  const expectedModel = process.env.PI_WORKBENCH_EXPECTED_MODEL?.trim();
  const expectedThinking = process.env.PI_WORKBENCH_EXPECTED_THINKING?.trim() ?? "";
  if (!socketPath || !token || !/^[0-9a-f]{64}$/.test(token) || !runId || !RUN_ID_PATTERN.test(runId)
    || !expectedModel || expectedModel.length > 256 || /[\u0000-\u001f\u007f]/.test(expectedModel)
    || (expectedThinking !== "" && !/^(?:off|minimal|low|medium|high|xhigh|max)$/.test(expectedThinking))) return undefined;
  return { socketPath, token, runId, expectedModel, expectedThinking };
}

export default function piWorkbenchChildBridge(pi: ExtensionAPI): void {
  const contract = validEnvironment();
  if (!contract) throw new Error("Missing or invalid interactive Workbench child bridge contract.");
  const socket = net.createConnection({ path: contract.socketPath });
  const decoder = new BoundedJsonlDecoder(MAX_CONTROL_FRAME_BYTES);
  let context: ExtensionContext | undefined;
  let connected = false;
  let loadoutSent = false;
  let cancellationRequested = false;
  let shutdownRequested = false;
  let lastAssistantText = "";
  let lastStopReason: string | undefined;
  let expectedTools: string[] = [];

  const modelIdentity = (ctx: ExtensionContext): string => `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
  const verifyInteractiveContract = (ctx: ExtensionContext): void => {
    const projectRoot = process.env.PI_WORKBENCH_PROJECT_ROOT;
    if (!projectRoot || fs.realpathSync(process.cwd()) !== fs.realpathSync(projectRoot)) throw new Error("Interactive child cwd drifted from its delegated project.");
    if (expectedTools.length && JSON.stringify([...pi.getActiveTools()].sort()) !== JSON.stringify(expectedTools)) throw new Error("Interactive child tool loadout changed.");
    if (modelIdentity(ctx) !== contract.expectedModel) throw new Error("Interactive child model changed.");
    if (contract.expectedThinking && String((ctx as unknown as { thinkingLevel?: unknown }).thinkingLevel ?? "") !== contract.expectedThinking) throw new Error("Interactive child thinking level changed.");
  };

  const send = (frame: Record<string, unknown>): void => {
    if (!connected && frame.type !== "hello") throw new Error("Interactive Workbench child channel is not connected.");
    writeFrame(socket, frame);
  };
  const event = (value: Record<string, unknown>): void => {
    try {
      send({ type: "event", event: value });
    } catch {
      try { send({ type: "event", event: { type: "extension_error", error: "interactive_child_event_failed" } }); } catch { /* The bridge will fail on channel close. */ }
      context?.shutdown();
    }
  };
  const respond = (id: string, command: string, success: boolean, error?: string): void => send({
    type: "response", id, command, success, ...(error ? { error: error.slice(0, 512) } : {}),
  });

  const finalState = (ctx: ExtensionContext) => ({
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionId: ctx.sessionManager.getSessionId(),
    isStreaming: !ctx.isIdle(),
    isCompacting: false,
    pendingMessageCount: ctx.hasPendingMessages() ? 1 : 0,
  });

  const settleAndShutdown = (ctx: ExtensionContext, stopReason: string | undefined): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    try {
      send({
        type: "settlement",
        event: { type: "agent_settled", ...(stopReason ? { stopReason } : {}) },
        text: lastAssistantText,
        state: finalState(ctx),
      });
    } catch {
      event({ type: "extension_error", error: "interactive_child_settlement_failed" });
    } finally {
      ctx.shutdown();
    }
  };

  const handleCommand = (frame: Record<string, unknown>): void => {
    const id = typeof frame.id === "string" ? frame.id : "";
    const command = typeof frame.command === "string" ? frame.command : "";
    if (!id || id.length > 256 || !context) return;
    try {
      if (command === "prompt" || command === "steer" || command === "follow_up") {
        const message = frame.message;
        if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message, "utf8") > 512 * 1024) {
          throw new Error("Interactive child message is empty or oversized.");
        }
        pi.sendUserMessage(message, {
          ...(command === "steer" ? { deliverAs: "steer" as const } : command === "follow_up" ? { deliverAs: "followUp" as const } : {}),
          expandPromptTemplates: false,
        });
        respond(id, command, true);
        return;
      }
      if (command === "abort") {
        cancellationRequested = true;
        context.abort();
        respond(id, command, true);
        if (context.isIdle()) settleAndShutdown(context, "aborted");
        return;
      }
      if (command === "shutdown") {
        cancellationRequested = true;
        context.abort();
        respond(id, command, true);
        settleAndShutdown(context, "aborted");
        return;
      }
      respond(id, command || "unknown", false, "Unsupported interactive child command.");
    } catch (error) {
      respond(id, command || "unknown", false, error instanceof Error ? error.message : String(error));
    }
  };

  socket.on("connect", () => {
    connected = true;
    writeFrame(socket, { type: "hello", version: 1, runId: contract.runId, token: contract.token });
  });
  socket.on("data", (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) handleCommand(frame);
    } catch (error) {
      if (connected) event({ type: "extension_error", error: error instanceof Error ? error.message.slice(0, 512) : "Child bridge protocol error." });
      context?.shutdown();
    }
  });
  socket.on("error", () => { context?.shutdown(); });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (ctx.mode !== "tui") throw new Error("Interactive Workbench child bridge requires normal Pi TUI mode.");
    expectedTools = [...pi.getActiveTools()].sort();
    verifyInteractiveContract(ctx);
    const sendLoadout = () => {
      if (loadoutSent) return;
      loadoutSent = true;
      event({
        type: "extension_ui_request",
        id: "interactive-loadout",
        method: "setStatus",
        statusKey: "pi-workbench-child-loadout",
        statusText: JSON.stringify({
          version: 1,
          runId: contract.runId,
          activeTools: expectedTools,
          model: modelIdentity(ctx),
          thinking: String((ctx as unknown as { thinkingLevel?: unknown }).thinkingLevel ?? ""),
        }),
      });
    };
    if (!connected) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out connecting the interactive Workbench child bridge.")), 10_000);
        timer.unref();
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      }).then(sendLoadout);
    }
    sendLoadout();
  });

  pi.on("before_agent_start", (_value, ctx) => {
    try { verifyInteractiveContract(ctx); }
    catch (error) {
      event({ type: "extension_error", error: error instanceof Error ? error.message.slice(0, 512) : "Interactive child contract changed." });
      ctx.shutdown();
      throw error;
    }
  });

  pi.on("agent_start", (value) => {
    lastStopReason = undefined;
    lastAssistantText = "";
    event(value as unknown as Record<string, unknown>);
  });
  pi.on("message_update", (value) => event({
    type: value.type,
    assistantMessageEvent: value.assistantMessageEvent,
  }));
  pi.on("message_end", (value) => {
    const text = assistantText(value.message);
    if (text) lastAssistantText = text;
    if (value.message && typeof value.message === "object" && (value.message as { role?: unknown }).role === "assistant") {
      const reason = (value.message as { stopReason?: unknown }).stopReason;
      if (typeof reason === "string") lastStopReason = reason;
    }
    event({ type: value.type, message: value.message });
  });
  pi.on("tool_execution_start", (value) => event(value as unknown as Record<string, unknown>));
  pi.on("tool_execution_end", (value) => event(value as unknown as Record<string, unknown>));
  pi.on("agent_settled", (_value, ctx) => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (lastStopReason === "aborted" && !cancellationRequested) {
      event({ type: "agent_settled", stopReason: "aborted" });
      return;
    }
    settleAndShutdown(ctx, lastStopReason);
  });
  pi.on("session_shutdown", () => {
    if (connected) send({ type: "terminal", state: "shutdown" });
    socket.end();
  });
}
