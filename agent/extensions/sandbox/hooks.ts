/**
 * Hooks System — Structured lifecycle hooks for tool execution
 *
 * Named, composable hooks that run before/after tool execution.
 * More structured than raw event handlers:
 * - Named hooks can be enabled/disabled at runtime
 * - Priority ordering (lower priority runs first)
 * - Match filtering (hook only fires for specific tools/params)
 * - Clear contract: PreToolUse returns allow/block/modify, PostToolUse returns injectContext
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────

export interface PreToolUseResult {
  action: "allow" | "block" | "modify";
  reason?: string;
  modifiedParams?: Record<string, unknown>;
}

export interface PostToolUseResult {
  injectContext?: string;
}

export interface PreToolUseHook {
  name: string;
  description?: string;
  /** Lower priority runs first. Default 100. */
  priority?: number;
  /** Optional filter: return false to skip this hook for a given tool call */
  match?: (toolName: string, params: Record<string, unknown>) => boolean;
  /** The hook handler */
  handler: (toolName: string, params: Record<string, unknown>) => Promise<PreToolUseResult>;
}

export interface PostToolUseHook {
  name: string;
  description?: string;
  priority?: number;
  match?: (toolName: string, params: Record<string, unknown>, result: unknown) => boolean;
  handler: (
    toolName: string,
    params: Record<string, unknown>,
    result: unknown,
  ) => Promise<PostToolUseResult>;
}

export interface HookInfo {
  name: string;
  type: "pre" | "post";
  description?: string;
  priority: number;
  enabled: boolean;
}

// ── Registry ──────────────────────────────────────────────────────────

class HookRegistry {
  private preHooks: (PreToolUseHook & { _enabled: boolean })[] = [];
  private postHooks: (PostToolUseHook & { _enabled: boolean })[] = [];

  register(hook: PreToolUseHook | PostToolUseHook): void {
    // Discriminate by handler param count:
    // PreToolUseHook: (toolName, params)
    // PostToolUseHook: (toolName, params, result)
    if (hook.handler.length <= 2) {
      this.preHooks.push({ ...hook, _enabled: true });
      this.preHooks.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    } else {
      this.postHooks.push({ ...(hook as PostToolUseHook), _enabled: true });
      this.postHooks.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }
  }

  unregister(name: string): boolean {
    const preIdx = this.preHooks.findIndex((h) => h.name === name);
    if (preIdx >= 0) {
      this.preHooks.splice(preIdx, 1);
      return true;
    }
    const postIdx = this.postHooks.findIndex((h) => h.name === name);
    if (postIdx >= 0) {
      this.postHooks.splice(postIdx, 1);
      return true;
    }
    return false;
  }

  enable(name: string): boolean {
    return this.setEnabled(name, true);
  }

  disable(name: string): boolean {
    return this.setEnabled(name, false);
  }

  private setEnabled(name: string, enabled: boolean): boolean {
    for (const h of this.preHooks) {
      if (h.name === name) {
        h._enabled = enabled;
        return true;
      }
    }
    for (const h of this.postHooks) {
      if (h.name === name) {
        h._enabled = enabled;
        return true;
      }
    }
    return false;
  }

  list(): HookInfo[] {
    const pre: HookInfo[] = this.preHooks.map((h) => ({
      name: h.name,
      type: "pre" as const,
      description: h.description,
      priority: h.priority ?? 100,
      enabled: h._enabled,
    }));
    const post: HookInfo[] = this.postHooks.map((h) => ({
      name: h.name,
      type: "post" as const,
      description: h.description,
      priority: h.priority ?? 100,
      enabled: h._enabled,
    }));
    return [...pre, ...post].sort((a, b) => a.priority - b.priority);
  }

