# .pi

## Tech Stack

- **Languages:** TypeScript
- **Package Manager:** npm

## Project Structure

```
├── agent/
│   ├── agents/
│   │   ├── planner.md
│   │   ├── reviewer.md
│   │   ├── scout.md
│   │   ├── worker.md
│   ├── extensions/
│   │   ├── plan-mode/
│   │   ├── sandbox/
│   │   ├── subagent/
│   │   ├── add-context.ts
│   │   ├── bookmark.ts
│   │   ├── btw.ts
│   │   ├── confirm-destructive.ts
│   │   ├── cost.ts
│   │   ├── custom-compaction.ts
│   │   ├── dirty-repo-guard.ts
│   │   ├── git-checkpoint.ts
│   │   ├── handoff.ts
│   │   ├── init.ts
│   │   ├── memory.ts
│   │   ├── model-status.ts
│   │   ├── protected-paths.ts
│   │   ├── review-mode.ts
│   │   ├── session-name.ts
│   │   ├── summarize.ts
│   │   ├── theme.ts
│   │   ├── todo.ts
│   │   ├── tools.ts
│   │   ├── workspace-detect.ts
│   ├── prompts/
│   │   ├── implement-and-review.md
│   │   ├── implement.md
│   │   ├── scout-and-plan.md
│   ├── sessions/
│   │   ├── --home-delta--/
│   │   ├── --home-delta-.pi--/
│   │   ├── --home-delta-ai-workspace--/
│   │   ├── --home-delta-ai-workspace-global--/
│   │   ├── --home-delta-Toys-ConicalRolling--/
│   │   ├── --home-delta-Toys-slice_linq--/
│   ├── skills/
│   │   ├── zig-0-16-migration/
│   ├── themes/
│   │   ├── catppuccin-latte.json
│   │   ├── catppuccin-mocha.json
│   │   ├── dracula.json
│   │   ├── gruvbox-dark.json
│   │   ├── gruvbox-light.json
│   │   ├── monokai.json
│   │   ├── nord.json
│   │   ├── one-dark.json
│   │   ├── solarized-dark.json
│   │   ├── solarized-light.json
│   │   ├── tokyo-night.json
│   ├── AGENTS.md
│   ├── auth.json
│   ├── settings.json
├── .gitignore
├── sandbox.json
├── tsconfig.json
```

## Configuration Files

- `sandbox.json`
- `tsconfig.json`
- `.gitignore`

## Conventions

<!-- Add project-specific conventions here -->

- Run `npm test` (or equivalent) before committing
- Keep commits small and focused
- Write meaningful commit messages

## Common Commands

```bash
npm install           # Install dependencies
npm run dev           # Start dev server
npm run build         # Build for production
npm test              # Run tests
npm run lint          # Run linter
```
