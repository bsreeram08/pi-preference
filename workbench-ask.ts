import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_LABEL = 60;
const MAX_HEADER = 16;

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskParams {
  questions: AskQuestion[];
}

export function validateAskQuestions(questions: unknown): AskQuestion[] {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS) {
    throw new Error(`workbench_ask requires 1-${MAX_QUESTIONS} questions.`);
  }
  return questions.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Question ${index + 1} is malformed.`);
    const question = (raw as AskQuestion).question?.trim();
    const header = ((raw as AskQuestion).header ?? `Q${index + 1}`).trim().slice(0, MAX_HEADER);
    const options = (raw as AskQuestion).options;
    if (!question) throw new Error(`Question ${index + 1} needs a question string.`);
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      throw new Error(`Question ${index + 1} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
    }
    const parsed = options.map((option, optionIndex) => {
      const label = option?.label?.trim().slice(0, MAX_LABEL);
      const description = option?.description?.trim() || label;
      if (!label) throw new Error(`Question ${index + 1} option ${optionIndex + 1} needs a label.`);
      if (/^(other|type something\.?)$/i.test(label)) throw new Error(`"${label}" is reserved; Workbench appends a custom-answer path.`);
      return { label, description };
    });
    return {
      question,
      header,
      options: parsed,
      multiSelect: (raw as AskQuestion).multiSelect === true,
    };
  });
}

export function registerWorkbenchAsk(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workbench_ask",
    label: "Workbench Ask",
    description: "Ask the user up to 4 structured questions with 2-4 options each. Prefer this over third-party ask_user_question tools. Use only when a real decision is required.",
    promptSnippet: "Ask the user a structured question instead of guessing",
    promptGuidelines: [
      "Use workbench_ask for material product decisions; do not use third-party ask_user_question packages.",
      "Ask only when safe bounded progress is impossible without a user choice.",
      "Do not stack more than one workbench_ask call back-to-back; group questions in one call.",
    ],
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        question: Type.String({ description: "The complete question to ask" }),
        header: Type.Optional(Type.String({ description: "Short chip label" })),
        options: Type.Array(Type.Object({
          label: Type.String(),
          description: Type.Optional(Type.String()),
        })),
        multiSelect: Type.Optional(Type.Boolean()),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = validateAskQuestions(params.questions);
      if (!ctx.hasUI) throw new Error("workbench_ask requires interactive UI.");
      const answers: Array<{ question: string; header: string; answer: string }> = [];
      for (const item of questions) {
        const labels = [...item.options.map((option) => option.label), "Type something."];
        const selected = await ctx.ui.select(`${item.header}: ${item.question}`, labels);
        if (!selected) throw new Error("User cancelled workbench_ask.");
        let answer = selected;
        if (selected === "Type something.") {
          const typed = (await ctx.ui.input(item.question, "Your answer"))?.trim();
          if (!typed) throw new Error("User cancelled workbench_ask.");
          answer = typed;
        } else {
          const option = item.options.find((candidate) => candidate.label === selected);
          if (option?.description && option.description !== option.label) answer = `${option.label} — ${option.description}`;
        }
        answers.push({ question: item.question, header: item.header, answer });
      }
      const text = answers.map((item) => `- **${item.header}**: ${item.answer}`).join("\n");
      return { content: [{ type: "text", text }], details: { answers } };
    },
  });
}
