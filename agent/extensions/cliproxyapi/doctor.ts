import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isCliProxyCredentials } from "./auth.ts";
import { saveDiscoveryCache } from "./cache.ts";
import { discoverModels } from "./discovery.ts";
import { formatGroupSummary, registerDiscoveredProviders } from "./providers.ts";
import { readCliProxyCredentials } from "./setup.ts";

interface CliProxyCommandContext {
  modelRegistry: any;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}

export async function refreshCliProxyModels(
  pi: ExtensionAPI,
  ctx: CliProxyCommandContext,
  authPath?: string,
): Promise<void> {
  const credentials = getStoredCredentials(ctx.modelRegistry, authPath);
  if (!credentials) {
    ctx.ui.notify("CLIProxyAPI is not configured. Run /cliproxy-setup first.", "warning");
    return;
  }

  try {
    const discovery = await discoverModels(credentials.endpoint, credentials.access);
    saveDiscoveryCache(discovery);
    const report = registerDiscoveredProviders(pi, credentials, discovery);
    ctx.modelRegistry.refresh?.();
    ctx.ui.notify(
      `CLIProxyAPI refresh ok: ${report.modelCount} model(s) across ${report.providerCount} provider(s) from ${credentials.endpoint}.`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      [
        "CLIProxyAPI refresh failed.",
        `endpoint: ${credentials.endpoint}`,
        `error: ${error instanceof Error ? error.message : String(error)}`,
        "Run /cliproxy-refresh to retry or /cliproxy-setup to reconfigure.",
      ].join("\n"),
      "error",
    );
  }
}

export async function runDoctor(ctx: CliProxyCommandContext, authPath?: string): Promise<void> {
  const credentials = getStoredCredentials(ctx.modelRegistry, authPath);
  if (!credentials) {
    ctx.ui.notify(
      "CLIProxyAPI doctor: not configured. Run /cliproxy-setup to configure endpoint and API key.",
      "warning",
    );
    return;
  }

  try {
    const discovery = await discoverModels(credentials.endpoint, credentials.access);
    saveDiscoveryCache(discovery);
    ctx.ui.notify(
      [
        "CLIProxyAPI doctor ok",
        `endpoint: ${credentials.endpoint}`,
        `api key: ${credentials.access ? "configured" : "missing"}`,
        `models: ${discovery.totalModels}`,
        "groups:",
        formatGroupSummary(discovery.groups),
      ].join("\n"),
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      [
        "CLIProxyAPI doctor failed",
        `endpoint: ${credentials.endpoint}`,
        `api key: ${credentials.access ? "configured" : "missing"}`,
        `error: ${error instanceof Error ? error.message : String(error)}`,
        "Run /cliproxy-setup to reconfigure if the endpoint or key changed.",
      ].join("\n"),
      "error",
    );
  }
}

export function getStoredCredentials(modelRegistry: any, authPath?: string) {
  const fileCredential = authPath ? readCliProxyCredentials(authPath) : undefined;
  if (fileCredential) return fileCredential;

  const credential = modelRegistry?.authStorage?.get?.("cliproxyapi");
  return credential?.type === "oauth" && isCliProxyCredentials(credential) ? credential : undefined;
}
