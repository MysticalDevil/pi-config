/**
 * /init - Project Initialization (like Claude Code's /init)
 *
 * Scans the project structure and generates an AGENTS.md file
 * with project description, tech stack, directory layout, and conventions.
 *
 * Usage:
 *   /init                    — scan and generate AGENTS.md
 *   /init --force            — overwrite existing AGENTS.md
 *   /init --preview          — show what would be generated without writing
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ProjectInfo {
  name: string;
  description: string;
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  packageManager: string;
  topDirs: string[];
  configFiles: string[];
  structure: string;
}

const MAX_STRUCTURE_DEPTH = 3;
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "target",
  ".cache",
  ".turbo",
  "coverage",
  ".nyc_output",
  ".tox",
  ".mypy_cache",
]);

const LANGUAGE_SIGNATURES: Record<string, string[]> = {
  TypeScript: ["tsconfig.json", "*.ts", "*.tsx"],
  JavaScript: ["package.json", "*.js", "*.jsx"],
  Python: ["pyproject.toml", "setup.py", "requirements.txt", "*.py"],
  Rust: ["Cargo.toml", "*.rs"],
  Go: ["go.mod", "*.go"],
  Zig: ["build.zig", "*.zig"],
  Java: ["pom.xml", "build.gradle", "*.java"],
  Kotlin: ["build.gradle.kts", "*.kt"],
  Ruby: ["Gemfile", "*.rb"],
  "C/C++": ["CMakeLists.txt", "Makefile", "*.c", "*.cpp", "*.h"],
};

const FRAMEWORK_SIGNATURES: Record<string, string> = {
  "next.config.js": "Next.js",
  "next.config.ts": "Next.js",
  "next.config.mjs": "Next.js",
  "svelte.config.js": "Svelte",
  "nuxt.config.ts": "Nuxt",
  "astro.config.mjs": "Astro",
  "remix.config.js": "Remix",
  "vite.config.ts": "Vite",
  "webpack.config.js": "Webpack",
  "tailwind.config.js": "Tailwind CSS",
  "tailwind.config.ts": "Tailwind CSS",
  Dockerfile: "Docker",
  "docker-compose.yml": "Docker Compose",
  "docker-compose.yaml": "Docker Compose",
  ".eslintrc.js": "ESLint",
  ".eslintrc.json": "ESLint",
  "eslint.config.js": "ESLint",
  ".prettierrc": "Prettier",
  "prettier.config.js": "Prettier",
  "jest.config.ts": "Jest",
  "vitest.config.ts": "Vitest",
  "playwright.config.ts": "Playwright",
};

const BUILD_TOOL_SIGNATURES: Record<string, string> = {
  "tsup.config.ts": "tsup",
  "rollup.config.js": "Rollup",
  "esbuild.config.js": "esbuild",
  "turbo.json": "Turborepo",
  "nx.json": "Nx",
  "lerna.json": "Lerna",
  Makefile: "Make",
  justfile: "Just",
  "taskfile.yaml": "Task",
};

function findFiles(dir: string, pattern: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".env.example" && entry !== ".gitignore") continue;
      if (IGNORED_DIRS.has(entry)) continue;

      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isFile()) {
        if (matchGlob(entry, pattern)) return true;
      } else if (stat.isDirectory() && pattern.startsWith("*.")) {
        if (findFiles(fullPath, pattern)) return true;
      }
    }
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== "ENOENT" &&
      (e as NodeJS.ErrnoException).code !== "EACCES"
    )
      throw e;
  }
  return false;
}

function matchGlob(filename: string, pattern: string): boolean {
  if (pattern === filename) return true;
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);
    return filename.endsWith(ext);
  }
  return false;
}

function scanProject(cwd: string): ProjectInfo {
  const entries = fs.readdirSync(cwd);
  const configFiles: string[] = [];
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      if (entry !== ".env.example" && entry !== ".gitignore" && entry !== ".github") continue;
      if (entry === ".github") {
        dirs.push(entry);
        continue;
      }
    }
    if (IGNORED_DIRS.has(entry)) continue;

    const fullPath = path.join(cwd, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        dirs.push(entry);
      } else {
        files.push(entry);
        if (
          entry.startsWith(".") ||
          entry.endsWith(".config.js") ||
          entry.endsWith(".config.ts") ||
          entry.endsWith(".json") ||
          entry.endsWith(".toml") ||
          entry.endsWith(".yaml") ||
          entry.endsWith(".yml") ||
          entry === "Makefile" ||
          entry === "Dockerfile"
        ) {
          configFiles.push(entry);
        }
      }
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "ENOENT" &&
        (e as NodeJS.ErrnoException).code !== "EACCES"
      )
        throw e;
    }
  }

  // Detect languages
  const languages: string[] = [];
  for (const [lang, sigs] of Object.entries(LANGUAGE_SIGNATURES)) {
    for (const sig of sigs) {
      if (sig.startsWith("*.")) {
        if (findFiles(cwd, sig)) {
          languages.push(lang);
          break;
        }
      } else if (files.includes(sig) || configFiles.includes(sig)) {
        languages.push(lang);
        break;
      }
    }
  }

  // Detect frameworks
  const frameworks: string[] = [];
  for (const [file, name] of Object.entries(FRAMEWORK_SIGNATURES)) {
    if (files.includes(file) || configFiles.includes(file) || fs.existsSync(path.join(cwd, file))) {
      if (!frameworks.includes(name)) frameworks.push(name);
    }
  }

  // Detect build tools
  const buildTools: string[] = [];
  for (const [file, name] of Object.entries(BUILD_TOOL_SIGNATURES)) {
    if (files.includes(file) || configFiles.includes(file) || fs.existsSync(path.join(cwd, file))) {
      if (!buildTools.includes(name)) buildTools.push(name);
    }
  }

  // Detect package manager
  let packageManager = "npm";
  if (files.includes("pnpm-lock.yaml") || configFiles.includes("pnpm-workspace.yaml"))
    packageManager = "pnpm";
  else if (files.includes("yarn.lock")) packageManager = "yarn";
  else if (files.includes("bun.lockb")) packageManager = "bun";

  // Package name from package.json
  let projectName = path.basename(cwd);
  if (files.includes("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
      if (pkg.name) projectName = pkg.name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (files.includes("Cargo.toml")) {
    try {
      const cargo = fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf-8");
      const match = cargo.match(/name\s*=\s*"(.+)"/);
      if (match) projectName = match[1];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  // Generate directory structure tree
  const structure = generateTree(cwd, "", MAX_STRUCTURE_DEPTH);

  return {
    name: projectName,
    description: files.includes("README.md") ? "(see README.md)" : "",
    languages,
    frameworks,
    buildTools,
    packageManager,
    topDirs: dirs.filter((d) => !d.startsWith(".") || d === ".github"),
    configFiles,
    structure,
  };
}

function generateTree(
  dir: string,
  prefix: string,
  maxDepth: number,
  currentDepth: number = 0,
): string {
  if (currentDepth >= maxDepth) return "";

  let result = "";
  let entries: string[] = [];

  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === "ENOENT" ||
      (e as NodeJS.ErrnoException).code === "EACCES"
    )
      return "";
    throw e;
  }

  // Filter and sort
  entries = entries
    .filter((e) => {
      if (e.startsWith(".") && e !== ".env.example" && e !== ".gitignore" && e !== ".github")
        return false;
      return !IGNORED_DIRS.has(e);
    })
    .sort((a, b) => {
      const aIsDir = fs.statSync(path.join(dir, a)).isDirectory();
      const bIsDir = fs.statSync(path.join(dir, b)).isDirectory();
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

  const displayEntries = entries.slice(0, 30);
  const overflow = entries.length - 30;

  for (let i = 0; i < displayEntries.length; i++) {
    const entry = displayEntries[i];
    const fullPath = path.join(dir, entry);
    const isLast = i === displayEntries.length - 1 && overflow === 0;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = prefix + (isLast ? "    " : "│   ");

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code === "ENOENT" ||
        (e as NodeJS.ErrnoException).code === "EACCES"
      )
        continue;
      throw e;
    }

    if (stat.isDirectory()) {
      result += `${prefix}${connector}${entry}/\n`;
      result += generateTree(fullPath, childPrefix, maxDepth, currentDepth + 1);
    } else {
      result += `${prefix}${connector}${entry}\n`;
    }
  }

  if (overflow > 0) {
    result += `${prefix}└── ... ${overflow} more entries\n`;
  }

  return result;
}

function generateAgentsMd(info: ProjectInfo): string {
  const lines: string[] = [];

  lines.push(`# ${info.name}`);
  lines.push("");

  if (info.description) {
    lines.push(info.description);
    lines.push("");
  }

  // Tech stack
  lines.push("## Tech Stack");
  lines.push("");
  if (info.languages.length > 0) {
    lines.push(`- **Languages:** ${info.languages.join(", ")}`);
  }
  if (info.frameworks.length > 0) {
    lines.push(`- **Frameworks:** ${info.frameworks.join(", ")}`);
  }
  if (info.buildTools.length > 0) {
    lines.push(`- **Build Tools:** ${info.buildTools.join(", ")}`);
  }
  lines.push(`- **Package Manager:** ${info.packageManager}`);
  lines.push("");

  // Project structure
  lines.push("## Project Structure");
  lines.push("");
  lines.push("```");
  lines.push(info.structure.trimEnd());
  lines.push("```");
  lines.push("");

  // Key config files
  if (info.configFiles.length > 0) {
    lines.push("## Configuration Files");
    lines.push("");
    for (const f of info.configFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  // Conventions placeholder
  lines.push("## Conventions");
  lines.push("");
  lines.push("<!-- Add project-specific conventions here -->");
  lines.push("");
  lines.push("- Run `npm test` (or equivalent) before committing");
  lines.push("- Keep commits small and focused");
  lines.push("- Write meaningful commit messages");
  lines.push("");

  // Commands
  lines.push("## Common Commands");
  lines.push("");

  switch (info.packageManager) {
    case "pnpm":
      lines.push("```bash");
      lines.push("pnpm install          # Install dependencies");
      lines.push("pnpm dev              # Start dev server");
      lines.push("pnpm build            # Build for production");
      lines.push("pnpm test             # Run tests");
      lines.push("pnpm lint             # Run linter");
      lines.push("```");
      break;
    case "yarn":
      lines.push("```bash");
      lines.push("yarn install          # Install dependencies");
      lines.push("yarn dev              # Start dev server");
      lines.push("yarn build            # Build for production");
      lines.push("yarn test             # Run tests");
      lines.push("yarn lint             # Run linter");
      lines.push("```");
      break;
    default:
      lines.push("```bash");
      lines.push("npm install           # Install dependencies");
      lines.push("npm run dev           # Start dev server");
      lines.push("npm run build         # Build for production");
      lines.push("npm test              # Run tests");
      lines.push("npm run lint          # Run linter");
      lines.push("```");
      break;
  }

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "Scan project and generate AGENTS.md (usage: /init [--force] [--preview])",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);
      const force = tokens.includes("--force");
      const preview = tokens.includes("--preview");
      const agentsPath = path.join(ctx.cwd, "AGENTS.md");

      // Check if already exists
      if (!force && !preview && fs.existsSync(agentsPath)) {
        const choice = await ctx.ui.select("AGENTS.md already exists. Overwrite?", [
          "Yes, overwrite",
          "Preview only",
          "Cancel",
        ]);
        if (choice === "Cancel") return;
        if (choice === "Preview only") {
          void (preview as unknown as boolean);
        }
      }

      ctx.ui.notify("Scanning project...", "info");

      const info = scanProject(ctx.cwd);
      const content = generateAgentsMd(info);

      if (preview) {
        // Show preview
        await ctx.ui.custom((_tui, theme, _kb, done) => {
          const lines = content.split("\n");
          const previewLines = lines.slice(0, 40);

          return {
            render(width: number) {
              const header = theme.fg("accent", theme.bold(" AGENTS.md Preview "));
              const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width - 16)));
              const result = [header + border, ""];
              for (const line of previewLines) {
                if (line.startsWith("## ")) {
                  result.push(theme.fg("accent", theme.bold(line)));
                } else if (line.startsWith("# ")) {
                  result.push(theme.fg("accent", theme.bold(line)));
                } else if (line.startsWith("- ")) {
                  result.push(theme.fg("muted", line));
                } else if (line.startsWith("```")) {
                  result.push(theme.fg("dim", line));
                } else {
                  result.push(line);
                }
              }
              if (lines.length > 40) {
                result.push(theme.fg("dim", `... ${lines.length - 40} more lines`));
              }
              result.push("");
              result.push(
                theme.fg("dim", "Use /init --force to write this file. Press Esc to close."),
              );
              return result;
            },
            invalidate() {},
            handleInput(data: string) {
              if (data === "\x1b") done(undefined);
            },
          };
        });
        return;
      }

      // Write the file
      fs.writeFileSync(agentsPath, content, "utf-8");

      ctx.ui.notify(
        `Generated AGENTS.md (${info.languages.length} languages, ${info.frameworks.length} frameworks)`,
        "info",
      );
    },
  });
}
