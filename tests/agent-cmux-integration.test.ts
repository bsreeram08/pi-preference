import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunManager } from "../agent-run-manager.ts";
import { AgentRunStore } from "../agent-run-store.ts";
import { createCmuxAgentSessionHost } from "../agent-cmux-session.ts";
import type { AgentSpec } from "../types.ts";

const AGENT: AgentSpec = { id: "planner", title: "Planner", description: "Plans", triggers: [], readOnly: true, model: "fixture/model:medium" };

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for interactive cmux fixture.");
}

async function harness() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cmux-agent-integration-")));
  const project = path.join(root, "project");
  const records = path.join(root, "records");
  const log = path.join(root, "cmux.ndjson");
  const manuallyClosed = path.join(root, "manual-close");
  const closedByBridge = path.join(root, "closed-by-bridge");
  const closeFailure = path.join(root, "close-failure");
  const fakePi = path.join(root, "fake-pi.mjs");
  const fakeCmux = path.join(root, "fake-cmux.mjs");
  await fs.mkdir(project);
  await fs.writeFile(fakePi, `#!/usr/bin/env node
import fs from "node:fs"; import net from "node:net"; import path from "node:path";
const args=process.argv.slice(2), after=(n)=>{const i=args.indexOf(n);return i<0?undefined:args[i+1]};
const sessionDir=after("--session-dir"), runId=process.env.PI_WORKBENCH_RUN_ID, socketPath=process.env.PI_WORKBENCH_BRIDGE_SOCKET;
fs.writeFileSync(path.join(path.dirname(process.env.TMPDIR),"pi-args.json"),JSON.stringify(args));
const socket=net.createConnection(socketPath); let buffer="", latest="verified interactive output";
const send=(v)=>socket.write(JSON.stringify(v)+"\\n");
const event=(v)=>send({type:"event",event:v});
function session(){fs.mkdirSync(sessionDir,{recursive:true,mode:0o700});const f=path.join(sessionDir,"interactive-session.jsonl");fs.writeFileSync(f,JSON.stringify({type:"session",version:3,id:"interactive-session",timestamp:new Date().toISOString(),cwd:process.cwd()})+"\\n",{mode:0o600});return f;}
function normal(reason="stop"){event({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:latest}});event({type:"message_end",message:{role:"assistant",content:[{type:"text",text:latest}],stopReason:reason}});send({type:"settlement",event:{type:"agent_settled",stopReason:reason},text:latest,state:{sessionFile:session(),sessionId:"interactive-session",isStreaming:false,isCompacting:false,pendingMessageCount:0}});send({type:"terminal",state:"shutdown"});socket.end();}
socket.on("connect",()=>{send({type:"hello",version:1,runId,token:process.env.PI_WORKBENCH_BRIDGE_TOKEN});event({type:"extension_ui_request",id:"loadout",method:"setStatus",statusKey:"pi-workbench-child-loadout",statusText:JSON.stringify({version:1,runId,activeTools:(after("--tools")||"").split(",").filter(Boolean).sort(),model:runId.includes("model-mismatch")?"wrong/model":process.env.PI_WORKBENCH_EXPECTED_MODEL,thinking:process.env.PI_WORKBENCH_EXPECTED_THINKING})});});
socket.on("data",chunk=>{buffer+=chunk;for(;;){const i=buffer.indexOf("\\n");if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line)continue;const c=JSON.parse(line);if(c.command==="prompt"){send({type:"response",id:c.id,command:c.command,success:true});event({type:"agent_start"});if(c.message.includes("ABORTED")){event({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"aborted draft"}],stopReason:"aborted"}});event({type:"agent_settled",stopReason:"aborted"});}else if(c.message.includes("LENGTH"))normal("length");else if(!c.message.includes("HANG"))normal();}else if(c.command==="steer"||c.command==="follow_up"){send({type:"response",id:c.id,command:c.command,success:true});normal();}else if(c.command==="abort"||c.command==="shutdown"){send({type:"response",id:c.id,command:c.command,success:true});send({type:"terminal",state:"shutdown"});socket.end();}}});
`, { mode: 0o700 });
  await fs.writeFile(fakeCmux, `#!/usr/bin/env node
import fs from "node:fs"; import {spawn} from "node:child_process";
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");const command=args[0];
if(command==="identify")console.log(JSON.stringify({caller:{workspace_ref:"workspace:21",pane_ref:"pane:53"}}));
else if(command==="new-surface")console.log("OK surface:97 pane:53 workspace:21");
else if(command==="list-pane-surfaces"){if(!fs.existsSync(${JSON.stringify(manuallyClosed)})&&!fs.existsSync(${JSON.stringify(closedByBridge)}))console.log("* surface:97  Planner · running  [selected]");}
else if(command==="send"){const text=args.at(-1);const match=/^bash '([^']+)'\\n$/.exec(text);if(!match)process.exit(2);spawn("bash",[match[1]],{stdio:"ignore",detached:true}).unref();console.log("OK");}
else if(command==="rename-tab"){if(!args.includes("--title"))process.exit(2);console.log("OK");}
else if(command==="close-surface"){if(fs.existsSync(${JSON.stringify(closeFailure)}))process.exit(2);fs.writeFileSync(${JSON.stringify(closedByBridge)},"1");console.log("OK");}
else {console.log("OK");}
`, { mode: 0o700 });
  const environment = {
    PATH: process.env.PATH, HOME: root, TERM: "xterm-256color", PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    CMUX_WORKSPACE_ID: "workspace:21", CMUX_SURFACE_ID: "surface:5", CMUX_BUNDLED_CLI_PATH: fakeCmux,
  };
  const host = createCmuxAgentSessionHost(environment)!;
  const manager = new AgentRunManager({
    store: new AgentRunStore(records), sessionHost: host, environment,
    invocation: (args) => ({ command: process.execPath, args: [fakePi, ...args] }),
    defaultModel: "fixture/default:high",
    terminationGraceMs: 100, killGraceMs: 200,
  });
  return { root, project: await fs.realpath(project), log, manuallyClosed, closeFailure, manager };
}

