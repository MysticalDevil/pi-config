/**
 * Sandbox + Permissions Extension
 *
 * Three permission modes (like Codex CLI):
 * - sandbox (default): OS-level sandboxing via bwrap with sensible dev defaults
 * - auto-review: Natively execute, but flag dangerous commands for review
 * - full-access:  No restrictions, full native execution
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/extensions/sandbox/config.json (global)
 * - <cwd>/.pi/sandbox.json               (project-local)
 *
 * Usage:
 * - `/permissions` — switch between sandbox / auto-review / full-access
 * - `/sandbox`     — show current sandbox configuration and status
 * - `pi --no-sandbox` — disable sandboxing at startup
 *
 * Sandbox mode wraps every bash command with bubblewrap (bwrap).
 * It creates a new mount namespace where:
 *   - The root filesystem is read-only by default
 *   - Project directory, /tmp, and common dev tool paths are writable
 *   - Sensitive paths (~/.ssh, ~/.aws, ~/.gnupg) are hidden (read denied)
 *   - Network access is shared with the host
 *   - PID namespace is isolated for clean teardown
 *
 * Requires: bubblewrap (bwrap) on Linux
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashOperations, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { evaluateCommand, type LoadedPolicy, loadPolicy } from "./execpolicy";
import { guardianReview, lightweightModel } from "./guardian";
import { auditLogHook, configProtectionHook, hooks, networkSafetyHook, setupHooks } from "./hooks";
import { setupSnapshots } from "./shell-snapshot";
import { setupTurnDiff } from "./turn-diff";

// ── Types ───────────────────────────────────────────────────────────────────

type PermissionMode = "sandbox" | "auto-review" | "full-access";

const MODE_EMOJI: Record<PermissionMode, string> = {
  sandbox: "🔒",
  "auto-review": "🔍",
  "full-access": "🔓",
};

const MODE_COLOR: Record<PermissionMode, string> = {
  sandbox: "accent",
  "auto-review": "warning",
  "full-access": "error",
};

interface SandboxConfig {
  enabled: boolean;
  /** Paths to make writable (in addition to cwd and /tmp) */
  writablePaths: string[];
  /** Paths to hide entirely (deny read + write) */
  deniedPaths: string[];
  /** Paths (globs) inside writable areas that should stay read-only */
  writeProtected: string[];
  /** Network restriction — if false, use --share-net */
  restrictNetwork: boolean;
  /** Extra bwrap arguments appended to every invocation */
  extraBwrapArgs: string[];
}

// ── Default Config (development-friendly, less conservative) ───────────────

const HOME = homedir();

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  writablePaths: [
    join(HOME, ".cache"),
    join(HOME, ".local"),
    join(HOME, ".npm"),
    join(HOME, ".mise"),
    join(HOME, ".cargo"),
    join(HOME, ".rustup"),
    join(HOME, ".config"),
    join(HOME, ".pi"),
    "/var/tmp",
  ],
  deniedPaths: [
    join(HOME, ".ssh"),
    join(HOME, ".aws"),
    join(HOME, ".gnupg"),
    join(HOME, ".gemini"),
    join(HOME, ".anthropic"),
  ],
  writeProtected: [".env", ".env.*", "*.pem", "*.key", "*.secret"],
  restrictNetwork: false,
  extraBwrapArgs: [],
};

// ── Config loading ──────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(HOME, p.slice(1));
  }
  return p;
}

function loadConfig(cwd: string): SandboxConfig {
  const globalConfigPath = join(getAgentDir(), "extensions", "sandbox", "config.json");
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");

  let global: Partial<SandboxConfig> = {};
  let project: Partial<SandboxConfig> = {};

  for (const [path, target] of [
    [globalConfigPath, "global"] as const,
    [projectConfigPath, "project"] as const,
  ]) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        if (target === "global") global = parsed;
        else project = parsed;
      } catch (e) {
        console.error(`Warning: Could not parse ${path}: ${e}`);
      }
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, deepMerge(global, project));

  // Expand tildes in all path arrays
  merged.writablePaths = merged.writablePaths.map(expandTilde);
  merged.deniedPaths = merged.deniedPaths.map(expandTilde);

  return merged;
}

