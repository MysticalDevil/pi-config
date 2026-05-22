/**
 * ast-grep Tool — Structural AST-aware code search
 *
 * Wraps the ast-grep CLI (sg) as a pi tool. Searches code using AST
 * patterns instead of regex — understands code structure across 20+
 * languages including TS, JS, Rust, Python, Go, Zig, and more.
 *
 * Falls back to plain-text message when sg is not installed.
 *
 * Install:
 *   brew install ast-grep                 # macOS
 *   cargo install ast-grep --locked       # From source
 *   npm i -g @ast-grep/cli                # npm
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Common languages for autocomplete ────────────────────────────────

const LANG_HINT =
  "ts, js, tsx, jsx, rust, python, go, zig, c, cpp, java, kotlin, swift, ruby, lua, scala, html, css, json, yaml, toml, markdown";

const AstGrepParams = Type.Object({
  pattern: Type.String({
    description: "AST pattern to match. Use $VAR for metavariables and $$$ for ellipsis.",
  }),
  lang: Type.Optional(
    Type.String({
      description: `Language for pattern parsing. Auto-detected from file extensions if omitted. Common: ${LANG_HINT}.`,
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Paths to search. Multiple paths allowed. Default: ["."].',
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description: "Lines of context around each match (equivalent to -A/-B). Default: 0.",
      default: 0,
    }),
  ),
  globs: Type.Optional(
    Type.String({
      description:
        "File glob filter, e.g. '*.ts' or '!*.test.ts'. Precede with ! to exclude. Multiple globs can be separated by newline.",
    }),
  ),
  selector: Type.Optional(
    Type.String({
      description:
        "AST node kind to extract as the match target. See https://ast-grep.github.io/guide/rule-config/atomic-rule.html#pattern-object.",
    }),
  ),
  json: Type.Optional(
    Type.Boolean({
      description: "Return raw JSON match objects instead of formatted output. Default: false.",
      default: false,
    }),
  ),
});

// ── Availability detection ───────────────────────────────────────────

let sgAvailable = false;
let sgCmd = "sg";

try {
  // Try `sg` first (binary name on most platforms)
  const r = spawnSync("sg", ["--version"], { stdio: "ignore", timeout: 3000 });
  if (r.status === 0) {
    sgAvailable = true;
  } else {
    // Fall back to `ast-grep` (full name)
    const r2 = spawnSync("ast-grep", ["--version"], { stdio: "ignore", timeout: 3000 });
    if (r2.status === 0) {
      sgAvailable = true;
      sgCmd = "ast-grep";
    }
  }
} catch {
  /* not installed */
}

// ── Helpers ───────────────────────────────────────────────────────────

async function runSg(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await pi.exec(sgCmd, args, { cwd, signal });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.code ?? 1,
  };
}

interface AstGrepMatch {
  file: string;
  lines: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  language?: string;
  metaVariables?: Record<string, unknown>;
}

function parseStreamJson(stdout: string): AstGrepMatch[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as AstGrepMatch;
      } catch {
        return null;
      }
    })
    .filter((m): m is AstGrepMatch => m !== null);
}

