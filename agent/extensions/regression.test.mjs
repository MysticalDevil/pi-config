import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

const addContext = await import("./add-context.ts");
const cost = await import("./cost.ts");
const init = await import("./init.ts");
const planMode = await import("./plan-mode/utils.ts");
const extensionsCmd = await import("./lib/extensions-cmd-helpers.ts");
const fileWatcher = await import("./file-watcher.ts");
const reviewMode = await import("./lib/review-mode-helpers.ts");
const todoCommand = await import("./lib/todo-command-helpers.ts");
const askDialogHelpers = await import("./ask-user-question/dialog-helpers.ts");
const askResponse = await import("./ask-user-question/response.ts");
const discovery = await import("./cliproxyapi/discovery.ts");
const cliproxySetup = await import("./cliproxyapi/setup.ts");
const execpolicy = await import("./sandbox/execpolicy.ts");
const sandboxConfig = await import("./sandbox/config-helpers.ts");
const sandboxHooks = await import("./sandbox/hooks.ts");
const guardianCircuit = await import("./sandbox/guardian-circuit-helpers.ts");
const projectTrustBypass = await import("./lib/project-trust-bypass-helpers.ts");

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

test("project trust bypass detects documented self-update commands", () => {
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "update", "--self"]),
    true,
  );
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "update", "self"]),
    true,
  );
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "update", "pi", "--force"]),
    true,
  );
});

test("project trust bypass keeps package commands explicit", () => {
  assert.equal(projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "update"]), false);
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "update", "--extensions"]),
    false,
  );
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "update", "npm:foo"]),
    false,
  );
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "install", "npm:foo"]),
    false,
  );
  assert.equal(projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "list"]), false);
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand([
      "pi",
      "update",
      "--self",
      "--approve",
    ]),
    false,
  );
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand(["pi", "-p", "update"]),
    false,
  );
  assert.equal(
    projectTrustBypass.shouldDeclineProjectTrustForCliCommand([
      "pi",
      "--model",
      "--self",
      "update",
      "package",
    ]),
    false,
  );
});

test("CLIProxyAPI discovery timeout covers response body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, requestInit) => {
    assert.equal(requestInit.signal.aborted, false);
    return {
      ok: true,
      async json() {
        return await new Promise(() => {});
      },
    };
  };

  try {
    await assert.rejects(
      () => discovery.discoverModels("http://127.0.0.1:8317/v1", "test-key", 5),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLIProxyAPI setup parses args and keeps secrets out of success text", () => {
  assert.deepEqual(cliproxySetup.parseSetupArgs("http://127.0.0.1:8317/v1 sk-test"), {
    endpoint: "http://127.0.0.1:8317/v1",
    apiKey: "sk-test",
  });
  assert.deepEqual(
    cliproxySetup.parseSetupArgs(
      '{"endpoint":"http://127.0.0.1:8317/v1","apiKey":"super-secret-key"}',
    ),
    {
      endpoint: "http://127.0.0.1:8317/v1",
      apiKey: "super-secret-key",
    },
  );
  assert.equal(cliproxySetup.parseSetupArgs(""), undefined);

  const discoveryResult = {
    endpoint: "http://127.0.0.1:8317/v1",
    totalModels: 1,
    groups: [
      {
        provider: "cliproxy-openai",
        label: "CLIProxy OpenAI",
        owner: "openai",
        api: "openai-completions",
        models: [{ id: "gpt-test", ownedBy: "openai" }],
      },
    ],
  };
  const text = cliproxySetup.formatSetupSuccess(discoveryResult, {
    providerCount: 1,
    modelCount: 1,
    providers: [{ provider: "cliproxy-openai", modelCount: 1 }],
  });

  assert.equal(text.includes("gpt-test"), true);
  assert.equal(text.includes("super-secret-key"), false);
});

test("extension names reject path traversal and separators", () => {
  assert.equal(extensionsCmd.isSafeExtensionName("dirty-repo-guard"), true);
  assert.equal(extensionsCmd.isSafeExtensionName("../dirty-repo-guard"), false);
  assert.equal(extensionsCmd.isSafeExtensionName("dir/plugin"), false);
  assert.equal(extensionsCmd.isSafeExtensionName(".hidden"), false);
});

test("extension sorting preserves project/global duplicates", () => {
  const sorted = extensionsCmd.sortExtensionEntries([
    { name: "todo", source: "project" },
    { name: "todo", source: "global" },
  ]);

  assert.deepEqual(sorted, [
    { name: "todo", source: "global" },
    { name: "todo", source: "project" },
  ]);
});

test("plan mode enables the installed ask_user_question tool", () => {
  assert.equal(planMode.PLAN_MODE_TOOLS.includes("ask_user_question"), true);
  assert.equal(planMode.PLAN_MODE_TOOLS.includes("questionnaire"), false);
});

