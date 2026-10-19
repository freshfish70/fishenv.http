import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Router, r } from "../core/index.ts";

/** Every file outside the root contains this marker; it must never leak. */
export const SECRET = "TOP-SECRET-MARKER";

/** Fixed mtime so ETag / Last-Modified are predictable. */
export const MTIME = new Date("2026-01-02T03:04:05.000Z");

export interface Fixture {
  base: string;
  root: string;
  write(rel: string, content: string | Uint8Array): string;
  cleanup(): void;
  /** False where `mkfifo` is unavailable. */
  hasFifo: boolean;
}

/**
 * Build a served root next to things an attacker wants:
 *
 * ```
 * base/
 *   secret.txt                  outside the root
 *   public-secrets/key.txt      sibling sharing the root's name prefix
 *   public/                     the root
 *     hello.txt, with space.txt, %2e%2e (literal name), Secret.KEY
 *     index.html, about.html, app.js(.br/.gz), app.js.map, style.css
 *     docs/index.html, docs/guide.txt, empty/, noindex/file.txt
 *     .env, .git/config, .well-known/security.txt, nested/.hidden/x.txt
 *     upload.html, upload.svg, photo.png, notes.txt
 *     link-in -> hello.txt, link-dir-in -> docs
 *     link-out -> ../secret.txt, link-dir-out -> ../public-secrets
 *     dangling -> missing.txt, fifo (named pipe)
 * ```
 */
export function createFixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "fishenv-static-"));
  const root = path.join(base, "public");

  const write = (rel: string, content: string | Uint8Array): string => {
    const abs = path.join(base, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    utimesSync(abs, MTIME, MTIME);
    return abs;
  };

  write("secret.txt", SECRET);
  write("public-secrets/key.txt", SECRET);

  write("public/hello.txt", "hello world");
  write("public/with space.txt", "spaced");
  write("public/%2e%2e", "literal percent name");
  write("public/Secret.KEY", SECRET);
  write("public/index.html", "<h1>shell</h1>");
  write("public/about.html", "<h1>about</h1>");
  write("public/app.js", "console.log('identity')");
  write("public/app.js.br", "BR-BYTES");
  write("public/app.js.gz", "GZ-BYTES");
  write("public/app.js.map", "{}");
  write("public/style.css", "body{}");
  write("public/docs/index.html", "<h1>docs</h1>");
  write("public/docs/guide.txt", "guide");
  write("public/noindex/file.txt", "file");
  mkdirSync(path.join(root, "empty"));
  write("public/.env", SECRET);
  write("public/.git/config", SECRET);
  write("public/.well-known/security.txt", "contact");
  write("public/nested/.hidden/x.txt", SECRET);
  write("public/upload.html", "<script>alert(1)</script>");
  write("public/upload.svg", "<svg onload=alert(1)/>");
  write("public/photo.png", "PNG");
  write("public/notes.txt", "notes");

  symlinkSync("hello.txt", path.join(root, "link-in"));
  symlinkSync("docs", path.join(root, "link-dir-in"));
  symlinkSync("../secret.txt", path.join(root, "link-out"));
  symlinkSync("../public-secrets", path.join(root, "link-dir-out"));
  symlinkSync("missing.txt", path.join(root, "dangling"));

  const fifo = Bun.spawnSync(["mkfifo", path.join(root, "fifo")]);

  return {
    base,
    root,
    write,
    hasFifo: fifo.success,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Build `router` and return a fetch helper for in-process requests. */
// biome-ignore lint/suspicious/noExplicitAny: accepts routers of any context
export function client(app: Router<any, any>) {
  app.build();
  return (urlPath: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://localhost${urlPath}`, init));
}

/** Mount a static router at `prefix` on a fresh root router. */
// biome-ignore lint/suspicious/noExplicitAny: accepts routers of any context
export function mount(prefix: string, child: Router<any, any>) {
  return client(r().add(prefix, child));
}
