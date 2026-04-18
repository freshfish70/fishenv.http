import type { DIContainer } from "@fishenv/http";
import { InMemoryTodoRepo } from "../repos/todo-repo.ts";
import { ListTodos } from "../usecases/list-todos.ts";
import { CreateTodo } from "../usecases/create-todo.ts";
import { ToggleTodo } from "../usecases/toggle-todo.ts";
import { DeleteTodo } from "../usecases/delete-todo.ts";

/**
 * Simple DI container — maps class tokens to singleton instances.
 * In production you'd use a proper container (e.g. tsyringe, inversify).
 */
export function createContainer(): DIContainer {
  const repo = new InMemoryTodoRepo();

  // deno-lint-ignore no-explicit-any
  const registry = new Map<abstract new (...args: any[]) => unknown, unknown>();
  registry.set(ListTodos, new ListTodos(repo));
  registry.set(CreateTodo, new CreateTodo(repo));
  registry.set(ToggleTodo, new ToggleTodo(repo));
  registry.set(DeleteTodo, new DeleteTodo(repo));

  return {
    // deno-lint-ignore no-explicit-any
    get<T>(token: abstract new (...args: any[]) => T): T {
      const instance = registry.get(token);
      if (!instance) throw new Error(`No binding for ${token.name}`);
      return instance as T;
    },
  };
}
