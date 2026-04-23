import { createTodo, toggleTodo, filterTodos, countActive } from "../../src/todo.js";

describe("todo — smoke", () => {
  describe("createTodo()", () => {
    it("creates a todo with default priority", () => {
      const todo = createTodo(1, "Buy groceries");
      expect(todo).toMatchObject({
        id: 1,
        text: "Buy groceries",
        completed: false,
        priority: "medium",
      });
    });

    it("trims whitespace from text", () => {
      const todo = createTodo(1, "  Buy groceries  ");
      expect(todo.text).toBe("Buy groceries");
    });

    it("throws on empty text", () => {
      expect(() => createTodo(1, "")).toThrow("Todo text must not be empty");
      expect(() => createTodo(1, "   ")).toThrow("Todo text must not be empty");
    });

    it("accepts explicit priority", () => {
      const todo = createTodo(1, "Urgent task", "high");
      expect(todo.priority).toBe("high");
    });
  });

  describe("toggleTodo()", () => {
    it("marks an incomplete todo as completed", () => {
      const todo = createTodo(1, "Task");
      expect(toggleTodo(todo).completed).toBe(true);
    });

    it("marks a completed todo as incomplete", () => {
      const todo = { ...createTodo(1, "Task"), completed: true };
      expect(toggleTodo(todo).completed).toBe(false);
    });

    it("does not mutate the original", () => {
      const todo = createTodo(1, "Task");
      toggleTodo(todo);
      expect(todo.completed).toBe(false);
    });
  });

  describe("filterTodos()", () => {
    const todos = [
      createTodo(1, "Active task"),
      { ...createTodo(2, "Done task"), completed: true },
    ];

    it("filter=all returns everything", () => {
      expect(filterTodos(todos, "all")).toHaveLength(2);
    });

    it("filter=active returns only incomplete", () => {
      expect(filterTodos(todos, "active")).toHaveLength(1);
      expect(filterTodos(todos, "active")[0].id).toBe(1);
    });

    it("filter=completed returns only done", () => {
      expect(filterTodos(todos, "completed")).toHaveLength(1);
      expect(filterTodos(todos, "completed")[0].id).toBe(2);
    });
  });

  describe("countActive()", () => {
    it("returns 0 when all done", () => {
      const todos = [{ ...createTodo(1, "Task"), completed: true }];
      expect(countActive(todos)).toBe(0);
    });

    it("counts only incomplete todos", () => {
      const todos = [
        createTodo(1, "Active"),
        { ...createTodo(2, "Done"), completed: true },
        createTodo(3, "Also active"),
      ];
      expect(countActive(todos)).toBe(2);
    });
  });
});
