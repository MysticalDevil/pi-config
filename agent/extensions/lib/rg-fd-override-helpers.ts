const FIND_IGNORED_DIRS = [
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "target",
  ".cache",
];

export function buildGrepRgArgs(params: Record<string, unknown>): {
  command: string;
  args: string[];
} {
  const pattern = (params.pattern as string) ?? "";
  const searchPath = (params.path as string) ?? ".";
  const ignoreCase = params.ignoreCase === true;
  const literal = params.literal === true;
  const glob = typeof params.glob === "string" ? params.glob : undefined;

  const args: string[] = ["--no-heading", "--with-filename", "--line-number", "--color=never"];

  if (ignoreCase) args.push("--ignore-case");
  if (literal) args.push("--fixed-strings");
  if (glob) args.push("--glob", glob);

  args.push("--", pattern, searchPath);
  return { command: "rg", args };
}

export function buildGrepSystemArgs(params: Record<string, unknown>): {
  command: string;
  args: string[];
} {
  const pattern = (params.pattern as string) ?? "";
  const searchPath = (params.path as string) ?? ".";
  const ignoreCase = params.ignoreCase === true;
  const literal = params.literal === true;
  const glob = typeof params.glob === "string" ? params.glob : undefined;

  const args: string[] = ["-rnH", "--color=never"];

  if (ignoreCase) args.push("-i");
  if (literal) args.push("-F");
  if (glob) args.push(`--include=${glob}`);

  args.push("--", pattern, searchPath);
  return { command: "grep", args };
}

function splitGlobPattern(pattern: string): { searchPath: string; glob: string } {
  const normalized = pattern.replace(/\\/g, "/");
  const firstGlobIndex = normalized.search(/[*?[{}()]/);
  const splitIndex =
    firstGlobIndex === -1
      ? normalized.lastIndexOf("/")
      : normalized.slice(0, firstGlobIndex).lastIndexOf("/");

  if (splitIndex <= 0) {
    return { searchPath: ".", glob: normalized };
  }

  return {
    searchPath: normalized.slice(0, splitIndex),
    glob: normalized.slice(splitIndex + 1),
  };
}

export function buildFindFdArgs(params: Record<string, unknown>): {
  command: string;
  args: string[];
} {
  const pattern = (params.pattern as string) ?? "*";
  const explicitPath = typeof params.path === "string" ? params.path : undefined;
  const split = splitGlobPattern(pattern);
  const searchPath = explicitPath ?? split.searchPath;
  const glob = explicitPath ? pattern : split.glob;

  const args: string[] = ["--type", "f", "--glob", glob, searchPath];

  return { command: "fd", args };
}

export function buildFindSystemArgs(params: Record<string, unknown>): {
  command: string;
  args: string[];
} {
  const pattern = (params.pattern as string) ?? "*";
  const explicitPath = typeof params.path === "string" ? params.path : undefined;
  const split = splitGlobPattern(pattern);
  const searchPath = explicitPath ?? split.searchPath;
  const glob = explicitPath ? pattern : split.glob;

  const pruneArgs = FIND_IGNORED_DIRS.flatMap((dir, index) =>
    index === 0 ? ["(", "-name", dir] : ["-o", "-name", dir],
  );

  const matcher = glob.includes("/") ? ["-path", `*/${glob}`] : ["-name", glob];

  return {
    command: "find",
    args: [searchPath, ...pruneArgs, ")", "-prune", "-o", "-type", "f", ...matcher, "-print"],
  };
}
