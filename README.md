# pi-config

Personal [pi](https://pi.dev) coding agent configuration — extensions, agents, prompts, and settings.

## Structure

```
├── agent/
│   ├── extensions/       # Custom extensions
│   │   ├── sandbox/      # Permissions, execpolicy, guardian, hooks, turn-diff
│   │   ├── plan-mode/    # Read-only exploration mode
│   │   ├── subagent/     # Delegated sub-agents with isolated context
│   │   └── ...           # review-mode, workspace-detect, git-checkpoint, etc.
│   ├── agents/           # Sub-agent definitions (scout, planner, worker, reviewer)
│   ├── prompts/          # Workflow prompt templates
│   ├── settings.json     # Model, theme, thinking preferences
│   └── AGENTS.md         # Global agent rules
├── sandbox.json          # Project-level sandbox config
├── tsconfig.json         # TypeScript config for oxlint
└── .oxfmtrc.json         # oxfmt config
```

## Key Features

### Permissions (`/permissions`)

Three modes like Codex CLI:

- **sandbox** — bwrap isolation for bash commands
- **auto-review** — execpolicy + guardian LLM evaluation
- **full-access** — unrestricted

### ExecPolicy

Declarative JSON rules for command safety with prefix matching, alternatives, and allow/prompt/forbidden decisions.

### Guardian

LLM-based auto-review that spawns a subprocess to evaluate command safety before execution.

### Secret Detection

Scans staged `git diff` for API keys, tokens, and credentials. Blocks `git commit` when secrets are detected.

### Sub-agents

Chain multiple specialized agents: scout → planner → worker → reviewer. Each has isolated context and configurable tools/models.

### Plan Mode (`/plan`)

Read-only exploration mode. Toggle with `/plan` or `Ctrl+Alt+P`.

### Hooks System

Named, composable lifecycle hooks: PreToolUse, PostToolUse. Built-ins: network-safety, config-protection, secret-detection, audit-log.

### Workspace Detection

Auto-detects project language, package manager, test runner, linter, CI, and container setup at session start.

### Turn Diff Tracking

Captures git diff per turn and injects changes as context for the next turn.

## Setup

```bash
# Install pi (if not already)
curl -fsSL https://pi.dev/install.sh | sh

# Backup existing config
mv ~/.pi ~/.pi.bak
git clone git@github.com:MysticalDevil/pi-config.git ~/.pi

# Migrate user-specific files
cp ~/.pi.bak/agent/auth.json     ~/.pi/agent/   # API keys
cp ~/.pi.bak/agent/settings.json ~/.pi/agent/   # model/theme prefs (optional)
cp -r ~/.pi.bak/agent/sessions/  ~/.pi/agent/   # chat history (optional)
```

Then in pi: `/reload`

## Git excludes

These are intentionally not tracked:

| Path                       | Reason                                           |
| -------------------------- | ------------------------------------------------ |
| `agent/auth.json`          | API keys — secrets                               |
| `agent/sessions/`          | Full chat history — privacy                      |
| `agent/themes/`            | Third-party / auto-discovered                    |
| `agent/skills/`            | Third-party / auto-discovered                    |
| `agent/npm/`, `agent/git/` | Installed packages — reinstall with `pi install` |
| `node_modules/`            | Dependencies                                     |

## Lint

```bash
npx oxlint@latest --tsconfig tsconfig.json
npx oxfmt@latest --write agent/extensions/
```
