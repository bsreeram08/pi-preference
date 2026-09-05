import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CHECK_KINDS, checkPassed, runCheck } from "./verification.ts";

export function registerVerificationTool(pi: ExtensionAPI): void {
  const runId = process.env.PI_WORKBENCH_RUN_ID ?? randomUUID();
  const evidenceDir = process.env.PI_WORKBENCH_EVIDENCE_DIR
    ?? path.join(getAgentDir(), "workbench", "checks", runId);
  pi.registerTool({
    name: "workbench_verify",
    label: "Run verification check",
    description: "Run a project verification command with literal argv (no implicit shell). Records actual exit status, output, and before/after code fingerprints. Use for completion evidence; a plain claim or ordinary bash output cannot replace this receipt. A zero exit records execution only; judge whether the check proves the criterion. Never use it to edit, install, or deploy.",
    parameters: Type.Object({
      argv: Type.Array(Type.String(), { minItems: 1, maxItems: 128, description: 'Executable and literal arguments, e.g. ["bun", "test", "tests/orders.test.ts"].' }),
      cwd: Type.Optional(Type.String({ description: "Directory relative to the project root; defaults to the root." })),
      criterionIds: Type.Array(Type.String(), { minItems: 1, maxItems: 16, description: "Acceptance criterion IDs this check supports. Use a descriptive kebab-case ID for work without a packet." }),
      kind: StringEnum(CHECK_KINDS),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { receipt, output } = await runCheck(params, {
        projectRoot: process.env.PI_WORKBENCH_PROJECT_ROOT ?? ctx.cwd,
        evidenceDir, runId, signal,
      });
      const passed = checkPassed(receipt, receipt.snapshotAfter);
      return {
        content: [{ type: "text", text: `${passed ? "Check exited zero on unchanged code" : "Check did not pass"}. Receipt: ${receipt.id}\nExit: ${receipt.exitCode}; interrupted: ${receipt.interrupted}; code changed: ${receipt.snapshotBefore !== receipt.snapshotAfter}\nOutput artifact: ${path.join(evidenceDir, `${receipt.id}.log`)}\n\n${output}` }],
        details: { receipt },
      };
    },
  });
}
