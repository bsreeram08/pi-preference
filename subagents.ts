import type { AgentResult, AgentSpec } from "./types.ts";
import {
  getDefaultAgentRunManager,
  type AgentRunContext,
  type AgentRunProgress,
} from "./agent-run-manager.ts";

export type { AgentRunContext } from "./agent-run-manager.ts";

let jobSequence = 0;

export async function runAgentsParallel(
  projectRoot: string,
  agents: AgentSpec[],
  systemPromptFor: (agent: AgentSpec) => string,
  taskFor: (agent: AgentSpec) => string,
  signal?: AbortSignal,
  progress?: AgentRunProgress,
  runContext?: Omit<AgentRunContext, "jobId">,
): Promise<AgentResult[]> {
  const manager = getDefaultAgentRunManager();
  return Promise.all(agents.map((agent, index) => manager.runToResult({
    projectRoot,
    agent,
    systemPrompt: systemPromptFor(agent),
    task: taskFor(agent),
    signal,
    progress,
    runContext: {
      ...runContext,
      jobId: `${runContext?.groupId ?? "agents"}-${agent.id}-${++jobSequence}-${index}`,
    },
  })));
}

export async function runSingleAgent(
  projectRoot: string,
  agent: AgentSpec,
  systemPrompt: string,
  task: string,
  signal?: AbortSignal,
  progress?: AgentRunProgress,
  runContext?: AgentRunContext,
): Promise<AgentResult> {
  return getDefaultAgentRunManager().runToResult({
    projectRoot,
    agent,
    systemPrompt,
    task,
    signal,
    progress,
    runContext,
  });
}
