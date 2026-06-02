import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

const addContext = await import("./add-context.ts");
const extensionsCmd = await import("./lib/extensions-cmd-helpers.ts");
const rgFdOverride = await import("./lib/rg-fd-override-helpers.ts");
const reviewMode = await import("./lib/review-mode-helpers.ts");

test("resolveWorkspacePath rejects paths outside cwd", () => {
  const cwd = "/workspace/project";

  assert.equal(
    addContext.resolveWorkspacePath(cwd, "src/index.ts"),
    "/workspace/project/src/index.ts",
  );
  assert.equal(addContext.resolveWorkspacePath(cwd, "../secret.txt"), undefined);
  assert.equal(addContext.resolveWorkspacePath(cwd, "/etc/passwd"), undefined);
});

test("isPathWithin respects path segment boundaries", () => {
  const base = path.resolve("/workspace/project/src/foo");

  assert.equal(
    addContext.isPathWithin(path.resolve("/workspace/project/src/foo/bar.ts"), base),
    true,
  );
  assert.equal(addContext.isPathWithin(path.resolve("/workspace/project/src/foo"), base), true);
  assert.equal(
    addContext.isPathWithin(path.resolve("/workspace/project/src/foobar.ts"), base),
    false,
  );
});

test("removeContextEntries removes every entry under a directory", () => {
  const cwd = "/workspace/project";
  const entries = [
    { path: "/workspace/project/src/foo/a.ts", type: "file", addedAt: 1 },
    { path: "/workspace/project/src/foo/nested/b.ts", type: "file", addedAt: 2 },
    { path: "/workspace/project/src/foobar.ts", type: "file", addedAt: 3 },
  ];

  const result = addContext.removeContextEntries(entries, cwd, "src/foo");

  assert.deepEqual(
    result.removed.map((entry) => entry.path),
    ["/workspace/project/src/foo/a.ts", "/workspace/project/src/foo/nested/b.ts"],
  );
  assert.deepEqual(
    result.remaining.map((entry) => entry.path),
    ["/workspace/project/src/foobar.ts"],
  );
});

test("fd find args split path-qualified globs into search path and basename pattern", () => {
  assert.deepEqual(rgFdOverride.buildFindFdArgs({ pattern: "agent/extensions/*.ts" }), {
    command: "fd",
    args: ["--type", "f", "--glob", "*.ts", "agent/extensions"],
  });
});

test("fd find args keep leading globstar patterns rooted at the requested path", () => {
  assert.deepEqual(rgFdOverride.buildFindFdArgs({ pattern: "**/*.json" }), {
    command: "fd",
    args: ["--type", "f", "--glob", "**/*.json", "."],
  });
});

test("system find fallback excludes common ignored directories", () => {
  const built = rgFdOverride.buildFindSystemArgs({ pattern: "*.ts", path: "." });

  assert.equal(built.command, "find");
  assert.ok(built.args.includes("node_modules"));
  assert.ok(built.args.includes("-prune"));
  assert.ok(built.args.includes("-name"));
  assert.ok(built.args.includes("*.ts"));
});

test("system find fallback uses path matching for slash-containing globs", () => {
  const built = rgFdOverride.buildFindSystemArgs({ pattern: "**/*.json", path: "." });

  assert.ok(built.args.includes("-path"));
  assert.ok(built.args.includes("*/**/*.json"));
});

test("extension names reject path traversal and separators", () => {
  assert.equal(extensionsCmd.isSafeExtensionName("dirty-repo-guard"), true);
  assert.equal(extensionsCmd.isSafeExtensionName("../dirty-repo-guard"), false);
  assert.equal(extensionsCmd.isSafeExtensionName("dir/plugin"), false);
  assert.equal(extensionsCmd.isSafeExtensionName(".hidden"), false);
});

test("review revert paths stay inside repository", () => {
  const cwd = "/workspace/project";

  assert.equal(
    reviewMode.resolveRepoFilePath(cwd, "src/file.ts"),
    "/workspace/project/src/file.ts",
  );
  assert.equal(reviewMode.resolveRepoFilePath(cwd, "../file.ts"), undefined);
  assert.equal(reviewMode.resolveRepoFilePath(cwd, "/etc/passwd"), undefined);
});
