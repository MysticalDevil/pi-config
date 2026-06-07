# Global Agent Rules

## Instruction Hierarchy

- Apply instructions in order: global rules → repository rules → task-specific.
- If two instructions conflict, follow the higher-precedence source and state the conflict.
- Direct user instructions in the active session take precedence over AGENTS.md.

## Safety and Scope

- Ask for confirmation before destructive operations: `rm -rf`, `git reset --hard`,
  `git push --force`, `sudo`, filesystem wipe, raw device writes.
- Run `--dry-run` before destructive or bulk operations when supported.
- Do not modify unrelated files unless explicitly requested.
- Keep edits minimal, scoped, and reversible.
- Do not exfiltrate data via curl/wget POST, netcat, or ssh tunneling.
- Use `/permissions` to check or change the active permission mode.

## Editing Rules

- For targeted changes to existing files, prefer `edit` over `write`.
- Use `write` only for new files or complete rewrites.
- Do not write files using shell redirection (`>`, `>>`), heredoc, or `tee`.
- For file reads, use `read`; fall back to `cat`/`bat` only when needed.
- Use `!command` to run a shell command and send output to the model.
- Use `!!command` to run a shell command without sending output.

## Bash Tool Usage

- Combine related bash operations into a single invocation when possible.
- Use `rg` for text search, `rg --files` for file listing.
- Use `fd` or `find` for path/file discovery.
- Use `ls` or `find` for directory listing.
- Avoid `cat` redirection to create, write, or overwrite files.
- Long inline scripts (> 80 lines) should be written to `scripts/` first, then executed.

## Verification Before Finish

- Run lint/formatters only when related source files have been modified or the user
  explicitly requests it (e.g. `fmt`, `lint`, `/lint`). Do not auto-run lint/fmt on
  every change regardless of file type.
- For build/test verification after code changes, run the smallest relevant
  verification. If verification cannot run, explicitly report what was not verified
  and why.
- Shell scripts should comply with `shellcheck` guidance when feasible.

## Git Hygiene

- Do not amend commits unless explicitly requested.
- Keep commits scoped to one concern; use Conventional Commit prefixes:
  `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`.
- Do not revert user-authored changes unless explicitly requested.
- Auto-checkpoint (`/checkpoint`) is available before risky operations.
- `/rollback` reverts to the last checkpoint.

## Reliability

- Do not swallow errors with broad try/catch; catch only where recovery is real.
- Do not hardcode constants or thresholds solely to satisfy current tests.
- For bug fixes: write a failing reproduction test first, then fix, then verify.

## Task Entrypoints

- Use consistent task names: `fmt`, `lint`, `typecheck`, `build`, `test`, `check`.
- `check` = smallest full quality gate (format + lint + typecheck + build + relevant tests).
- Preferred task runner order: `just` → `task` → `make` → language-native commands.
- Read `justfile`, `Makefile`, `Taskfile.yml`, or `package.json` scripts to discover
  available tasks before inventing new ones.

## Language Tooling Defaults

| Language | Formatter       | Linter        | Test runner      | Package mgr   |
| -------- | --------------- | ------------- | ---------------- | ------------- |
| Rust     | `rustfmt`       | `clippy`      | `cargo test`     | `cargo`       |
| Go       | `gofumpt`       | `go vet`      | `go test`        | `go mod`      |
| Node.js  | `oxfmt`         | `oxlint`      | `vitest`/`jest`  | `pnpm`        |
| Python   | `ruff`          | `ruff`/`mypy` | `pytest`         | `uv`/`poetry` |
| Zig      | `zig fmt`       | —             | `zig build test` | `zig build`   |
| C/C++    | `clang-format`  | `clang-tidy`  | `ctest`          | `CMake`       |
| Swift    | `swift-format`  | —             | `swift test`     | `swift`       |
| C#       | `dotnet format` | —             | `dotnet test`    | `dotnet`      |

## Type Safety

- TypeScript: prefer `unknown`, generics, and discriminated unions over `any`.
- Go: prefer concrete types and constrained interfaces over `any`/`interface{}`.
- Keep `any`-like types minimal at module boundaries; narrow types immediately.

## Zig Policy

- Verify local Zig version before writing code: `zig version`.
- For `std.*` usage, run `zig env` to locate local Zig source, then verify in source.
- Do not implement `std` APIs from memory; always verify against local source.
- Official docs: `https://ziglang.org/documentation/` (version-matched).
- Official source: `https://codeberg.org/ziglang/zig`.
- Zig I/O: use proper std I/O interface types, not `anytype` for reader/writer params.
- Handle errors explicitly; do not use `catch {}`, `catch unreachable`, or
  `orelse unreachable` in non-test code.
- Do not discard return values to bypass checks (`_ = foo()`).
- Do not reimplement `std` or language features without justification.
- Acceptance: run `zig fmt` on touched files, then `zig build` or `zig build test`.

## Cross-Compilation

- Prefer project-provided cross-compilation workflows first.
- Define target triple, architecture, ABI, and minimum runtime version before compiling.
- Verify artifacts with `file`/`readelf` after cross-compiling.

## Minimal Acceptance Matrix

- Lint and formatters are triggered lazily: only run them when source files of the
  corresponding language have been modified, or when the user explicitly requests.
- Build and test steps run on relevant changes as usual.

| Language | Pipeline (fmt/lint lazy; build/test on change)              |
| -------- | ----------------------------------------------------------- |
| Rust     | `cargo fmt` → `cargo clippy` → `cargo build` → `cargo test` |
| Go       | `gofumpt` → `go vet` → `go build` → `go test`               |
| Node.js  | `oxfmt` → `oxlint` → typecheck → build → test               |
| Python   | `ruff check` → `mypy` → smallest test subset                |
| Zig      | `zig fmt` → `zig build` → `zig build test`                  |
| C/C++    | `clang-format` → `clang-tidy` → build → `ctest`             |
| Scripts  | `shellcheck` → smoke test                                   |
| Markdown | lint (if available)                                         |
