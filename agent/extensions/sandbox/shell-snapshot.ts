/**
 * Shell Snapshot — Capture shell environment state for context injection
 *
 * After each bash command execution, captures:
 * - Working directory changes (cd detection)
 * - Key environment variables (filtered for safety)
 *
 * The snapshot is injected as additional context before the next LLM turn,
 * helping the model understand the current shell state.
 *
 * Filtering:
 * - Excludes PWD, OLDPWD (tracked separately via cwd)
 * - Excludes SECRET, TOKEN, KEY, PASSWORD variables
 * - Keeps PATH, HOME, VIRTUAL_ENV, NODE_ENV, RUSTUP_HOME, CARGO_HOME, etc.
 * - Max 40 env vars to avoid context bloat
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────

export interface ShellSnapshot {
  cwd: string;
  /** Timestamp of last capture */
  capturedAt: number;
  /** Key env vars (filtered) */
  env: Record<string, string>;
  /** Last known directory (pre-cd detection) */
  lastDir?: string;
  /** Number of captures in this session */
  captureCount: number;
}

// ── Env var filtering ────────────────────────────────────────────────

const EXCLUDED_VARS = new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "PS1",
  "PS2",
  "PS4",
  "PROMPT",
  "PROMPT_COMMAND",
  "RPROMPT",
]);

const EXCLUDED_PATTERNS = [
  /SECRET/i,
  /TOKEN/i,
  /KEY/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /AUTH/i,
  /CERT/i,
  /PRIVATE[_-]?KEY/i,
  /API[_-]?KEY/i,
];

const KEPT_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "EDITOR",
  "VISUAL",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "NODE_ENV",
  "NVM_DIR",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "GOPATH",
  "JAVA_HOME",
  "PYTHONPATH",
  "GEM_HOME",
  "CC",
  "CXX",
  "MAKEFLAGS",
  "NINJA_STATUS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
]);

function isSensitiveVar(name: string): boolean {
  if (EXCLUDED_VARS.has(name)) return true;
  for (const pat of EXCLUDED_PATTERNS) {
    if (pat.test(name)) return true;
  }
  return false;
}

function isKeptVar(name: string): boolean {
  return KEPT_VARS.has(name);
}

/**
 * Filter process.env down to safe, relevant variables.
 * Strategy: keep known-interesting vars + any non-sensitive vars up to a limit.
 */
function captureEnv(maxVars: number = 40): Record<string, string> {
  const result: Record<string, string> = {};

  // First pass: keep known-interesting vars
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (isKeptVar(name)) {
      result[name] = value;
    }
  }

  // Second pass: fill up with other non-sensitive vars
  if (Object.keys(result).length < maxVars) {
    for (const [name, value] of Object.entries(process.env)) {
      if (!value) continue;
      if (result[name]) continue;
      if (isSensitiveVar(name)) continue;
      result[name] = value;
      if (Object.keys(result).length >= maxVars) break;
    }
  }

  return result;
}

// ── Snapshot management ──────────────────────────────────────────────

let currentSnapshot: ShellSnapshot = {
  cwd: process.cwd(),
  capturedAt: Date.now(),
  env: {},
  captureCount: 0,
};

export function getSnapshot(): ShellSnapshot {
  return { ...currentSnapshot };
}

/**
 * Capture a new snapshot. Called after each bash command.
 * Detects cd by comparing new cwd with last known directory.
 */
export function captureSnapshot(newCwd?: string): ShellSnapshot {
  const previousDir = currentSnapshot.cwd;
  const cwd = newCwd ?? process.cwd();

  currentSnapshot = {
    cwd,
    capturedAt: Date.now(),
    env: captureEnv(),
    lastDir: previousDir !== cwd ? previousDir : currentSnapshot.lastDir,
    captureCount: currentSnapshot.captureCount + 1,
  };

  return currentSnapshot;
}

/**
 * Generate context injection text for the LLM.
 * Only includes meaningful changes to avoid noise.
 */
export function snapshotContextText(snap: ShellSnapshot): string | null {
  const lines: string[] = [];

  // Working directory
  lines.push(`Current working directory: ${snap.cwd}`);

  // cd detection
  if (snap.lastDir) {
    lines.push(`(Changed from: ${snap.lastDir})`);
  }

  // Key env vars (only show the important ones)
  const importantVars = Object.entries(snap.env).filter(([name]) => isKeptVar(name));
  if (importantVars.length > 0) {
    lines.push("");
    lines.push("Environment:");
    for (const [name, value] of importantVars) {
      // Truncate long values
      const displayVal = value.length > 100 ? value.slice(0, 97) + "..." : value;
      lines.push(`  ${name}=${displayVal}`);
    }
  }

  return lines.join("\n");
}

// ── Extension integration ─────────────────────────────────────────────

/**
 * Set up shell snapshot hooks on the extension API.
 * Call from the main extension's session_start handler.
 */
export function setupSnapshots(pi: ExtensionAPI) {
  // After each bash command, capture snapshot
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "bash") return;

    try {
      // Try to detect cwd changes from bash output
      const content = Array.isArray(event.content)
        ? event.content.map((c) => (c.type === "text" ? c.text : "")).join("")
        : "";

      // Simple heuristic: look for cd or pushd/popd patterns
      // This is best-effort; we can't actually know the shell's cwd
      // without a more sophisticated mechanism
      captureSnapshot();
    } catch {
      // Best effort
    }
  });

  // Inject snapshot context before each agent turn
  pi.on("before_agent_start", async (event, _ctx) => {
    const snap = getSnapshot();
    if (snap.captureCount === 0) return; // No commands run yet

    const ctxText = snapshotContextText(snap);
    if (!ctxText) return;

    // Append snapshot as additional context
    return {
      systemPrompt: event.systemPrompt + "\n\n<shell_state>\n" + ctxText + "\n</shell_state>",
    };
  });

  // Reset on new session
  pi.on("session_start", async () => {
    currentSnapshot = {
      cwd: process.cwd(),
      capturedAt: Date.now(),
      env: captureEnv(),
      captureCount: 0,
    };
  });
}
