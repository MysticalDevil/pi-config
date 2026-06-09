import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isCliProxyCredentials } from "./auth.ts";
import { saveDiscoveryCache } from "./cache.ts";
import { discoverModels } from "./discovery.ts";
import { formatGroupSummary, registerDiscoveredProviders } from "./providers.ts";

export async function refreshCliProxyModels(
  pi: ExtensionAPI,
  ctx: {
    modelRegistry: any;
    ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
  },
): Promise<void> {
  const credentials = getStoredCredentials(ctx.modelRegistry);
  if (!credentials) {
    ctx.ui.notify(
      "CLIProxyAPI is not configured. Run /login and choose CLIProxyAPI first.",
      "warning",
    );
    return;
  }

  try {
    const discovery = await discoverModels(credentials.endpoint, credentials.access);
    saveDiscoveryCache(discovery);
    const report = registerDiscoveredProviders(pi, credentials, discovery);
    ctx.modelRegistry.refresh?.();
    ctx.ui.notify(
      `CLIProxyAPI refresh ok: ${report.modelCount} models across ${report.providerCount} providers.`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `CLIProxyAPI refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

export async function runDoctor(ctx: {
  modelRegistry: any;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
}): Promise<void> {
  const credentials = getStoredCredentials(ctx.modelRegistry);
  if (!credentials) {
    ctx.ui.notify(
      "CLIProxyAPI doctor: not logged in. Run /login and choose CLIProxyAPI.",
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
      ].join("\n"),
      "error",
    );
  }
}

export function getStoredCredentials(modelRegistry: any) {
  const credential = modelRegistry?.authStorage?.get?.("cliproxyapi");
  return credential?.type === "oauth" && isCliProxyCredentials(credential) ? credential : undefined;
}
