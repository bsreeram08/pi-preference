export type AgentStatus =
  | "queued"
  | "starting"
  | "running"
  | "steering"
  | "waiting_for_parent"
  | "cancelling"
  | "terminating"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "orphaned"
  | "retrying";

export interface AgentToolEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  expanded?: boolean;
  startedAt?: number;
  finishedAt?: number;
}

export interface AgentTranscriptItem {
  kind: "user" | "assistant" | "tool" | "system";
  text: string;
  timestamp: number;
  tool?: AgentToolEvent;
}

export interface AgentDashboardJob {
  id: string;
  title: string;
  groupId: string;
  groupTitle: string;
  status: AgentStatus;
  startedAt?: number;
  finishedAt?: number;
  latestActivity: string;
  queuedMessages: string[];
  transcript: AgentTranscriptItem[];
  tools: AgentToolEvent[];
  files: string[];
  tests: string[];
  error?: string;
  output?: string;
  exitCode?: number;
  sessionPresent?: boolean;
  question?: { id: string; text: string };
}

export interface AgentDashboardGroup {
  id: string;
  title: string;
  collapsed: boolean;
  jobs: AgentDashboardJob[];
}

export interface AgentControl {
  steer(message: string): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  restart(): void;
  answer?(questionId: string, value: string): void;
}

export interface DashboardJobInput {
  id: string;
  title: string;
  groupId: string;
  groupTitle: string;
}

function isFinished(status: AgentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted" || status === "orphaned";
}

export class AgentDashboardState {
  private groups = new Map<string, AgentDashboardGroup>();
  private jobs = new Map<string, AgentDashboardJob>();
  private controls = new Map<string, AgentControl>();
  private listeners = new Set<() => void>();
  private selectedJobId?: string;
  private selectedGroupId?: string;
  private focused = false;
  private finishedExpanded = false;
  private runId?: string;

  beginRun(runId: string): void {
    this.clear();
    this.runId = runId;
  }

  endRun(): void {
    this.focused = false;
    this.notify();
  }

  clear(): void {
    this.groups.clear();
    this.jobs.clear();
    this.controls.clear();
    this.selectedJobId = undefined;
    this.selectedGroupId = undefined;
    this.focused = false;
    this.finishedExpanded = false;
    this.runId = undefined;
    this.notify();
  }

  get currentRunId(): string | undefined {
    return this.runId;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  ensureGroup(id: string, title: string): AgentDashboardGroup {
    const existing = this.groups.get(id);
    if (existing) return existing;
    const group: AgentDashboardGroup = { id, title, collapsed: false, jobs: [] };
    this.groups.set(id, group);
    if (!this.selectedGroupId) this.selectedGroupId = id;
    this.notify();
    return group;
  }

  addJob(input: DashboardJobInput): AgentDashboardJob {
    const existing = this.jobs.get(input.id);
    if (existing) return existing;
    const group = this.ensureGroup(input.groupId, input.groupTitle);
    const job: AgentDashboardJob = {
      ...input,
      status: "queued",
      latestActivity: "Queued",
      queuedMessages: [],
      transcript: [],
      tools: [],
      files: [],
      tests: [],
    };
    group.jobs.push(job);
    this.jobs.set(job.id, job);
    if (!this.selectedJobId) this.selectedJobId = job.id;
    this.notify();
    return job;
  }

  getJob(id: string): AgentDashboardJob | undefined {
    return this.jobs.get(id);
  }

  getSelectedJob(): AgentDashboardJob | undefined {
    return this.selectedJobId ? this.jobs.get(this.selectedJobId) : undefined;
  }

  getGroups(): AgentDashboardGroup[] {
    return [...this.groups.values()];
  }

  getActiveGroups(): AgentDashboardGroup[] {
    return this.getGroups().filter((group) => group.jobs.some((job) => !isFinished(job.status)));
  }

  getFinishedGroups(): AgentDashboardGroup[] {
    return this.getGroups().filter((group) => group.jobs.some((job) => isFinished(job.status)));
  }

  get finishedCount(): number {
    return [...this.jobs.values()].filter((job) => isFinished(job.status)).length;
  }

  isFocused(): boolean {
    return this.focused;
  }

  setFocused(value: boolean): void {
    this.focused = value;
    this.notify();
  }

  isFinishedExpanded(): boolean {
    return this.finishedExpanded;
  }

  toggleFinished(): void {
    this.finishedExpanded = !this.finishedExpanded;
    if (this.finishedExpanded) {
      for (const group of this.getFinishedGroups()) group.collapsed = false;
    } else {
      for (const group of this.getFinishedGroups()) group.collapsed = true;
    }
    this.notify();
  }

  toggleGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    group.collapsed = !group.collapsed;
    this.notify();
  }

  selectJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.selectedJobId = id;
    this.selectedGroupId = job.groupId;
    this.notify();
  }

  selectNext(delta: number): void {
    const selectable = this.getSelectableJobs();
    if (selectable.length === 0) return;
    const current = this.selectedJobId ? selectable.indexOf(this.selectedJobId) : -1;
    const next = current < 0 ? 0 : (current + delta + selectable.length) % selectable.length;
    this.selectedJobId = selectable[next];
    const selected = this.jobs.get(this.selectedJobId);
    this.selectedGroupId = selected?.groupId;
    this.notify();
  }

  selectGroup(delta: number): void {
    const groups = [...this.groups.values()];
    if (groups.length === 0) return;
    const current = this.selectedGroupId ? groups.findIndex((group) => group.id === this.selectedGroupId) : -1;
    const next = current < 0 ? 0 : (current + delta + groups.length) % groups.length;
    this.selectedGroupId = groups[next]?.id;
    const job = groups[next]?.jobs[0];
    if (job) this.selectedJobId = job.id;
    this.notify();
  }

  private getSelectableJobs(): string[] {
    const active = this.getActiveGroups().flatMap((group) => group.jobs.filter((job) => !isFinished(job.status)));
    if (active.length > 0) return active.map((job) => job.id);
    return this.getFinishedGroups().flatMap((group) => group.jobs).map((job) => job.id);
  }

  setControl(id: string, control: AgentControl | undefined): void {
    if (control) this.controls.set(id, control);
    else this.controls.delete(id);
  }

  control(id = this.selectedJobId): AgentControl | undefined {
    return id ? this.controls.get(id) : undefined;
  }

  updateJob(id: string, patch: Partial<AgentDashboardJob>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
    this.notify();
  }

  addTranscript(id: string, item: AgentTranscriptItem): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.transcript.push(item);
    if (job.transcript.length > 2000) job.transcript.splice(0, job.transcript.length - 2000);
    this.notify();
  }

  addTool(id: string, tool: AgentToolEvent): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const existing = job.tools.find((candidate) => candidate.id === tool.id);
    if (existing) Object.assign(existing, tool);
    else job.tools.push(tool);
    this.notify();
  }

  toggleTool(id: string, toolId: string): void {
    const job = this.jobs.get(id);
    const tool = job?.tools.find((candidate) => candidate.id === toolId);
    if (!tool) return;
    tool.expanded = !tool.expanded;
    this.notify();
  }

  setQueuedMessages(id: string, messages: string[]): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.queuedMessages = [...messages];
    this.notify();
  }

  finishJob(id: string, status: Extract<AgentStatus, "completed" | "failed" | "cancelled">, patch: Partial<AgentDashboardJob> = {}): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch, { status, finishedAt: patch.finishedAt ?? Date.now() });
    const group = this.groups.get(job.groupId);
    if (group && group.jobs.every((candidate) => isFinished(candidate.status))) group.collapsed = true;
    this.controls.delete(id);
    this.notify();
  }
}

export function isFinishedStatus(status: AgentStatus): boolean {
  return isFinished(status);
}
