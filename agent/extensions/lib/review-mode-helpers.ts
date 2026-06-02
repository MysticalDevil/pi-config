import * as path from "node:path";

export function resolveRepoFilePath(cwd: string, file: string): string | undefined {
  if (path.isAbsolute(file)) return undefined;

  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(resolvedCwd, file);
  const relative = path.relative(resolvedCwd, resolvedFile);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  return resolvedFile;
}
