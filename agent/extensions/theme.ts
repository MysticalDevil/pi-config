/**
 * /theme - Interactive Theme Switcher
 *
 * Switches between installed themes with live color swatch preview.
 * Writes selection to settings.json and triggers reload.
 *
 * Usage:
 *   /theme              — interactive theme picker with swatches
 *   /theme <name>       — switch directly to theme
 *   /theme --list       — list all available themes
 *   /theme --current    — show current theme
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ThemeMeta {
  file: string;
  name: string;
  isDark: boolean;
}

interface ThemeData {
  name?: string;
  colors?: Record<string, string | number | undefined>;
  vars?: Record<string, string>;
}

function getThemeNames(cwd: string): ThemeMeta[] {
  const themes: ThemeMeta[] = [];

  // Built-in themes
  themes.push({ file: "dark", name: "Dark (built-in)", isDark: true });
  themes.push({ file: "light", name: "Light (built-in)", isDark: false });

  // Global themes
  const globalDir = path.join(homedir(), ".pi", "agent", "themes");
  if (fs.existsSync(globalDir)) {
    for (const entry of fs.readdirSync(globalDir)) {
      if (entry.endsWith(".json")) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(globalDir, entry), "utf-8")) as ThemeData;
          if (content.name) {
            const bg = content.colors?.toolPendingBg || content.vars?.bg || "";
            const isDark = isDarkColor(bg);
            themes.push({ file: entry.replace(".json", ""), name: content.name, isDark });
          }
        } catch (e) {
          if (e instanceof SyntaxError) throw e;
        }
      }
    }
  }

  // Project themes
  const projectDir = path.join(cwd, ".pi", "themes");
  if (fs.existsSync(projectDir)) {
    for (const entry of fs.readdirSync(projectDir)) {
      if (entry.endsWith(".json")) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(projectDir, entry), "utf-8")) as ThemeData;
          if (content.name) {
            const name = content.name + " (project)";
            themes.push({ file: entry.replace(".json", ""), name, isDark: false });
          }
        } catch (e) {
          if (e instanceof SyntaxError) throw e;
        }
      }
    }
  }

  return themes;
}

function isDarkColor(hex: string): boolean {
  hex = hex.replace("#", "");
  if (hex.length === 0) return true; // empty = default = probably dark
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return true; // fallback: assume dark
  // Perceived brightness
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness < 128;
}

function getSwatchColors(themeFile: string): Record<string, string> | null {
  // Try global first
  const globalPath = path.join(
    homedir(),
    ".pi",
    "agent",
    "themes",
    `${themeFile}.json`,
  );
  let themeData: ThemeData | null = null;

  if (fs.existsSync(globalPath)) {
    try {
      themeData = JSON.parse(fs.readFileSync(globalPath, "utf-8")) as ThemeData;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  if (!themeData || !themeData.colors) return null;

  const colors = themeData.colors;
  return {
    accent: colorValue(colors.accent, themeData.vars),
    success: colorValue(colors.success, themeData.vars),
    error: colorValue(colors.error, themeData.vars),
    warning: colorValue(colors.warning, themeData.vars),
    text: colorValue(colors.text, themeData.vars),
    muted: colorValue(colors.muted, themeData.vars),
    bg: colorValue(colors.toolPendingBg, themeData.vars),
    userBg: colorValue(colors.userMessageBg, themeData.vars),
  };
}

function colorValue(
  val: string | number | undefined,
  vars: Record<string, string> | undefined,
): string {
  if (val === undefined || val === "") return "";
  if (typeof val === "number") return `${val}`;
  if (val.startsWith("#")) return val;
  if (vars && vars[val]) return vars[val];
  return val;
}

function readCurrentTheme(settingsPath: string): string {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    return typeof settings.theme === "string" ? settings.theme : "dark";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "dark";
    throw e;
  }
}

function writeTheme(settingsPath: string, theme: string): void {
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  settings.theme = theme;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("theme", {
    description: "Switch color theme (usage: /theme [name|--list|--current])",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);
      const subcommand = tokens[0] || "";
      const settingsPath = path.join(homedir(), ".pi", "agent", "settings.json");
      const themes = getThemeNames(ctx.cwd);
      const currentTheme = readCurrentTheme(settingsPath);

      // --list: show all themes
      if (subcommand === "--list") {
        const items = themes.map((t) => {
          const marker = t.file === currentTheme ? " ★" : "";
          const icon = t.isDark ? "🌙" : "☀️";
          return `${icon} ${t.name}${marker}`;
        });
        ctx.ui.notify(`Available themes (${themes.length}):\n${items.join("\n")}`, "info");
        return;
      }

      // --current: show current
      if (subcommand === "--current") {
        const current = themes.find((t) => t.file === currentTheme);
        const name = current?.name || currentTheme;
        const icon = current?.isDark ? "🌙" : "☀️";
        ctx.ui.notify(`Current theme: ${icon} ${name}`, "info");
        return;
      }

      // Direct switch: /theme <name>
      if (subcommand && subcommand !== "--list" && subcommand !== "--current") {
        const match = themes.find(
          (t) => t.file === subcommand || t.name.toLowerCase().includes(subcommand.toLowerCase()),
        );
        if (!match) {
          ctx.ui.notify(
            `Theme "${subcommand}" not found. Use /theme --list to see available themes.`,
            "warning",
          );
          return;
        }
        writeTheme(settingsPath, match.file);
        ctx.ui.notify(`Theme set to: ${match.name}\nReloading...`, "info");

        // Trigger reload to apply
        await ctx.reload();
        return;
      }

      // Interactive picker with swatches
      const currentDisplay = themes.find((t) => t.file === currentTheme);

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        let selectedIdx = themes.findIndex((t) => t.file === currentTheme);
        if (selectedIdx < 0) selectedIdx = 0;

        const render = (_width: number) => {
          const lines: string[] = [];
          lines.push("");
          lines.push(theme.fg("accent", theme.bold(" Theme Switcher ")));
          lines.push(theme.fg("borderMuted", "─".repeat(55)));
          lines.push("");

          // Current theme display
          if (currentDisplay) {
            lines.push(`  Current: ${theme.fg("accent", currentDisplay.name)}`);
            lines.push("");
          }

          // Show swatches for visible themes
          const startIdx = Math.max(0, selectedIdx - 5);
          const endIdx = Math.min(themes.length, selectedIdx + 8);
          const visibleThemes = themes.slice(startIdx, endIdx);

          if (startIdx > 0) {
            lines.push(`  ${theme.fg("dim", `... ${startIdx} more ...`)}`);
          }

          for (let i = 0; i < visibleThemes.length; i++) {
            const t = visibleThemes[i];
            const absoluteIdx = startIdx + i;
            const isSelected = absoluteIdx === selectedIdx;
            const isCurrent = t.file === currentTheme;
            const swatch = getSwatchColors(t.file);

            const prefix = isSelected ? theme.fg("accent", "▶") : " ";
            const star = isCurrent ? " ★" : "";

            if (swatch) {
              // Draw mini swatch indicators using theme colors
              const swatchBar = [
                swatch.bg ? ` █ ` : "",
                swatch.userBg ? ` ⌂ ` : "",
                swatch.accent ? ` ● ` : "",
                swatch.text ? ` T ` : "",
              ]
                .filter(Boolean)
                .join("");

              const name = isSelected ? theme.fg("accent", theme.bold(t.name)) : t.name;
              const icon = t.isDark ? "🌙" : "☀️";

              lines.push(`${prefix} ${icon} ${name}${star}  ${swatchBar}`);
            } else {
              const name = isSelected ? theme.fg("accent", theme.bold(t.name)) : t.name;
              lines.push(`${prefix} ${t.isDark ? "🌙" : "☀️"} ${name}${star}`);
            }
          }

          if (endIdx < themes.length) {
            lines.push(`  ${theme.fg("dim", `... ${themes.length - endIdx} more ...`)}`);
          }

          lines.push("");
          lines.push(theme.fg("dim", "  ↑↓ navigate  Enter select  Esc cancel"));
          lines.push("");

          return lines;
        };

        return {
          render,
          invalidate() {},
          handleInput(data: string) {
            if (data === "\x1b") {
              done(undefined);
            } else if (data === "\r" || data === "\n") {
              const selected = themes[selectedIdx];
              if (selected && selected.file !== currentTheme) {
                writeTheme(settingsPath, selected.file);
                // Reload to apply
                ctx.reload().finally(() => done(undefined));
              } else {
                done(undefined);
              }
            } else if ((data === "\x1b[A" || data === "k") && selectedIdx > 0) {
              selectedIdx--;
              _tui.requestRender();
            } else if ((data === "\x1b[B" || data === "j") && selectedIdx < themes.length - 1) {
              selectedIdx++;
              _tui.requestRender();
            }
          },
        };
      });
    },
  });
}
