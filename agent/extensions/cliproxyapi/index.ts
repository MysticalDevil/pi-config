import { join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { loadCachedDiscovery, saveDiscoveryCache } from "./cache.ts";
import { discoverModels } from "./discovery.ts";
import { getStoredCredentials, refreshCliProxyModels, runDoctor } from "./doctor.ts";
import { registerDiscoveredProviders } from "./providers.ts";
import {
  DEFAULT_CLI_PROXY_ENDPOINT,
  formatSetupSuccess,
  makeStoredCredentials,
  parseSetupArgs,
  readCliProxyCredentials,
  saveCliProxyCredentials,
} from "./setup.ts";

function authPath(): string {
  return join(getAgentDir(), "auth.json");
}

export default function cliproxyapiLite(pi: ExtensionAPI): void {
  const cachedDiscovery = loadCachedDiscovery();
  if (cachedDiscovery) {
    const credentials = readCliProxyCredentials(authPath());
    if (credentials && credentials.endpoint === cachedDiscovery.endpoint) {
      registerDiscoveredProviders(pi, credentials, cachedDiscovery);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const credentials = getStoredCredentials(ctx.modelRegistry, authPath());
    if (!credentials) return;

    try {
      const discovery = await discoverModels(credentials.endpoint, credentials.access);
      saveDiscoveryCache(discovery);
      registerDiscoveredProviders(pi, credentials, discovery);
      ctx.modelRegistry.refresh?.();
    } catch (error) {
      ctx.ui.notify(
        `CLIProxyAPI model discovery failed: ${error instanceof Error ? error.message : String(error)}. Run /cliproxy-refresh to retry or /cliproxy-setup to reconfigure.`,
        "warning",
      );
    }
  });

  pi.registerCommand("cliproxy-setup", {
    description: "Configure CLIProxyAPI endpoint and API key, then discover models",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let endpoint: string;
      let apiKey: string;

      try {
        const parsed = parseSetupArgs(args || "");
        if (parsed) {
          endpoint = parsed.endpoint;
          apiKey = parsed.apiKey;
        } else {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              `Usage: /cliproxy-setup <endpoint> <apiKey> or /cliproxy-setup '{"endpoint":"...","apiKey":"..."}'`,
              "error",
            );
            return;
          }

          const endpointInput = await ctx.ui.input(
            "CLIProxyAPI endpoint",
            DEFAULT_CLI_PROXY_ENDPOINT,
          );
          endpoint = endpointInput.trim() || DEFAULT_CLI_PROXY_ENDPOINT;
          apiKey = await ctx.ui.input("CLIProxyAPI API key", "sk-...");
        }

        const credentials = makeStoredCredentials(endpoint, apiKey);
        ctx.ui.notify("CLIProxyAPI: discovering models...", "info");

        const discovery = await discoverModels(credentials.endpoint, credentials.access);
        saveCliProxyCredentials(authPath(), credentials);
        saveDiscoveryCache(discovery);
        const report = registerDiscoveredProviders(pi, credentials, discovery);
        ctx.modelRegistry.refresh?.();
        ctx.ui.notify(formatSetupSuccess(discovery, report), "info");
      } catch (error) {
        ctx.ui.notify(
          `CLIProxyAPI setup failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("cliproxy-refresh", {
    description: "Refresh CLIProxyAPI models from the saved endpoint",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await refreshCliProxyModels(pi, ctx, authPath());
    },
  });

  pi.registerCommand("cliproxy-doctor", {
    description: "Check CLIProxyAPI endpoint, credentials, and model discovery",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await runDoctor(ctx, authPath());
    },
  });
}
