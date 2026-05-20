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

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { evaluateCommand, loadPolicy, type LoadedPolicy } from "./execpolicy.js";
import { guardianReview } from "./guardian.js";
import { setupSnapshots } from "./shell-snapshot.js";
import { setupHooks, hooks, networkSafetyHook, configProtectionHook, auditLogHook } from "./hooks.js";
import { setupTurnDiff } from "./turn-diff.js";

// ── Types ───────────────────────────────────────────────────────────────────

type PermissionMode = "sandbox" | "auto-review" | "full-access";

const MODE_LABELS: Record<PermissionMode, string> = {
  sandbox: "Sandbox — bwrap isolation for bash commands",
  "auto-review": "Auto Review — flag dangerous commands, allow everything",
  "full-access": "Full Access — no restrictions",
};

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
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overrides)) {
    const ov = (overrides as Record<string, unknown>)[key];
    if (ov !== undefined) {
      if (Array.isArray(ov)) {
        (result as Record<string, unknown>)[key] = ov;
      } else if (typeof ov === "object" && ov !== null && !Array.isArray(ov)) {
        (result as Record<string, unknown>)[key] = deepMerge(
          (base as Record<string, unknown>)[key] as Record<string, unknown> ?? {},
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
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--chdir", cwd,
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
  // We need a throwaway empty directory; use /tmp/.bwrap-empty-XXXX
  const emptyDir = "/tmp/.bwrap-empty";
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
 * We do this OUTSIDE the sandbox via a minimal execSync so the tmpfs
 * in the sandbox doesn't interfere.
 */
function ensureEmptyDir(path: string) {
  try {
    execSync(`rm -rf "${path}" && mkdir -p "${path}"`, { stdio: "ignore" });
  } catch {
    // best effort
  }
}

// ── Bash operations: sandboxed ──────────────────────────────────────────────

function createSandboxedBashOps(config: SandboxConfig): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const bwrapArgs = buildBwrapArgs(command, cwd, config);

      return new Promise((resolve, reject) => {
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
              } catch {
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
            } catch {
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
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
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
    { pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(sk-[a-zA-Z0-9]{20,})["']?/g, type: "API key" },
    { pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(AIza[a-zA-Z0-9_-]{30,})["']?/g, type: "Google API key" },
    { pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(ghp_[a-zA-Z0-9]{30,})["']?/g, type: "GitHub token" },
    { pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(github_pat_[a-zA-Z0-9_]{30,})["']?/g, type: "GitHub token" },
    { pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(xox[bprs]-[a-zA-Z0-9-]{30,})["']?/g, type: "Slack token" },
    { pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(AKIA[a-zA-Z0-9]{16})["']?/g, type: "AWS key" },
    { pattern: /(-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----)/g, type: "Private key" },
    { pattern: /([a-zA-Z0-9_]+)\s*[:=]\s*["']?(mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@)/g, type: "DB connection" },
    { pattern: /([a-zA-Z0-9_]+)\s*[:=]\s*["']?(postgres(?:ql)?:\/\/[^:]+:[^@]+@)/g, type: "DB connection" },
    { pattern: /([a-zA-Z0-9_]+)\s*[:=]\s*["']?(redis(?:s)?:\/\/[^:]+:[^@]+@)/g, type: "Redis connection" },
    { pattern: /([a-zA-Z0-9_]+)\s*=\s*["']?(https?:\/\/[^:]+:[^@]+@)/g, type: "URL credentials" },
    { pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']([^"'\s]{8,})["']?/gi, type: "Credential" },
  ];

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) { currentFile = line.slice(6).trim(); continue; }
    if (line.startsWith("@@")) { const m = line.match(/^@@ -(\d+)/); currentLine = m ? parseInt(m[1], 10) : currentLine; continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    currentLine++;
    const added = line.slice(1);
    for (const { pattern, type } of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(added)) !== null) {
        const captured = match[1] || match[0];
        const masked = captured.length > 25 ? captured.slice(0, 12) + "..." + captured.slice(-5) : "***";
        findings.push({ file: currentFile, line: currentLine, type, masked });
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
  let turnApproved = false;   // true when user said "allow all this turn"
  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);

  // ── CLI flag ──────────────────────────────────────────────────────────

  pi.registerFlag("no-sandbox", {
    description: "Disable sandboxing (start in full-access mode)",
    type: "boolean",
    default: false,
  });

  // ── Apply permission mode ─────────────────────────────────────────────

  function applyMode(mode: PermissionMode, source: string, ctx?: {
    ui?: { setStatus: (id: string, text: string | undefined) => void; notify: (text: string, level: string) => void; theme: { fg: (color: string, text: string) => string } };
  }) {
    currentMode = mode;
    sandboxActive = mode === "sandbox" && bwrapAvailable && sandboxConfig.enabled;

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
        const sandboxedBash = createBashTool(localCwd, {
          operations: createSandboxedBashOps(sandboxConfig),
        });
        return sandboxedBash.execute(id, params, signal, onUpdate);
      }

      // Fallback: sandbox mode but no bwrap
      return localBash.execute(id, params, signal, onUpdate);
    },
  });

  // ── User bash (!! and ! commands) ─────────────────────────────────────

  pi.on("user_bash", () => {
    if (currentMode === "sandbox" && sandboxActive) {
      return { operations: createSandboxedBashOps(sandboxConfig) };
    }
    return;
  });

  // ── Reset per-turn state ────────────────────────────────────────────

  pi.on("turn_start", async () => {
    turnApproved = false;
  });

  // ── Load execpolicy ──────────────────────────────────────────────────

  let currentPolicy: LoadedPolicy = { rules: [], bannedPrefixes: [], sources: [] };

  // ── tool_call interception: auto-review mode ──────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command as string;

    // ── Secret detection: scan staged diff on git commit (all modes) ──
    if (/\bgit\s+commit\b/.test(command) && !/\bgit\s+commit\s*--dry-run\b/.test(command)) {
      try {
        const diff = execSync("git diff --cached --unified=0", { cwd: ctx.cwd, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 });
        if (diff.trim()) {
          const findings = scanGitDiff(diff);
          if (findings.length > 0 && !process.env.ALLOW_SECRETS) {
            const report = findings.map((f) => `  ${f.file}:${f.line}  ${f.type}: ${f.masked}`).join("\n");
            return { block: true, reason: `Secret-detection: ${findings.length} potential secret(s) in staged changes:\n${report}\n\nRemove secrets or set ALLOW_SECRETS=1 to bypass.` };
          }
        }
      } catch (e) { /* execSync throws when not a git repo or no staged changes — safe to skip */ }
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
        return { block: true, reason: `Banned command prefix: ${bannedBy.join(" ")}` };
      }

      // Execpolicy decision
      if (evaluation.decision === "forbidden") {
        const rule = evaluation.matchedRules[0];
        ctx.ui.notify(
          `🚫 Auto-review: forbidden by policy (${rule.justification}):\n  ${command.slice(0, 100)}`,
          "error",
        );
        return { block: true, reason: `Forbidden by policy: ${rule.justification}` };
      }

      if (evaluation.decision === "prompt") {
        // Skip dialog if user already approved all for this turn
        if (turnApproved) {
          ctx.ui.notify(`✅ Auto-approved: ${command.slice(0, 80)}`, "info");
        } else {
        const justification = evaluation.matchedRules[0]?.justification ?? "requires review";
        const preview = command.length > 80 ? command.slice(0, 80) + "..." : command;

        // First do a quick guardian evaluation
        let guardianAdvice = "";
        try {
          const gr = await guardianReview(command, ctx.cwd, 8000);
          guardianAdvice = `\nGuardian assessment: ${gr.decision} — ${gr.reason}`;
        } catch {
          // guardian failed, proceed without advice
        }

        const choice = await ctx.ui.select(
          `⚠️  ${justification}\n\n  $ ${preview}${guardianAdvice}`,
          ["Allow once", "Deny", "Allow all this turn"],
        );

        if (!choice || choice === "Deny") {
          return { block: true, reason: `Denied by user: ${justification}` };
        }

        if (choice === "Allow all this turn") {
          turnApproved = true;
        }
        } // end else (not turnApproved)
      }

      if (evaluation.decision === "allow" || evaluation.decision === null) {
        // Non-blocking background review for transparent commands
        guardianReview(command, ctx.cwd).then((result) => {
          if (result.decision !== "allow") {
            ctx.ui.notify(
              `⚠️ Guardian: ${result.reason}\n  ${command.slice(0, 80)}`,
              "warning",
            );
          }
        }).catch(() => {});
      }
    }

    // sandbox: check write-protected paths for edit/write tools
    if (currentMode === "sandbox") {
      // (bash itself is handled by the tool override above)
    }
  });

  // Also intercept write/edit to protect sensitive paths in sandbox mode
  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (currentMode !== "sandbox") return;

    if (event.toolName === "write" || event.toolName === "edit") {
      const filepath = (event.input as { path?: string }).path ?? "";
      if (isWriteProtected(filepath, sandboxConfig.writeProtected)) {
        ctx.ui.notify(
          `🔒 Sandbox: write to protected path blocked: ${filepath}`,
          "warning",
        );
        return { block: true, reason: `Sandbox: write to protected path "${filepath}" is blocked` };
      }
    }

    if (event.toolName === "read") {
      const filepath = (event.input as { path?: string }).path ?? "";
      const resolved = resolve(filepath);
      for (const denied of sandboxConfig.deniedPaths) {
        if (resolved.startsWith(denied + "/") || resolved === denied) {
          ctx.ui.notify(
            `🔒 Sandbox: read of denied path blocked: ${filepath}`,
            "warning",
          );
          return { block: true, reason: `Sandbox: read of "${filepath}" is blocked (denied path)` };
        }
      }
    }
  });

  // ── Session lifecycle ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
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

    // Determine initial mode
    const initialMode: PermissionMode = noSandbox
      ? "full-access"
      : restoredMode ?? "sandbox";

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
      applyMode(initialMode, noSandbox ? "cli-flag" : restoredMode ? "session-restore" : "default", ctx);
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
    // Clean up empty dir marker
    try {
      execSync("rm -rf /tmp/.bwrap-empty", { stdio: "ignore" });
    } catch {
      // best effort
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
    description: "Switch permission mode: sandbox (default), auto-review, or full-access",
    handler: async (_args, ctx) => {
      const options = [
        `${MODE_EMOJI.sandbox}  sandbox      ${MODE_LABELS.sandbox}`,
        `${MODE_EMOJI["auto-review"]}  auto-review  ${MODE_LABELS["auto-review"]}`,
        `${MODE_EMOJI["full-access"]}  full-access  ${MODE_LABELS["full-access"]}`,
      ];

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
        ctx.ui.notify(
          "bwrap not found. Install bubblewrap: sudo apt install bubblewrap",
          "error",
        );
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
        ...hooks.list().map((h) => `  ${h.enabled ? "✅" : "❌"} [${h.type}] ${h.name} (prio ${h.priority})`),
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
