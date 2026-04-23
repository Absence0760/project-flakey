import { createTodo, sortByPriority } from "../../src/todo.js";

describe("todo sort — regression", () => {
  describe("sortByPriority()", () => {
    it("puts high priority first", () => {
      const todos = [
        createTodo(1, "Low task", "low"),
        createTodo(2, "High task", "high"),
        createTodo(3, "Medium task", "medium"),
      ];
      const sorted = sortByPriority(todos);
      expect(sorted[0].priority).toBe("high");
      expect(sorted[1].priority).toBe("medium");
      expect(sorted[2].priority).toBe("low");
    });

    it("does not mutate the original array", () => {
      const todos = [
        createTodo(1, "Low", "low"),
        createTodo(2, "High", "high"),
      ];
      sortByPriority(todos);
      expect(todos[0].priority).toBe("low");
    });

    it("handles empty array", () => {
      expect(sortByPriority([])).toEqual([]);
    });

    it("handles single-element array", () => {
      const todos = [createTodo(1, "Only task", "medium")];
      expect(sortByPriority(todos)).toHaveLength(1);
    });

    it("maintains relative order within same priority", () => {
      const todos = [
        createTodo(1, "First medium", "medium"),
        createTodo(2, "High task", "high"),
        createTodo(3, "Second medium", "medium"),
      ];
      const sorted = sortByPriority(todos);
      // Both mediums should come after high, and relative order preserved
      expect(sorted[0].priority).toBe("high");
      const mediums = sorted.filter((t) => t.priority === "medium");
      expect(mediums.map((t) => t.id)).toEqual([1, 3]);
    });
  });
});
