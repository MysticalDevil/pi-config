export type TodoCommandAction = "create" | "update" | "list" | "get" | "delete" | "clear" | "help";

export interface ParsedTodoCommand {
  action: TodoCommandAction;
  params: Record<string, unknown>;
  confirm: boolean;
  errors: string[];
}

function parseId(raw: string | undefined, action: string): { id?: number; error?: string } {
  if (!raw) return { error: `id required for ${action}` };
  const cleaned = raw.replace(/^#/, "");
  const id = Number(cleaned);
  if (!Number.isInteger(id) || id <= 0) return { error: `invalid id for ${action}: ${raw}` };
  return { id };
}

function stripConfirmFlags(tokens: string[]): { tokens: string[]; confirm: boolean } {
  let confirm = false;
  const filtered = tokens.filter((token) => {
    if (token === "--yes" || token === "-y") {
      confirm = true;
      return false;
    }
    return true;
  });
  return { tokens: filtered, confirm };
}

export function parseTodoCommandArgs(args: string): ParsedTodoCommand {
  const rawTokens = args.trim().split(/\s+/).filter(Boolean);
  const { tokens, confirm } = stripConfirmFlags(rawTokens);
  const verb = (tokens[0] ?? "list").toLowerCase();
  const rest = tokens.slice(1);
  const errors: string[] = [];

  if (verb === "help" || verb === "--help" || verb === "-h") {
    return { action: "help", params: {}, confirm, errors };
  }

  if (verb === "list" || verb === "ls" || verb === "show") {
    if (rest[0]?.startsWith("#") || /^\d+$/.test(rest[0] ?? "")) {
      const parsed = parseId(rest[0], "get");
      if (parsed.error) errors.push(parsed.error);
      return { action: "get", params: { id: parsed.id }, confirm, errors };
    }
    const status = rest[0];
    const params: Record<string, unknown> = {};
    if (status && ["pending", "in_progress", "completed", "deleted"].includes(status)) {
      params.status = status;
    }
    if (rest.includes("--all") || rest.includes("--deleted")) params.includeDeleted = true;
    return { action: "list", params, confirm, errors };
  }

  if (verb === "add" || verb === "create") {
    const subject = rest.join(" ").trim();
    if (!subject) errors.push("subject required for create");
    return { action: "create", params: { subject }, confirm, errors };
  }

  if (verb === "get") {
    const parsed = parseId(rest[0], "get");
    if (parsed.error) errors.push(parsed.error);
    return { action: "get", params: { id: parsed.id }, confirm, errors };
  }

  if (verb === "start" || verb === "progress" || verb === "in-progress") {
    const parsed = parseId(rest[0], verb);
    if (parsed.error) errors.push(parsed.error);
    return { action: "update", params: { id: parsed.id, status: "in_progress" }, confirm, errors };
  }

  if (verb === "done" || verb === "complete" || verb === "completed") {
    const parsed = parseId(rest[0], verb);
    if (parsed.error) errors.push(parsed.error);
    return { action: "update", params: { id: parsed.id, status: "completed" }, confirm, errors };
  }

  if (verb === "reopen" || verb === "pending") {
    const parsed = parseId(rest[0], verb);
    if (parsed.error) errors.push(parsed.error);
    return { action: "update", params: { id: parsed.id, status: "pending" }, confirm, errors };
  }

  if (verb === "delete" || verb === "del" || verb === "rm") {
    const parsed = parseId(rest[0], verb);
    if (parsed.error) errors.push(parsed.error);
    return { action: "delete", params: { id: parsed.id }, confirm, errors };
  }

  if (verb === "clear") {
    return { action: "clear", params: {}, confirm, errors };
  }

  return {
    action: "help",
    params: {},
    confirm,
    errors: [`unknown /todo action: ${verb}`],
  };
}

export function todoCommandHelp(): string {
  return [
    "Usage: /todo [command]",
    "",
    "Commands:",
    "  /todo                         List active todos",
    "  /todo list [status] [--all]   List todos, optionally filtered",
    "  /todo add <subject>           Create a todo",
    "  /todo get <id>                Show one todo",
    "  /todo start <id>              Mark in progress",
    "  /todo done <id>               Mark completed",
    "  /todo reopen <id>             Move back to pending",
    "  /todo delete <id>             Tombstone one todo",
    "  /todo clear [--yes]           Clear all todos",
  ].join("\n");
}
