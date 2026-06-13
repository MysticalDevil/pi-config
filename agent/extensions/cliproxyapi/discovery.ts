import type { Api } from "@earendil-works/pi-ai";

const DISCOVERY_TIMEOUT_MS = 8_000;

export interface RawProxyModel {
  id: string;
  ownedBy: string;
}

export interface DiscoveredGroup {
  provider: string;
  label: string;
  owner: string;
  api: Api;
  models: RawProxyModel[];
}

export interface DiscoveryResult {
  endpoint: string;
  totalModels: number;
  groups: DiscoveredGroup[];
}

interface ModelsResponse {
  data?: Array<{ id?: unknown; owned_by?: unknown; object?: unknown }>;
}

async function withDiscoveryTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`/v1/models discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function discoverModels(
  endpoint: string,
  apiKey: string,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<DiscoveryResult> {
  const modelsUrl = new URL("models", `${endpoint.replace(/\/+$/, "")}/`).toString();

  const body = await withDiscoveryTimeout(timeoutMs, async (signal) => {
    const response = await fetch(modelsUrl, {
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "pi-cliproxyapi-lite/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`/v1/models returned HTTP ${response.status}`);
    }

    return (await response.json()) as ModelsResponse;
  });
  if (!Array.isArray(body.data)) {
    throw new Error("/v1/models response does not contain a data array");
  }

  const models = body.data
    .map(
      (model): RawProxyModel => ({
        id: typeof model.id === "string" ? model.id : "",
        ownedBy: typeof model.owned_by === "string" && model.owned_by ? model.owned_by : "unknown",
      }),
    )
    .filter((model) => model.id.length > 0);

  return {
    endpoint,
    totalModels: models.length,
    groups: groupModels(models),
  };
}

export function groupModels(models: RawProxyModel[]): DiscoveredGroup[] {
  const groups = new Map<string, DiscoveredGroup>();

  for (const model of models) {
    const info = classifyOwner(model.ownedBy);
    let existingGroup = groups.get(info.provider);
    if (!existingGroup) {
      existingGroup = {
        provider: info.provider,
        label: info.label,
        owner: info.owner,
        api: "openai-completions",
        models: [],
      };
      groups.set(info.provider, existingGroup);
    }
    existingGroup.models.push(model);
  }

  return Array.from(groups.values())
    .map((discoveredGroup) => ({
      ...discoveredGroup,
      models: discoveredGroup.models.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function classifyOwner(ownedBy: string): { provider: string; label: string; owner: string } {
  const normalized = ownedBy.trim();
  const lower = normalized.toLowerCase();

  if (lower === "openai") return group("cliproxy-openai", "CLIProxy OpenAI", normalized);
  if (lower === "anthropic") return group("cliproxy-anthropic", "CLIProxy Anthropic", normalized);
  if (lower === "deepseek") return group("cliproxy-deepseek", "CLIProxy DeepSeek", normalized);
  if (lower === "google" || lower === "antigravity") {
    return group("cliproxy-google", "CLIProxy Google", normalized);
  }
  if (lower === "zai") return group("cliproxy-zai", "CLIProxy Z.ai", normalized);
  if (lower === "openrouter")
    return group("cliproxy-openrouter", "CLIProxy OpenRouter", normalized);
  if (lower === "mistral") return group("cliproxy-mistral", "CLIProxy Mistral", normalized);
  if (lower.includes("ollama")) return group("cliproxy-ollama", "CLIProxy Ollama", normalized);

  return group("cliproxy-misc", "CLIProxy Misc", normalized || "unknown");
}

function group(
  provider: string,
  label: string,
  owner: string,
): { provider: string; label: string; owner: string } {
  return { provider, label, owner };
}