function formatMatches(matches: AstGrepMatch[], maxMatchDisplay: number): string {
  if (matches.length === 0) return "No matches found.";

  const lines: string[] = [];
  const display = matches.slice(0, maxMatchDisplay);

  for (const m of display) {
    const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
    lines.push(loc);
    // Indent the matched code line
    const code = m.lines.trimEnd();
    if (code) {
      for (const codeLine of code.split("\n")) {
        lines.push(`  ${codeLine}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

const MAX_BYTES = 50 * 1024;

function truncateOutput(text: string, matchCount: number): string {
  if (Buffer.byteLength(text, "utf-8") <= MAX_BYTES) return text;

  const truncated = Buffer.from(text, "utf-8").subarray(0, MAX_BYTES).toString("utf-8");
  return (
    truncated +
    `\n\n[Output truncated at ${Math.round(MAX_BYTES / 1024)}KB. ` +
    `${matchCount} matches total. Narrow your pattern or paths to see more.]`
  );
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ast_grep",
    label: "AST Grep",
    description:
      `Structural AST-aware code search using ast-grep. Matches code by syntax structure, not text. Use $VAR for metavariables (match any single node), $$$ for ellipsis (match any sequence). Supports ${LANG_HINT}.` +
      (sgAvailable
        ? ""
        : "\n\n⚠️ ast-grep is not installed. Install it to use this tool: brew install ast-grep / cargo install ast-grep --locked / npm i -g @ast-grep/cli"),

    promptSnippet: "Search code structurally using AST patterns (metavariables $VAR, ellipsis $$$)",
    promptGuidelines: [
      "Use ast_grep for structural code search when you need to find code patterns that regex can't reliably match (e.g., matching function calls regardless of argument formatting, or finding all class declarations with specific properties).",
      "Use $VAR (uppercase) as metavariable to match any single AST node. Use $$$ for ellipsis to match any sequence of nodes.",
      "Set lang when the file extension is ambiguous or to force a specific parser. Common langs: ts, js, rust, python, go, zig.",
    ],
    parameters: AstGrepParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!sgAvailable) {
        return {
          content: [
            {
              type: "text",
              text:
                "ast-grep (sg) is not installed. Install it:\n" +
                "  brew install ast-grep               # macOS\n" +
                "  cargo install ast-grep --locked      # from source\n" +
                "  npm i -g @ast-grep/cli               # npm\n\n" +
                `Pattern: ${params.pattern}\n` +
                `Language: ${params.lang || "(auto)"}\n` +
                `Paths: ${(params.paths || ["."]).join(", ")}`,
            },
          ],
          details: { available: false },
        };
      }

      // Build args
      const args: string[] = ["run", "--json=stream", "--color=never"];
      args.push("--pattern", params.pattern);

      if (params.lang) args.push("--lang", params.lang);

      if (params.context && params.context > 0) {
        args.push("--context", String(params.context));
      }

      if (params.selector) args.push("--selector", params.selector);

      if (params.globs) {
        for (const g of params.globs
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)) {
          args.push("--globs", g);
        }
      }

      const searchPaths = params.paths?.length ? params.paths : ["."];
      args.push(...searchPaths);

      const { stdout, stderr, code } = await runSg(pi, args, ctx.cwd, signal);

      if (code !== 0 && code !== 1) {
        // code 1 = no matches, code > 1 = error
        return {
          content: [{ type: "text", text: stderr || `ast-grep failed with exit code ${code}` }],
          details: { exitCode: code, stderr },
        };
      }

      const matches = parseStreamJson(stdout);

      // JSON raw mode
      if (params.json) {
        const text = matches.length === 0 ? "[]" : JSON.stringify(matches.slice(0, 500), null, 2);
        return {
          content: [{ type: "text", text: truncateOutput(text, matches.length) }],
          details: {
            count: matches.length,
            language: params.lang,
            truncated: matches.length > 500,
          },
        };
      }

      // Formatted output
      const formatted = formatMatches(matches, 100);
      const header =
        `${matches.length} match${matches.length !== 1 ? "es" : ""}` +
        (params.lang ? ` in ${params.lang}` : "") +
        (params.paths ? ` under ${params.paths.join(", ")}` : "") +
        ":\n\n";

      const output = truncateOutput(header + formatted, matches.length);

      return {
        content: [{ type: "text", text: output }],
        details: {
          count: matches.length,
          language: params.lang,
          languages: [...new Set(matches.map((m) => m.language).filter(Boolean))],
          truncated: matches.length > 100,
        },
      };
    },

    renderCall(args, theme, _context) {
      const avail = sgAvailable ? "" : theme.fg("warning", " (not installed)");
      let text = theme.fg("toolTitle", theme.bold("ast-grep ")) + avail;
      text += theme.fg("accent", `\`${String(args.pattern || "...").slice(0, 60)}\``);
      if (args.lang) text += theme.fg("muted", ` ${args.lang}`);
      if (args.paths) text += theme.fg("dim", ` in ${(args.paths as string[]).join(", ")}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as Record<string, unknown> | undefined;
      if (details?.available === false) {
        return new Text(theme.fg("warning", "⚠️ ast-grep not installed"), 0, 0);
      }
      if (details?.exitCode && (details.exitCode as number) > 1) {
        return new Text(theme.fg("error", `Error (exit ${details.exitCode})`), 0, 0);
      }
      const count = (details?.count as number) ?? 0;
      if (count === 0) return new Text(theme.fg("muted", "No matches"), 0, 0);
      const langInfo = details?.language ? ` ${details.language}` : "";
      const truncInfo = details?.truncated ? " (output truncated)" : "";
      return new Text(
        theme.fg("success", `✓ ${count} match${count !== 1 ? "es" : ""}${langInfo}${truncInfo}`),
        0,
        0,
      );
    },
  });
}
