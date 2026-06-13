export interface ExtensionInfoLike {
  name: string;
  source: string;
}

export function isSafeExtensionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

export function sortExtensionEntries<T extends ExtensionInfoLike>(entries: T[]): T[] {
  return [...entries].sort(
    (a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
  );
}
