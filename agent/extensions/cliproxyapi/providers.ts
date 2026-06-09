import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import type { CliProxyCredentials } from "./auth.ts";
import type { DiscoveredGroup, DiscoveryResult } from "./discovery.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface RegistrationReport {
  providerCount: number;
  modelCount: number;
  providers: Array<{ provider: string; modelCount: number }>;
}

export function registerDiscoveredProviders(
  pi: ExtensionAPI,
  credentials: CliProxyCredentials,
  discovery: DiscoveryResult,
): RegistrationReport {
  const providers: Array<{ provider: string; modelCount: number }> = [];

  for (const group of discovery.groups) {
    const models = group.models.map((model): ProviderModelConfig => modelConfig(model.id));
    if (models.length === 0) continue;

    pi.registerProvider(group.provider, {
      name: group.label,
      baseUrl: credentials.endpoint,
      apiKey: credentials.access,
      authHeader: true,
      api: group.api,
      compat: {
        supportsStore: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      },
      models,
    });

    providers.push({ provider: group.provider, modelCount: models.length });
  }

  return {
    providers,
    providerCount: providers.length,
    modelCount: providers.reduce((total, provider) => total + provider.modelCount, 0),
  };
}

export function formatGroupSummary(groups: DiscoveredGroup[]): string {
  if (groups.length === 0) return "No models discovered.";
  return groups.map((group) => `${group.provider}: ${group.models.length}`).join("\n");
}

function modelConfig(id: string): ProviderModelConfig {
  return {
    id,
    name: prettifyModelName(id),
    api: "openai-completions",
    reasoning: isReasoningModel(id),
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 16_000,
    cost: { ...ZERO_COST },
  };
}

function isReasoningModel(id: string): boolean {
  return (
    /^gpt-5(?:\.|-|$)/i.test(id) ||
    /(?:^|[-_.])thinking$/i.test(id) ||
    /^gemini-3(?:\.|-|$)/i.test(id)
  );
}

function prettifyModelName(id: string): string {
  return id
    .replace(/[/:]/g, " ")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^api$/i.test(part)) return "API";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}
