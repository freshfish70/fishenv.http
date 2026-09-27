/**
 * Contract — Typesafe Contract Registration
 *
 * Shows how to define an API contract as portable data (`@fishenv/http-contract`)
 * and register it on the router with `.contract(endpoint).handle(...)`,
 * getting the exact same type safety as `.input().output().param()`.
 *
 * The contract module (`./contract.ts` below) has zero server dependencies —
 * it can be published as its own package and imported by:
 *   - the API (this file), to build routes
 *   - a frontend client, to build a typesafe RPC client
 *   - an OpenAPI generator, to build docs
 *
 * Run: deno run --allow-net examples/contract/main.ts
 *
 * Try:
 *   curl localhost:3004/api/users -X POST -H "Content-Type: application/json" \
 *     -d '{"name":"Alice","email":"alice@example.com"}'
 *
 *   curl localhost:3004/api/users/42
 */
import { r, serve } from "@fishenv/http";
import { contract } from "./contract.ts";

const app = r({ prefix: "/api" });

app.contract(contract.users.create).handle(({ body }) => {
  // body is typed as { name: string; email: string } — from the contract
  return {
    id: crypto.randomUUID(),
    ...body,
  };
});

app.contract(contract.users.get).handle(({ path }) => {
  // path.id is typed as number — coerced by the contract's `.param()` schema
  return {
    id: String(path.id),
    name: `User ${path.id}`,
    email: `user${path.id}@example.com`,
  };
});

serve(app, {
  port: 3004,
  onListen: ({ hostname, port }) =>
    console.log(`Contract server running at http://${hostname}:${port}`),
});
