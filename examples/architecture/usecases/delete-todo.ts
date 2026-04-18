import type { TodoRepo } from "../repos/todo-repo.ts";
import { TodoNotFoundError } from "./toggle-todo.ts";

/** Use case: delete a todo by ID. */
export class DeleteTodo {
  constructor(private repo: TodoRepo) {}

  async execute(id: string): Promise<void> {
    const removed = await this.repo.remove(id);
    if (!removed) throw new TodoNotFoundError(id);
  }
}
