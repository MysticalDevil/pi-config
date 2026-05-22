/**
 * Shared utilities for extensions
 */

/** Parse a git status line like " M path/to/file" */
export function parseStatusLine(line: string): { status: string; file: string } | null {
  if (line.length < 4) return null;
  const status = line.slice(0, 2);
  let file = line.slice(3).trim();
  if (!file) return null;
  const renameArrow = file.indexOf(" -> ");
  if (renameArrow >= 0) {
    file = file.slice(renameArrow + 4).trim();
  }
  return { status, file };
}
