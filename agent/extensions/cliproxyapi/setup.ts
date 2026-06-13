import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  LOGIN_PROVIDER_ID,
  makeCredentials,
  parseCliProxySetupInput,
  type CliProxyCredentials,
} from "./auth.ts";
import type { DiscoveryResult } from "./discovery.ts";
import type { RegistrationReport } from "./providers.ts";

export const DEFAULT_CLI_PROXY_ENDPOINT = "http://127.0.0.1:8317/v1";

export type StoredCliProxyCredentials = CliProxyCredentials & { type: "oauth" };

export function parseSetupArgs(raw: string): { endpoint: string; apiKey: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return parseCliProxySetupInput(trimmed);
}

export function makeStoredCredentials(endpoint: string, apiKey: string): StoredCliProxyCredentials {
  return { type: "oauth", ...makeCredentials(endpoint, apiKey) };
}

export function formatDiscoverySummary(discovery: DiscoveryResult): string {
  if (discovery.groups.length === 0) return "No models discovered.";
  return discovery.groups
    .map((group) => {
      const preview = group.models
        .slice(0, 5)
        .map((model) => model.id)
        .join(", ");
      const suffix = group.models.length > 5 ? `, … ${group.models.length - 5} more` : "";
      return `- ${group.label} (${group.provider}): ${group.models.length} model(s)${preview ? ` — ${preview}${suffix}` : ""}`;
    })
    .join("\n");
}

export function formatSetupSuccess(discovery: DiscoveryResult, report: RegistrationReport): string {
  return [
    "CLIProxyAPI setup complete.",
    `Endpoint: ${discovery.endpoint}`,
    `Registered: ${report.modelCount} model(s) across ${report.providerCount} provider(s).`,
    "",
    "Discovered models:",
    formatDiscoverySummary(discovery),
    "",
    "Next: use /model to choose a CLIProxyAPI model, or /cliproxy-doctor to verify later.",
  ].join("\n");
}

export function saveCliProxyCredentials(
  authPath: string,
  credentials: StoredCliProxyCredentials,
): void {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });

  let auth: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        auth = parsed as Record<string, unknown>;
      } else {
        throw new Error("auth.json must contain a JSON object");
      }
    } catch (error) {
      throw new Error(
        `Could not read existing auth.json: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  auth[LOGIN_PROVIDER_ID] = credentials;
  const tmpPath = `${authPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, authPath);
  chmodSync(authPath, 0o600);
}

export function readCliProxyCredentials(authPath: string): StoredCliProxyCredentials | undefined {
  if (!existsSync(authPath)) return undefined;

  try {
    const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    const value = auth[LOGIN_PROVIDER_ID];
    if (!value || typeof value !== "object") return undefined;
    const credential = value as Partial<StoredCliProxyCredentials>;
    if (
      credential.type !== "oauth" ||
      typeof credential.access !== "string" ||
      typeof credential.endpoint !== "string" ||
      credential.endpoint.length === 0
    ) {
      return undefined;
    }
    return credential as StoredCliProxyCredentials;
  } catch {
    return undefined;
  }
}
