import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchResearchUrl, searchResearchWeb } from "./research-tools.ts";

const MAX_OUTPUT = 48 * 1024;
const BROWSER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "research-browser.mjs");

function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT) return text;
  let result = text.slice(0, MAX_OUTPUT);
  while (Buffer.byteLength(result, "utf8") > MAX_OUTPUT) result = result.slice(0, -1);
  return `${result}\n\n[Tool output truncated.]`;
}

export default function piWorkbenchChildTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "qmd_search",
    label: "QMD Search",
    description: "Read-only keyword search over local QMD Markdown collections. Returns JSON snippets and document paths.",
    promptSnippet: "Search local QMD-indexed project and council knowledge",
    promptGuidelines: ["Use qmd_search for prior project decisions and local Markdown knowledge; cite returned document paths."],
    parameters: Type.Object({
      query: Type.String({ description: "Focused keyword query" }),
      collection: Type.Optional(Type.String({ description: "Optional QMD collection name" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8 })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = ["search", "--json", "-n", String(params.limit ?? 8)];
      if (params.collection) args.push("-c", params.collection);
      args.push(params.query);
      const result = await pi.exec("qmd", args, { signal, timeout: 30_000 });
      if (result.code !== 0) throw new Error(result.stderr || "QMD search failed");
      return {
        content: [{ type: "text", text: truncate(result.stdout || "[]") }],
        details: { query: params.query, collection: params.collection, exitCode: result.code },
      };
    },
  });

  pi.registerTool({
    name: "research_search",
    label: "Research Search",
    description: "Search the public web through configured APIs with automatic fallback to a browser-readable search page. Returns titles, URLs, snippets, provider attempts, and retrieval time.",
    promptSnippet: "Search the public web with automatic provider fallback and provenance",
    promptGuidelines: [
      "Use research_search to discover sources, then use research_fetch or research_browser to inspect the source itself before making a material claim.",
      "Prefer official and primary sources; label search snippets as discovery evidence only.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Focused web query" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8 })),
      domains: Type.Optional(Type.Array(Type.String(), { description: "Optional domains to prioritize with site filters" })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await searchResearchWeb(params.query, { limit: params.limit, domains: params.domains, signal });
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(result, null, 2)) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "research_fetch",
    label: "Research Fetch",
    description: "Retrieve a public HTTP(S) source directly, extract readable text and metadata, and return a SHA-256 content fingerprint. Blocks local/private network targets and truncates long pages.",
    promptSnippet: "Fetch and extract a public source with metadata and content fingerprint",
    promptGuidelines: [
      "Use research_fetch on source URLs before citing them; capture the title, publisher, dates, exact excerpt, canonical URL, retrieval time, and contentHash in evidence.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Public http/https URL" }),
      maxChars: Type.Optional(Type.Number({ minimum: 2000, maximum: 100000, default: 30000 })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await fetchResearchUrl(params.url, { maxChars: params.maxChars, signal });
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(result, null, 2)) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "research_browser",
    label: "Research Browser",
    description: "Render a public JavaScript-dependent page in headless Chromium and return visible text, metadata, links, status, and a content fingerprint. Use only when direct fetch is insufficient.",
    promptSnippet: "Render a JavaScript-dependent public page with Playwright",
    promptGuidelines: [
      "Use research_browser only after research_fetch fails or returns an unusable shell; do not treat rendered platform data as owner-verified fact.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Public http/https URL" }),
      maxChars: Type.Optional(Type.Number({ minimum: 2000, maximum: 100000, default: 30000 })),
      purpose: Type.Optional(StringEnum(["dynamic-page", "maps", "listing", "social", "other"] as const)),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await pi.exec(process.execPath, [BROWSER_SCRIPT, params.url, String(params.maxChars ?? 30_000)], {
        signal,
        timeout: 70_000,
      });
      if (result.code !== 0) throw new Error(result.stderr || `Research browser exited with code ${result.code}`);
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`Research browser returned invalid JSON: ${result.stdout.slice(0, 500)}`); }
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(parsed, null, 2)) }],
        details: { ...(parsed as Record<string, unknown>), purpose: params.purpose },
      };
    },
  });
}
