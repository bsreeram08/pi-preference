import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TODO_ENTRY = "pi-workbench-todo";
const TODO_ACTIONS = ["create", "update", "list", "delete", "clear"] as const;
const TODO_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;
const MAX_ITEMS = 40;
const MAX_TEXT = 240;

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoAction = (typeof TODO_ACTIONS)[number];

export interface TodoItem {
  id: number;
  subject: string;
  status: TodoStatus;
  activeForm?: string;
  blockedBy: number[];
}

export interface TodoSnapshot {
  version: 1;
  nextId: number;
  items: TodoItem[];
}

export interface TodoParams {
  action: TodoAction;
  subject?: string;
  activeForm?: string;
  status?: TodoStatus;
  id?: number;
  blockedBy?: number[];
}

const emptySnapshot = (): TodoSnapshot => ({ version: 1, nextId: 1, items: [] });

function clip(value: string | undefined, fallback = ""): string {
  return (value ?? fallback).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, MAX_TEXT);
}

export function restoreTodoSnapshot(value: unknown): TodoSnapshot {
  if (!value || typeof value !== "object") return emptySnapshot();
  const raw = value as Partial<TodoSnapshot>;
  if (raw.version !== 1 || !Array.isArray(raw.items) || typeof raw.nextId !== "number") return emptySnapshot();
  const items: TodoItem[] = [];
  for (const item of raw.items) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id < 1) continue;
    if (typeof item.subject !== "string" || !TODO_STATUSES.includes(item.status as TodoStatus)) continue;
    items.push({
      id: item.id,
      subject: clip(item.subject),
      status: item.status as TodoStatus,
      ...(typeof item.activeForm === "string" && item.activeForm.trim() ? { activeForm: clip(item.activeForm) } : {}),
      blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.filter((id) => typeof id === "number" && Number.isSafeInteger(id)) : [],
    });
  }
  return { version: 1, nextId: Math.max(raw.nextId, ...items.map((item) => item.id + 1), 1), items };
}

function visible(items: TodoItem[]): TodoItem[] {
  return items.filter((item) => item.status !== "deleted");
}

function renderTodos(snapshot: TodoSnapshot): string {
  const items = visible(snapshot.items);
  if (items.length === 0) return "No Workbench todos.";
  return items.map((item) => {
    const blocked = item.blockedBy.length ? `; blocked by ${item.blockedBy.join(",")}` : "";
    const active = item.status === "in_progress" && item.activeForm ? `; ${item.activeForm}` : "";
    return `- #${item.id} **${item.status}** ${item.subject}${active}${blocked}`;
  }).join("\n");
}

export function applyTodoAction(snapshot: TodoSnapshot, params: TodoParams): { snapshot: TodoSnapshot; text: string } {
  if (params.action === "list") return { snapshot, text: renderTodos(snapshot) };
  if (params.action === "clear") return { snapshot: emptySnapshot(), text: "Cleared Workbench todos." };

  if (params.action === "create") {
    const subject = clip(params.subject);
    if (!subject) throw new Error("todo create requires subject.");
    if (visible(snapshot.items).length >= MAX_ITEMS) throw new Error(`todo list is capped at ${MAX_ITEMS} items.`);
    const blockedBy = [...new Set(params.blockedBy ?? [])];
    if (blockedBy.includes(snapshot.nextId) || blockedBy.some((id) => !snapshot.items.some((item) => item.id === id && item.status !== "deleted"))) {
      throw new Error("todo blockedBy must reference existing items and cannot include the new id.");
    }
    const item: TodoItem = {
      id: snapshot.nextId,
      subject,
      status: "pending",
      blockedBy,
      ...(clip(params.activeForm) ? { activeForm: clip(params.activeForm) } : {}),
    };
    const next = { version: 1 as const, nextId: snapshot.nextId + 1, items: [...snapshot.items, item] };
    return { snapshot: next, text: `Created #${item.id}: ${item.subject}` };
  }

  if (typeof params.id !== "number" || !Number.isSafeInteger(params.id)) throw new Error("todo update/delete requires id.");
  const index = snapshot.items.findIndex((item) => item.id === params.id);
  if (index < 0) throw new Error(`Unknown todo #${params.id}.`);
  const current = snapshot.items[index]!;
  if (params.action === "delete") {
    const items = snapshot.items.map((item) => item.id === current.id ? { ...item, status: "deleted" as const } : item);
    return { snapshot: { ...snapshot, items }, text: `Deleted #${current.id}.` };
  }

  const nextItem: TodoItem = {
    ...current,
    ...(params.subject !== undefined ? { subject: clip(params.subject) || current.subject } : {}),
    ...(params.status && params.status !== "deleted" ? { status: params.status } : {}),
    ...(params.activeForm !== undefined ? (clip(params.activeForm) ? { activeForm: clip(params.activeForm) } : { activeForm: undefined }) : {}),
    ...(params.blockedBy ? { blockedBy: [...new Set(params.blockedBy)] } : {}),
  };
  if (nextItem.blockedBy.includes(nextItem.id)) throw new Error("todo cannot block itself.");
  const items = snapshot.items.map((item) => item.id === current.id ? nextItem : item);
  return { snapshot: { ...snapshot, items }, text: `Updated #${nextItem.id} (${nextItem.status}).` };
}

function snapshotFrom(ctx: ExtensionContext): TodoSnapshot {
  const entry = ctx.sessionManager.getBranch()
    .filter((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === TODO_ENTRY)
    .pop() as { data?: unknown } | undefined;
  return restoreTodoSnapshot(entry?.data);
}

export function registerWorkbenchTodo(pi: ExtensionAPI, report: (title: string, body: string) => void): void {
  pi.registerTool({
    name: "workbench_todo",
    label: "Workbench Todo",
    description: "First-party session todo list. Create, update, list, or clear bounded tasks. Prefer this over third-party todo tools.",
    promptSnippet: "Track multi-step work with workbench_todo",
    promptGuidelines: [
      "Use workbench_todo for session task lists; do not use third-party todo packages.",
      "Keep at most one in_progress item. Mark completed immediately when done.",
      "Do not store secrets or one-off chatter in todo subjects.",
    ],
    parameters: Type.Object({
      action: StringEnum(TODO_ACTIONS),
      subject: Type.Optional(Type.String({ description: "Task subject for create/update" })),
      activeForm: Type.Optional(Type.String({ description: "Present-continuous label while in_progress" })),
      status: Type.Optional(StringEnum(TODO_STATUSES)),
      id: Type.Optional(Type.Number({ description: "Todo id for update/delete" })),
      blockedBy: Type.Optional(Type.Array(Type.Number())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const applied = applyTodoAction(snapshotFrom(ctx), params as TodoParams);
      if (params.action !== "list") pi.appendEntry(TODO_ENTRY, applied.snapshot);
      return { content: [{ type: "text", text: applied.text }], details: { snapshot: applied.snapshot } };
    },
  });

  pi.registerCommand("todos", {
    description: "Show the first-party Workbench todo list",
    handler: async (_rawArgs, ctx) => {
      report("Workbench todos", renderTodos(snapshotFrom(ctx)));
    },
  });
}
