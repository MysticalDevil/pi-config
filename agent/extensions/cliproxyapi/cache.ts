import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { DiscoveredGroup, DiscoveryResult, RawProxyModel } from "./discovery.ts";

const CACHE_VERSION = 1;
const CACHE_FILE = "cliproxyapi-models.json";

interface CachedDiscovery {
  version: typeof CACHE_VERSION;
  endpoint: string;
  savedAt: number;
  totalModels: number;
  groups: DiscoveredGroup[];
}

export function loadCachedDiscovery(): DiscoveryResult | undefined {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(cachePath, "utf-8"));
  } catch {
    return undefined;
  }

  if (!isCachedDiscovery(value)) return undefined;
  return {
    endpoint: value.endpoint,
    totalModels: value.totalModels,
    groups: value.groups,
  };
}

export function saveDiscoveryCache(discovery: DiscoveryResult): void {
  const cachePath = getCachePath();
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  const cached: CachedDiscovery = {
    version: CACHE_VERSION,
    endpoint: discovery.endpoint,
    savedAt: Date.now(),
    totalModels: discovery.totalModels,
    groups: discovery.groups,
  };
  writeFileSync(cachePath, JSON.stringify(cached, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function getCachePath(): string {
  return join(getAgentDir(), CACHE_FILE);
}

function isCachedDiscovery(value: unknown): value is CachedDiscovery {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return (
    object.version === CACHE_VERSION &&
    typeof object.endpoint === "string" &&
    typeof object.savedAt === "number" &&
    typeof object.totalModels === "number" &&
    Array.isArray(object.groups) &&
    object.groups.every(isDiscoveredGroup)
  );
}

function isDiscoveredGroup(value: unknown): value is DiscoveredGroup {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return (
    typeof object.provider === "string" &&
    typeof object.label === "string" &&
    typeof object.owner === "string" &&
    object.api === "openai-completions" &&
    Array.isArray(object.models) &&
    object.models.every(isRawProxyModel)
  );
}

function isRawProxyModel(value: unknown): value is RawProxyModel {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return typeof object.id === "string" && typeof object.ownedBy === "string";
}
