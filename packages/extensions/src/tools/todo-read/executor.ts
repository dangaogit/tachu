import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted } from "../shared";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

interface TodoReadInput {
  status?: TodoStatus | "all";
}

interface TodoReadOutput {
  todos: TodoItem[];
  total: number;
}

const getTodosPath = (workspaceRoot: string, sessionId: string): string =>
  join(workspaceRoot, ".tachu", "sessions", sessionId, "todos.json");

/**
 * Todo 读取 Tool 执行器。
 */
export const todoReadExecutor: ToolExecutor<TodoReadInput, TodoReadOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);

  const path = getTodosPath(context.workspaceRoot, context.session.id);

  let todos: TodoItem[] = [];
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    todos = Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
  } catch {
    todos = [];
  }

  const filterStatus = input.status;
  const filtered =
    filterStatus === undefined || filterStatus === "all"
      ? todos
      : todos.filter((t) => t.status === filterStatus);

  return { todos: filtered, total: filtered.length };
};
