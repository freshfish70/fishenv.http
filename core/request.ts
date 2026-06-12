import type {
  AnySchema,
  InputKind,
  InputOptions,
  RouteDefinition,
} from "./types.ts";
import { BadRequestError, HttpError } from "./error.ts";
import { validateField, validatePathParams } from "./validation.ts";

export interface ParsedInput {
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  cookies: Record<string, string>;
  path: Record<string, unknown>;
}

/**
 * Parse and validate all input from a request according to the route definition.
 */
export async function parseInput(
  req: Request,
  def: RouteDefinition,
  rawParams: Record<string, string>,
): Promise<ParsedInput> {
  const cookies = parseCookies(req);
  const headers = extractHeaders(req);
  const query = extractQuery(req);
  const body = await parseBody(req, def.inputKind, def.inputOptions);
  const path = validatePathParams(rawParams, def.paramSchemas);

  // Validate each field if a schema is provided
  const opts = def.inputOptions;

  return {
    body: opts.body ? validateField(opts.body, body, "body") : body,
    headers:
      (opts.headers
        ? validateField(opts.headers, headers, "headers")
        : headers) as Record<string, string>,
    query:
      (opts.query
        ? validateField(opts.query, query, "query")
        : query) as Record<string, string | string[]>,
    cookies:
      (opts.cookies
        ? validateField(opts.cookies, cookies, "cookies")
        : cookies) as Record<string, string>,
    path,
  };
}

/**
 * Parse the request body based on InputKind.
 */
export async function parseBody(
  req: Request,
  kind: InputKind,
  opts: InputOptions<InputKind>,
): Promise<unknown> {
  switch (kind) {
    case "json":
      try {
        return await req.json();
      } catch (e) {
        throw new BadRequestError("Invalid JSON", e);
      }

    case "multipart":
    case "urlencoded":
      enforceMaxSize(req, opts.maxSize as number | undefined);
      return req.formData();

    case "blob":
      enforceMaxSize(req, opts.maxSize as number | undefined);
      return req.blob();

    case "text":
      return req.text();

    case "none":
    default:
      return undefined;
  }
}

/**
 * Check Content-Length against maxSize before reading the body.
 */
function enforceMaxSize(req: Request, maxSize?: number): void {
  if (!maxSize) return;
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > maxSize) {
    throw new HttpError(413, "Payload Too Large");
  }
}

/**
 * Extract all headers as a lowercased-key record.
 */
export function extractHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value; // Headers API already lowercases keys
  });
  return headers;
}

/**
 * Parse cookies from the Cookie header.
 */
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") ?? "";
  if (!header) return {};
  return Object.fromEntries(
    header.split(";")
      .map((pair) => pair.trim().split("="))
      .filter(([k]) => k?.length > 0)
      .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join("="))]),
  );
}

/**
 * Extract query parameters. Duplicate keys become arrays.
 */
export function extractQuery(req: Request): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  new URL(req.url).searchParams.forEach((value, key) => {
    const existing = params[key];
    if (existing === undefined) {
      params[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      params[key] = [existing, value];
    }
  });
  return params;
}
