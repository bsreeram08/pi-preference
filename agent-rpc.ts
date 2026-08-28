import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const MAX_AGENT_RPC_FRAME_BYTES = 256 * 1024;
export const MAX_AGENT_RPC_STDERR_BYTES = 64 * 1024;

const EVENT_TYPES = new Set([
  "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
  "message_start", "message_update", "message_end", "tool_execution_start",
  "tool_execution_update", "tool_execution_end", "queue_update", "compaction_start",
  "compaction_end", "auto_retry_start", "auto_retry_end", "summarization_retry_scheduled",
  "summarization_retry_attempt_start", "summarization_retry_finished", "extension_error",
  "extension_ui_request", "bash_execution_update",
]);

export interface RpcResponse {
  readonly id: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type AgentRpcEvent = Record<string, unknown> & { type: string };

export class AgentRpcProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentRpcProtocolError";
  }
}

export class JsonlFrameDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly maxFrameBytes = MAX_AGENT_RPC_FRAME_BYTES) {}

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.assertBufferedSize();
    const lines: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.assertFrameSize(line);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }

  end(): string[] {
    this.buffer += this.decoder.end();
    if (!this.buffer) return [];
    this.assertFrameSize(this.buffer);
    this.buffer = "";
    throw new AgentRpcProtocolError("unterminated_frame", "Agent RPC output ended before the required LF frame delimiter.");
  }

  private assertBufferedSize(): void {
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      throw new AgentRpcProtocolError("frame_too_large", "Agent RPC frame exceeded its byte limit before LF framing.");
    }
  }

  private assertFrameSize(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
      throw new AgentRpcProtocolError("frame_too_large", "Agent RPC frame exceeded its byte limit.");
    }
  }
}

function parseObject(line: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch (error) {
    throw new AgentRpcProtocolError("malformed_json", `Malformed Agent RPC JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentRpcProtocolError("invalid_frame", "Agent RPC frame must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function parseAgentRpcFrame(line: string): RpcResponse | AgentRpcEvent {
  const value = parseObject(line);
  if (value.type === "response") {
    if (typeof value.id !== "string" || !value.id || value.id.length > 256
      || typeof value.command !== "string" || !value.command || value.command.length > 128
      || typeof value.success !== "boolean"
      || (value.error !== undefined && typeof value.error !== "string")) {
      throw new AgentRpcProtocolError("invalid_response", "Agent RPC response shape is invalid.");
    }
    return value as unknown as RpcResponse;
  }
  if (typeof value.type !== "string" || !EVENT_TYPES.has(value.type)) {
    throw new AgentRpcProtocolError("unknown_event", `Unsupported Agent RPC event: ${String(value.type)}`);
  }
  if (value.type === "extension_ui_request"
    && (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256
      || typeof value.method !== "string" || value.method.length < 1 || value.method.length > 128)) {
    throw new AgentRpcProtocolError("invalid_ui_request", "Agent RPC extension UI request is invalid.");
  }
  return value as AgentRpcEvent;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface AgentRpcConnectionOptions {
  readonly timeoutMs?: number;
  readonly onEvent: (event: AgentRpcEvent) => void;
  readonly onProtocolError: (error: AgentRpcProtocolError) => void;
}

export class AgentRpcConnection {
  private readonly decoder = new JsonlFrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private inputClosed = false;
  private failed = false;

  constructor(
    readonly input: Writable,
    output: Readable,
    private readonly options: AgentRpcConnectionOptions,
  ) {
    output.on("data", (chunk: Buffer) => this.consume(chunk));
    output.on("end", () => this.finishOutput());
    output.on("error", (error) => this.fail(new AgentRpcProtocolError("stdout_error", error.message)));
  }

  request(command: Record<string, unknown> & { type: string }, timeoutMs = this.options.timeoutMs ?? 15_000): Promise<RpcResponse> {
    if (this.inputClosed || this.failed) return Promise.reject(new AgentRpcProtocolError("connection_closed", "Agent RPC input is closed."));
    const id = typeof command.id === "string" && command.id ? command.id : `workbench-${++this.requestSequence}`;
    if (this.pending.has(id)) return Promise.reject(new AgentRpcProtocolError("duplicate_request", `Duplicate Agent RPC request id: ${id}`));
    const frame = { ...command, id };
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentRpcProtocolError("response_timeout", `Timed out waiting for Agent RPC ${command.type} response.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      this.input.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new AgentRpcProtocolError("stdin_error", error.message));
      });
    });
  }

  notify(command: Record<string, unknown> & { type: string }): void {
    if (this.inputClosed || this.failed) throw new AgentRpcProtocolError("connection_closed", "Agent RPC input is closed.");
    this.input.write(`${JSON.stringify(command)}\n`);
  }

  closeInput(): void {
    if (this.inputClosed) return;
    this.inputClosed = true;
    this.input.end();
  }

  rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private consume(chunk: Buffer): void {
    if (this.failed) return;
    try {
      for (const line of this.decoder.push(chunk)) this.route(parseAgentRpcFrame(line));
    } catch (error) {
      this.fail(error instanceof AgentRpcProtocolError ? error : new AgentRpcProtocolError("protocol_error", String(error)));
    }
  }

  private finishOutput(): void {
    try {
      for (const line of this.decoder.end()) this.route(parseAgentRpcFrame(line));
    } catch (error) {
      this.fail(error instanceof AgentRpcProtocolError ? error : new AgentRpcProtocolError("protocol_error", String(error)));
    }
  }

  private route(frame: RpcResponse | AgentRpcEvent): void {
    if (frame.type !== "response") {
      this.options.onEvent(frame as AgentRpcEvent);
      return;
    }
    const response = frame as RpcResponse;
    const pending = this.pending.get(response.id);
    if (!pending) throw new AgentRpcProtocolError("unexpected_response", `Unexpected or duplicate Agent RPC response id: ${response.id}`);
    if (response.command !== pending.command) {
      throw new AgentRpcProtocolError("mismatched_response", `Expected Agent RPC response for ${pending.command}, received ${response.command}.`);
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (!response.success) {
      pending.reject(new AgentRpcProtocolError("command_failed", response.error || `Agent RPC command failed: ${response.command}`));
      return;
    }
    pending.resolve(response);
  }

  private fail(error: AgentRpcProtocolError): void {
    if (this.failed) return;
    this.failed = true;
    this.inputClosed = true;
    this.rejectPending(error);
    this.options.onProtocolError(error);
  }
}
