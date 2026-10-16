import type { Tool } from "./types.js";
import { truncate } from "./types.js";

interface Hit { title: string; url: string; snippet: string }

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web. Use for library docs, error messages, API changes, or anything that may be newer than your training data. Follow up with web_fetch on the best result.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "integer", minimum: 1, maximum: 10, description: "Results to return (default 5)" },
    },
    required: ["query"],
  },
  async run({ query, count = 5 }, ctx) {
    const { provider, apiKey, url } = ctx.config.search;
    let hits: Hit[];
    switch (provider) {
      case "brave": {
        const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
          headers: { Accept: "application/json", "X-Subscription-Token": apiKey ?? "" },
        });
        if (!r.ok) return `search error: ${r.status} ${await r.text()}`;
        const j = (await r.json()) as any;
        hits = (j.web?.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.description ?? "" }));
        break;
      }
      case "tavily": {
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: count }),
        });
        if (!r.ok) return `search error: ${r.status} ${await r.text()}`;
        const j = (await r.json()) as any;
        hits = (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "" }));
        break;
      }
      case "searxng": {
        const r = await fetch(`${url!.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`);
        if (!r.ok) return `search error: ${r.status} ${await r.text()}`;
        const j = (await r.json()) as any;
        hits = (j.results ?? []).slice(0, count).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? "" }));
        break;
      }
      default:
        return "web_search is not configured. Set BRAVE_API_KEY, TAVILY_API_KEY, or SEARXNG_URL.";
    }
    if (!hits.length) return "no results";
    return hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n");
  },
};

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch a URL and return its readable text (HTML stripped), e.g. documentation pages or search results you already have a URL for.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      max_chars: { type: "integer", description: "Default 15000" },
    },
    required: ["url"],
  },
  async run({ url, max_chars = 15_000 }) {
    if (!/^https?:\/\//.test(url)) return "error: url must start with http(s)://";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "arcode/0.1 (+coding agent)" } });
      const type = r.headers.get("content-type") ?? "";
      const raw = await r.text();
      const text = type.includes("html") ? htmlToText(raw) : raw;
      return truncate(`[${r.status}] ${url}\n\n${text}`, max_chars);
    } catch (e: any) {
      return `fetch error: ${e.message}`;
    } finally {
      clearTimeout(t);
    }
  },
};

/** Crude but dependency-free. Swap for a readability extractor later. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, "")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => "\n```\n" + c.replace(/<[^>]+>/g, "") + "\n```\n")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
