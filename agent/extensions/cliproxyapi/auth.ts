import type { OAuthCredentials } from "@earendil-works/pi-ai";

export const LOGIN_PROVIDER_ID = "cliproxyapi";
export const LOGIN_PROVIDER_NAME = "CLIProxyAPI";

export interface CliProxyCredentials extends OAuthCredentials {
  endpoint: string;
}

export interface CliProxySetupInput {
  endpoint: string;
  apiKey: string;
}

export function isCliProxyCredentials(
  credentials: OAuthCredentials | undefined,
): credentials is CliProxyCredentials {
  return (
    Boolean(credentials) &&
    typeof credentials?.access === "string" &&
    typeof credentials?.endpoint === "string" &&
    credentials.endpoint.length > 0
  );
}

export function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function validateEndpoint(raw: string): string {
  const endpoint = normalizeEndpoint(raw);
  if (!endpoint) throw new Error("Endpoint cannot be empty.");

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Endpoint must be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Endpoint must use http:// or https://.");
  }
  if (!url.pathname.endsWith("/v1")) {
    throw new Error("Endpoint must end with /v1, for example http://127.0.0.1:8317/v1.");
  }
  return endpoint;
}

export function parseCliProxySetupInput(raw: string): CliProxySetupInput {
  const input = raw.trim();
  if (!input) throw new Error("Setup input cannot be empty.");

  if (input.startsWith("{")) {
    return parseJsonSetupInput(input);
  }

  const match = input.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    throw new Error(
      'Usage: /cliproxy-setup <endpoint> <apiKey> or /cliproxy-setup \'{"endpoint":"...","apiKey":"..."}\'.',
    );
  }

  return {
    endpoint: match[1],
    apiKey: match[2],
  };
}

export function makeCredentials(endpoint: string, apiKey: string): CliProxyCredentials {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) throw new Error("API key cannot be empty.");

  return {
    access: trimmedKey,
    refresh: trimmedKey,
    expires: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
    endpoint: validateEndpoint(endpoint),
  };
}

function parseJsonSetupInput(input: string): CliProxySetupInput {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("JSON setup input is invalid.");
  }

  if (!value || typeof value !== "object") {
    throw new Error("JSON setup input must be an object.");
  }

  const object = value as Record<string, unknown>;
  const endpoint = object.endpoint ?? object.baseUrl ?? object.base_url;
  const apiKey = object.apiKey ?? object.api_key ?? object.key ?? object.access;

  if (typeof endpoint !== "string" || typeof apiKey !== "string") {
    throw new Error("JSON setup input must include endpoint and apiKey.");
  }

  return { endpoint, apiKey };
}