function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  // IMPORTANT: Arrays are replaced (not concatenated). For example, project-level
  // writablePaths *replaces* the global default writablePaths entirely.
  // To extend a default list, copy it into your project config first.
  // Nested objects are recursively merged.
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overrides)) {
    const ov = (overrides as Record<string, unknown>)[key];
    if (ov !== undefined) {
      if (Array.isArray(ov)) {
        (result as Record<string, unknown>)[key] = ov;
      } else if (typeof ov === "object" && ov !== null && !Array.isArray(ov)) {
        (result as Record<string, unknown>)[key] = deepMerge(
          ((base as Record<string, unknown>)[key] as Record<string, unknown>) ?? {},
          ov as Record<string, unknown>,
        );
      } else {
        (result as Record<string, unknown>)[key] = ov;
      }
    }
  }
  return result as T;
}

// ── bwrap detection ─────────────────────────────────────────────────────────

let bwrapAvailable: boolean | undefined;

function checkBwrap(): boolean {
  if (bwrapAvailable !== undefined) return bwrapAvailable;
  try {
    execSync("bwrap --version", { stdio: "ignore" });
    bwrapAvailable = true;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

// ── bwrap command builder ───────────────────────────────────────────────────

/**
 * Build a bwrap command line that isolates the shell command.
 *
 * Strategy:
 * 1. Bind-mount the entire root filesystem read-only
 * 2. Re-bind allowed write paths as read-write
 * 3. Hide denied paths by bind-mounting an empty directory over them
 * 4. Set up /dev, /proc, /tmp
 * 5. Unshare all namespaces except network (unless restrictive)
 */
function buildBwrapArgs(command: string, cwd: string, config: SandboxConfig): string[] {
  const args: string[] = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--chdir",
    cwd,
    "--die-with-parent",
  ];

  // Unshare everything except network (unless restrictive)
  args.push("--unshare-all");
  if (!config.restrictNetwork) {
    args.push("--share-net");
  }

  // Ensure working directory exists, bind it writable
  if (existsSync(cwd)) {
    args.push("--bind", cwd, cwd);
  }

  // Bind writable paths
  for (const wp of config.writablePaths) {
    if (existsSync(wp)) {
      args.push("--bind", wp, wp);
    }
  }

  // Always make /tmp writable via tmpfs (already done above)

  // Hide denied paths — bind an empty tmpfs over them
  // Per-process unique directory to avoid races between concurrent pi instances
  const emptyDir = `/tmp/.bwrap-empty-${process.pid}`;
  ensureEmptyDir(emptyDir);

  for (const dp of config.deniedPaths) {
    if (existsSync(dp)) {
      args.push("--bind", emptyDir, dp);
    }
  }

  // Extra args from config
  for (const a of config.extraBwrapArgs) {
    args.push(a);
  }

  // The command to run
  args.push("bash", "-c", command);

  return args;
}

/**
 * Ensure an empty directory exists for bind-mount hiding.
 * Uses fs.rmSync + fs.mkdirSync directly (no shell).
 */
function ensureEmptyDir(path: string) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

// ── Bash operations: sandboxed ──────────────────────────────────────────────

function createSandboxedBashOps(config: SandboxConfig): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const bwrapArgs = buildBwrapArgs(command, cwd, config);

      return new Promise((_resolve, reject) => {
        const child = spawn("bwrap", bwrapArgs, {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch (e) {
                console.error(
                  "sandbox: failed to kill process group, falling back to direct kill:",
                  e,
                );
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (e) {
              console.error("sandbox: abort failed to kill process group, direct kill:", e);
              child.kill("SIGKILL");
            }
          }
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            _resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

// ── Read defaultPermissions from settings.json ────────────────────────────

function getDefaultPermissions(cwd: string): PermissionMode | undefined {
  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "settings.json");

  let permissions: string | undefined;

  for (const path of [globalSettingsPath, projectSettingsPath]) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        if (parsed.defaultPermissions) {
          permissions = parsed.defaultPermissions;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  if (permissions && ["sandbox", "auto-review", "full-access"].includes(permissions)) {
    return permissions as PermissionMode;
  }
  return undefined;
}

// ── Check if a path matches write-protection patterns ──────────────────────

function isWriteProtected(filepath: string, patterns: string[]): boolean {
  const base = filepath.split("/").pop() ?? filepath;
  for (const p of patterns) {
    if (p.includes("*")) {
      // Simple glob: *.ext => endsWith, prefix* => startsWith
      if (p.startsWith("*.") && base.endsWith(p.slice(1))) return true;
      if (p.endsWith(".*") && base.startsWith(p.slice(0, -2))) return true;
      if (p === base) return true;
    } else {
      if (base === p) return true;
    }
  }
  return false;
}

// ── Secret scanner for git diff ─────────────────────────────────────────

interface DiffFinding {
  file: string;
  line: number;
  type: string;
  masked: string;
}

function scanGitDiff(diff: string): DiffFinding[] {
  const findings: DiffFinding[] = [];
  const lines = diff.split("\n");
  let currentFile = "";
  let currentLine = 0;

  const patterns: Array<{ pattern: RegExp; type: string }> = [
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(sk-[a-zA-Z0-9]{20,})["']?/g,
      type: "API key",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(AIza[a-zA-Z0-9_-]{30,})["']?/g,
      type: "Google API key",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(ghp_[a-zA-Z0-9]{30,})["']?/g,
      type: "GitHub token",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(github_pat_[a-zA-Z0-9_]{30,})["']?/g,
      type: "GitHub token",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(xox[bprs]-[a-zA-Z0-9-]{30,})["']?/g,
      type: "Slack token",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(AKIA[a-zA-Z0-9]{16})["']?/g,
      type: "AWS key",
    },
    {
      pattern: /(-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----)/g,
      type: "Private key",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*[:=]\s*["']?(mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@)/g,
      type: "DB connection",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*[:=]\s*["']?(postgres(?:ql)?:\/\/[^:]+:[^@]+@)/g,
      type: "DB connection",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*[:=]\s*["']?(redis(?:s)?:\/\/[^:]+:[^@]+@)/g,
      type: "Redis connection",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(https?:\/\/[^:]+:[^@]+@)/g,
      type: "URL credentials",
    },
    {
      pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']([^"'\s]{8,})["']?/gi,
      type: "Credential",
    },
    // OpenAI / LLM keys
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(sk-proj-[a-zA-Z0-9_-]{30,})["']?/g,
      type: "OpenAI project key",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(sk-svcacct-[a-zA-Z0-9_-]{30,})["']?/g,
      type: "OpenAI service account",
    },
    // Anthropic keys
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(sk-ant-(?:api03|admin)-[a-zA-Z0-9_-]{30,})["']?/g,
      type: "Anthropic API key",
    },
    // HuggingFace tokens
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(hf_[a-zA-Z0-9]{30,})["']?/g,
      type: "HuggingFace token",
    },
    // Stripe live keys (sk_live_...) — separate from generic sk- pattern
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(sk_live_[a-zA-Z0-9]{20,})["']?/g,
      type: "Stripe live key",
    },
    {
      pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(rk_live_[a-zA-Z0-9]{20,})["']?/g,
      type: "Stripe restricted key",
    },
    // JWT tokens (standalone)
    {
      pattern: /(eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})/g,
      type: "JWT token",
    },
  ];

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)/);
      currentLine = m ? parseInt(m[1], 10) : currentLine;
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    currentLine++;
    const added = line.slice(1);
    for (const { pattern, type } of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(added);
      while (match !== null) {
        const captured = match[1] || match[0];
        const masked =
          captured.length > 25 ? `${captured.slice(0, 12)}...${captured.slice(-5)}` : "***";
        findings.push({ file: currentFile, line: currentLine, type, masked });
        match = pattern.exec(added);
      }
    }
  }
  return findings;
}

// ── Main Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── State ─────────────────────────────────────────────────────────────

  let currentMode: PermissionMode = "sandbox";
  let sandboxConfig: SandboxConfig = DEFAULT_CONFIG;
  let sandboxActive = false; // true when sandbox mode is actually enforcing
  let localCwd = process.cwd();
  let localBash = createBashTool(localCwd);
  let sandboxedBash = createBashTool(localCwd, {
    operations: createSandboxedBashOps(sandboxConfig),
  });

  // ── CLI flag ──────────────────────────────────────────────────────────

  pi.registerFlag("no-sandbox", {
    description: "Disable sandboxing (start in full-access mode)",
    type: "boolean",
    default: false,
  });

  // ── Apply permission mode ─────────────────────────────────────────────

  function applyMode(
    mode: PermissionMode,
    source: string,
    ctx?: {
      ui?: {
        setStatus: (id: string, text: string | undefined) => void;
        notify: (text: string, level: string) => void;
        theme: { fg: (color: string, text: string) => string };
      };
    },
  ) {
    currentMode = mode;
    sandboxActive = mode === "sandbox" && !!bwrapAvailable && sandboxConfig.enabled;

    // Persist to session
    pi.appendEntry("permissions-mode", { mode, timestamp: Date.now() });

    // Status bar
    const color = MODE_COLOR[mode];
    const emoji = MODE_EMOJI[mode];
    if (ctx?.ui) {
      ctx.ui.setStatus("permissions", ctx.ui.theme.fg(color, `${emoji} Permissions: ${mode}`));
      const detail = sandboxActive
        ? "bwrap sandbox active"
        : mode === "sandbox"
          ? "bwrap not available — running native"
          : "";
      ctx.ui.notify(
        `Permissions: ${mode}${detail ? ` (${detail})` : ""}${source ? ` [${source}]` : ""}`,
        mode === "full-access" ? "warning" : "info",
      );
    }
  }

  // ── Inject permission mode into agent context ────────────────────────

  pi.on("before_agent_start", async (event) => {
    const bwrapOk = checkBwrap();
    const sandboxStatus =
      currentMode === "sandbox"
        ? sandboxActive
          ? "active (bwrap)"
          : bwrapOk
            ? "inactive"
            : "bwrap missing"
        : "inactive";
    const details =
      `Mode: ${currentMode} (sandbox ${sandboxStatus})\n` +
      `Denied paths: ${sandboxConfig.deniedPaths.filter((p) => existsSync(p)).length} active\n` +
      `Write protected: ${sandboxConfig.writeProtected.join(", ")}\n` +
      `ExecPolicy: ${currentPolicy.rules.length} rules, ${currentPolicy.bannedPrefixes.length} banned`;
    return {
      message: {
        customType: "permissions-context",
        content: `<permissions>\n${details}\n</permissions>`,
        display: false,
      },
      systemPrompt: event.systemPrompt + `\n\n<permissions>\n${details}\n</permissions>\n`,
    };
  });

  // ── Override bash tool ────────────────────────────────────────────────

  pi.registerTool({
    ...localBash,
    label: "bash (permissions-aware)",
    async execute(id, params, signal, onUpdate, _ctx) {
      // full-access or auto-review: run natively
      if (currentMode === "full-access" || currentMode === "auto-review") {
        return localBash.execute(id, params, signal, onUpdate);
      }

      // sandbox mode with bwrap
      if (currentMode === "sandbox" && bwrapAvailable && sandboxConfig.enabled) {
        return sandboxedBash.execute(id, params, signal, onUpdate);
      }

      // Fallback: sandbox mode but no bwrap
      return localBash.execute(id, params, signal, onUpdate);
    },
  });

  // ── User bash (!! and ! commands) ─────────────────────────────────────

  pi.on("user_bash", async (event, ctx) => {
    const command = event.command;

    // Secret detection on git commit
    if (/\bgit\s+commit\b/.test(command) && !/\bgit\s+commit\s*--dry-run\b/.test(command)) {
      try {
        const diff = execSync("git diff --cached --unified=0", {
          cwd: event.cwd,
          encoding: "utf-8",
          maxBuffer: 2 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (diff.trim()) {
          const findings = scanGitDiff(diff);
          if (findings.length > 0 && !process.env.ALLOW_SECRETS) {
            const report = findings
              .map((f) => `  ${f.file}:${f.line}  ${f.type}: ${f.masked}`)
              .join("\n");
            return {
              result: {
                output: `⚠️ Secret-detection blocked. ${findings.length} potential secret(s):\n${report}\n\nRemove secrets or set ALLOW_SECRETS=1 to bypass.`,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            };
          }
        }
      } catch (e) {
        if (
          e instanceof Error &&
          !e.message.includes("not a git repository") &&
          !e.message.includes("did not match any files")
        ) {
          ctx.ui.notify(`Secret-detection scan failed: ${e.message}`, "warning");
        }
      }
    }

    // auto-review: also evaluate user-bash commands
    if (currentMode === "auto-review") {
      const { evaluation, bannedBy } = evaluateCommand(command, currentPolicy);
      if (bannedBy || evaluation.decision === "forbidden") {
        return {
          result: {
            output: `Auto-review: blocked — ${bannedBy ? `banned prefix "${bannedBy.join(" ")}"` : `forbidden by policy`}`,
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        };
      }
      if (evaluation.decision === "prompt") {
        // Auto-review: guardian makes the final call for user commands too
        ctx.ui.setStatus("guardian", `🔍 Guardian reviewing: ${command.slice(0, 60)}...`);
        try {
          const gr = await guardianReview(
            command,
            ctx.cwd,
            60000,
            ctx.signal,
            lightweightModel(ctx.model?.id),
          );
          if (gr.outcome === "allow") {
            ctx.ui.setStatus("guardian", undefined);
            ctx.ui.notify(`✅ Auto-approved: ${gr.reason}`, "warning");
            // fall through to execute
          } else {
            ctx.ui.setStatus("guardian", undefined);
            ctx.ui.notify(`🚫 Auto-review blocked: ${gr.reason}`, "error");
            return {
              result: {
                output: `Auto-review blocked: ${gr.reason}`,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            };
          }
        } catch (e) {
          ctx.ui.notify(
            `⚠️ Guardian unavailable: ${e instanceof Error ? e.message : e}. Blocking: ${command.slice(0, 80)}`,
            "warning",
          );
          return {
            result: {
              output: `Guardian review failed — blocked for safety.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
      }

      // Check for writes to protected paths (shell redirects to .env etc.)
      const writeTargetMatch = command.match(/[>]\s*(\S+)/g);
      if (writeTargetMatch) {
        for (const m of writeTargetMatch) {
          const target = m.replace(/^[>]+\s*/, "");
          if (isWriteProtected(target, sandboxConfig.writeProtected)) {
            return {
              result: {
                output: `Auto-review: blocked — write to protected path "${target}".`,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            };
          }
        }
      }
      // prompt in interactive mode and allow/null: fall through to native execution
    }

    if (currentMode === "sandbox" && sandboxActive) {
      return { operations: createSandboxedBashOps(sandboxConfig) };
    }
    return;
  });

  // ── Reset per-turn state ────────────────────────────────────────────

  // ── Load execpolicy ──────────────────────────────────────────────────

  let currentPolicy: LoadedPolicy = {
    rules: [],
    bannedPrefixes: [],
    sources: [],
  };

  // ── tool_call interception: auto-review mode ──────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command as string;

    // ── Secret detection: scan staged diff on git commit (all modes) ──
    if (/\bgit\s+commit\b/.test(command) && !/\bgit\s+commit\s*--dry-run\b/.test(command)) {
      try {
        const diff = execSync("git diff --cached --unified=0", {
          cwd: ctx.cwd,
          encoding: "utf-8",
          maxBuffer: 2 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (diff.trim()) {
          const findings = scanGitDiff(diff);
          if (findings.length > 0 && !process.env.ALLOW_SECRETS) {
            const report = findings
              .map((f) => `  ${f.file}:${f.line}  ${f.type}: ${f.masked}`)
              .join("\n");
            return {
              block: true,
              reason: `Secret-detection: ${findings.length} potential secret(s) in staged changes:\n${report}\n\nRemove secrets or set ALLOW_SECRETS=1 to bypass.`,
            };
          }
        }
      } catch (e) {
        if (e instanceof Error && !e.message.includes("not a git repository")) {
          return {
            result: {
              output: `Secret-detection scan failed: ${e.message}`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
      }
    }

    // auto-review: execpolicy + guardian evaluation
    if (currentMode === "auto-review") {
      const { evaluation, bannedBy } = evaluateCommand(command, currentPolicy);

      // Banned prefixes: block immediately (model trying to bypass sandbox)
      if (bannedBy) {
        ctx.ui.notify(
          `🚫 Auto-review: banned prefix "${bannedBy.join(" ")}" blocked:\n  ${command.slice(0, 100)}`,
          "error",
        );
        return {
          block: true,
          reason: `Banned command prefix: ${bannedBy.join(" ")}`,
        };
      }

      // Execpolicy decision
      if (evaluation.decision === "forbidden") {
        const rule = evaluation.matchedRules[0];
        ctx.ui.notify(
          `🚫 Auto-review: forbidden by policy (${rule.justification}):\n  ${command.slice(0, 100)}`,
          "error",
        );
        return {
          block: true,
          reason: `Forbidden by policy: ${rule.justification}`,
        };
      }

      if (evaluation.decision === "prompt") {
        // auto-review: guardian makes the final call, no user prompt
        ctx.ui.setStatus("guardian", `🔍 Guardian reviewing: ${command.slice(0, 60)}...`);
        try {
          const gr = await guardianReview(
            command,
            ctx.cwd,
            60000,
            ctx.signal,
            lightweightModel(ctx.model?.id),
          );
          ctx.ui.setStatus("guardian", undefined);
          if (gr.outcome === "allow") {
            ctx.ui.notify(`✅ Auto-approved: ${gr.reason}`, "warning");
            // fall through to execute
          } else {
            ctx.ui.notify(`🚫 Auto-review blocked: ${gr.reason}`, "error");
            return { block: true, reason: `Guardian blocked: ${gr.reason}` };
          }
        } catch (e) {
          ctx.ui.setStatus("guardian", undefined);
          ctx.ui.notify(`⚠️ Guardian unavailable, blocking: ${command.slice(0, 80)}`, "warning");
          return {
            block: true,
            reason: `Guardian review failed — blocked for safety: ${e instanceof Error ? e.message : e}`,
          };
        }
      }
    }

    // sandbox: check write-protected paths for edit/write tools
    if (currentMode === "sandbox") {
      // (bash itself is handled by the tool override above)
    }
  });

  // Also intercept write/edit to protect sensitive paths in sandbox mode
  pi.on("tool_call", async (event, ctx) => {
    if (currentMode !== "sandbox") return;

    if (event.toolName === "write" || event.toolName === "edit") {
      const filepath = (event.input as { path?: string }).path ?? "";
      if (isWriteProtected(filepath, sandboxConfig.writeProtected)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`🔒 Sandbox: write to protected path blocked: ${filepath}`, "warning");
        }
        return {
          block: true,
          reason: `Sandbox: write to protected path "${filepath}" is blocked`,
        };
      }
      const resolved = resolve(filepath);
      for (const denied of sandboxConfig.deniedPaths) {
        if (resolved.startsWith(`${denied}/`) || resolved === denied) {
          ctx.ui.notify(`🔒 Sandbox: write to denied path blocked: ${filepath}`, "warning");
          return {
            block: true,
            reason: `Sandbox: write to "${filepath}" is blocked (denied path)`,
          };
        }
      }
    }

    if (event.toolName === "read") {
      const filepath = (event.input as { path?: string }).path ?? "";
      const resolved = resolve(filepath);
      for (const denied of sandboxConfig.deniedPaths) {
        if (resolved.startsWith(`${denied}/`) || resolved === denied) {
          ctx.ui.notify(`🔒 Sandbox: read of denied path blocked: ${filepath}`, "warning");
          return {
            block: true,
            reason: `Sandbox: read of "${filepath}" is blocked (denied path)`,
          };
        }
      }
    }
  });

  // ── Session lifecycle ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    localCwd = ctx.cwd;
    localBash = createBashTool(localCwd);
    const noSandbox = pi.getFlag("no-sandbox") as boolean;

    // Load config
    sandboxConfig = loadConfig(ctx.cwd);

    // Load execpolicy rules (project-specific)
    currentPolicy = loadPolicy(ctx.cwd);

    // Restore mode from session entries
    let restoredMode: PermissionMode | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "permissions-mode") {
        const data = entry.data as { mode?: PermissionMode } | undefined;
        if (data?.mode && ["sandbox", "auto-review", "full-access"].includes(data.mode)) {
          restoredMode = data.mode;
        }
      }
    }

    // Determine initial mode: CLI flag > session restore > settings default > hardcoded default
    const settingsDefault = getDefaultPermissions(ctx.cwd);
    const initialMode: PermissionMode = noSandbox
      ? "full-access"
      : (restoredMode ?? settingsDefault ?? "sandbox");

    // Check platform
    if (initialMode === "sandbox" && process.platform !== "linux") {
      ctx.ui.notify(
        `Sandbox mode requires Linux (bwrap). Current platform: ${process.platform}. Falling back to full-access.`,
        "warning",
      );
      applyMode("full-access", "platform-fallback", ctx);
    } else if (initialMode === "sandbox" && !checkBwrap()) {
      ctx.ui.notify(
        "bwrap not found. Install bubblewrap: sudo apt install bubblewrap. Falling back to full-access.",
        "warning",
      );
      applyMode("full-access", "bwrap-missing", ctx);
    } else if (initialMode === "sandbox" && !sandboxConfig.enabled) {
      ctx.ui.notify("Sandbox disabled in config. Using full-access.", "info");
      applyMode("full-access", "config-disabled", ctx);
    } else {
      applyMode(
        initialMode,
        noSandbox
          ? "cli-flag"
          : restoredMode
            ? "session-restore"
            : settingsDefault
              ? "settings"
              : "default",
        ctx,
      );
    }

    // Show sandbox info in status
    if (sandboxActive || initialMode === "sandbox") {
      const writePathCount = sandboxConfig.writablePaths.filter((p) => existsSync(p)).length;
      const denyPathCount = sandboxConfig.deniedPaths.filter((p) => existsSync(p)).length;
      ctx.ui.setStatus(
        "sandbox-detail",
        ctx.ui.theme.fg("dim", `${writePathCount} writable, ${denyPathCount} denied`),
      );
    }
  });

  pi.on("session_shutdown", async () => {
    // Clean up per-process empty dir marker
    try {
      rmSync(`/tmp/.bwrap-empty-${process.pid}`, { recursive: true, force: true });
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("sandbox: failed to clean up empty dir:", e.message);
      }
    }
  });

  // ── Setup shell snapshots ────────────────────────────────────────────

  setupSnapshots(pi);

  // ── Setup hooks system ───────────────────────────────────────────────

  setupHooks(pi);
  hooks.register(networkSafetyHook);
  hooks.register(configProtectionHook);
  hooks.register(auditLogHook);

  // ── Setup turn diff tracking ─────────────────────────────────────────

  setupTurnDiff(pi);

  // ── /permissions command ───────────────────────────────────────────────

  pi.registerCommand("permissions", {
    description:
      "Switch permission mode or check status (usage: /permissions [sandbox|auto-review|full-access|--status])",
    handler: async (_args, ctx) => {
      const arg = (_args || "").trim();

      // --status: show current mode without switching
      if (arg === "--status" || arg === "status" || arg === "show") {
        const bwrapOk = checkBwrap();
        const lines = [
          `${MODE_EMOJI[currentMode]} Mode: ${currentMode}`,
          `Sandbox: ${sandboxActive ? (bwrapOk ? "🔒 active (bwrap)" : "⚠️ active (bwrap missing)") : "❌ inactive"}`,
          `bwrap: ${bwrapOk ? "✅ available" : "❌ not found"}`,
          `Platform: ${process.platform}`,
          `Config: enabled=${sandboxConfig.enabled}, writable=${sandboxConfig.writablePaths.length}, denied=${sandboxConfig.deniedPaths.length}`,
          `ExecPolicy: ${currentPolicy.rules.length} rules, ${currentPolicy.bannedPrefixes.length} banned`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Direct switch: /permissions <mode>
      if (arg === "sandbox" || arg === "auto-review" || arg === "full-access") {
        const newMode = arg as PermissionMode;
        if (newMode === currentMode) {
          ctx.ui.notify(`Already in ${newMode} mode`, "info");
          return;
        }
        if (newMode === "full-access") {
          const confirmed = await ctx.ui.confirm(
            "⚠️ Full Access",
            "This removes all restrictions. Commands will run with full system access. Continue?",
          );
          if (!confirmed) return;
        }
        if (newMode === "sandbox" && !checkBwrap()) {
          ctx.ui.notify(
            "bwrap not found. Install bubblewrap: sudo apt install bubblewrap",
            "error",
          );
          return;
        }
        applyMode(newMode, "user-command", ctx);
        return;
      }

      // Interactive mode picker
      const choice = await ctx.ui.select(
        `Select permission level (current: ${MODE_EMOJI[currentMode]} ${currentMode}):`,
        ["sandbox", "auto-review", "full-access"],
      );

      if (!choice) return;

      const newMode = choice as PermissionMode;
      if (newMode === currentMode) {
        ctx.ui.notify(`Already in ${newMode} mode`, "info");
        return;
      }

      // Extra confirmation for full-access
      if (newMode === "full-access") {
        const confirmed = await ctx.ui.confirm(
          "⚠️ Full Access",
          "This removes all restrictions. Commands will run with full system access. Continue?",
        );
        if (!confirmed) return;
      }

      // Check bwrap for sandbox mode
      if (newMode === "sandbox" && !checkBwrap()) {
        ctx.ui.notify("bwrap not found. Install bubblewrap: sudo apt install bubblewrap", "error");
        return;
      }

      applyMode(newMode, "user-command", ctx);
    },
  });

  // ── /sandbox command (show config) ────────────────────────────────────

  pi.registerCommand("sandbox", {
    description: "Show current sandbox configuration and status",
    handler: async (_args, ctx) => {
      const bwrapOk = checkBwrap();
      const config = loadConfig(ctx.cwd);

      const lines = [
        `Sandbox Status: ${sandboxActive ? "🔒 Active" : "❌ Inactive"}`,
        `Current Mode:   ${MODE_EMOJI[currentMode]} ${currentMode}`,
        `bwrap:          ${bwrapOk ? "✅ available" : "❌ not found"}`,
        `Platform:       ${process.platform}`,
        "",
        "Writable paths:",
        ...config.writablePaths.map((p) => `  ${existsSync(p) ? "✅" : "⚠️ "} ${p}`),
        "",
        "Denied paths (hidden):",
        ...config.deniedPaths.map((p) => `  ${existsSync(p) ? "🔒" : "  "} ${p}`),
        "",
        "Write-protected patterns:",
        ...config.writeProtected.map((p) => `  • ${p}`),
        "",
        `Network:        ${config.restrictNetwork ? "🔒 restricted" : "✅ shared with host"}`,
        "",
        "ExecPolicy:",
        `  Rules: ${currentPolicy.rules.length} (from ${currentPolicy.sources.join(", ")})`,
        `  Banned prefixes: ${currentPolicy.bannedPrefixes.length}`,
        "",
        "Hooks:",
        ...hooks
          .list()
          .map((h) => `  ${h.enabled ? "✅" : "❌"} [${h.type}] ${h.name} (prio ${h.priority})`),
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
