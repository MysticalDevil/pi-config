/**
 * Todo Extension — Task tracking with 4-state lifecycle, dependency graph,
 * live overlay widget, and branch replay persistence.
 *
 * Based on design patterns from @juicesharp/rpiv-todo.
 *
 * Tool: todo
 *   create  — new task with optional blockedBy, description, owner
 *   update  — modify status/description/owner/blockedBy
 *   list    — list tasks, optionally filtered by status
 *   get     — fetch a single task by id
 *   delete  — tombstone a task (keeps historic blockedBy references)
 *   clear   — remove all tasks
 *
 * Commands:
 *   /todo  — manage tasks from the slash command line
 *   /todos — show interactive task list grouped by status
 *
 * Widget: overlay above editor showing pending/in_progress tasks
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseTodoCommandArgs, todoCommandHelp } from "./lib/todo-command-helpers";

// ── Types ─────────────────────────────────────────────────────────────

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

interface Task {
  id: number;
  subject: string;
  description?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
}

interface TaskDetails {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
}

interface AppState {
  tasks: Task[];
  nextId: number;
}

// ── Status transitions ────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
};

function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || VALID_TRANSITIONS[from].has(to);
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "done",
  deleted: "deleted",
};

// ── Cycle detection for blockedBy ─────────────────────────────────────

function detectCycle(allTasks: Task[], newTaskId: number, blockedBy: number[]): boolean {
  const graph = new Map<number, number[]>();
  for (const t of allTasks) {
    graph.set(t.id, t.blockedBy ?? []);
  }
  graph.set(newTaskId, blockedBy);

  const visited = new Set<number>();
  const inStack = new Set<number>();

  function dfs(id: number): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (dfs(dep)) return true;
    }
    inStack.delete(id);
    return false;
  }

  for (const id of graph.keys()) {
    if (dfs(id)) return true;
  }
  return false;
}

// ── State management ──────────────────────────────────────────────────

function createEmptyState(): AppState {
  return { tasks: [], nextId: 1 };
}

function applyMutation(
  state: AppState,
  action: TaskAction,
  params: Record<string, unknown>,
): {
  state: AppState;
  error?: string;
  op?: Record<string, unknown>;
} {
  switch (action) {
    case "create": {
      const subject = typeof params.subject === "string" ? params.subject.trim() : "";
      if (!subject) return { state, error: "subject required for create" };

      const blockedBy = Array.isArray(params.blockedBy)
        ? (params.blockedBy as number[]).filter((n) => typeof n === "number")
        : [];
      for (const dep of blockedBy) {
        const depTask = state.tasks.find((t) => t.id === dep);
        if (!depTask) return { state, error: `blockedBy: #${dep} not found` };
        if (depTask.status === "deleted") return { state, error: `blockedBy: #${dep} is deleted` };
      }

      const newTask: Task = {
        id: state.nextId,
        subject,
        status: "pending",
      };
      if (typeof params.description === "string" && params.description.trim()) {
        newTask.description = params.description.trim();
      }
      if (blockedBy.length) newTask.blockedBy = [...blockedBy];
      if (typeof params.owner === "string" && params.owner.trim()) {
        newTask.owner = params.owner.trim();
      }

      return {
        state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
        op: { kind: "create", taskId: newTask.id },
      };
    }

    case "update": {
      const id = typeof params.id === "number" ? params.id : undefined;
      if (id === undefined) return { state, error: "id required for update" };

      const idx = state.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return { state, error: `#${id} not found` };

      const current = state.tasks[idx];
      let newStatus = current.status;

      if (typeof params.status === "string" && isTaskStatus(params.status)) {
        if (!isTransitionValid(current.status, params.status)) {
          return { state, error: `illegal transition ${current.status} → ${params.status}` };
        }
        newStatus = params.status;
      }

      // blockedBy merge
      let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
      const removeBlockedBy = toIdArray(params.removeBlockedBy);
      const addBlockedBy = toIdArray(params.addBlockedBy);
      if (removeBlockedBy.length) {
        const toRemove = new Set(removeBlockedBy);
        newBlockedBy = newBlockedBy.filter((d) => !toRemove.has(d));
      }
      if (addBlockedBy.length) {
        for (const dep of addBlockedBy) {
          if (dep === current.id) return { state, error: `cannot block #${id} on itself` };
          const depTask = state.tasks.find((t) => t.id === dep);
          if (!depTask) return { state, error: `addBlockedBy: #${dep} not found` };
          if (depTask.status === "deleted")
            return { state, error: `addBlockedBy: #${dep} is deleted` };
          if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
        }
        if (detectCycle(state.tasks, current.id, newBlockedBy)) {
          return { state, error: "addBlockedBy would create a cycle" };
        }
      }

      const updated: Task = { ...current, status: newStatus };
      if (typeof params.subject === "string" && params.subject.trim())
        updated.subject = params.subject.trim();
      if (typeof params.description === "string")
        updated.description = params.description.trim() || undefined;
      if (typeof params.owner === "string") updated.owner = params.owner.trim() || undefined;
      if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
      else delete updated.blockedBy;

      const tasks = [...state.tasks];
      tasks[idx] = updated;
      return {
        state: { tasks, nextId: state.nextId },
        op: { kind: "update", id, fromStatus: current.status, toStatus: newStatus },
      };
    }

    case "list":
      return { state, op: { kind: "list", includeDeleted: params.includeDeleted === true } };

    case "get": {
      const id = typeof params.id === "number" ? params.id : undefined;
      if (id === undefined) return { state, error: "id required for get" };
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return { state, error: `#${id} not found` };
      return { state, op: { kind: "get", task } };
    }

    case "delete": {
      const id = typeof params.id === "number" ? params.id : undefined;
      if (id === undefined) return { state, error: "id required for delete" };
      const idx = state.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return { state, error: `#${id} not found` };
      if (state.tasks[idx].status === "deleted")
        return { state, error: `#${id} is already deleted` };
      const tasks = [...state.tasks];
      tasks[idx] = { ...tasks[idx], status: "deleted" };
      return {
        state: { tasks, nextId: state.nextId },
        op: { kind: "delete", id, subject: state.tasks[idx].subject },
      };
    }

    case "clear": {
      const count = state.tasks.length;
      return { state: { tasks: [], nextId: 1 }, op: { kind: "clear", count } };
    }
  }
}

function toIdArray(raw: unknown): number[] {
  return Array.isArray(raw) ? (raw as number[]).filter((n) => typeof n === "number") : [];
}

function isTaskStatus(s: string): s is TaskStatus {
  return s === "pending" || s === "in_progress" || s === "completed" || s === "deleted";
}

// ── Response formatting ───────────────────────────────────────────────

function formatTaskLine(t: Task, showId: boolean): string {
  const idStr = showId ? `#${t.id} ` : "";
  const statusIcon =
    t.status === "completed"
      ? "✓"
      : t.status === "in_progress"
        ? "…"
        : t.status === "deleted"
          ? "✗"
          : "○";
  if (t.blockedBy?.length) {
    return `${statusIcon} ${idStr}${t.subject} (blocked by: ${t.blockedBy.join(", ")})`;
  }
  return `${statusIcon} ${idStr}${t.subject}`;
}

function formatCreateResult(op: Record<string, unknown>): string {
  return `Created task #${op.taskId}`;
}

function formatUpdateResult(op: Record<string, unknown>): string {
  return `Updated #${op.id}: ${op.fromStatus} → ${op.toStatus}`;
}

function formatDeleteResult(op: Record<string, unknown>): string {
  return `Deleted #${op.id}: ${op.subject}`;
}

function formatListResult(state: AppState, params: Record<string, unknown>): string {
  const includeDeleted = params.includeDeleted === true;
  const statusFilter =
    typeof params.status === "string" && isTaskStatus(params.status) ? params.status : undefined;
  let filtered = state.tasks;
  if (!includeDeleted) filtered = filtered.filter((t) => t.status !== "deleted");
  if (statusFilter) filtered = filtered.filter((t) => t.status === statusFilter);

  if (filtered.length === 0) return "No todos";

  const grouped: Record<string, Task[]> = {
    pending: [],
    in_progress: [],
    completed: [],
    deleted: [],
  };
  for (const t of filtered) grouped[t.status].push(t);

  const lines: string[] = [];
  for (const [status, tasks] of Object.entries(grouped)) {
    if (tasks.length === 0) continue;
    lines.push(`${STATUS_LABELS[status as TaskStatus]} (${tasks.length}):`);
    for (const t of tasks) lines.push(`  ${formatTaskLine(t, true)}`);
  }
  return lines.join("\n");
}

function formatGetResult(task: Task): string {
  const lines = [`#${task.id}: ${task.subject}`, `  status: ${STATUS_LABELS[task.status]}`];
  if (task.description) lines.push(`  description: ${task.description}`);
  if (task.owner) lines.push(`  owner: ${task.owner}`);
  if (task.blockedBy?.length) lines.push(`  blockedBy: ${task.blockedBy.join(", ")}`);
  return lines.join("\n");
}

function formatClearResult(count: number): string {
  return `Cleared ${count} tasks`;
}

// ── Todo Params schema ────────────────────────────────────────────────

const TodoParams = Type.Object({
  action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
  subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
  description: Type.Optional(Type.String({ description: "Long-form task description" })),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
      description: "Target status (update) or list filter (list)",
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.Number(), { description: "Initial blockedBy task ids (create only)" }),
  ),
  addBlockedBy: Type.Optional(
    Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only)" }),
  ),
  removeBlockedBy: Type.Optional(
    Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only)" }),
  ),
  owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
  id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
  includeDeleted: Type.Optional(
    Type.Boolean({ description: "If true, list returns deleted tasks too. Default: false." }),
  ),
});

// ── Overlay widget ────────────────────────────────────────────────────

const WIDGET_KEY = "pi-todos";
const MAX_WIDGET_LINES = 12;

class TodoOverlay {
  private registered = false;

  update(ctx: ExtensionContext, state: AppState): void {
    const visible = state.tasks.filter((t) => t.status !== "deleted");
    const allCompleted = visible.length > 0 && visible.every((t) => t.status === "completed");
    if (visible.length === 0 || allCompleted) {
      if (this.registered) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        this.registered = false;
      }
      return;
    }

    // Always re-register to trigger a re-render with latest state.
    // The TUI widget only refreshes when setWidget is called, so a
    // no-op on an already-registered widget would show stale data.
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        render: (width: number) => this.renderWidget(state, theme, width),
        invalidate: () => {
          this.registered = false;
        },
      }),
      { placement: "aboveEditor" },
    );
    this.registered = true;
  }

  private renderWidget(state: AppState, theme: Theme, width: number): string[] {
    const visible = state.tasks.filter((t) => t.status !== "deleted");
    const completed = visible.filter((t) => t.status === "completed").length;
    const total = visible.length;
    const hasActive = visible.some((t) => t.status === "in_progress");

    const truncate = (s: string) => truncateToWidth(s, width, "…");
    const headingColor = hasActive ? "accent" : "dim";
    const heading = `${theme.fg(headingColor, hasActive ? "●" : "○")} ${theme.fg(headingColor, `Todos (${completed}/${total})`)}`;
    const lines: string[] = [truncate(heading)];

    const maxItems = Math.min(visible.length, MAX_WIDGET_LINES - 1);
    for (let i = 0; i < maxItems; i++) {
      const t = visible[i];
      const conn = i === maxItems - 1 && maxItems === visible.length ? "└─" : "├─";
      const icon =
        t.status === "completed"
          ? theme.fg("success", "✓")
          : t.status === "in_progress"
            ? theme.fg("warning", "…")
            : theme.fg("dim", "○");
      const subject = t.status === "completed" ? theme.fg("dim", t.subject) : t.subject;
      const blockers = t.blockedBy?.length
        ? theme.fg("dim", ` (blocked by: ${t.blockedBy.join(",")})`)
        : "";
      lines.push(truncate(`${theme.fg("dim", conn)} ${icon} ${subject}${blockers}`));
    }

    if (visible.length > maxItems) {
      lines.push(
        truncate(
          `${theme.fg("dim", "└─")} ${theme.fg("dim", `+${visible.length - maxItems} more`)}`,
        ),
      );
    }
    return lines;
  }

  dispose(clearWidget: (key: string, value: undefined) => void): void {
    clearWidget(WIDGET_KEY, undefined);
    this.registered = false;
  }
}

// ── Todos command UI ──────────────────────────────────────────────────

class TodoListComponent {
  private tasks: Task[];
  private theme: Theme;
  private onClose: () => void;

  constructor(tasks: Task[], theme: Theme, onClose: () => void) {
    this.tasks = tasks;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    lines.push("");
    lines.push(truncateToWidth(th.fg("accent", th.bold(" Todos ")), width));
    lines.push("");

    if (this.tasks.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet.")}`, width));
    } else {
      const grouped: Record<string, Task[]> = {
        in_progress: [],
        pending: [],
        completed: [],
        deleted: [],
      };
      for (const t of this.tasks) {
        if (grouped[t.status]) grouped[t.status].push(t);
      }

      for (const [status, tasks] of Object.entries(grouped)) {
        if (tasks.length === 0) continue;
        const label = STATUS_LABELS[status as TaskStatus];
        lines.push(truncateToWidth(`  ${th.fg("accent", label)} (${tasks.length})`, width));
        for (const t of tasks) {
          const icon =
            t.status === "completed"
              ? th.fg("success", "✓")
              : t.status === "in_progress"
                ? th.fg("warning", "…")
                : t.status === "deleted"
                  ? th.fg("error", "✗")
                  : th.fg("dim", "○");
          const idStr = th.fg("accent", `#${t.id}`);
          const text =
            t.status === "completed" || t.status === "deleted"
              ? th.fg("dim", t.subject)
              : th.fg("text", t.subject);
          const blockers = t.blockedBy?.length
            ? th.fg("dim", ` (blocks: ${t.blockedBy.join(",")})`)
            : "";
          lines.push(truncateToWidth(`    ${icon} ${idStr} ${text}${blockers}`, width));
        }
        lines.push("");
      }
    }

    lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
    return lines;
  }

  invalidate(): void {}
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const overlay = new TodoOverlay();
  let state = createEmptyState();

  function persistDetails(action: TaskAction, params: Record<string, unknown>): TaskDetails {
    return { action, params, tasks: state.tasks.map((t) => ({ ...t })), nextId: state.nextId };
  }

  function refreshOverlay(ctx: ExtensionContext): void {
    overlay.update(ctx, state);
  }

  // Reconstruct state from branch on session events.
  // Iterates backwards — each todo tool result stores the full state,
  // so only the last one is needed (O(1) effective for large sessions).
  function reconstruct(ctx: ExtensionContext): void {
    state = createEmptyState();
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      let details: TaskDetails | undefined;
      if (entry.type === "message") {
        const msg = entry.message;
        if (msg.role === "toolResult" && msg.toolName === "todo") {
          details = msg.details as TaskDetails | undefined;
        }
      } else if (entry.type === "custom" && entry.customType === "todo-state") {
        details = entry.data as TaskDetails | undefined;
      }
      if (details?.tasks) {
        state = { tasks: details.tasks.map((t) => ({ ...t })), nextId: details.nextId };
        break;
      }
    }
    refreshOverlay(ctx);
  }

  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
  pi.on("turn_end", async (_event, ctx) => refreshOverlay(ctx));

  pi.on("session_shutdown", () => {
    overlay.dispose(() => {});
  });

  // ── Custom message renderer for todo results ──────────────────────────

  pi.registerMessageRenderer("pi-todo-result", (message, _options, theme) => {
    return new Text(theme.fg("accent", `[todo] `) + (message.content as string), 0, 0);
  });

  // ── Tool registration ─────────────────────────────────────────────────

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage a todo list with 4-state lifecycle (pending → in_progress → completed; any → deleted tombstone). Supports blockedBy dependency tracking with cycle detection. Tasks survive /reload and compaction via branch replay.",
    promptSnippet: "Create, update, list, or delete tasks in the project todo list.",
    promptGuidelines: [
      "Use todo create when the user asks you to track a task or build a plan. Set blockedBy to sequence dependent work.",
      "Use todo update to change task status (pending/in_progress/completed) or modify description/owner/blockedBy.",
      "Use todo list to view current tasks. Filter by status when the user asks about a specific category.",
      "Use todo delete (not clear) to remove individual tasks. Deleted tasks become tombstones so blockedBy references stay valid.",
      "Use todo clear only when the user explicitly asks to wipe the entire list.",
    ],
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const action = params.action as TaskAction;
      const result = applyMutation(state, action, params as Record<string, unknown>);

      if (result.error) {
        const details = persistDetails(action, params as Record<string, unknown>);
        details.error = result.error;
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: details as unknown as Record<string, unknown>,
        };
      }

      state = result.state;
      const details = persistDetails(action, params as Record<string, unknown>);

      let text: string;
      switch (action) {
        case "create":
          text = formatCreateResult(result.op!);
          break;
        case "update":
          text = formatUpdateResult(result.op!);
          break;
        case "list":
          text = formatListResult(state, params as Record<string, unknown>);
          break;
        case "get":
          text = formatGetResult((result.op! as { task: Task }).task);
          break;
        case "delete":
          text = formatDeleteResult(result.op!);
          break;
        case "clear":
          text = formatClearResult((result.op! as { count: number }).count);
          break;
      }

      return {
        content: [{ type: "text", text }],
        details: details as unknown as Record<string, unknown>,
      };
    },

    renderCall(args, theme, _context) {
      let text =
        theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action as string);
      if (args.subject) text += ` ${theme.fg("dim", `"${args.subject}"`)}`;
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as TaskDetails | undefined;
      if (!details) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }

      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const tasks = details.tasks.filter((t) => t.status !== "deleted");
      const completed = tasks.filter((t) => t.status === "completed").length;
      const hasActive = tasks.some((t) => t.status === "in_progress");

      let text =
        theme.fg("success", "✓ ") + theme.fg("muted", `${tasks.length} tasks, ${completed} done`);
      if (hasActive) text += theme.fg("warning", ", active");
      if (expanded && tasks.length > 0) {
        for (const t of tasks) {
          const icon =
            t.status === "completed"
              ? theme.fg("success", "  ✓")
              : t.status === "in_progress"
                ? theme.fg("warning", "  …")
                : theme.fg("dim", "  ○");
          text += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${theme.fg("muted", t.subject)}`;
          if (t.blockedBy?.length) {
            text += theme.fg("dim", ` (blocks: ${t.blockedBy.join(",")})`);
          }
        }
      }
      return new Text(text, 0, 0);
    },
  });

  // ── /todo command ─────────────────────────────────────────────────────

  pi.registerCommand("todo", {
    description: "Manage todos (usage: /todo [list|add|start|done|reopen|delete|clear|help])",
    handler: async (args, ctx) => {
      reconstruct(ctx);

      const parsed = parseTodoCommandArgs(args);
      if (parsed.action === "help") {
        const text = [parsed.errors.join("\n"), todoCommandHelp()].filter(Boolean).join("\n\n");
        ctx.ui.notify(text, parsed.errors.length ? "error" : "info");
        return;
      }

      if (parsed.errors.length > 0) {
        ctx.ui.notify(`${parsed.errors.join("\n")}\n\n${todoCommandHelp()}`, "error");
        return;
      }

      const action = parsed.action as TaskAction;
      if (action === "clear" && state.tasks.length > 0 && !parsed.confirm) {
        if (!ctx.hasUI) {
          ctx.ui.notify("/todo clear requires --yes outside interactive mode", "error");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Clear todos?",
          `This will remove ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}. Continue?`,
        );
        if (!confirmed) return;
      }

      const result = applyMutation(state, action, parsed.params);
      if (result.error) {
        ctx.ui.notify(`Error: ${result.error}`, "error");
        return;
      }

      state = result.state;
      const mutating =
        action === "create" || action === "update" || action === "delete" || action === "clear";
      if (mutating) {
        pi.appendEntry("todo-state", persistDetails(action, parsed.params));
      }
      refreshOverlay(ctx);

      let text: string;
      switch (action) {
        case "create":
          text = formatCreateResult(result.op!);
          break;
        case "update":
          text = formatUpdateResult(result.op!);
          break;
        case "list":
          text = formatListResult(state, parsed.params);
          break;
        case "get":
          text = formatGetResult((result.op! as { task: Task }).task);
          break;
        case "delete":
          text = formatDeleteResult(result.op!);
          break;
        case "clear":
          text = formatClearResult((result.op! as { count: number }).count);
          break;
      }
      ctx.ui.notify(text, "info");
    },
  });

  // ── /todos command ────────────────────────────────────────────────────

  pi.registerCommand("todos", {
    description: "Show all todos grouped by status (alias: /todo list)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/todos requires interactive mode", "error");
        return;
      }
      reconstruct(ctx);
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new TodoListComponent(state.tasks, theme, () => done());
      });
    },
  });
}
