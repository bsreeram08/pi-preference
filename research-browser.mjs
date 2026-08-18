#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";

const rawUrl = process.argv[2];
const maxChars = Math.max(2_000, Math.min(Number(process.argv[3] ?? 30_000), 100_000));
if (!rawUrl) throw new Error("Usage: research-browser.mjs <url> [maxChars]");
const initial = new URL(rawUrl);
if (!['http:', 'https:'].includes(initial.protocol)) throw new Error("Only http/https URLs are supported");

function isPrivateIp(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIp(normalized.slice(7));
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

const hostSafety = new Map();
async function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (hostSafety.has(host)) return hostSafety.get(host);
  let blocked;
  if (isIP(host)) blocked = isPrivateIp(host);
  else {
    try {
      const addresses = await lookup(host, { all: true });
      blocked = addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address));
    } catch {
      blocked = true;
    }
  }
  hostSafety.set(host, blocked);
  return blocked;
}
if (await isBlockedHost(initial.hostname)) throw new Error("Local/private URLs are blocked");

function loadPlaywright() {
  const candidates = [];
  if (process.env.NODE_PATH) candidates.push(...process.env.NODE_PATH.split(path.delimiter));
  try { candidates.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()); } catch {}
  for (const root of candidates.filter(Boolean)) {
    try { return createRequire(path.join(root, "pi-workbench-research-loader.cjs"))("playwright"); } catch {}
  }
  try { return createRequire(import.meta.url)("playwright"); } catch {}
  throw new Error("Playwright is not installed. Install it globally or configure a search API key.");
}

const { chromium } = loadPlaywright();
const executableCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = executableCandidates.find((candidate) => fs.existsSync(candidate));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36 PiWorkbenchResearch/1.0",
    locale: "en-IN",
  });
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    try {
      const parsed = new URL(requestUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || await isBlockedHost(parsed.hostname)) {
        await route.abort();
        return;
      }
      const type = route.request().resourceType();
      if (["media", "font"].includes(type)) {
        await route.abort();
        return;
      }
      await route.continue();
    } catch {
      await route.abort();
    }
  });
  const page = await context.newPage();
  const response = await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_200);
  const finalUrl = page.url();
  const finalParsed = new URL(finalUrl);
  if (await isBlockedHost(finalParsed.hostname)) throw new Error("Navigation redirected to a blocked host");
  const data = await page.evaluate(() => {
    const meta = (keys) => {
      for (const key of keys) {
        const node = document.querySelector(`meta[name="${key}"],meta[property="${key}"]`);
        const value = node?.getAttribute("content")?.trim();
        if (value) return value;
      }
    };
    const canonical = document.querySelector('link[rel~="canonical"]')?.getAttribute('href') ?? undefined;
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 80).map((node) => ({
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      url: node.href,
    })).filter((item) => item.text && /^https?:/.test(item.url));
    return {
      title: document.title || location.hostname,
      description: meta(["description", "og:description", "twitter:description"]),
      publisher: meta(["og:site_name", "application-name"]),
      publishedAt: meta(["article:published_time", "datePublished", "date", "pubdate"]),
      canonicalUrl: canonical ? new URL(canonical, location.href).href : meta(["og:url"]),
      text: (document.body?.innerText ?? document.documentElement.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim(),
      links,
    };
  });
  const normalized = data.text.replace(/\s+/g, ' ').trim();
  const truncated = data.text.length > maxChars;
  process.stdout.write(JSON.stringify({
    requestedUrl: rawUrl,
    finalUrl,
    status: response?.status(),
    ...data,
    retrievedAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(normalized).digest("hex"),
    text: truncated ? `${data.text.slice(0, maxChars)}\n\n[Browser text truncated at ${maxChars} characters.]` : data.text,
    truncated,
  }));
} finally {
  await browser.close();
}
