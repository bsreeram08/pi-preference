#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export const MAX_BRIDGE_FRAME_BYTES = 4 * 1024 * 1024;
const CONFIG_LIMIT = 512 * 1024;
const REF = /^(?:workspace|pane|surface):\d+$/;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const EVENT_TYPES = new Set([
  "extension_ui_request", "agent_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_end", "extension_error", "agent_settled",
]);

export class JsonlDecoder {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  constructor(maximum = MAX_BRIDGE_FRAME_BYTES) { this.maximum = maximum; }
  push(chunk) {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const frames = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > this.maximum) throw new Error("frame_too_large");
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_frame");
      frames.push(value);
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > this.maximum) throw new Error("frame_too_large");
    return frames;
  }
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readConfig(configPath) {
  const handle = await fs.open(configPath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
  let raw;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > CONFIG_LIMIT || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("invalid_config");
    raw = await handle.readFile("utf8");
  } finally { await handle.close(); }
  const value = JSON.parse(raw);
  const stringKeys = ["runId", "title", "projectRoot", "runRoot", "launcherPath", "socketPath", "surfaceRecord", "questionStateFile", "authToken", "cmuxCommand", "piCommand"];
  if (value.version !== 1 || stringKeys.some((key) => typeof value[key] !== "string" || !value[key])
    || !RUN_ID.test(value.runId) || !["Codebase Explorer", "Researcher", "Technical Reviewer", "Requirements Analyst", "Planner", "Quality Reviewer", "Execution Manager", "Implementer", "Task Implementer", "Council Supervisor", "Product Advisor", "Opponent", "Architect", "Developer", "UX Advisor", "Security Reviewer", "QA Reviewer", "Hiring Advisor", "Specialist"].includes(value.title)
    || !path.isAbsolute(value.projectRoot) || !path.isAbsolute(value.runRoot) || !path.isAbsolute(value.cmuxCommand)
    || !Array.isArray(value.piArgs) || value.piArgs.some((item) => typeof item !== "string")
    || !value.childEnvironment || typeof value.childEnvironment !== "object" || Array.isArray(value.childEnvironment)
    || !/^[0-9a-f]{64}$/.test(value.authToken)) throw new Error("invalid_config");
  const canonicalRoot = await fs.realpath(value.runRoot);
  for (const key of ["launcherPath", "surfaceRecord", "questionStateFile"]) {
    if (!path.isAbsolute(value[key]) || !contained(canonicalRoot, path.resolve(value[key]))) throw new Error("invalid_config_path");
  }
  if (!path.isAbsolute(value.socketPath) || path.dirname(value.socketPath) !== os.tmpdir()
    || !/^pi-wb-[0-9a-f]{16}\.sock$/.test(path.basename(value.socketPath))) throw new Error("invalid_socket_path");
  return value;
}

function shellQuote(value) { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export function launcherText(config) {
  const environment = {
    ...config.childEnvironment,
    PI_WORKBENCH_BRIDGE_SOCKET: config.socketPath,
    PI_WORKBENCH_BRIDGE_TOKEN: config.authToken,
    PI_WORKBENCH_QUESTION_STATE_FILE: config.questionStateFile,
  };
  const assignments = Object.entries(environment)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const command = [shellQuote(config.piCommand), ...config.piArgs.map(shellQuote)].join(" ");
  return `#!/bin/bash\nset -eu\ncd -- ${shellQuote(config.projectRoot)}\nexec env -i ${assignments.join(" ")} ${command}\n`;
}

async function atomicWrite(file, content, mode) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | (fsSync.constants.O_NOFOLLOW ?? 0), mode);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, file); await fs.chmod(file, mode); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

async function readQuestionState(config) {
  let handle;
  try {
    handle = await fs.open(config.questionStateFile, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_024 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return undefined;
    const value = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["version", "runId", "state"].includes(key))
      || value.version !== 1 || value.runId !== config.runId
      || (value.state !== "waiting" && value.state !== "running")) return undefined;
    return value.state;
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}

export function runCmuxCommand(command, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false, timedOut = false;
    let hardTimer;
    let absoluteTimer;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      resolve({ ok, stdout, stderr });
    };
    const child = execFile(command, args, { env: process.env, maxBuffer: 128 * 1024 }, (error, out, err) => {
      stdout = out; stderr = err;
      finish(!error && !timedOut);
    });
    const softTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      hardTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 250);
      hardTimer.unref();
      absoluteTimer = setTimeout(() => finish(false), 1_000);
      absoluteTimer.unref();
    }, timeoutMs);
    softTimer.unref();
    child.once("error", () => finish(false));
  });
}

const run = runCmuxCommand;

export function parseCaller(stdout) {
  try {
    const value = JSON.parse(stdout);
    const workspace = value?.caller?.workspace_ref;
    const pane = value?.caller?.pane_ref;
    return typeof workspace === "string" && /^workspace:\d+$/.test(workspace)
      && typeof pane === "string" && /^pane:\d+$/.test(pane) ? { workspace, pane } : undefined;
  } catch { return undefined; }
}

