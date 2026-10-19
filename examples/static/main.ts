/**
 * Static files — an API and a single-page app on one server
 *
 * - `/api/*`    JSON API; unknown API paths stay real 404s (`exclude`)
 * - `/assets/*` fingerprinted assets, cached for a year
 * - `/*`        the SPA: real files, else `index.html` for client routes
 *
 * Run: bun examples/static/main.ts
 */
import { r, serve } from "@fishenv/http";
import { spa } from "@fishenv/http/static";

const api = r({ prefix: "/api" });
api.get("/todos").handle(() => Response.json([{ id: 1, title: "Ship it" }]));

const app = r()
  .add(api)
  .add(
    spa({
      root: new URL("./public", import.meta.url).pathname,
      // Without this, a browser navigating to an unknown /api/... path would
      // get the HTML shell instead of a 404.
      exclude: ["api/**"],
      rules: [
        {
          match: "assets/**",
          cacheControl: "public, max-age=31536000, immutable",
        },
      ],
    }),
  );

serve(app, {
  port: 3000,
  onListen: ({ hostname, port }) =>
    console.log(`Static example running at http://${hostname}:${port}`),
});
