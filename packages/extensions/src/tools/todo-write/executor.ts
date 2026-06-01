import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutor } from "../shared";
import { assertNotAborted } from "../shared";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

interface TodoWriteInput {
  todos: TodoItem[];
  merge?: boolean;
}

interface TodoWriteOutput {
  total: number;
  written: number;
}

const getTodosPath = (workspaceRoot: string, sessionId: string): string =>
  join(workspaceRoot, ".tachu", "sessions", sessionId, "todos.json");

const readExisting = async (path: string): Promise<TodoItem[]> => {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
  } catch {
    return [];
  }
};

/**
 * Todo 写入 Tool 执行器。
 */
export const todoWriteExecutor: ToolExecutor<TodoWriteInput, TodoWriteOutput> = async (
  input,
  context,
) => {
  assertNotAborted(context.abortSignal);

  const path = getTodosPath(context.workspaceRoot, context.session.id);
  await mkdir(join(path, ".."), { recursive: true });

  const merge = input.merge !== false;

  let final: TodoItem[];
  if (merge) {
    const existing = await readExisting(path);
    const map = new Map<string, TodoItem>(existing.map((t) => [t.id, t]));
    for (const todo of input.todos) {
      map.set(todo.id, todo);
    }
    final = [...map.values()];
  } else {
    final = [...input.todos];
  }

  await writeFile(path, JSON.stringify(final, null, 2), "utf8");
  return { total: final.length, written: input.todos.length };
};
