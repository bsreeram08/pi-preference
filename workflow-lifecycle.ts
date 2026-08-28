export const WORKFLOW_LIFECYCLE_EVENT = "pi-workbench:workflow-lifecycle:v1" as const;

export type WorkflowLifecyclePhase = "session" | "planning" | "execution" | "delegation" | "council" | "background";
export type WorkflowLifecycleState = "running" | "needs_attention" | "blocked" | "completed" | "failed" | "cancelled" | "interrupted";
export type WorkflowLifecycleErrorCode = "agent_failure" | "invalid_result" | "state_corruption" | "writer_busy" | "cancelled" | "operational_failure";

export interface WorkflowLifecycleEvent {
  readonly schemaVersion: 1;
  readonly type: "workflow-lifecycle";
  readonly phase: WorkflowLifecyclePhase;
  readonly state: WorkflowLifecycleState;
  readonly errorCode?: WorkflowLifecycleErrorCode;
}

export interface WorkflowLifecycleMetadata {
  readonly progress: number;
  readonly progressLabel: string;
  readonly status: "working" | "needs attention" | "blocked" | "done" | "failed" | "cancelled" | "interrupted";
  readonly icon: string;
  readonly color: string;
  readonly level: "progress" | "warning" | "error" | "success";
}

const PHASES = new Set<WorkflowLifecyclePhase>([
  "session", "planning", "execution", "delegation", "council", "background",
]);

const STATE_METADATA: Record<WorkflowLifecycleState, WorkflowLifecycleMetadata> = {
  running: { progress: 0.35, progressLabel: "Pi · working", status: "working", icon: "sparkle", color: "#FF8A4C", level: "progress" },
  needs_attention: { progress: 0.85, progressLabel: "Pi · needs attention", status: "needs attention", icon: "exclamationmark.triangle", color: "#E7B84B", level: "warning" },
  blocked: { progress: 0.85, progressLabel: "Pi · blocked", status: "blocked", icon: "exclamationmark.octagon", color: "#E85D5D", level: "error" },
  completed: { progress: 1, progressLabel: "Pi · done", status: "done", icon: "checkmark.circle", color: "#4CAF7A", level: "success" },
  failed: { progress: 1, progressLabel: "Pi · failed", status: "failed", icon: "xmark.circle", color: "#E85D5D", level: "error" },
  cancelled: { progress: 1, progressLabel: "Pi · cancelled", status: "cancelled", icon: "xmark.circle", color: "#8A8A8A", level: "warning" },
  interrupted: { progress: 1, progressLabel: "Pi · interrupted", status: "interrupted", icon: "exclamationmark.octagon", color: "#E85D5D", level: "error" },
};

const ERROR_CODES = new Set<WorkflowLifecycleErrorCode>([
  "agent_failure",
  "invalid_result",
  "state_corruption",
  "writer_busy",
  "cancelled",
  "operational_failure",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createWorkflowLifecycleEvent(
  phase: WorkflowLifecyclePhase,
  state: WorkflowLifecycleState,
  errorCode?: WorkflowLifecycleErrorCode,
): WorkflowLifecycleEvent {
  return {
    schemaVersion: 1,
    type: "workflow-lifecycle",
    phase,
    state,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function decodeWorkflowLifecycleEvent(value: unknown): WorkflowLifecycleEvent | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(["schemaVersion", "type", "phase", "state", "errorCode"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (value.schemaVersion !== 1 || value.type !== "workflow-lifecycle") return undefined;
  if (typeof value.phase !== "string" || !PHASES.has(value.phase as WorkflowLifecyclePhase)) return undefined;
  if (typeof value.state !== "string" || !(value.state in STATE_METADATA)) return undefined;
  if (value.errorCode !== undefined && (typeof value.errorCode !== "string" || !ERROR_CODES.has(value.errorCode as WorkflowLifecycleErrorCode))) return undefined;
  return value as unknown as WorkflowLifecycleEvent;
}

export function workflowLifecycleMetadata(event: WorkflowLifecycleEvent): WorkflowLifecycleMetadata {
  return STATE_METADATA[event.state];
}
