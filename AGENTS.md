# pi-config

Personal pi coding-agent configuration for extensions, prompts, sandboxing,
and installed pi packages.
This repo is version-controlled at `git@github.com:MysticalDevil/pi-config.git`.

## Runtime Model

- Custom extensions are TypeScript files loaded directly by pi from
  `agent/extensions/`; there is no root `package.json` and no build step for
  normal extension edits.
- After editing extensions, run `/reload` inside pi.
- Changes to `sandbox.json` require restarting the pi daemon, not just `/reload`.
- `agent/extensions/sandbox/` is its own npm package
  (`pi-extension-sandbox`) with a local `package.json`, but its scripts are
  placeholders; do not assume a separate build/test workflow there.

## Verification

Use the project commands as written; this repo intentionally uses `npx` for
the lint/format tools.

```bash
npx oxfmt@latest --write agent/extensions/
npx oxlint@latest --tsconfig tsconfig.json
node --test agent/extensions/regression.test.mjs
```

Run the regression test after extension changes. It is the only checked-in
test suite and covers path safety, fd/rg fallback behavior, extension-name
validation, review revert safety, ask-user-question dialogs, and `/init`
helpers.

## Extension Boundaries

- `agent/extensions/sandbox/` — permissions, execpolicy, guardian, hooks,
  shell snapshot, turn diff, and sandbox integration.
- `agent/extensions/btw/` — fork-based side questions for `/btw`.
- `agent/extensions/plan-mode/` — read-only exploration mode and plan
  execution flow.
- `agent/extensions/ask-user-question/` — structured question dialog UI and
  tool implementation.
- `agent/extensions/lib/` — shared helper modules used by multiple extensions.
- Most other files under `agent/extensions/` are single-file extensions; keep
  new cross-extension logic in `agent/extensions/lib/` only when it is
  actually shared.

## Config Files

| File | Purpose |
| ---- | ------- |
| `agent/AGENTS.md` | Global agent rules injected for pi sessions; do not weaken casually. |
| `sandbox.json` | Project sandbox permissions and protected paths. |
| `tsconfig.json` | Type-check scope for extensions; `noEmit: true`. |
| `oxlint.config.ts` | Correctness errors, suspicious warnings, ignores installed packages. |
| `oxfmt.config.ts` | Formatter ignores `node_modules` only. |

## Installed Package Areas

- `agent/npm/` contains installed pi npm packages such as `pi-subagents`,
  `context-mode`, `pi-web-access`, and `pi-mcp-adapter`; it is intentionally
  untracked.
- `agent/git/` is also untracked and should be treated as installed or
  third-party package state.
- Other intentionally untracked local state includes `agent/auth.json`,
  `agent/sessions/`, `agent/themes/`, `agent/skills/`, `agent/settings.json`,
  `agent/models.json`, and `agent/memories.json`.

## Command Notes

- `/init` triggers an agent turn that investigates the current repository and
  creates or updates `AGENTS.md`; use `/init --force` to skip the
  existing-file confirmation.
- `/btw` asks forked side questions without disturbing the main session.
- Use Conventional Commit prefixes when committing repo changes: `feat:`,
  `fix:`, `refactor:`, `chore:`, `docs:`.
