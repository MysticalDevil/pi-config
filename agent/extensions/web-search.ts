/**
 * Web Search Tool — Search the web from within pi
 *
 * Uses DuckDuckGo Lite (no API key required).
 * Model can call web_search to find current information.
 *
 * Tool: web_search
 * Params: query (string), max_results (number, default 5)
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function searchDuckDuckGo(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const url = `https://lite.duckduckgo.com/lite?q=${encodeURIComponent(query)}`;
    const args = ["-sL", "-A", "Mozilla/5.0", "--max-time", "10", url];

    const proc = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let html = "";

    proc.stdout.on("data", (d: Buffer) => {
      html += d.toString();
    });
    proc.stderr.on("data", () => {});

    const abort = () => {
      try {
        proc.kill();
      } catch {
        /* dead */
      }
    };
    signal?.addEventListener("abort", abort, { once: true });

    proc.on("close", () => {
      signal?.removeEventListener("abort", abort);
      const results = parseDuckDuckGoLite(html, maxResults);
      resolve(results || "No results found.");
    });

    proc.on("error", () => resolve("Search failed: network error."));
  });
}

function parseDuckDuckGoLite(html: string, max: number): string {
  // DuckDuckGo Lite has results in <a> tags with class="result-link"
  // and snippets in <td class="result-snippet">
  const lines: string[] = [];
  const linkRe = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*result-link[^"]*"[^>]*>([^<]+)<\/a>/gi;
  const snippetRe = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ title: string; url: string }> = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ url: m[1], title: decodeEntities(m[2]) });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, "").trim()));
  }

  if (links.length === 0) return "";

  for (let i = 0; i < Math.min(links.length, max); i++) {
    const title = links[i].title;
    const url = links[i].url.startsWith("//") ? "https:" + links[i].url : links[i].url;
    const snippet = i < snippets.length ? snippets[i] : "";
    lines.push(`${i + 1}. **${title}**`);
    lines.push(`   ${url}`);
    if (snippet) lines.push(`   ${snippet}`);
    lines.push("");
  }

  return lines.join("\n");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web for current information. Returns titles, URLs, and snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(Type.Number({ description: "Max results (default 5, max 10)" })),
    }),

    async execute(_id, params, signal) {
      const query = params.query as string;
      const max = Math.min(params.max_results ?? 5, 10);

      const text = await searchDuckDuckGo(query, max, signal);
      return {
        content: [{ type: "text", text }],
        details: { query, results: text },
      };
    },
  });
}
