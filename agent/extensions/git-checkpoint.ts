/**
 * Manual Checkpoint — Named git stash for explicit rollback
 *
 * Only stashes when you run /checkpoint. No auto-stashing.
 * Commands: /rollback, /checkpoint
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function git(pi: ExtensionAPI, args: string[], cwd: string) {
  const r = await pi.exec("git", args, { cwd });
  return { stdout: (r.stdout ?? "").trim(), code: r.code ?? 1 };
}

async function getPiStashes(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const { stdout } = await git(pi, ["stash", "list", "--format=%gd %gs"], cwd);
  return stdout
    .split("\n")
    .filter((l) => l.includes("pi:"))
    .map((l) => l.split(" ")[0]);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (isGitRepo(ctx.cwd)) {
      ctx.ui.setStatus("checkpoint", ctx.ui.theme.fg("dim", "💾 /checkpoint available"));
    }
  });

  pi.registerCommand("checkpoint", {
    description: "Create a named git stash checkpoint",
    handler: async (args, ctx) => {
      if (!isGitRepo(ctx.cwd)) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      const name = (args || "").trim() || `manual-${Date.now()}`;
      const { stdout } = await git(pi, ["status", "--porcelain"], ctx.cwd);
      if (!stdout) {
        ctx.ui.notify("Nothing to checkpoint", "info");
        return;
      }

      const { code } = await git(
        pi,
        ["stash", "push", "-m", `pi:${name}`, "--include-untracked"],
        ctx.cwd,
      );
      if (code === 0) ctx.ui.notify(`Checkpoint: ${name}`, "info");
      else ctx.ui.notify("Checkpoint failed", "error");
    },
  });

  pi.registerCommand("rollback", {
    description: "Revert to the latest pi checkpoint stash",
    handler: async (_args, ctx) => {
      if (!isGitRepo(ctx.cwd)) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      const stashes = await getPiStashes(pi, ctx.cwd);
      if (stashes.length === 0) {
        ctx.ui.notify("No checkpoints", "info");
        return;
      }

      const ref = stashes[0];
      const ok = await ctx.ui.confirm("Rollback", `Revert to ${ref}?`);
      if (!ok) return;

      const { code } = await git(pi, ["stash", "pop", ref], ctx.cwd);
      if (code === 0) ctx.ui.notify("Rolled back", "info");
      else ctx.ui.notify("Rollback failed — conflicts", "error");
    },
  });
}
