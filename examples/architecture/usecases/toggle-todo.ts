import type { Todo } from "../domain/todo.ts";
import type { TodoRepo } from "../repos/todo-repo.ts";

/** Use case: toggle a todo's completed status. */
export class ToggleTodo {
  constructor(private repo: TodoRepo) {}

  async execute(id: string): Promise<Todo> {
    const todo = await this.repo.findById(id);
    if (!todo) throw new TodoNotFoundError(id);
    return (await this.repo.update(id, { completed: !todo.completed }))!;
  }
}

export class TodoNotFoundError extends Error {
  constructor(public readonly todoId: string) {
    super(`Todo ${todoId} not found`);
    this.name = "TodoNotFoundError";
  }
}
