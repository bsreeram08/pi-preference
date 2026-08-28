import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  AgentRpcConnection,
  AgentRpcProtocolError,
  JsonlFrameDecoder,
  parseAgentRpcFrame,
} from "../agent-rpc.ts";

describe("Agent RPC framing", () => {
  test("uses LF framing without splitting Unicode separators", () => {
    const decoder = new JsonlFrameDecoder();
    const text = `${JSON.stringify({ type: "message_update", text: "left\u2028right\u2029end" })}\r\n`;
    const bytes = Buffer.from(text);
    const first = decoder.push(bytes.subarray(0, 13));
    const second = decoder.push(bytes.subarray(13));
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(JSON.parse(second[0]).text).toBe("left right end");
  });

  test("rejects malformed, unknown, oversized, and unterminated frames", () => {
    expect(() => parseAgentRpcFrame("{broken")).toThrow(AgentRpcProtocolError);
    expect(() => parseAgentRpcFrame(JSON.stringify({ type: "made_up" }))).toThrow("Unsupported Agent RPC event");
    expect(() => parseAgentRpcFrame(JSON.stringify({ type: "extension_ui_request", id: "x".repeat(257), method: "input" }))).toThrow("UI request is invalid");
    const decoder = new JsonlFrameDecoder(8);
    expect(() => decoder.push("123456789")).toThrow("byte limit");
    const unterminated = new JsonlFrameDecoder();
    expect(unterminated.push(JSON.stringify({ type: "agent_settled" }))).toEqual([]);
    expect(() => unterminated.end()).toThrow("required LF");
  });

  test("reports an unterminated tail even after command input closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let protocolError: AgentRpcProtocolError | undefined;
    const connection = new AgentRpcConnection(input, output, {
      onEvent() {},
      onProtocolError(error) { protocolError = error; },
    });
    connection.closeInput();
    output.end(JSON.stringify({ type: "agent_settled" }));
    await new Promise((resolve) => output.once("close", resolve));
    expect(protocolError?.code).toBe("unterminated_frame");
  });

  test("correlates command and response before resolving", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: AgentRpcProtocolError[] = [];
    const connection = new AgentRpcConnection(input, output, {
      onEvent() {},
      onProtocolError(error) { errors.push(error); },
    });
    let outbound = "";
    input.on("data", (chunk) => { outbound += chunk.toString(); });
    const pending = connection.request({ type: "get_state" }, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = JSON.parse(outbound.trim());
    output.write(`${JSON.stringify({ id: request.id, type: "response", command: "get_state", success: true, data: { sessionId: "one" } })}\n`);
    await expect(pending).resolves.toMatchObject({ command: "get_state", success: true });
    expect(errors).toEqual([]);
  });

  test("rejects a mismatched response command", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let protocolError: AgentRpcProtocolError | undefined;
    const connection = new AgentRpcConnection(input, output, {
      onEvent() {},
      onProtocolError(error) { protocolError = error; },
    });
    let outbound = "";
    input.on("data", (chunk) => { outbound += chunk.toString(); });
    const pending = connection.request({ type: "get_state" }, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = JSON.parse(outbound.trim());
    output.write(`${JSON.stringify({ id: request.id, type: "response", command: "prompt", success: true })}\n`);
    await expect(pending).rejects.toThrow("Expected Agent RPC response for get_state");
    expect(protocolError?.code).toBe("mismatched_response");
  });
});
