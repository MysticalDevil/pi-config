/**
 * rg/fd Tool Overrides — Faster grep/find via ripgrep and fd-find
 *
 * Overrides the built-in grep and find tools to use rg (ripgrep) and
 * fd (fd-find) when available. Falls back to system grep/find if
 * the faster tools are not installed.
 *
 * Install:
 *   sudo apt install ripgrep fd-find        # Debian/Ubuntu
 *   brew install ripgrep fd                  # macOS
 *   cargo install ripgrep fd-find            # From source
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ── Availability detection (cached at load time) ─────────────────────

let rgAvailable = false;
let fdAvailable = false;

try {
  const r = spawnSync("rg", ["--version"], { stdio: "ignore", timeout: 3000 });
  rgAvailable = r.status === 0;
} catch {
  /* not installed */
}

try {
  const r = spawnSync("fd", ["--version"], { stdio: "ignore", timeout: 3000 });
  fdAvailable = r.status === 0;
} catch {
  /* not installed */
}

// ── Helpers ───────────────────────────────────────────────────────────

async function runTool(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await pi.exec(command, args, { cwd, signal });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.code ?? 1,
  };
}

function buildGrepRgArgs(params: Record<string, unknown>): { command: string; args: string[] } {
  const pattern = (params.pattern as string) ?? "";
  const searchPath = (params.path as string) ?? ".";
  const ignoreCase = params.ignoreCase === true;
  const literal = params.literal === true;
  const glob = typeof params.glob === "string" ? params.glob : undefined;

  const args: string[] = ["--no-heading", "--with-filename", "--line-number", "--color=never"];

  if (ignoreCase) args.push("--ignore-case");
  if (literal) args.push("--fixed-strings");
  if (glob) args.push("--glob", glob);

  args.push("--", pattern, searchPath);
  return { command: "rg", args };
}

function buildGrepSystemArgs(params: Record<string, unknown>): { command: string; args: string[] } {
  const pattern = (params.pattern as string) ?? "";
  const searchPath = (params.path as string) ?? ".";
  const ignoreCase = params.ignoreCase === true;
  const literal = params.literal === true;
  const glob = typeof params.glob === "string" ? params.glob : undefined;

  const args: string[] = ["-rnH", "--color=never"];

  if (ignoreCase) args.push("-i");
  if (literal) args.push("-F");
  if (glob) args.push(`--include=${glob}`);

  args.push("--", pattern, searchPath);
  return { command: "grep", args };
}

function buildFindFdArgs(params: Record<string, unknown>): { command: string; args: string[] } {
  const pattern = (params.pattern as string) ?? "*";
  const searchPath = (params.path as string) ?? ".";

  const args: string[] = ["--hidden", "--no-ignore", "--type", "f", "--glob", pattern, searchPath];

  return { command: "fd", args };
}

function buildFindSystemArgs(params: Record<string, unknown>): { command: string; args: string[] } {
  const pattern = (params.pattern as string) ?? "*";
  const searchPath = (params.path as string) ?? ".";

  // Use -path + -name fallback for basic glob support
  const args: string[] = [searchPath, "-type", "f", "-name", pattern];

  return { command: "find", args };
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Grep override ──────────────────────────────────────────────────

  pi.registerTool({
    name: "grep",
    label: "Grep",
    description: rgAvailable
      ? "Search file contents for a pattern (uses ripgrep). Respects .gitignore. Output truncated to 100 matches or 50KB. Supports full regex syntax, --glob filtering, --ignore-case, --fixed-strings."
      : "Search file contents for a pattern. Respects .gitignore. Output truncated to 100 matches or 50KB. Supports full regex syntax, file type filtering, case-insensitive and literal matching.",

    // Inherit built-in parameter schema implicitly; define inline for self-documentation
    parameters: {} as any,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { command, args } = rgAvailable ? buildGrepRgArgs(params) : buildGrepSystemArgs(params);

      const { stdout, stderr, code } = await runTool(pi, command, args, ctx.cwd, signal);

      if (code !== 0 && code !== 1) {
        // code 1 = no matches (not an error)
        return {
          content: [{ type: "text", text: stderr || `grep failed with code ${code}` }],
          details: { exitCode: code },
        };
      }

      // Truncate to built-in limits
      const lines = stdout.split("\n").filter(Boolean);
      const maxLines = 2000;
      const maxBytes = 50 * 1024;
      let truncated = false;
      let output = stdout;

      if (lines.length > maxLines) {
        output = lines.slice(0, maxLines).join("\n");
        truncated = true;
      }
      if (Buffer.byteLength(output, "utf-8") > maxBytes) {
        output = Buffer.from(output, "utf-8").subarray(0, maxBytes).toString("utf-8");
        truncated = true;
      }

      const suffix = truncated
        ? `\n\n[Output truncated. ${lines.length} matches total. Use a more specific pattern or ` +
          `limit the search path.]`
        : "";

      return {
        content: [{ type: "text", text: output + suffix }],
        details: {
          matches: lines.length,
          truncated,
          exitCode: code,
          command: rgAvailable ? "rg" : "grep",
        },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold(rgAvailable ? "rg " : "grep "));
      text += theme.fg("accent", `/${args.pattern || "..."}/`);
      if (args.path && args.path !== ".") {
        text += theme.fg("dim", ` in ${args.path}`);
      }
      if (rgAvailable) text += theme.fg("dim", " (rg)");
      return new Text(text, 0, 0);
    },
  });

  // ── Find override ──────────────────────────────────────────────────

  pi.registerTool({
    name: "find",
    label: "Find",
    description: fdAvailable
      ? "Search for files by glob pattern (uses fd-find). Respects .gitignore. Returns matching file paths relative to the search directory. Output truncated to 1000 results or 50KB."
      : "Search for files by glob pattern. Respects .gitignore. Returns matching file paths relative to the search directory. Output truncated to 1000 results or 50KB.",

    parameters: {} as any,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { command, args } = fdAvailable ? buildFindFdArgs(params) : buildFindSystemArgs(params);

      const { stdout, stderr, code } = await runTool(pi, command, args, ctx.cwd, signal);

      if (code !== 0) {
        return {
          content: [{ type: "text", text: stderr || `find failed with code ${code}` }],
          details: { exitCode: code },
        };
      }

      const lines = stdout.split("\n").filter(Boolean);
      const maxLines = 1000;
      const maxBytes = 50 * 1024;
      let truncated = false;
      let output = stdout;

      if (lines.length > maxLines) {
        output = lines.slice(0, maxLines).join("\n");
        truncated = true;
      }
      if (Buffer.byteLength(output, "utf-8") > maxBytes) {
        output = Buffer.from(output, "utf-8").subarray(0, maxBytes).toString("utf-8");
        truncated = true;
      }

      const suffix = truncated
        ? `\n\n[Output truncated. ${lines.length} files total. Narrow the search pattern.]`
        : "";

      return {
        content: [{ type: "text", text: output + suffix }],
        details: {
          count: lines.length,
          truncated,
          exitCode: code,
          command: fdAvailable ? "fd" : "find",
        },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold(fdAvailable ? "fd " : "find "));
      text += theme.fg("accent", (args.pattern as string) || "*");
      if (args.path && args.path !== ".") {
        text += theme.fg("dim", ` in ${args.path}`);
      }
      if (fdAvailable) text += theme.fg("dim", " (fd)");
      return new Text(text, 0, 0);
    },
  });
}
