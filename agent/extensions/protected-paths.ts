/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROTECTED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "service-account.json",
]);

const PROTECTED_DIRS = new Set([".git", "node_modules"]);

function isProtected(targetPath: string): boolean {
  if (PROTECTED_FILES.has(basename(targetPath))) return true;
  const parts = targetPath.replace(/\\/g, "/").split("/");
  return parts.some((part) => PROTECTED_DIRS.has(part));
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }

    const path = event.input.path as string;
    if (isProtected(path)) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
      }
      return { block: true, reason: `Path "${path}" is protected` };
    }

    return undefined;
  });
}
