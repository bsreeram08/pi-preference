import type { AgentResult } from "./types.ts";

export class WorkflowCancellationError extends Error {
  constructor(message = "Workflow run was cancelled.") {
    super(message);
    this.name = "WorkflowCancellationError";
  }
}

export class MandatoryAgentResultError extends Error {
  readonly phase: string;

  constructor(phase: string, reason: "failed" | "blank") {
    super(`Mandatory ${phase} result was ${reason}.`);
    this.name = "MandatoryAgentResultError";
    this.phase = phase;
  }
}

export function throwIfWorkflowCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkflowCancellationError();
}

export function assertMandatoryAgentResult(result: AgentResult, phase: string): AgentResult {
  if (result.cancelled) throw new WorkflowCancellationError(`${phase} was cancelled.`);
  if (result.exitCode !== 0) throw new MandatoryAgentResultError(phase, "failed");
  if (!result.output.trim()) throw new MandatoryAgentResultError(phase, "blank");
  return result;
}

export function assertMandatoryAgentBatch(results: AgentResult[], phase: string): AgentResult[] {
  for (const [index, result] of results.entries()) {
    assertMandatoryAgentResult(result, `${phase} member ${index + 1}`);
  }
  return results;
}

export function isWorkflowCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || error instanceof WorkflowCancellationError;
}