export function parseSurface(stdout) {
  const match = stdout.trim().match(/^OK\s+(surface:\d+)\s+(pane:\d+)\s+(workspace:\d+)$/);
  return match ? { surface: match[1], pane: match[2], workspace: match[3] } : undefined;
}

export function surfaceListed(stdout, expectedSurface) {
  return stdout.split(/\r?\n/).some((line) => line.match(/\bsurface:\d+\b/)?.[0] === expectedSurface);
}

export function authenticatedHello(frame, config) {
  return frame?.type === "hello" && frame.version === 1 && frame.runId === config.runId && frame.token === config.authToken;
}

function writeRpc(frame) {
  const encoded = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_BRIDGE_FRAME_BYTES) throw new Error("frame_too_large");
  process.stdout.write(encoded);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath || !path.isAbsolute(configPath) || process.argv.length !== 3) throw new Error("invalid_invocation");
  const config = await readConfig(configPath);
  await fs.rm(config.socketPath, { force: true });
  const server = net.createServer();
  let childSocket;
  let childAuthenticated = false;
  let childClosed = false;
  let finalText;
  let finalState;
  let normalSettlement = false;
  let surface;
  let caller;
  let closing = false;
  let parentEnded = false;
  let monitor;
  let shutdownTimer;
  let lastQuestionState;

  const renameRecordedSurface = async (state) => {
    if (!surface || !caller || !["running", "waiting", "done", "failed"].includes(state)) return;
    await run(config.cmuxCommand, ["rename-tab", "--workspace", caller.workspace, "--surface", surface.surface, "--title", `${config.title} · ${state}`]);
  };
  const closeRecordedSurface = async () => {
    if (!surface || !caller) return true;
    const result = await run(config.cmuxCommand, ["close-surface", "--surface", surface.surface, "--workspace", caller.workspace]);
    if (!result.ok) return false;
    const listed = await run(config.cmuxCommand, ["list-pane-surfaces", "--workspace", caller.workspace, "--pane", caller.pane], 2_000);
    return listed.ok && !surfaceListed(listed.stdout, surface.surface);
  };
  const cleanup = async (code, requestShutdown = false) => {
    if (closing) return;
    closing = true;
    if (monitor) clearTimeout(monitor);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    if (requestShutdown && childAuthenticated && childSocket && !childSocket.destroyed) {
      try { childSocket.write(`${JSON.stringify({ type: "command", id: "bridge-shutdown", command: "shutdown" })}\n`); } catch {}
      await new Promise((resolve) => { const timer = setTimeout(resolve, 300); timer.unref(); childSocket.once("close", resolve); });
    }
    const surfaceClosed = await closeRecordedSurface();
    const finalCode = surfaceClosed ? code : 1;
    childSocket?.destroy();
    server.close();
    await fs.rm(config.socketPath, { force: true }).catch(() => undefined);
    process.exitCode = finalCode;
    setTimeout(() => process.exit(finalCode), 10).unref();
  };
  const fail = (code = "interactive_session_failed") => {
    if (closing) return;
    try { writeRpc({ type: "extension_error", error: code }); } catch {}
    void cleanup(1, true);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { void cleanup(1, true); });
  process.on("disconnect", () => { void cleanup(1, true); });

  server.maxConnections = 8;
  server.on("connection", (socket) => {
    if (childSocket) { socket.destroy(); return; }
    const decoder = new JsonlDecoder();
    let authenticated = false;
    const authenticationTimer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 2_000);
    authenticationTimer.unref();
    socket.on("data", (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (!authenticated) {
            if (!authenticatedHello(frame, config) || childSocket) { socket.destroy(); return; }
            authenticated = true;
            clearTimeout(authenticationTimer);
            childAuthenticated = true;
            childSocket = socket;
            continue;
          }
          if (frame.type === "event") {
            if (!frame.event || typeof frame.event !== "object" || !EVENT_TYPES.has(frame.event.type)) throw new Error("unsupported_event");
            if (frame.event.type === "agent_start") void renameRecordedSurface("running");
            if (frame.event.type === "agent_settled" && frame.event.stopReason === "aborted") {
              // An interactive Escape/abort means "wait for another prompt", not
              // final completion. AgentRunManager treats every agent_settled RPC
              // event as terminal, so keep this local to the terminal host.
              void renameRecordedSurface("waiting");
              continue;
            }
            writeRpc(frame.event);
            continue;
          }
          if (frame.type === "response") {
            const { id, command, success, error } = frame;
            if (typeof id !== "string" || typeof command !== "string" || typeof success !== "boolean") throw new Error("invalid_response");
            if (id !== "bridge-shutdown") {
              writeRpc({ id, type: "response", command, success, ...(typeof error === "string" ? { error } : {}) });
            }
            continue;
          }
          if (frame.type === "settlement") {
            if (normalSettlement) throw new Error("duplicate_settlement");
            if (!frame.event || frame.event.type !== "agent_settled" || typeof frame.text !== "string" || !frame.state || typeof frame.state !== "object") throw new Error("invalid_settlement");
            normalSettlement = true; finalText = frame.text; finalState = frame.state;
            void renameRecordedSurface("done");
            writeRpc(frame.event);
            continue;
          }
          if (frame.type === "terminal" && frame.state === "shutdown") continue;
          throw new Error("unsupported_child_frame");
        }
      } catch { fail("interactive_child_protocol"); }
    });
    socket.on("close", () => {
      clearTimeout(authenticationTimer);
      if (!authenticated) return;
      childClosed = true;
      if (!normalSettlement && !closing) fail("interactive_child_closed");
      else if (parentEnded) void cleanup(0);
    });
    socket.on("error", () => {
      clearTimeout(authenticationTimer);
      if (authenticated && !closing) fail("interactive_child_channel");
    });
  });
  process.umask(0o077);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, () => resolve());
  });
  await fs.chmod(config.socketPath, 0o600);

  try {
  const identity = await run(config.cmuxCommand, ["identify"]);
  caller = identity.ok ? parseCaller(identity.stdout) : undefined;
  if (!caller) throw new Error("cmux_identity_failed");
  const createdResult = await run(config.cmuxCommand, [
    "new-surface", "--type", "terminal", "--pane", caller.pane, "--workspace", caller.workspace,
    "--focus", "false",
  ]);
  surface = createdResult.ok ? parseSurface(createdResult.stdout) : undefined;
  if (!surface || surface.workspace !== caller.workspace || surface.pane !== caller.pane) throw new Error("cmux_surface_failed");
  await atomicWrite(config.surfaceRecord, `${JSON.stringify({ version: 1, runId: config.runId, ...surface })}\n`, 0o600);
  const renamed = await run(config.cmuxCommand, ["rename-tab", "--workspace", caller.workspace, "--surface", surface.surface, "--title", `${config.title} · running`]);
  if (!renamed.ok) throw new Error("cmux_title_failed");
  await atomicWrite(config.launcherPath, launcherText(config), 0o700);
  const launcherCommand = `bash ${shellQuote(config.launcherPath)}\n`;
  const sent = await run(config.cmuxCommand, ["send", "--surface", surface.surface, "--workspace", caller.workspace, "--", launcherCommand]);
  if (!sent.ok) throw new Error("cmux_launch_failed");
  } catch {
    await cleanup(1, true);
    return;
  }

  const monitorSurface = async () => {
    if (closing || !surface || !caller) return;
    const questionState = await readQuestionState(config);
    if (questionState && questionState !== lastQuestionState) {
      lastQuestionState = questionState;
      await renameRecordedSurface(questionState);
    }
    const listed = await run(config.cmuxCommand, ["list-pane-surfaces", "--workspace", caller.workspace, "--pane", caller.pane], 2_000);
    if (!listed.ok || !surfaceListed(listed.stdout, surface.surface)) {
      if (!closing) fail("interactive_surface_closed");
      return;
    }
    if (!closing) {
      monitor = setTimeout(() => { void monitorSurface(); }, 250);
      monitor.unref();
    }
  };
  monitor = setTimeout(() => { void monitorSurface(); }, 250);
  monitor.unref();

  const parentDecoder = new JsonlDecoder();
  process.stdin.on("data", (chunk) => {
    try {
      for (const frame of parentDecoder.push(chunk)) {
        const type = typeof frame.type === "string" ? frame.type : "";
        const id = typeof frame.id === "string" ? frame.id : "";
        if (!id || id.length > 256) throw new Error("invalid_parent_command");
        if (type === "get_last_assistant_text") {
          if (!normalSettlement) writeRpc({ id, type: "response", command: type, success: false, error: "Interactive child is not settled." });
          else writeRpc({ id, type: "response", command: type, success: true, data: { text: finalText } });
          continue;
        }
        if (type === "get_state") {
          if (!normalSettlement) writeRpc({ id, type: "response", command: type, success: false, error: "Interactive child is not settled." });
          else writeRpc({ id, type: "response", command: type, success: true, data: finalState });
          continue;
        }
        if (!["prompt", "steer", "follow_up", "abort"].includes(type) || !childAuthenticated || !childSocket || childSocket.destroyed) {
          writeRpc({ id, type: "response", command: type || "unknown", success: false, error: "Interactive child control is unavailable." });
          continue;
        }
        childSocket.write(`${JSON.stringify({ type: "command", id, command: type, ...(typeof frame.message === "string" ? { message: frame.message } : {}) })}\n`);
      }
    } catch { fail("interactive_parent_protocol"); }
  });
  process.stdin.on("end", () => {
    parentEnded = true;
    if (!normalSettlement) { void cleanup(1, true); return; }
    if (childClosed) { void cleanup(0); return; }
    shutdownTimer = setTimeout(() => { void cleanup(1, true); }, 5_000);
    shutdownTimer.unref();
  });
  process.stdin.on("error", () => { void cleanup(1, true); });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(() => {
  try { writeRpc({ type: "extension_error", error: "interactive_session_launch_failed" }); } catch {}
  process.exit(1);
});
