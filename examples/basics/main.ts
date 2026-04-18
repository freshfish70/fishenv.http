/**
 * Basics — Hello World
 *
 * The simplest possible @fishenv/http server.
 * Run: deno run --allow-net examples/basics/main.ts
 */
import { r, serve } from "@fishenv/http";

const app = r();

// Plain text response
app.get("/").handle(() => new Response("Hello, World!"));

// JSON response
app.get("/health").handle(() =>
  Response.json({ status: "ok", uptime: performance.now() })
);

// Reading the request
app.post("/echo").handle(async ({ req }) => {
  const text = await req.text();
  return new Response(`You said: ${text}`);
});

serve(app, {
  port: 3000,
  onListen: ({ hostname, port }) =>
    console.log(`Basics server running at http://${hostname}:${port}`),
});
