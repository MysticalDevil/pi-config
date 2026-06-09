import type { OAuthCredentials } from "@earendil-works/pi-ai";

export const LOGIN_PROVIDER_ID = "cliproxyapi";
export const LOGIN_PROVIDER_NAME = "CLIProxyAPI";

export interface CliProxyCredentials extends OAuthCredentials {
  endpoint: string;
}

export interface CliProxyLoginInput {
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

export function parseLoginInput(raw: string): CliProxyLoginInput {
  const input = raw.trim();
  if (!input) throw new Error("Login input cannot be empty.");

  if (input.startsWith("{")) {
    return parseJsonLoginInput(input);
  }

  const match = input.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    throw new Error("Enter both endpoint and API key, separated by a space.");
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

function parseJsonLoginInput(input: string): CliProxyLoginInput {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("JSON login input is invalid.");
  }

  if (!value || typeof value !== "object") {
    throw new Error("JSON login input must be an object.");
  }

  const object = value as Record<string, unknown>;
  const endpoint = object.endpoint ?? object.baseUrl ?? object.base_url;
  const apiKey = object.apiKey ?? object.api_key ?? object.key ?? object.access;

  if (typeof endpoint !== "string" || typeof apiKey !== "string") {
    throw new Error("JSON login input must include endpoint and apiKey.");
  }

  return { endpoint, apiKey };
}
