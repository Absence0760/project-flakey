/**
 * Pure utility functions for the todo domain.
 * These are tested by the Jest example without spinning up the sample app.
 */

export type Priority = "low" | "medium" | "high";

export interface Todo {
  id: number;
  text: string;
  completed: boolean;
  priority: Priority;
  createdAt: Date;
}

export function createTodo(id: number, text: string, priority: Priority = "medium"): Todo {
  if (!text.trim()) throw new Error("Todo text must not be empty");
  return { id, text: text.trim(), completed: false, priority, createdAt: new Date() };
}

export function toggleTodo(todo: Todo): Todo {
  return { ...todo, completed: !todo.completed };
}

export function filterTodos(todos: Todo[], filter: "all" | "active" | "completed"): Todo[] {
  if (filter === "active") return todos.filter((t) => !t.completed);
  if (filter === "completed") return todos.filter((t) => t.completed);
  return todos;
}

export function countActive(todos: Todo[]): number {
  return todos.filter((t) => !t.completed).length;
}

export function sortByPriority(todos: Todo[]): Todo[] {
  const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  return [...todos].sort((a, b) => order[a.priority] - order[b.priority]);
}
