/**
 * Auto-Checkpoint — Per-turn git stash + rollback
 *
 * Before each LLM turn, creates a named git stash.
 * Commands: /rollback, /checkpoint, --no-checkpoint
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let turnIndex = 0;
let checkpointActive = true;
let recordedStashes: string[] = [];
const cwd = process.cwd();

function isGitRepo(): boolean {
  try { execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" }); return true; }
  catch { return false; }
}

async function git(pi: ExtensionAPI, args: string[]): Promise<{ stdout: string; code: number }> {
  const r = await pi.exec("git", args);
  return { stdout: (r.stdout ?? "").trim(), code: r.code ?? 1 };
}

async function getPiStashes(pi: ExtensionAPI): Promise<string[]> {
  const { stdout } = await git(pi, ["stash", "list", "--format=%gd %gs"]);
  return stdout.split("\n").filter((l) => l.includes("pi:")).map((l) => l.split(" ")[0]);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-checkpoint", {
    description: "Disable auto git stash checkpointing",
    type: "boolean", default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    const noCheckpoint = pi.getFlag("no-checkpoint") as boolean;
    checkpointActive = !noCheckpoint && isGitRepo();
    turnIndex = 0; recordedStashes = [];
    if (checkpointActive)
      ctx.ui.setStatus("checkpoint", ctx.ui.theme.fg("dim", "💾 Auto-checkpoint ready"));
    else if (!isGitRepo())
      ctx.ui.notify("Auto-checkpoint: not a git repository", "info");
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!checkpointActive) return;
    turnIndex++;
    const { stdout } = await git(pi, ["status", "--porcelain"]);
    if (!stdout) return;
    const { code } = await git(pi, ["stash", "push", "-m", "pi:turn-"+turnIndex, "--include-untracked"]);
    if (code === 0) {
      recordedStashes.push("pi:turn-"+turnIndex);
      ctx.ui.setStatus("checkpoint", ctx.ui.theme.fg("dim", "💾 turn #"+turnIndex+" stashed"));
    }
  });

  pi.on("session_shutdown", async () => {
    if (!checkpointActive || recordedStashes.length === 0) return;
    const stashes = await getPiStashes(pi);
    for (const ref of stashes) await git(pi, ["stash", "drop", ref]);
    recordedStashes = [];
  });

  pi.registerCommand("checkpoint", {
    description: "Create a named git stash checkpoint",
    handler: async (args, ctx) => {
      if (!isGitRepo()) { ctx.ui.notify("Not a git repository", "error"); return; }
      const name = (args || "").trim() || ("manual-"+Date.now());
      const msg = "pi:" + name;
      const { stdout } = await git(pi, ["status", "--porcelain"]);
      if (!stdout) { ctx.ui.notify("Nothing to checkpoint (clean tree)", "info"); return; }
      const { code } = await git(pi, ["stash", "push", "-m", msg, "--include-untracked"]);
      if (code === 0) { recordedStashes.push(msg); ctx.ui.notify("Checkpoint saved: " + name, "info"); }
      else ctx.ui.notify("Checkpoint failed", "error");
    },
  });

  pi.registerCommand("rollback", {
    description: "Revert to the latest pi checkpoint stash",
    handler: async (_args, ctx) => {
      if (!isGitRepo()) { ctx.ui.notify("Not a git repository", "error"); return; }
      const stashes = await getPiStashes(pi);
      if (stashes.length === 0) { ctx.ui.notify("No pi checkpoints found", "info"); return; }
      const latestStash = stashes[0];
      const confirmed = await ctx.ui.confirm("Rollback",
        "Revert to checkpoint " + latestStash + "?\nAll uncommitted changes since will be restored.");
      if (!confirmed) return;
      const { code } = await git(pi, ["stash", "pop", latestStash]);
      if (code === 0) {
        recordedStashes = recordedStashes.filter((s) => s !== latestStash);
        ctx.ui.notify("Rolled back to checkpoint", "info");
      } else
        ctx.ui.notify("Rollback failed — there may be conflicts.", "error");
    },
  });
}
