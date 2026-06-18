import { defineTool } from "eve/tools";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Хранилище задач — простой JSON-файл на диске app-runtime (на VPS переживает рестарты).
// Путь настраивается через ASSISTANT_DATA_DIR; по умолчанию ./data рядом с процессом.
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const FILE = join(DATA_DIR, "tasks.json");

type Priority = "low" | "med" | "high";
interface Task {
  id: number;
  text: string;
  priority: Priority;
  due: string | null;
  done: boolean;
  createdAt: string;
}

async function load(): Promise<Task[]> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Task[];
  } catch {
    return [];
  }
}

async function save(tasks: Task[]): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(tasks, null, 2), "utf8");
}

export default defineTool({
  description:
    "Управление списком задач пользователя. action=add добавляет задачу (нужен text); " +
    "list показывает задачи (по умолчанию незавершённые); done отмечает задачу выполненной (нужен id); " +
    "remove удаляет задачу (нужен id).",
  inputSchema: z.object({
    action: z.enum(["add", "list", "done", "remove"]),
    text: z.string().min(1).optional().describe("Текст задачи (для action=add)"),
    id: z.number().int().positive().optional().describe("ID задачи (для done/remove)"),
    priority: z.enum(["low", "med", "high"]).optional().describe("Приоритет (для add)"),
    due: z.string().optional().describe("Срок в свободной форме или ISO-дата (для add)"),
    includeDone: z.boolean().optional().describe("Показать и выполненные (для list)"),
  }),
  async execute({ action, text, id, priority, due, includeDone }) {
    const tasks = await load();

    switch (action) {
      case "add": {
        if (!text) return { ok: false, error: "Для add нужен text" };
        const nextId = tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
        const task: Task = {
          id: nextId,
          text,
          priority: priority ?? "med",
          due: due ?? null,
          done: false,
          createdAt: new Date().toISOString(),
        };
        tasks.push(task);
        await save(tasks);
        return { ok: true, added: task, total: tasks.length };
      }
      case "list": {
        const items = includeDone ? tasks : tasks.filter((t) => !t.done);
        return { ok: true, count: items.length, tasks: items };
      }
      case "done": {
        if (!id) return { ok: false, error: "Для done нужен id" };
        const t = tasks.find((x) => x.id === id);
        if (!t) return { ok: false, error: `Задача ${id} не найдена` };
        t.done = true;
        await save(tasks);
        return { ok: true, done: t };
      }
      case "remove": {
        if (!id) return { ok: false, error: "Для remove нужен id" };
        const idx = tasks.findIndex((x) => x.id === id);
        if (idx === -1) return { ok: false, error: `Задача ${id} не найдена` };
        const [removed] = tasks.splice(idx, 1);
        await save(tasks);
        return { ok: true, removed, total: tasks.length };
      }
    }
  },
});