async function commands(file: string): Promise<string[][]> {
  try { return (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}

describe("AgentRunManager interactive cmux runtime", () => {
  test("launches actual non-RPC Pi loadout in one unfocused terminal and closes exactly it after normal settlement", async () => {
    const item = await harness();
    const secret = "task-output-secret-sentinel";
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: `Private system prompt ${secret}`, task: "Review release fixtures", runId: "interactive-normal" });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 0, output: "verified interactive output" });
      const calls = await commands(item.log);
      expect(calls.filter(([name]) => name === "new-surface")).toEqual([[
        "new-surface", "--type", "terminal", "--pane", "pane:53", "--workspace", "workspace:21", "--focus", "false",
      ]]);
      const sends = calls.filter(([name]) => name === "send");
      expect(sends).toHaveLength(1);
      expect(sends[0].at(-1)).toMatch(/^bash '[^']+\/launch-pi-tui\.sh'\n$/);
      expect(calls).toContainEqual(["rename-tab", "--workspace", "workspace:21", "--surface", "surface:97", "--title", "Project · Review release fixtures"]);
      expect(calls).toContainEqual(["close-surface", "--surface", "surface:97", "--workspace", "workspace:21"]);
      expect(JSON.stringify(calls)).not.toContain(secret);
      expect(JSON.stringify(calls)).not.toContain("verified interactive output");
      expect(JSON.stringify(calls)).not.toContain("fixture/model");
      const record = await item.manager.store.load(item.project, handle.runId);
      expect(record?.runtime).toBe("interactive-tui");
      const runRoot = path.dirname(record!.sessionDir);
      const piArgs = JSON.parse(await fs.readFile(path.join(runRoot, "pi-args.json"), "utf8"));
      expect((await fs.lstat(path.join(runRoot, "launch-pi-tui.sh"))).mode & 0o777).toBe(0o700);
      expect((await fs.lstat(path.join(runRoot, "cmux-surface.json"))).mode & 0o077).toBe(0);
      expect(piArgs).not.toContain("rpc");
      expect(piArgs).toContain("--session-id");
      expect(piArgs.filter((value: string) => value === "--extension")).toHaveLength(2);
      expect(piArgs.some((value: string) => value.endsWith("agent-child-bridge.ts"))).toBe(true);
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });

  test("prepares the same fast-mode extension in the interactive cmux Pi invocation", async () => {
    const item = await harness();
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: { ...AGENT, model: "openai-codex/gpt-5.6-sol:xhigh" },
        systemPrompt: "Prompt",
        task: "complete",
        runId: "interactive-fast-mode",
      });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
      const record = await item.manager.store.load(item.project, handle.runId);
      const piArgs = JSON.parse(await fs.readFile(path.join(path.dirname(record!.sessionDir), "pi-args.json"), "utf8"));
      expect(piArgs.filter((value: string) => value === "--extension")).toHaveLength(3);
      expect(piArgs.some((value: string) => value.endsWith("child-fast-mode.ts"))).toBe(true);
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("an aborted interactive turn leaves the tab open and accepts a later steer", async () => {
    const item = await harness();
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Prompt", task: "ABORTED", runId: "interactive-aborted" });
      await waitFor(async () => (await commands(item.log)).some((call) => call.at(-1) === "Project · ABORTED"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await item.manager.status(item.project, handle.runId))[0]?.status).toBe("running");
      expect((await commands(item.log)).some(([name]) => name === "close-surface")).toBe(false);
      await item.manager.message(handle.runId, "finish now", "steer");
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 0, output: "verified interactive output" });
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });

  test("pins model-less built-in agents to the resolved parent route", async () => {
    const item = await harness();
    const { model: _model, ...modelLess } = AGENT;
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: modelLess, systemPrompt: "Prompt", task: "complete", runId: "interactive-default-model" });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 0, output: "verified interactive output" });
      expect((await item.manager.status(item.project, handle.runId))[0]?.model).toBe("fixture/default:high");
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });

  test("rejects a model mismatch before delivering the task", async () => {
    const item = await harness();
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Prompt", task: "must not run", runId: "interactive-model-mismatch" });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1 });
      expect((await item.manager.status(item.project, handle.runId))[0]).toMatchObject({ status: "failed", errorCode: "loadout_mismatch" });
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });

  test("length settlement fails closed after exact-surface cleanup", async () => {
    const item = await harness();
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Prompt", task: "LENGTH", runId: "interactive-length" });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1 });
      expect((await item.manager.status(item.project, handle.runId))[0]).toMatchObject({ status: "failed", errorCode: "assistant-length" });
      expect((await commands(item.log)).some(([name]) => name === "close-surface")).toBe(true);
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });

  test("manual surface closure fails the run and closes no unrelated surface", async () => {
    const item = await harness();
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Prompt", task: "HANG", runId: "interactive-manual-close" });
      await fs.writeFile(item.manuallyClosed, "closed");
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1 });
      const calls = await commands(item.log);
      expect(calls.filter(([name]) => name === "close-surface").every((call) => call.includes("surface:97"))).toBe(true);
      expect((await item.manager.status(item.project, handle.runId))[0]?.status).toBe("failed");
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });

  test("surface close failure prevents successful completion", async () => {
    const item = await harness();
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Prompt", task: "HANG", runId: "interactive-close-failure" });
      await fs.writeFile(item.closeFailure, "fail close");
      await item.manager.message(handle.runId, "finish now", "steer");
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1 });
      expect((await item.manager.status(item.project, handle.runId))[0]?.status).toBe("failed");
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });

  test("cancellation requests child abort before bridge surface cleanup", async () => {
    const item = await harness();
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Prompt", task: "HANG", runId: "interactive-cancel" });
      await item.manager.cancel(handle.runId);
      await expect(handle.completion).resolves.toMatchObject({ cancelled: true });
      expect((await item.manager.status(item.project, handle.runId))[0]?.errorCode).toBeUndefined();
      expect((await commands(item.log)).some(([name]) => name === "close-surface")).toBe(true);
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });
});
