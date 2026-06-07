export interface SandboxConfig {
  enabled: boolean;
  /** Paths to make writable (in addition to cwd and /tmp) */
  writablePaths: string[];
  /** Paths to hide entirely (deny read + write) */
  deniedPaths: string[];
  /** Paths (globs) inside writable areas that should stay read-only */
  writeProtected: string[];
  /** Network restriction — if false, use --share-net */
  restrictNetwork: boolean;
  /** Extra bwrap arguments appended to every invocation */
  extraBwrapArgs: string[];
}

export function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  // IMPORTANT: Arrays are replaced (not concatenated). Global config can replace
  // defaults because it is user-controlled. Project config is merged separately
  // with only-tightening semantics.
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overrides)) {
    const ov = (overrides as Record<string, unknown>)[key];
    if (ov !== undefined) {
      if (Array.isArray(ov)) {
        result[key] = ov;
      } else if (typeof ov === "object" && ov !== null && !Array.isArray(ov)) {
        result[key] = deepMerge(
          ((base as Record<string, unknown>)[key] as Record<string, unknown>) ?? {},
          ov as Record<string, unknown>,
        );
      } else {
        result[key] = ov;
      }
    }
  }
  return result as T;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isSameOrInsidePath(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(`${base}/`);
}

function filterWritablePaths(basePaths: string[], projectPaths: string[]): string[] {
  return projectPaths.filter((candidate) =>
    basePaths.some((base) => isSameOrInsidePath(candidate, base)),
  );
}

export function mergeProjectSandboxConfig(
  base: SandboxConfig,
  project: Partial<SandboxConfig>,
): SandboxConfig {
  const writablePaths = Array.isArray(project.writablePaths)
    ? filterWritablePaths(base.writablePaths, project.writablePaths)
    : base.writablePaths;

  return {
    enabled: base.enabled,
    writablePaths,
    deniedPaths: unique([...base.deniedPaths, ...(project.deniedPaths ?? [])]),
    writeProtected: unique([...base.writeProtected, ...(project.writeProtected ?? [])]),
    restrictNetwork: base.restrictNetwork || project.restrictNetwork === true,
    extraBwrapArgs: base.extraBwrapArgs,
  };
}
