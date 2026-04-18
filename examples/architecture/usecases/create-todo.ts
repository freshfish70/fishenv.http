import type { Todo } from "../domain/todo.ts";
import type { TodoRepo } from "../repos/todo-repo.ts";

/** Use case: create a new todo. */
export class CreateTodo {
  constructor(private repo: TodoRepo) {}

  async execute(title: string): Promise<Todo> {
    if (!title.trim()) throw new Error("Title cannot be empty");
    return this.repo.create(title.trim());
  }
}
