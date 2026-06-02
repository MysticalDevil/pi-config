/**
 * Project Detection — shared logic for init.ts and workspace-detect.ts
 *
 * Detects languages, frameworks, package managers, test runners, linters,
 * formatters, build systems, CI, and container tooling from project files.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectInfo {
  languages: string[];
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

export function existingFiles(dir: string, files: string[]): string[] {
  return files.filter((f) => existsSync(join(dir, f)));
}

export function readJson(dir: string, file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf-8")) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export function detectNode(dir: string): ProjectInfo | null {
  const pkg = readJson(dir, "package.json");
  if (!pkg) return null;
  const hasTs = existsSync(join(dir, "tsconfig.json"));
  const language = hasTs ? "TypeScript" : "JavaScript";
  let packageManager = "npm";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (existsSync(join(dir, "yarn.lock"))) packageManager = "yarn";
  else if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
    packageManager = "bun";
  const engines = pkg.engines as Record<string, string> | undefined;
  const runtime = engines?.node ? `Node ${engines.node}` : "Node";
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const allDeps = { ...devDeps, ...deps };
  let testRunner: string | undefined;
  if (allDeps.vitest || existsSync(join(dir, "vitest.config.ts"))) testRunner = "vitest";
  else if (allDeps.jest || existsSync(join(dir, "jest.config.ts"))) testRunner = "jest";
  let linter: string | undefined;
  let formatter: string | undefined;
  if (existsSync(join(dir, "biome.json"))) {
    linter = "biome";
    formatter = "biome";
  } else {
    if (existsSync(join(dir, "eslint.config.mjs")) || existsSync(join(dir, "eslint.config.js")))
      linter = "eslint";
    if (allDeps.prettier || existsSync(join(dir, ".prettierrc"))) formatter = "prettier";
  }
  return {
    languages: [language],
    runtime,
    packageManager,
    testRunner,
    linter,
    formatter,
    keyFiles: existingFiles(dir, ["package.json", "tsconfig.json"]),
  };
}

export function detectRust(dir: string): ProjectInfo | null {
  if (!existsSync(join(dir, "Cargo.toml"))) return null;
  let edition: string | undefined;
  try {
    const raw = readFileSync(join(dir, "Cargo.toml"), "utf-8");
    const m = raw.match(/edition\s*=\s*"(\d+)"/);
    if (m) edition = m[1];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return {
    languages: ["Rust"],
    runtime: edition ? `Rust ${edition} edition` : "Rust",
    packageManager: "cargo",
    testRunner: "cargo test",
    linter: "clippy",
    formatter: "rustfmt",
    keyFiles: existingFiles(dir, ["Cargo.toml", "Cargo.lock"]),
  };
}

export function detectPython(dir: string): ProjectInfo | null {
  const hasPyproject = existsSync(join(dir, "pyproject.toml"));
  const hasRequirements = existsSync(join(dir, "requirements.txt"));
  if (!hasPyproject && !hasRequirements) return null;
  let packageManager = "pip";
  if (existsSync(join(dir, "poetry.lock"))) packageManager = "poetry";
  else if (existsSync(join(dir, "uv.lock"))) packageManager = "uv";
  let testRunner: string | undefined;
  if (existsSync(join(dir, "conftest.py")) || existsSync(join(dir, "pytest.ini")))
    testRunner = "pytest";
  let linter: string | undefined;
  if (hasPyproject) {
    try {
      const raw = readFileSync(join(dir, "pyproject.toml"), "utf-8");
      if (/^\[tool\.ruff\]/m.test(raw)) linter = "ruff";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return {
    languages: ["Python"],
    packageManager,
    testRunner,
    linter,
    keyFiles: existingFiles(dir, ["pyproject.toml", "requirements.txt"]),
  };
}

export function detectGo(dir: string): ProjectInfo | null {
  if (!existsSync(join(dir, "go.mod"))) return null;
  return {
    languages: ["Go"],
    packageManager: "go modules",
    testRunner: "go test",
    keyFiles: existingFiles(dir, ["go.mod"]),
  };
}

export function detectZig(dir: string): ProjectInfo | null {
  if (!existsSync(join(dir, "build.zig")) && !existsSync(join(dir, "build.zig.zon"))) return null;
  return {
    languages: ["Zig"],
    packageManager: "zig build",
    testRunner: "zig build test",
    keyFiles: existingFiles(dir, ["build.zig", "build.zig.zon"]),
  };
}

export function detectBuild(dir: string): string | undefined {
  const files = existingFiles(dir, ["Makefile", "makefile", "justfile", "Taskfile.yml"]);
  return files[0];
}

export function detectCI(dir: string): string | undefined {
  if (existsSync(join(dir, ".github", "workflows"))) return "GitHub Actions";
  if (existsSync(join(dir, ".gitlab-ci.yml"))) return "GitLab CI";
  return undefined;
}

export function detectContainer(dir: string): string | undefined {
  if (existsSync(join(dir, "Dockerfile"))) return "Docker";
  if (existsSync(join(dir, "docker-compose.yml")) || existsSync(join(dir, "docker-compose.yaml")))
    return "Docker Compose";
  return undefined;
}

const DETECTORS = [detectNode, detectRust, detectPython, detectGo, detectZig];

export function detectAll(dir: string): ProjectInfo {
  const results = DETECTORS.map((fn) => fn(dir)).filter((r): r is ProjectInfo => r !== null);

  if (results.length === 0) {
    return { languages: ["unknown"], keyFiles: [] };
  }

  const merged: ProjectInfo = {
    languages: results.map((r) => r.languages[0]).filter(Boolean),
    runtime: results.find((r) => r.runtime)?.runtime,
    packageManager: results.find((r) => r.packageManager)?.packageManager,
    testRunner: results.find((r) => r.testRunner)?.testRunner,
    linter: results.find((r) => r.linter)?.linter,
    formatter: results.find((r) => r.formatter)?.formatter,
    keyFiles: [...new Set(results.flatMap((r) => r.keyFiles))],
  };
  merged.buildSystem = detectBuild(dir);
  merged.ci = detectCI(dir);
  merged.container = detectContainer(dir);
  return merged;
}

export function formatContext(info: ProjectInfo): string {
  const lines: string[] = [];
  if (info.languages.length > 0 && info.languages[0] !== "unknown") {
    lines.push(`Project: ${info.languages.join(", ")}`);
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
