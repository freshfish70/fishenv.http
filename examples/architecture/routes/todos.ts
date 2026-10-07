import * as v from "valibot";
import { NotFoundError, r } from "@fishenv/http";
import type { AppCtx } from "../context.ts";
import { ListTodos } from "../usecases/list-todos.ts";
import { CreateTodo } from "../usecases/create-todo.ts";
import { ToggleTodo } from "../usecases/toggle-todo.ts";
import { DeleteTodo } from "../usecases/delete-todo.ts";
import { TodoNotFoundError } from "../usecases/toggle-todo.ts";

/**
 * Todo routes. Handlers pull use cases from the DI container — no direct repo access.
 *
 * `r<AppCtx>()` declares that whoever mounts this router must provide AppCtx.
 * The import above is type-only, so this module never loads context.ts or
 * main.ts at runtime.
 */
export const todoRoutes = r<AppCtx>();

// GET /todos?completed=true — logs the request id provided by AppCtx
todoRoutes.get("/todos")
  .input("none", {
    query: v.object({
      completed: v.optional(v.pipe(
        v.string(),
        v.transform((s) => s === "true"),
      )),
    }),
  })
  .handle(async ({ query, container, ctx }) => {
    console.log(`[${ctx.requestId}] list todos`);
    const uc = container.get(ListTodos);
    const todos = await uc.execute(
      query.completed !== undefined
        ? { completed: query.completed }
        : undefined,
    );
    return Response.json(todos);
  });

// POST /todos  { title: "..." }
todoRoutes.post("/todos")
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
todoRoutes.patch("/todos/:id/toggle")
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
todoRoutes.delete("/todos/:id")
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
