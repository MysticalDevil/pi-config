import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

import {
  LOGIN_PROVIDER_ID,
  LOGIN_PROVIDER_NAME,
  isCliProxyCredentials,
  makeCredentials,
  parseLoginInput,
  type CliProxyCredentials,
} from "./auth.ts";
import { loadCachedDiscovery, saveDiscoveryCache } from "./cache.ts";
import { discoverModels } from "./discovery.ts";
import { getStoredCredentials, refreshCliProxyModels, runDoctor } from "./doctor.ts";
import { registerDiscoveredProviders } from "./providers.ts";

export default function cliproxyapiLite(pi: ExtensionAPI): void {
  const cachedDiscovery = loadCachedDiscovery();
  if (cachedDiscovery) {
    const credentials = credentialsFromAuthFile(cachedDiscovery.endpoint);
    if (credentials) {
      registerDiscoveredProviders(pi, credentials, cachedDiscovery);
    }
  }

  pi.registerProvider(LOGIN_PROVIDER_ID, {
    name: LOGIN_PROVIDER_NAME,
    api: "openai-completions",
    oauth: {
      name: LOGIN_PROVIDER_NAME,
      login: (callbacks) => loginCliProxy(pi, callbacks),
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => credentials.access,
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const credentials = getStoredCredentials(ctx.modelRegistry);
    if (!credentials) return;

    try {
      const discovery = await discoverModels(credentials.endpoint, credentials.access);
      saveDiscoveryCache(discovery);
      registerDiscoveredProviders(pi, credentials, discovery);
      ctx.modelRegistry.refresh();
    } catch (error) {
      ctx.ui.notify(
        `CLIProxyAPI model discovery failed: ${error instanceof Error ? error.message : String(error)}. Run /cliproxy-refresh to retry.`,
        "warning",
      );
    }
  });

  pi.registerCommand("cliproxy-refresh", {
    description: "Refresh CLIProxyAPI models from the saved endpoint",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await refreshCliProxyModels(pi, ctx);
    },
  });

  pi.registerCommand("cliproxy-doctor", {
    description: "Check CLIProxyAPI login, endpoint, and model discovery",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await runDoctor(ctx);
    },
  });
}

async function loginCliProxy(
  pi: ExtensionAPI,
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const input = await callbacks.onPrompt({
    message: "Enter CLIProxyAPI endpoint and API key, separated by a space:",
    placeholder: "http://127.0.0.1:8317/v1 sk-...",
  });
  const { endpoint, apiKey } = parseLoginInput(input);
  const credentials = makeCredentials(endpoint, apiKey);
  callbacks.onProgress?.("Saved CLIProxyAPI credentials. Discovering models...");

  try {
    const discovery = await discoverModels(credentials.endpoint, credentials.access);
    saveDiscoveryCache(discovery);
    const report = registerDiscoveredProviders(pi, credentials, discovery);
    callbacks.onProgress?.(
      `Discovered ${report.modelCount} CLIProxyAPI models across ${report.providerCount} providers.`,
    );
  } catch (error) {
    callbacks.onProgress?.(
      `Credentials saved, but model discovery failed: ${error instanceof Error ? error.message : String(error)}. Run /cliproxy-refresh later.`,
    );
  }

  return credentials;
}

function credentialsFromAuthFile(endpoint: string): CliProxyCredentials | undefined {
  const authPath = join(getAgentDir(), "auth.json");
  if (!existsSync(authPath)) return undefined;

  try {
    const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    const credentials = auth[LOGIN_PROVIDER_ID];
    if (!credentials || typeof credentials !== "object") return undefined;
    const typedCredentials = credentials as { type?: unknown } & OAuthCredentials;
    if (typedCredentials.type !== "oauth" || !isCliProxyCredentials(typedCredentials)) {
      return undefined;
    }
    return typedCredentials.endpoint === endpoint ? typedCredentials : undefined;
  } catch {
    return undefined;
  }
}

export type { CliProxyCredentials };
