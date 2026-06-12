import type { Todo } from "../domain/todo.ts";

/** Repository interface — the domain defines the contract, infra implements it. */
export interface TodoRepo {
  findAll(): Promise<Todo[]>;
  findById(id: string): Promise<Todo | null>;
  create(title: string): Promise<Todo>;
  update(
    id: string,
    patch: Partial<Pick<Todo, "title" | "completed">>,
  ): Promise<Todo | null>;
  remove(id: string): Promise<boolean>;
}

/** In-memory implementation — swap for Postgres/SQLite/etc. in production. */
export class InMemoryTodoRepo implements TodoRepo {
  #todos: Map<string, Todo> = new Map();

  async findAll(): Promise<Todo[]> {
    return [...this.#todos.values()];
  }

  async findById(id: string): Promise<Todo | null> {
    return this.#todos.get(id) ?? null;
  }

  async create(title: string): Promise<Todo> {
    const todo: Todo = {
      id: crypto.randomUUID(),
      title,
      completed: false,
      createdAt: new Date(),
    };
    this.#todos.set(todo.id, todo);
    return todo;
  }

  async update(
    id: string,
    patch: Partial<Pick<Todo, "title" | "completed">>,
  ): Promise<Todo | null> {
    const todo = this.#todos.get(id);
    if (!todo) return null;
    const updated = { ...todo, ...patch };
    this.#todos.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    return this.#todos.delete(id);
  }
}
