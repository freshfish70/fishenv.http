/**
 * Architecture — Clean Architecture with Use Cases & DI
 *
 * A todo API structured with:
 *   domain/     — pure entities (Todo)
 *   repos/      — repository interface + in-memory implementation
 *   usecases/   — application logic (ListTodos, CreateTodo, ToggleTodo, DeleteTodo)
 *   container/  — DI container wiring
 *   context.ts  — app-wide middleware; exports the AppCtx type
 *   routes/     — HTTP layer, one router per module, typed with r<AppCtx>()
 *   main.ts     — mounts the route modules on the base router
 *
 * Handlers never touch the repo directly. Swapping to Postgres is a
 * one-line change in container/mod.ts.
 *
 * Run: deno run --allow-net examples/architecture/main.ts
 *
 * Try:
 *   curl localhost:3004/api/todos
 *   curl localhost:3004/api/todos -X POST -H "Content-Type: application/json" \
 *     -d '{"title":"Buy groceries"}'
 *   curl localhost:3004/api/todos                          # see the new todo
 *   curl localhost:3004/api/todos/<id>/toggle -X PATCH     # toggle completed
 *   curl localhost:3004/api/todos/<id> -X DELETE
 *   curl localhost:3004/api/todos/nonexistent -X DELETE    # → 404
 */
import { serve } from "@fishenv/http";
import { createContainer } from "./container/mod.ts";
import { base } from "./context.ts";
import { todoRoutes } from "./routes/todos.ts";

const app = base;

// Global error handler — catch anything that slips through
app.onError((err) => {
  console.error("[app]", err);
  return null; // fall through to default error handler
});

// Mount route modules. Each one only compiles here if base provides its AppCtx.
// app.add("/v1", todoRoutes) would serve them under /api/v1 instead.
app.add(todoRoutes);

serve(app, {
  port: 3004,
  container: createContainer(),
  onListen: ({ hostname, port }) =>
    console.log(`Architecture server running at http://${hostname}:${port}`),
});
