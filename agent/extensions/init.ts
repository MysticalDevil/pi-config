/**
 * /init — Generate AGENTS.md via LLM-driven investigation
 *
 * Instead of programmatic template generation (which produces generic,
 * unverified commands), this injects a detailed behavioral directive
 * into the system prompt and lets the LLM read the codebase and write
 * a high-signal AGENTS.md following the directive.
 *
 * Usage:
 *   /init            — generate AGENTS.md (prompts before overwrite if exists)
 *   /init --force    — overwrite existing AGENTS.md without prompt
 *   /init --help     — show usage
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface InitArgs {
  force: boolean;
  help: boolean;
  errors: string[];
}

export const INIT_USAGE = "Usage: /init [--force]";

export const INIT_USER_MESSAGE =
  "Initialize this repository: investigate the codebase and create or update AGENTS.md.";

export const BEHAVIORAL_DIRECTIVE = `\
<behavioral_directive>
Create or update \`AGENTS.md\` for this repository.

The goal is a compact instruction file that helps future AI coding sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.

## How to investigate

Read the highest-value sources first:
- \`README*\`, root manifests, workspace config, lockfiles
- build, test, lint, formatter, typecheck, and codegen config
- CI workflows and pre-commit / task runner config
- existing instruction files (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`, \`.cursorrules\`, \`.github/copilot-instructions.md\`)
- repo-local AI coding config such as \`opencode.json\`

If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer reading the files that explain how the system is wired together over random leaf files.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable source and only keep what you can verify.

## What to extract

Look for the highest-signal facts for an agent working in this repo:
- exact developer commands, especially non-obvious ones
- how to run a single test, a single package, or a focused verification step
- required command order when it matters, such as \`lint -> typecheck -> test\`
- monorepo or multi-package boundaries, ownership of major directories, and the real app/library entrypoints
- framework or toolchain quirks: generated code, migrations, codegen, build artifacts, special env loading, dev servers, infra deploy flow
- repo-specific style or workflow conventions that differ from defaults
- testing quirks: fixtures, integration test prerequisites, snapshot workflows, required services, flaky or expensive suites
- important constraints from existing instruction files worth preserving

Good \`AGENTS.md\` content is usually hard-earned context that took reading multiple files to infer.

## Writing rules

Include only high-signal, repo-specific guidance such as:
- exact commands and shortcuts the agent would otherwise guess wrong
- architecture notes that are not obvious from filenames
- conventions that differ from language or framework defaults
- setup requirements, environment quirks, and operational gotchas
- references to existing instruction sources that matter

Exclude:
- generic software advice
- long tutorials or exhaustive file trees
- obvious language conventions
- speculative claims or anything you could not verify
- content better stored in another file referenced via \`opencode.json\` \`instructions\`

When in doubt, omit.

Prefer short sections and bullets. If the repo is simple, keep the file simple. If the repo is large, summarize the few structural facts that actually change how an agent should work.

If \`AGENTS.md\` already exists, improve it in place rather than rewriting blindly. Preserve verified useful guidance, delete fluff or stale claims, and reconcile it with the current codebase.
</behavioral_directive>`;

export function parseInitArgs(args: string): InitArgs {
  const parsed: InitArgs = { force: false, help: false, errors: [] };
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];

  for (const token of tokens) {
    switch (token) {
      case "--force":
      case "-f":
        parsed.force = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        parsed.errors.push(`Unknown option: ${token}`);
    }
  }

  return parsed;
}

export function buildInitPrompt(cwd: string, agentsExists: boolean): string {
  const agentsPath = path.join(cwd, "AGENTS.md");
  const action = agentsExists ? "Improve the existing" : "Create a new";

  return (
    BEHAVIORAL_DIRECTIVE +
    `\n\n${action} \`AGENTS.md\` at \`${agentsPath}\` for this repository.` +
    (agentsExists
      ? " Preserve verified useful guidance, delete fluff or stale claims, and reconcile it with the current codebase."
      : "")
  );
}

export default function (pi: ExtensionAPI) {
  let pendingInit: { cwd: string; agentsExists: boolean } | null = null;

  // Inject the behavioral directive into the system prompt on the next agent turn
  pi.on("before_agent_start", async (event) => {
    if (!pendingInit) return;

    const request = pendingInit;
    pendingInit = null;

    const prompt = buildInitPrompt(request.cwd, request.agentsExists);

    const cwd = event.systemPromptOptions.cwd;
    const cwdNote =
      cwd === request.cwd
        ? ""
        : `\n\nThe /init command was requested for \`${request.cwd}\`; keep all investigation and edits scoped to that repository even though the current prompt cwd is \`${cwd}\`.`;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + prompt + cwdNote,
    };
  });

  pi.registerCommand("init", {
    description: "Generate AGENTS.md for the current project by investigating the codebase",
    handler: async (args, ctx) => {
      const parsed = parseInitArgs(args);

      if (parsed.help) {
        ctx.ui.notify(INIT_USAGE, "info");
        return;
      }

      if (parsed.errors.length > 0) {
        ctx.ui.notify(`${parsed.errors.join("\n")}\n${INIT_USAGE}`, "error");
        return;
      }

      const agentsPath = path.join(ctx.cwd, "AGENTS.md");
      const agentsExists = fs.existsSync(agentsPath);

      if (!parsed.force && agentsExists) {
        if (!ctx.hasUI) {
          console.error(
            "AGENTS.md already exists, use --force to update it in non-interactive mode",
          );
          return;
        }
        const choice = await ctx.ui.select("AGENTS.md already exists. Update it?", [
          "Yes, update",
          "Cancel",
        ]);
        if (choice === "Cancel") return;
      }

      pendingInit = { cwd: ctx.cwd, agentsExists };

      ctx.ui.notify(
        agentsExists ? "Starting AGENTS.md update..." : "Starting AGENTS.md generation...",
        "info",
      );
      pi.sendUserMessage(INIT_USER_MESSAGE, { triggerTurn: true });
    },
  });
}
