# 01 — Project Setup

## Decisions
- **Validation**: Valibot v1. Core types designed for future Standard Schema compatibility.
- **Module identity**: Single JSR package `@fishenv/http` with sub-path exports (`/ws`, `/sse`, `/static`, `/openapi`, `/client-gen`).
- **Deno target**: 2.7+ — uses `Deno.serve` with `AbortSignal`, `Deno.upgradeWebSocket`.
- **DI**: Skipped for v1. Core defines a minimal `DIContainer` interface; no implementation.

## Directory Structure

```
fishenv.api/
├── deno.json                   # workspace root
├── core/
│   ├── deno.json
│   ├── mod.ts                  # public API: r(), router(), serve(), types
│   ├── router.ts               # Router class + r()/router() factories
│   ├── route-builder.ts        # fluent RouteBuilder chain
│   ├── compose.ts              # middleware pipeline + dispatch
│   ├── request.ts              # body parsing helpers
│   ├── error.ts                # HttpError classes + default handlers
│   ├── types.ts                # all shared TS types
│   └── utils/
│       ├── url.ts              # path merging, param extraction
│       └── headers.ts
├── ws/
│   ├── deno.json
│   └── mod.ts                  # WsRouteBuilder + withWs() mixin
├── sse/
│   ├── deno.json
│   └── mod.ts                  # SseController + withSse() mixin
├── static/
│   ├── deno.json
│   └── mod.ts                  # serveFile() + withStatic() mixin
├── openapi/
│   ├── deno.json
│   └── mod.ts                  # generateOpenApi(), serveOpenApi()
└── client-gen/
    ├── deno.json
    └── mod.ts                  # createClient() (uses @fishenv/wrq)
```

## deno.json (workspace root)

```json
{
  "workspace": ["./core", "./ws", "./sse", "./static", "./openapi", "./client-gen"],
  "tasks": {
    "test": "deno test --allow-read --allow-net --allow-env",
    "check": "deno check core/mod.ts"
  }
}
```

## core/deno.json

```json
{
  "name": "@fishenv/http",
  "version": "0.1.0",
  "exports": {
    ".": "./mod.ts",
    "./types": "./types.ts",
    "./ws": "../ws/mod.ts",
    "./sse": "../sse/mod.ts",
    "./static": "../static/mod.ts",
    "./openapi": "../openapi/mod.ts",
    "./client-gen": "../client-gen/mod.ts"
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@^1",
    "@std/path": "jsr:@std/path@^1",
    "@std/media-types": "jsr:@std/media-types@^1",
    "valibot": "jsr:@valibot/valibot@^1"
  }
}
```

## Deliverables
- [ ] Root `deno.json` workspace config
- [ ] One `deno.json` per sub-module with correct exports
- [ ] Empty `mod.ts` stubs in each sub-module
- [ ] `core/types.ts` with placeholder comment
- [ ] `.gitignore` for Deno cache (`/.deno`)
