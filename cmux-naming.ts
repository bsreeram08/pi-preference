import { Buffer } from "node:buffer";
import * as path from "node:path";

export interface CmuxWorkIdentity {
  readonly project: string;
  readonly task?: string;
  readonly title: string;
  readonly description: string;
}

const SENSITIVE_TEXT = /(?:api[ _-]?key|access[ _-]?token|auth(?:entication|orization)?[ _-]?token|password|passwd|credential|private[ _-]?key|secret|bearer\s+[a-z0-9._-]+|-----BEGIN|sentinel)/i;
const COMMON_CREDENTIAL_VALUE = /(?:\bgh[pousr]_[a-z0-9_]{20,}\b|\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b|\bAIza[a-z0-9_-]{35}\b|\beyJ[a-z0-9_-]+\.eyJ[a-z0-9_-]+\.[a-z0-9_-]{8,}\b)/i;
const TOKEN_LIKE_VALUE = /[a-z0-9_+/=-]{32,}/gi;
const CONTROL_TEXT = /[\u0000-\u001f\u007f-\u009f]/;
const LEADING_FILLER = /^(?:(?:and|also|please|kindly)\s+|(?:can|could|would)\s+you\s+|i\s+(?:need|want|would like)\s+(?:you\s+)?to\s+|help\s+(?:me\s+)?(?:to\s+)?)+/i;
const TITLE_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "i", "in", "is", "it", "me", "my",
  "not", "of", "on", "or", "our", "please", "properly", "that", "the", "them", "this", "to", "we", "with", "you", "your",
]);

function boundedWords(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const ellipsis = "…";
  const contentBudget = Math.max(0, maximumBytes - Buffer.byteLength(ellipsis, "utf8"));
  let clipped = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > contentBudget) break;
    clipped += character;
    bytes += characterBytes;
  }
  const boundary = clipped.lastIndexOf(" ");
  const atWordBoundary = boundary >= 0 ? clipped.slice(0, boundary).trimEnd() : "";
  const prefix = atWordBoundary && Buffer.byteLength(atWordBoundary, "utf8") >= Math.floor(maximumBytes * 0.6)
    ? atWordBoundary
    : clipped.trimEnd();
  return `${prefix}${ellipsis}`;
}

function containsSensitiveText(value: string): boolean {
  if (SENSITIVE_TEXT.test(value) || COMMON_CREDENTIAL_VALUE.test(value)) return true;
  const candidates = value.match(TOKEN_LIKE_VALUE) ?? [];
  return candidates.some((candidate) => {
    if (/^[a-f0-9]{32,}$/i.test(candidate)) return false;
    const classes = [/[a-z]/.test(candidate), /[A-Z]/.test(candidate), /\d/.test(candidate), /[_+/=-]/.test(candidate)];
    return classes.filter(Boolean).length >= 3;
  });
}

function cleanLocalText(value: string): string | undefined {
  const normalized = value
    .slice(0, 4_096)
    .normalize("NFKC")
    .replace(new RegExp(CONTROL_TEXT.source, "g"), " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || containsSensitiveText(normalized)) return undefined;
  return normalized;
}

function displayProjectName(cwd: string): string {
  const basename = path.basename(path.resolve(cwd));
  const base = basename && !CONTROL_TEXT.test(basename) ? cleanLocalText(basename) : undefined;
  if (!base) return "Project";
  const words = base.split(/[-_.\s]+/).filter(Boolean).map((word) => {
    const lower = word.toLowerCase();
    if (lower === "pi") return "Pi";
    if (["api", "cli", "sdk", "ui", "ux", "qa"].includes(lower)) return lower.toUpperCase();
    return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  });
  return boundedWords(words.join(" ") || "Project", 36);
}

function taskTitle(value: string): string {
  const firstThought = value.split(/(?<=[.!?])\s+|\n/)[0]?.replace(LEADING_FILLER, "").trim() || value;
  const words = firstThought.match(/[\p{L}\p{N}][\p{L}\p{N}'’+.#/-]*/gu) ?? [];
  const meaningful = words.filter((word, index) => index === 0 || !TITLE_STOP_WORDS.has(word.toLowerCase())).slice(0, 7);
  const selected = (meaningful.length >= 2 ? meaningful : words.slice(0, 7)).map((word, index) => {
    const cleaned = word.replace(/[.,;:!?/]+$/u, "");
    if (cleaned.toLowerCase() === "pi") return "Pi";
    if (cleaned.toLowerCase() === "cmux") return "cmux";
    return index === 0 ? `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}` : cleaned;
  }).filter(Boolean);
  const result = selected.join(" ");
  return boundedWords(result || "Current task", 48);
}

export function deriveCmuxWorkIdentity(input: {
  readonly cwd: string;
  readonly task?: string;
  readonly role?: string;
}): CmuxWorkIdentity {
  const project = displayProjectName(input.cwd);
  const safeTask = input.task ? cleanLocalText(input.task) : undefined;
  if (!safeTask) {
    return {
      project,
      title: project,
      description: input.role ? `${input.role} working in ${project}` : `${project} workspace`,
    };
  }
  const task = taskTitle(safeTask);
  const descriptionTask = boundedWords(safeTask, 120);
  return {
    project,
    task,
    title: boundedWords(`${project} · ${task}`, 128),
    description: boundedWords(input.role ? `${input.role}: ${descriptionTask}` : descriptionTask, 256),
  };
}
