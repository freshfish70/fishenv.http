import type { Todo } from "../domain/todo.ts";
import type { TodoRepo } from "../repos/todo-repo.ts";

/** Use case: list all todos, optionally filtered by completion status. */
export class ListTodos {
  constructor(private repo: TodoRepo) {}

  async execute(filter?: { completed?: boolean }): Promise<Todo[]> {
    const all = await this.repo.findAll();
    if (filter?.completed !== undefined) {
      return all.filter((t) => t.completed === filter.completed);
    }
    return all;
  }
}