test("file watcher ignores pi session state paths", () => {
  assert.equal(fileWatcher.shouldIgnoreWatcherPath("agent/sessions/abc.jsonl"), true);
  assert.equal(fileWatcher.shouldIgnoreWatcherPath("agent/sessions/nested/abc.jsonl"), true);
  assert.equal(fileWatcher.shouldIgnoreWatcherPath("agent/extensions/file-watcher.ts"), false);
});

test("cost extension reads official pi usage fields", () => {
  const stats = cost.getAssistantUsageStats({
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-5.5",
    responseModel: "gpt-5.5-2026-06-01",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
    },
  });

  assert.deepEqual(stats, {
    model: "gpt-5.5-2026-06-01",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    cost: 0.37,
  });
});

test("todo command parses create and clear confirmation", () => {
  assert.deepEqual(todoCommand.parseTodoCommandArgs("add ship feature"), {
    action: "create",
    params: { subject: "ship feature" },
    confirm: false,
    errors: [],
  });
  assert.deepEqual(todoCommand.parseTodoCommandArgs("clear --yes"), {
    action: "clear",
    params: {},
    confirm: true,
    errors: [],
  });
});

test("todo command parses status aliases", () => {
  assert.deepEqual(todoCommand.parseTodoCommandArgs("start #3"), {
    action: "update",
    params: { id: 3, status: "in_progress" },
    confirm: false,
    errors: [],
  });
  assert.deepEqual(todoCommand.parseTodoCommandArgs("done 3"), {
    action: "update",
    params: { id: 3, status: "completed" },
    confirm: false,
    errors: [],
  });
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

test("review commit git add args terminate options before file names", () => {
  assert.deepEqual(reviewMode.buildGitAddArgs(["-A", "src/file.ts"]), [
    "add",
    "--",
    "-A",
    "src/file.ts",
  ]);
});

test("execpolicy evaluates shell operators without surrounding whitespace", () => {
  const policy = {
    rules: [{ pattern: ["rm", ["-rf", "-r", "--recursive"]], decision: "prompt" }],
    bannedPrefixes: [["python3"], ["python"]],
  };

  assert.equal(
    execpolicy.evaluateCommand("echo ok;rm -rf tmp", policy).evaluation.decision,
    "prompt",
  );
  assert.deepEqual(execpolicy.evaluateCommand("true&&python3 -c 'print(1)'", policy).bannedBy, [
    "python3",
  ]);
});

test("execpolicy catches common dangerous command variants", () => {
  const policy = {
    rules: [
      {
        pattern: ["rm"],
        anyTokenRegex: ["^-[^-]*[rR][^-]*$", "^--recursive$"],
        decision: "prompt",
      },
      { pattern: ["chmod"], anyTokenRegex: ["^777$"], decision: "prompt" },
      {
        pattern: ["git", "push"],
        anyTokenRegex: ["^-f$", "^--force(?:-with-lease)?(?:=.*)?$"],
        decision: "prompt",
      },
      { pattern: ["dd"], anyTokenRegex: ["^(?:if|of)=/dev/"], decision: "forbidden" },
    ],
    bannedPrefixes: [],
  };

  assert.equal(execpolicy.evaluateCommand("rm -fr repo", policy).evaluation.decision, "prompt");
  assert.equal(execpolicy.evaluateCommand("chmod 777 file", policy).evaluation.decision, "prompt");
  assert.equal(
    execpolicy.evaluateCommand("git push origin main --force", policy).evaluation.decision,
    "prompt",
  );
  assert.equal(
    execpolicy.evaluateCommand("dd if=/dev/sda of=backup.img", policy).evaluation.decision,
    "forbidden",
  );
});

test("project sandbox config can only tighten global config", () => {
  const merged = sandboxConfig.mergeProjectSandboxConfig(
    {
      enabled: true,
      writablePaths: ["/home/me/.cache", "/home/me/.local"],
      deniedPaths: ["/home/me/.ssh"],
      writeProtected: [".env"],
      restrictNetwork: true,
      extraBwrapArgs: ["--ro-bind", "/safe", "/safe"],
    },
    {
      enabled: false,
      writablePaths: [
        "/home/me/.cache/project",
        "/home/me/.cache/../../escape",
        "/home/me/.cache2/project",
        "/etc",
      ],
      deniedPaths: ["/home/me/.aws"],
      writeProtected: ["*.pem"],
      restrictNetwork: false,
      extraBwrapArgs: ["--bind", "/", "/host"],
    },
  );

  assert.deepEqual(merged, {
    enabled: true,
    writablePaths: ["/home/me/.cache/project"],
    deniedPaths: ["/home/me/.ssh", "/home/me/.aws"],
    writeProtected: [".env", "*.pem"],
    restrictNetwork: true,
    extraBwrapArgs: ["--ro-bind", "/safe", "/safe"],
  });
});

test("pre-tool hooks fail closed only when configured", async () => {
  const registry = new sandboxHooks.HookRegistry();
  registry.register({
    hookType: "pre",
    name: "legacy-open",
    async handler() {
      throw new Error("open failure");
    },
  });
  assert.equal((await registry.runPreToolUse("bash", {})).blocked, false);

  registry.register({
    hookType: "pre",
    name: "security-closed",
    failureMode: "closed",
    async handler() {
      throw new Error("closed failure");
    },
  });
  const result = await registry.runPreToolUse("bash", {});
  assert.equal(result.blocked, true);
  assert.equal(result.reason.includes("security-closed"), true);
});

test("guardian denial circuit breaker interrupts repeated denials", () => {
  const circuitBreaker = new guardianCircuit.GuardianDenialCircuitBreaker();

  assert.deepEqual(circuitBreaker.recordDenial(), { action: "continue" });
  assert.deepEqual(circuitBreaker.recordDenial(), { action: "continue" });
  assert.deepEqual(circuitBreaker.recordDenial(), {
    action: "interrupt",
    consecutiveDenials: 3,
    recentDenials: 3,
  });
  assert.equal(circuitBreaker.isInterrupted(), true);
});

test("guardian denial circuit breaker resets consecutive denials on non-denial", () => {
  const circuitBreaker = new guardianCircuit.GuardianDenialCircuitBreaker();

  circuitBreaker.recordDenial();
  circuitBreaker.recordDenial();
  circuitBreaker.recordNonDenial();

  assert.deepEqual(circuitBreaker.recordDenial(), { action: "continue" });
  assert.equal(circuitBreaker.isInterrupted(), false);
});

test("guardian denial counting ignores timeout and parsing failures", () => {
  assert.equal(guardianCircuit.shouldCountGuardianDenial("Guardian timed out"), false);
  assert.equal(
    guardianCircuit.shouldCountGuardianDenial("Guardian returned non-JSON output"),
    false,
  );
  assert.equal(guardianCircuit.shouldCountGuardianDenial("critical destructive action"), true);
});

test("ask_user_question custom row is suppressed when previews are present", () => {
  const withPreview = {
    question: "Choose?",
    header: "Choice",
    options: [
      { label: "A", description: "A", preview: "preview A" },
      { label: "B", description: "B" },
    ],
  };
  const withoutPreview = {
    question: "Choose?",
    header: "Choice",
    options: [
      { label: "A", description: "A" },
      { label: "B", description: "B" },
    ],
  };

  assert.equal(askDialogHelpers.shouldShowCustomRow(withPreview), false);
  assert.equal(askDialogHelpers.shouldShowCustomRow(withoutPreview), true);
});

test("ask_user_question submit tab adds one extra tab", () => {
  assert.equal(askDialogHelpers.totalDialogTabs(2, true), 3);
  assert.equal(askDialogHelpers.totalDialogTabs(2, false), 2);
});

test("ask_user_question recognizes Ctrl+] collapse toggle", () => {
  assert.equal(askDialogHelpers.isCollapseToggle("\x1d"), true);
  assert.equal(askDialogHelpers.isCollapseToggle("\t"), false);
});

test("ask_user_question response includes notes", () => {
  const result = askResponse.buildResponse({
    cancelled: false,
    answers: [
      {
        questionIndex: 0,
        question: "Choose?",
        kind: "option",
        answer: "A",
        notes: "remember this",
        preview: "preview A",
      },
    ],
  });

  assert.equal(result.content[0].text.includes("note: remember this"), true);
  assert.equal(result.details.cancelled, false);
});

test("init args parse empty, force, and help flags", () => {
  assert.deepEqual(init.parseInitArgs(""), { force: false, help: false, errors: [] });
  assert.deepEqual(init.parseInitArgs("--force"), { force: true, help: false, errors: [] });
  assert.deepEqual(init.parseInitArgs("-f --help"), { force: true, help: true, errors: [] });
});

test("init args report unknown options", () => {
  assert.deepEqual(init.parseInitArgs("--preview"), {
    force: false,
    help: false,
    errors: ["Unknown option: --preview"],
  });
});

test("init prompt targets AGENTS.md and preserves existing guidance", () => {
  const prompt = init.buildInitPrompt("/workspace/project", true);

  assert.equal(prompt.includes("Improve the existing `AGENTS.md`"), true);
  assert.equal(prompt.includes("`/workspace/project/AGENTS.md`"), true);
  assert.equal(prompt.includes("Preserve verified useful guidance"), true);
});

test("init prompt creates a new AGENTS.md when missing", () => {
  const prompt = init.buildInitPrompt("/workspace/project", false);

  assert.equal(prompt.includes("Create a new `AGENTS.md`"), true);
  assert.equal(prompt.includes("Improve the existing `AGENTS.md`"), false);
});