  async runPreToolUse(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{
    blocked: boolean;
    reason?: string;
    params: Record<string, unknown>;
  }> {
    let currentParams = { ...params };
    let lastReason: string | undefined;

    for (const hook of this.preHooks) {
      if (!hook._enabled) continue;
      if (hook.match && !hook.match(toolName, currentParams)) continue;

      try {
        const result = await hook.handler(toolName, currentParams);

        if (result.reason) {
          lastReason = result.reason;
        }

        if (result.action === "block") {
          return {
            blocked: true,
            reason: result.reason ?? `Blocked by hook: ${hook.name}`,
            params: currentParams,
          };
        }

        if (result.action === "modify" && result.modifiedParams) {
          currentParams = { ...currentParams, ...result.modifiedParams };
        }
      } catch (err) {
        console.error(`Hook "${hook.name}" error:`, err);
      }
    }

    return { blocked: false, reason: lastReason, params: currentParams };
  }

  async runPostToolUse(
    toolName: string,
    params: Record<string, unknown>,
    result: unknown,
  ): Promise<string[]> {
    const contexts: string[] = [];

    for (const hook of this.postHooks) {
      if (!hook._enabled) continue;
      if (hook.match && !hook.match(toolName, params, result)) continue;

      try {
        const r = await hook.handler(toolName, params, result);
        if (r.injectContext) {
          contexts.push(`[hook: ${hook.name}]\n${r.injectContext}`);
        }
      } catch (err) {
        console.error(`Hook "${hook.name}" error:`, err);
      }
    }

    return contexts;
  }

  // ── Singleton ─────────────────────────────────────────────────────────

export const hooks = new HookRegistry();

// ── Extension integration ─────────────────────────────────────────────

/**
 * Wire the hooks registry into pi's event system.
 * Call once from the main extension.
 */
export function setupHooks(pi: ExtensionAPI) {
  // Pre-tool-use: run pre hooks, optionally block or modify params
  pi.on("tool_call", async (event, _ctx) => {
    const params = event.input as Record<string, unknown>;
    const {
      blocked,
      reason,
      params: modifiedParams,
    } = await hooks.runPreToolUse(event.toolName, params);

    if (blocked) {
      if (_ctx.hasUI) _ctx.ui.notify(reason ?? "Blocked by hook", "error");
      return { block: true, reason: reason ?? "Blocked by hook" };
    }

    if (reason && _ctx.hasUI) {
      _ctx.ui.notify(reason, "warning");
    }

    // Apply modified params back to event input
    if (modifiedParams !== params) {
      Object.assign(event.input, modifiedParams);
    }

    return;
  });

  // Post-tool-use: collect context injections for next turn
  let pendingContexts: string[] = [];

  pi.on("tool_result", async (event, _ctx) => {
    const result = "result" in event ? event.result : undefined;
    const contexts = await hooks.runPostToolUse(
      event.toolName,
      event.input as Record<string, unknown>,
      result,
    );
    pendingContexts.push(...contexts);
  });

  // Inject collected contexts before next agent turn
  pi.on("before_agent_start", async (event, _ctx) => {
    if (pendingContexts.length === 0) return;
    const hookBlock = pendingContexts.join("\n\n");
    pendingContexts = [];
    return {
      systemPrompt: event.systemPrompt + "\n\n<hook_context>\n" + hookBlock + "\n</hook_context>",
    };
  });
}

// ── Built-in hooks (can be registered by the main extension) ──────────

/**
 * Pre-built hook: warn on curl/wget to suspicious domains
 */
export const networkSafetyHook: PreToolUseHook = {
  name: "network-safety",
  description: "Warn when bash commands access suspicious domains",
  priority: 50,
  match: (toolName) => toolName === "bash",
  async handler(_toolName, params) {
    const cmd = (params.command as string) ?? "";
    const suspiciousPatterns = [
      /curl\s+.*\s+-[dD].*@/i, // curl posting data
      /wget\s+.*--post-data/i, // wget posting data
      /nc\s+-[lL]/i, // netcat listening
      /socat\s+/i, // socat
      /ngrok\s+/i, // ngrok tunnels
      /ssh\s+-[LR]\s+/i, // ssh tunneling
    ];
    for (const p of suspiciousPatterns) {
      if (p.test(cmd)) {
        return {
          action: "allow",
          reason: "Network safety hook triggered — please review manually.",
        };
      }
    }
    return { action: "allow" };
  },
};

/**
 * Pre-built hook: prevent edits to sensitive config files
 */
export const configProtectionHook: PreToolUseHook = {
  name: "config-protection",
  description: "Prevent editing of sensitive config files",
  priority: 40,
  match: (toolName) => toolName === "edit" || toolName === "write",
  async handler(_toolName, params) {
    const filepath = (params.path as string) ?? "";
    const protectedFiles = [
      ".env",
      ".env.local",
      ".env.production",
      "credentials.json",
      "service-account.json",
      "id_rsa",
      "id_ed25519",
      ".npmrc",
      ".pypirc",
    ];
    const basename = filepath.split("/").pop() ?? "";
    if (protectedFiles.includes(basename)) {
      return {
        action: "block",
        reason: `Editing "${basename}" is blocked by config-protection hook. Edit a template or use env vars instead.`,
      };
    }
    return { action: "allow" };
  },
};

/**
 * Pre-built hook: log all bash commands for audit
 */
export const auditLogHook: PostToolUseHook = {
  name: "audit-log",
  description: "Log all bash command results for audit trail",
  priority: 200,
  match: (toolName) => toolName === "bash",
  async handler(_toolName, params, _result) {
    const cmd = (params.command as string) ?? "";
    const preview = cmd.slice(0, 80);
    // Logging only — no context injection
    console.log(`[audit] bash: ${preview}${cmd.length > 80 ? "..." : ""}`);
    return {};
  },
};
