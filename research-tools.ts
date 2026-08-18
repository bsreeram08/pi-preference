import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36 PiWorkbenchResearch/1.0";
const MAX_REDIRECTS = 5;

export interface ResearchSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface ResearchSearchAttempt {
  provider: string;
  status: "skipped" | "failed" | "empty" | "success";
  detail: string;
}

export interface ResearchSearchResponse {
  query: string;
  provider: string;
  retrievedAt: string;
  results: ResearchSearchResult[];
  attempts: ResearchSearchAttempt[];
}

export interface ResearchFetchedPage {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl?: string;
  title: string;
  description?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  contentType: string;
  contentHash: string;
  text: string;
  truncated: boolean;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function cleanText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function metaContent(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return cleanText(match[1]);
    }
  }
  return undefined;
}

function linkHref(html: string, rel: string): string | undefined {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<link[^>]+rel=["'][^"']*${escaped}[^"']*["'][^>]+href=["']([^"']+)["']`, "i"),
    new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*${escaped}[^"']*["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return undefined;
}

export function extractHtmlDocument(html: string): {
  title: string;
  description?: string;
  publisher?: string;
  publishedAt?: string;
  canonicalUrl?: string;
  text: string;
} {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|template|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n");
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = decodeHtml(withoutNoise.replace(/<[^>]+>/g, " "))
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: titleMatch ? cleanText(titleMatch[1]) : "Untitled page",
    description: metaContent(html, ["description", "og:description", "twitter:description"]),
    publisher: metaContent(html, ["og:site_name", "application-name"]),
    publishedAt: metaContent(html, ["article:published_time", "datePublished", "date", "pubdate"]),
    canonicalUrl: linkHref(html, "canonical") ?? metaContent(html, ["og:url"]),
    text,
  };
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateIp(normalized.slice(7));
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export async function assertPublicResearchUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Research URLs must use http or https.");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new Error("Local/private URLs are blocked by the research fetcher.");
  if (isIP(hostname) && isPrivateIp(hostname)) throw new Error("Private network URLs are blocked by the research fetcher.");
  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length === 0 || addresses.some((result) => isPrivateIp(result.address))) {
      throw new Error("The research URL resolves to a private or unavailable network address.");
    }
  }
  return url;
}

async function safeFetch(rawUrl: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  let url = await assertPublicResearchUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "en-IN,en;q=0.9",
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        ...(init.headers ?? {}),
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    url = await assertPublicResearchUrl(new URL(location, url).toString());
  }
  throw new Error(`Too many redirects while fetching ${rawUrl}`);
}

function resolveCanonicalUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const resolved = new URL(value, base);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchResearchUrl(
  rawUrl: string,
  options: { maxChars?: number; signal?: AbortSignal } = {},
): Promise<ResearchFetchedPage> {
  const maxChars = Math.max(2_000, Math.min(options.maxChars ?? 30_000, 100_000));
  const response = await safeFetch(rawUrl, { signal: options.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${rawUrl}`);
  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  if (contentType === "application/pdf") throw new Error("PDF detected. Use research_browser or a primary HTML version; PDF extraction is not available in the static fetcher.");
  const body = await response.text();
  let title = new URL(response.url || rawUrl).hostname;
  let description: string | undefined;
  let publisher: string | undefined;
  let publishedAt: string | undefined;
  let canonicalUrl: string | undefined;
  let text = body;
  if (contentType.includes("html") || /<html|<body|<title/i.test(body.slice(0, 2_000))) {
    const extracted = extractHtmlDocument(body);
    ({ title, description, publisher, publishedAt, canonicalUrl, text } = extracted);
  } else if (contentType.includes("json")) {
    try { text = JSON.stringify(JSON.parse(body), null, 2); } catch { /* preserve original */ }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  const contentHash = createHash("sha256").update(normalized).digest("hex");
  const truncated = text.length > maxChars;
  return {
    requestedUrl: rawUrl,
    finalUrl: response.url || rawUrl,
    canonicalUrl: resolveCanonicalUrl(canonicalUrl, response.url || rawUrl),
    title,
    description,
    publisher,
    publishedAt,
    retrievedAt: new Date().toISOString(),
    contentType,
    contentHash,
    text: truncated ? `${text.slice(0, maxChars)}\n\n[Page text truncated at ${maxChars.toLocaleString()} characters.]` : text,
    truncated,
  };
}

function unwrapYahooUrl(href: string): string {
  const decoded = decodeHtml(href);
  const match = decoded.match(/\/RU=([^/]+)\/RK=/);
  if (match) return decodeURIComponent(match[1]);
  return decoded;
}

export function parseYahooSearchResults(html: string, limit = 10): ResearchSearchResult[] {
  const blocks = html.match(/<div class=["']dd algo[\s\S]*?<\/div>\s*<\/li>/gi) ?? [];
  const results: ResearchSearchResult[] = [];
  for (const block of blocks) {
    const href = block.match(/<div class=["']compTitle[\s\S]*?<a[^>]+href=["']([^"']+)["']/i)?.[1];
    const title = block.match(/<h3[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/h3>/i)?.[1]
      ?? block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i)?.[1];
    const snippet = block.match(/<div class=["']compText[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    if (!href || !title) continue;
    const url = unwrapYahooUrl(href);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title: cleanText(title), url, snippet: cleanText(snippet) });
    if (results.length >= limit) break;
  }
  return results;
}

function unwrapDuckDuckGoUrl(href: string): string {
  const decoded = decodeHtml(href);
  try {
    const parsed = new URL(decoded, "https://html.duckduckgo.com");
    return parsed.searchParams.get("uddg") ?? parsed.toString();
  } catch {
    return decoded;
  }
}

export function parseDuckDuckGoSearchResults(html: string, limit = 10): ResearchSearchResult[] {
  const blocks = html.match(/<div[^>]+class=["'][^"']*result(?:\s|__body)[^"']*["'][\s\S]*?(?=<div[^>]+class=["'][^"']*result(?:\s|__body)|$)/gi) ?? [];
  const results: ResearchSearchResult[] = [];
  for (const block of blocks) {
    const anchor = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = unwrapDuckDuckGoUrl(anchor[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const snippet = block.match(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1] ?? "";
    results.push({ title: cleanText(anchor[2]), url, snippet: cleanText(snippet) });
    if (results.length >= limit) break;
  }
  return results;
}

export function parseBingSearchResults(html: string, limit = 10): ResearchSearchResult[] {
  const blocks = html.match(/<li[^>]+class=["'][^"']*b_algo[^"']*["'][\s\S]*?<\/li>/gi) ?? [];
  const results: ResearchSearchResult[] = [];
  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    if (!anchor || !/^https?:\/\//i.test(decodeHtml(anchor[1]))) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    results.push({ title: cleanText(anchor[2]), url: decodeHtml(anchor[1]), snippet: cleanText(snippet) });
    if (results.length >= limit) break;
  }
  return results;
}

function withDomainFilters(query: string, domains?: string[]): string {
  const valid = (domains ?? []).map((domain) => domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
  return valid.length ? `${query} (${valid.map((domain) => `site:${domain}`).join(" OR ")})` : query;
}

async function braveSearch(query: string, limit: number, signal?: AbortSignal): Promise<ResearchSearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error("BRAVE_SEARCH_API_KEY is not configured");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const response = await safeFetch(url.toString(), { signal, headers: { "x-subscription-token": key, accept: "application/json" } });
  if (!response.ok) throw new Error(`Brave HTTP ${response.status}`);
  const payload = await response.json() as any;
  return (payload.web?.results ?? []).slice(0, limit).map((item: any) => ({
    title: cleanText(String(item.title ?? "")), url: String(item.url ?? ""), snippet: cleanText(String(item.description ?? "")),
    ...(item.page_age ? { publishedAt: String(item.page_age) } : {}),
  })).filter((item: ResearchSearchResult) => item.title && /^https?:\/\//.test(item.url));
}

async function tavilySearch(query: string, limit: number, signal?: AbortSignal): Promise<ResearchSearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not configured");
  const response = await safeFetch("https://api.tavily.com/search", {
    method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: "advanced", include_answer: false, include_raw_content: false }),
  });
  if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
  const payload = await response.json() as any;
  return (payload.results ?? []).slice(0, limit).map((item: any) => ({
    title: cleanText(String(item.title ?? "")), url: String(item.url ?? ""), snippet: cleanText(String(item.content ?? "")),
    ...(item.published_date ? { publishedAt: String(item.published_date) } : {}),
  })).filter((item: ResearchSearchResult) => item.title && /^https?:\/\//.test(item.url));
}

async function serperSearch(query: string, limit: number, signal?: AbortSignal): Promise<ResearchSearchResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY is not configured");
  const response = await safeFetch("https://google.serper.dev/search", {
    method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": key, accept: "application/json" },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
  const payload = await response.json() as any;
  return (payload.organic ?? []).slice(0, limit).map((item: any) => ({
    title: cleanText(String(item.title ?? "")), url: String(item.link ?? ""), snippet: cleanText(String(item.snippet ?? "")),
    ...(item.date ? { publishedAt: String(item.date) } : {}),
  })).filter((item: ResearchSearchResult) => item.title && /^https?:\/\//.test(item.url));
}

async function duckDuckGoSearch(query: string, limit: number, signal?: AbortSignal): Promise<ResearchSearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await safeFetch(url.toString(), { signal });
  if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
  return parseDuckDuckGoSearchResults(await response.text(), limit);
}

async function yahooSearch(query: string, limit: number, signal?: AbortSignal): Promise<ResearchSearchResult[]> {
  const url = new URL("https://search.yahoo.com/search");
  url.searchParams.set("p", query);
  const response = await safeFetch(url.toString(), { signal });
  if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
  return parseYahooSearchResults(await response.text(), limit);
}

async function bingSearch(query: string, limit: number, signal?: AbortSignal): Promise<ResearchSearchResult[]> {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const response = await safeFetch(url.toString(), { signal });
  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);
  return parseBingSearchResults(await response.text(), limit);
}

export function availableResearchSearchProviders(): string[] {
  return [
    ...(process.env.BRAVE_SEARCH_API_KEY ? ["Brave API"] : []),
    ...(process.env.TAVILY_API_KEY ? ["Tavily API"] : []),
    ...(process.env.SERPER_API_KEY ? ["Serper API"] : []),
    "DuckDuckGo/Yahoo/Bing HTML fallbacks",
    "direct fetch",
    "Playwright browser fallback",
  ];
}

export async function searchResearchWeb(
  rawQuery: string,
  options: { limit?: number; domains?: string[]; signal?: AbortSignal } = {},
): Promise<ResearchSearchResponse> {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 20));
  const query = withDomainFilters(rawQuery.trim(), options.domains);
  if (!query) throw new Error("Research search query cannot be empty.");
  const attempts: ResearchSearchAttempt[] = [];
  const providers: Array<{ name: string; configured: boolean; search: () => Promise<ResearchSearchResult[]> }> = [
    { name: "brave", configured: Boolean(process.env.BRAVE_SEARCH_API_KEY), search: () => braveSearch(query, limit, options.signal) },
    { name: "tavily", configured: Boolean(process.env.TAVILY_API_KEY), search: () => tavilySearch(query, limit, options.signal) },
    { name: "serper", configured: Boolean(process.env.SERPER_API_KEY), search: () => serperSearch(query, limit, options.signal) },
    { name: "duckduckgo-html", configured: true, search: () => duckDuckGoSearch(query, limit, options.signal) },
    { name: "yahoo-html", configured: true, search: () => yahooSearch(query, limit, options.signal) },
    { name: "bing-html", configured: true, search: () => bingSearch(query, limit, options.signal) },
  ];
  for (const provider of providers) {
    if (!provider.configured) {
      attempts.push({ provider: provider.name, status: "skipped", detail: "API key not configured" });
      continue;
    }
    try {
      const results = await provider.search();
      if (results.length === 0) {
        attempts.push({ provider: provider.name, status: "empty", detail: "No parseable results" });
        continue;
      }
      attempts.push({ provider: provider.name, status: "success", detail: `${results.length} results` });
      return { query, provider: provider.name, retrievedAt: new Date().toISOString(), results, attempts };
    } catch (error) {
      attempts.push({ provider: provider.name, status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new Error(`All research search providers failed: ${attempts.map((attempt) => `${attempt.provider}: ${attempt.detail}`).join("; ")}`);
}
