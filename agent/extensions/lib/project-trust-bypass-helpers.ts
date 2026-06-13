const TRUST_APPROVE_FLAGS = new Set(["--approve", "-a"]);

const TRUST_BYPASS_FLAGS = new Set(["--no-approve", "-na"]);

const AGENT_RUN_FLAGS = new Set([
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--mode",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
]);

const VALUE_TAKING_FLAGS = new Set([
  "--append-system-prompt",
  "--api-key",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--list-models",
  "--model",
  "--models",
  "--name",
  "-n",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
]);

const VALUE_TAKING_AGENT_RUN_FLAGS = new Set(["--export", "--fork", "--mode", "--session"]);

const FLAG_ALIASES_WITH_INLINE_VALUE = [
  "--append-system-prompt=",
  "--api-key=",
  "--exclude-tools=",
  "--extension=",
  "--fork=",
  "--list-models=",
  "--mode=",
  "--model=",
  "--models=",
  "--name=",
  "--provider=",
  "--session=",
  "--session-dir=",
  "--skill=",
  "--system-prompt=",
  "--theme=",
  "--thinking=",
  "--tools=",
];

const AGENT_RUN_INLINE_VALUE_PREFIXES = new Set(["--export=", "--fork=", "--mode=", "--session="]);

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function stripExecutablePrefix(argv: readonly string[]): string[] {
  const args = [...argv];
  if (args.length === 0) return args;

  const first = basename(args[0] ?? "");
  if (["node", "nodejs", "bun", "pi"].includes(first) || first.startsWith("pi-")) {
    args.shift();
  }

  const second = basename(args[0] ?? "");
  if (/\.(?:[cm]?[jt]s)$/.test(second) || second === "pi") {
    args.shift();
  }

  return args;
}

function isInlineValueFlag(arg: string): boolean {
  return FLAG_ALIASES_WITH_INLINE_VALUE.some((prefix) => arg.startsWith(prefix));
}

function isAgentRunInlineValueFlag(arg: string): boolean {
  for (const prefix of AGENT_RUN_INLINE_VALUE_PREFIXES) {
    if (arg.startsWith(prefix)) return true;
  }
  return false;
}

function commandArgs(argv: readonly string[]): string[] | undefined {
  const args = stripExecutablePrefix(argv);
  const result: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (AGENT_RUN_FLAGS.has(arg) || isAgentRunInlineValueFlag(arg)) {
      return undefined;
    }

    if (VALUE_TAKING_AGENT_RUN_FLAGS.has(arg)) {
      return undefined;
    }

    if (VALUE_TAKING_FLAGS.has(arg)) {
      i++;
      continue;
    }

    if (isInlineValueFlag(arg)) {
      continue;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    if (arg.startsWith("@")) {
      return undefined;
    }

    result.push(arg);
  }

  return result;
}

export function hasExplicitTrustApproval(argv: readonly string[]): boolean {
  return argv.some((arg) => TRUST_APPROVE_FLAGS.has(arg));
}

export function hasExplicitTrustBypass(argv: readonly string[]): boolean {
  return argv.some((arg) => TRUST_BYPASS_FLAGS.has(arg));
}

export function getPiSubcommand(argv: readonly string[]): string | undefined {
  return commandArgs(argv)?.[0];
}

function hasUpdateSelfFlag(argv: readonly string[]): boolean {
  const args = stripExecutablePrefix(argv);
  let updateCommandSeen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (AGENT_RUN_FLAGS.has(arg) || isAgentRunInlineValueFlag(arg)) {
      return false;
    }

    if (VALUE_TAKING_AGENT_RUN_FLAGS.has(arg)) {
      return false;
    }

    if (VALUE_TAKING_FLAGS.has(arg)) {
      i++;
      continue;
    }

    if (isInlineValueFlag(arg)) {
      continue;
    }

    if (arg.startsWith("@")) {
      return false;
    }

    if (arg.startsWith("-")) {
      if (updateCommandSeen && arg === "--self") return true;
      continue;
    }

    if (!updateCommandSeen) {
      if (arg !== "update") return false;
      updateCommandSeen = true;
    }
  }

  return false;
}

export function getPiUpdateTarget(argv: readonly string[]): string | undefined {
  const args = commandArgs(argv);
  if (!args || args[0] !== "update") return undefined;
  if (hasUpdateSelfFlag(argv)) return "self";
  return args[1];
}

export function isPiSelfUpdateCommand(argv: readonly string[]): boolean {
  const target = getPiUpdateTarget(argv);
  return target === "self" || target === "pi";
}

export function isProjectIndependentCliCommand(argv: readonly string[]): boolean {
  return isPiSelfUpdateCommand(argv);
}

export function shouldDeclineProjectTrustForCliCommand(argv: readonly string[]): boolean {
  return (
    isProjectIndependentCliCommand(argv) &&
    !hasExplicitTrustApproval(argv) &&
    !hasExplicitTrustBypass(argv)
  );
}
