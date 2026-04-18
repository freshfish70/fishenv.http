/**
 * Architecture — Clean Architecture with Use Cases & DI
 *
 * A todo API structured with:
 *   domain/     — pure entities (Todo)
 *   repos/      — repository interface + in-memory implementation
 *   usecases/   — application logic (ListTodos, CreateTodo, ToggleTodo, DeleteTodo)
 *   container/  — DI container wiring
 *   routes/     — HTTP layer — handlers pull use cases from the container
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
import { r, serve } from "@fishenv/http";
import { createContainer } from "./container/mod.ts";
import { registerTodoRoutes } from "./routes/todos.ts";

const app = r({ prefix: "/api" });

// Global error handler — catch anything that slips through
app.onError((err) => {
  console.error("[app]", err);
  return null; // fall through to default error handler
});

// Register route modules
registerTodoRoutes(app);

serve(app, {
  port: 3004,
  container: createContainer(),
  onListen: ({ hostname, port }) =>
    console.log(`Architecture server running at http://${hostname}:${port}`),
});
