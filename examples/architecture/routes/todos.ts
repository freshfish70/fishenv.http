import * as v from "valibot";
import type { Router } from "@fishenv/http";
import { NotFoundError } from "@fishenv/http";
import { ListTodos } from "../usecases/list-todos.ts";
import { CreateTodo } from "../usecases/create-todo.ts";
import { ToggleTodo } from "../usecases/toggle-todo.ts";
import { DeleteTodo } from "../usecases/delete-todo.ts";
import { TodoNotFoundError } from "../usecases/toggle-todo.ts";

/**
 * Register todo routes on a router.
 * Handlers pull use cases from the DI container — no direct repo access.
 */
export function registerTodoRoutes(router: Router) {
  // GET /todos?completed=true
  router.get("/todos")
    .input("none", {
      query: v.object({
        completed: v.optional(v.pipe(
          v.string(),
          v.transform((s) => s === "true"),
        )),
      }),
    })
    .handle(async ({ query, container }) => {
      const uc = container.get(ListTodos);
      const todos = await uc.execute(
        query.completed !== undefined
          ? { completed: query.completed }
          : undefined,
      );
      return Response.json(todos);
    });

  // POST /todos  { title: "..." }
  router.post("/todos")
    .input("json", {
      body: v.object({
        title: v.pipe(v.string(), v.minLength(1, "Title is required")),
      }),
    })
    .handle(async ({ body, container }) => {
      const uc = container.get(CreateTodo);
      const todo = await uc.execute(body.title);
      return Response.json(todo, { status: 201 });
    });

  // PATCH /todos/:id/toggle
  router.patch("/todos/:id/toggle")
    .handle(async ({ path, container }) => {
      const uc = container.get(ToggleTodo);
      const todo = await uc.execute(path.id);
      return Response.json(todo);
    })
    .catch((err) => {
      if (err instanceof TodoNotFoundError) {
        throw new NotFoundError(`Todo ${err.todoId} not found`);
      }
      return null; // pass to next error handler
    });

  // DELETE /todos/:id
  router.delete("/todos/:id")
    .handle(async ({ path, container }) => {
      const uc = container.get(DeleteTodo);
      await uc.execute(path.id);
      return new Response(null, { status: 204 });
    })
    .catch((err) => {
      if (err instanceof TodoNotFoundError) {
        throw new NotFoundError(`Todo ${err.todoId} not found`);
      }
      return null;
    });
}
