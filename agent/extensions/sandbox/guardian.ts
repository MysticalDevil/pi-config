/**
 * Guardian Auto-Review — LLM-based command safety evaluation
 *
 * When in auto-review mode, spawns a lightweight `pi -p` subprocess
 * to evaluate whether a proposed bash command is safe to execute.
 *
 * The guardian prompt includes:
 * - The proposed command
 * - Working directory
 * - Recent context (optional)
 * - Known dangerous patterns as reference
 *
 * Returns a structured JSON decision: { "decision": "allow"|"forbidden"|"prompt", "reason": "..." }
 *
 * Falls back to "allow" on timeout or execution failure (conservative for dev UX).
 */

import { spawn } from "node:child_process";
import { type Decision } from "./execpolicy";

// ── Types ─────────────────────────────────────────────────────────────

export interface GuardianResult {
  decision: Decision;
  reason: string;
}

interface GuardianJsonResponse {
  decision?: string;
  reason?: string;
}

// ── Guardian prompt template ──────────────────────────────────────────

function buildGuardianPrompt(command: string, cwd: string): string {
  return `You are a command safety reviewer. Evaluate the following shell command and respond with ONLY a JSON object (no markdown, no explanation outside the JSON).

Command: ${command}
Working directory: ${cwd}

Rules:
- "allow" means the command is safe to execute
- "deny" means the command is dangerous or destructive and should be blocked
- "prompt" means the command might be risky and the user should be asked

Common dangerous patterns to watch for:
- Recursive delete (rm -rf)
- Privilege escalation (sudo)
- Overwriting system files (> /etc/..., > /dev/sd*)
- Piping to shell (curl ... | sh)
- Force push to main/master
- Docker prune/rmi
- chmod 777
- dd, mkfs, shutdown, reboot
- Reading sensitive files (~/.ssh, ~/.aws, /etc/shadow)
- Exfiltrating data (curl/wget posting file contents to remote servers)

Respond with exactly:
{"decision": "allow"|"forbidden"|"prompt", "reason": "brief explanation"}`;
}

// ── Spawn guardian subprocess ─────────────────────────────────────────

function parseJsonSafely(text: string): GuardianJsonResponse | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getPiCommand(): { cmd: string; args: string[] } {
  // Same logic as subagent — use process.execPath if it looks like pi,
  // otherwise fall back to "pi".
  const execName = process.argv[1] || "";
  if (execName?.includes("pi")) {
    return { cmd: process.execPath, args: [execName] };
  }
  return { cmd: "pi", args: [] };
}

export async function guardianReview(
  command: string,
  cwd: string,
  timeoutMs: number = 60000,
  signal?: AbortSignal,
): Promise<GuardianResult> {
  // No execpolicy pre-check — caller already determined review is needed.
  // Guardian's job is LLM-based evaluation only.

  // Check if already aborted
  if (signal?.aborted) {
    return { decision: "prompt", reason: "Aborted before review" };
  }

  const prompt = buildGuardianPrompt(command, cwd);

  return new Promise((resolve) => {
    const pi = getPiCommand();
    const proc = spawn(pi.cmd, [...pi.args, "-p", "--no-session", "--no-extensions", prompt], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
    });

    let stdout = "";
    let _stderr = "";
    let settled = false;

    const finish = (result: GuardianResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      try {
        proc.kill("SIGTERM");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
          console.error("guardian: failed to kill subprocess:", e);
        }
      }
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      finish({ decision: "prompt", reason: "Guardian timed out — manual review needed" });
    }, timeoutMs);

    // AbortSignal: clean up on Esc
    const onAbort = () => {
      finish({ decision: "prompt", reason: "User cancelled guardian review" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      _stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      if (settled) return;

      // Try to extract JSON from output
      const text = stdout.trim();
      // Find JSON object in the output (model might wrap in markdown)
      const jsonMatch = text.match(/\{[\s\S]*"decision"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = parseJsonSafely(jsonMatch[0]);
        if (parsed) {
          const d = parsed.decision?.toLowerCase();
          if (d === "allow" || d === "deny" || d === "prompt") {
            const finalDecision: Decision = d === "deny" ? "forbidden" : (d as Decision);
            finish({
              decision: finalDecision,
              reason: parsed.reason ?? `Guardian: ${finalDecision}`,
            });
            return;
          }
        }
      }

      // Failed to parse — conservative block
      finish({
        decision: "forbidden",
        reason:
          code === 0
            ? "Guardian returned non-JSON output — blocking"
            : `Guardian exited ${code} — blocking`,
      });
    });

    proc.on("error", () => {
      clearTimeout(timeoutId);
      finish({ decision: "forbidden", reason: "Guardian spawn failed — blocking" });
    });
  });
}
