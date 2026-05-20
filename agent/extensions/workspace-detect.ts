/**
 * Workspace Detection — Auto-detect project tooling and inject context
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ProjectInfo {
  language: string;
  runtime?: string;
  packageManager?: string;
  testRunner?: string;
  linter?: string;
  formatter?: string;
  buildSystem?: string;
  ci?: string;
  container?: string;
  keyFiles: string[];
}

function existingFiles(dir: string, files: string[]): string[] {
  return files.filter((f) => existsSync(join(dir, f)));
}

function readJson(dir: string, file: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(join(dir, file), "utf-8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

function detectNode(dir: string): ProjectInfo | null {
  const pkg = readJson(dir, "package.json");
  if (!pkg) return null;
  const hasTs = existsSync(join(dir, "tsconfig.json"));
  const language = hasTs ? "TypeScript" : "JavaScript";
  let packageManager = "npm";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (existsSync(join(dir, "yarn.lock"))) packageManager = "yarn";
  else if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) packageManager = "bun";
  const engines = (pkg.engines as Record<string, string> | undefined);
  const runtime = engines?.node ? `Node ${engines.node}` : "Node";
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const allDeps = { ...devDeps, ...deps };
  let testRunner: string | undefined;
  if (allDeps.vitest || existsSync(join(dir, "vitest.config.ts"))) testRunner = "vitest";
  else if (allDeps.jest || existsSync(join(dir, "jest.config.ts"))) testRunner = "jest";
  let linter: string | undefined;
  let formatter: string | undefined;
  if (existsSync(join(dir, "biome.json"))) { linter = "biome"; formatter = "biome"; }
  else {
    if (existsSync(join(dir, "eslint.config.mjs")) || existsSync(join(dir, "eslint.config.js"))) linter = "eslint";
    if (allDeps.prettier || existsSync(join(dir, ".prettierrc"))) formatter = "prettier";
  }
  return { language, runtime, packageManager, testRunner, linter, formatter, keyFiles: existingFiles(dir, ["package.json", "tsconfig.json"]) };
}

function detectRust(dir: string): ProjectInfo | null {
  if (!existsSync(join(dir, "Cargo.toml"))) return null;
  let edition: string | undefined;
  try { const raw = readFileSync(join(dir, "Cargo.toml"), "utf-8"); const m = raw.match(/edition\s*=\s*"(\d+)"/); if (m) edition = m[1]; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return { language: "Rust", runtime: edition ? `Rust ${edition} edition` : "Rust", packageManager: "cargo", testRunner: "cargo test", linter: "clippy", formatter: "rustfmt", keyFiles: existingFiles(dir, ["Cargo.toml", "Cargo.lock"]) };
}

function detectPython(dir: string): ProjectInfo | null {
  const hasPyproject = existsSync(join(dir, "pyproject.toml"));
  const hasRequirements = existsSync(join(dir, "requirements.txt"));
  if (!hasPyproject && !hasRequirements) return null;
  let packageManager = "pip";
  if (existsSync(join(dir, "poetry.lock"))) packageManager = "poetry";
  else if (existsSync(join(dir, "uv.lock"))) packageManager = "uv";
  let testRunner: string | undefined;
  if (existsSync(join(dir, "conftest.py")) || existsSync(join(dir, "pytest.ini"))) testRunner = "pytest";
  let linter: string | undefined;
  if (hasPyproject) { try { const raw = readFileSync(join(dir, "pyproject.toml"), "utf-8"); if (raw.includes("[tool.ruff]")) linter = "ruff"; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  return { language: "Python", packageManager, testRunner, linter, keyFiles: existingFiles(dir, ["pyproject.toml", "requirements.txt"]) };
}

function detectGo(dir: string): ProjectInfo | null {
  if (!existsSync(join(dir, "go.mod"))) return null;
  return { language: "Go", packageManager: "go modules", testRunner: "go test", keyFiles: existingFiles(dir, ["go.mod"]) };
}

function detectZig(dir: string): ProjectInfo | null {
  if (!existsSync(join(dir, "build.zig")) && !existsSync(join(dir, "build.zig.zon"))) return null;
  return { language: "Zig", packageManager: "zig build", testRunner: "zig build test", keyFiles: existingFiles(dir, ["build.zig", "build.zig.zon"]) };
}

function detectBuild(dir: string): string | undefined {
  const files = existingFiles(dir, ["Makefile", "makefile", "justfile", "Taskfile.yml"]);
  return files[0];
}

function detectCI(dir: string): string | undefined {
  if (existsSync(join(dir, ".github", "workflows"))) return "GitHub Actions";
  if (existsSync(join(dir, ".gitlab-ci.yml"))) return "GitLab CI";
  return undefined;
}

function detectContainer(dir: string): string | undefined {
  if (existsSync(join(dir, "Dockerfile"))) return "Docker";
  if (existsSync(join(dir, "docker-compose.yml")) || existsSync(join(dir, "docker-compose.yaml"))) return "Docker Compose";
  return undefined;
}

function detectAll(dir: string): ProjectInfo {
  const result = detectNode(dir) ?? detectRust(dir) ?? detectPython(dir) ?? detectGo(dir) ?? detectZig(dir) ?? { language: "unknown", keyFiles: [] };
  result.buildSystem = detectBuild(dir);
  result.ci = detectCI(dir);
  result.container = detectContainer(dir);
  return result;
}

function formatContext(info: ProjectInfo): string {
  const lines: string[] = [];
  if (info.language !== "unknown") {
    lines.push(`Project: ${info.language}`);
    if (info.runtime) lines.push(`Runtime: ${info.runtime}`);
    if (info.packageManager) lines.push(`Package manager: ${info.packageManager}`);
    if (info.testRunner) lines.push(`Test runner: ${info.testRunner}`);
    if (info.linter) {
      const f = info.formatter && info.formatter !== info.linter ? ` / ${info.formatter}` : "";
      lines.push(`Linter/Formatter: ${info.linter}${f}`);
    }
  }
  if (info.buildSystem) lines.push(`Build: ${info.buildSystem}`);
  if (info.ci) lines.push(`CI: ${info.ci}`);
  if (info.container) lines.push(`Container: ${info.container}`);
  const informative = info.keyFiles.filter((f) => f !== "package.json");
  if (informative.length > 0) lines.push(`Key configs: ${informative.join(", ")}`);
  return lines.join("\n");
}

let workspaceContext = "";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const info = detectAll(ctx.cwd);
    workspaceContext = formatContext(info);
    if (workspaceContext) {
      ctx.ui.setStatus("workspace", ctx.ui.theme.fg("dim",
        info.language !== "unknown"
          ? "📁 " + info.language + (info.packageManager ? " (" + info.packageManager + ")" : "")
          : "📁 generic project"));
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!workspaceContext) return;
    return { systemPrompt: event.systemPrompt + "\n\n<workspace>\n" + workspaceContext + "\n</workspace>" };
  });
}
