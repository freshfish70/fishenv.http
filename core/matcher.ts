import type { HttpMethod, RouteDefinition } from "./types.ts";
import { buildRouteRegex } from "./utils/url.ts";

export interface MatchedRoute {
  definition: RouteDefinition;
  params: Record<string, string>;
  allowedMethods?: HttpMethod[];
}

interface CompiledRoute {
  regex: RegExp;
  paramNames: string[];
  definition: RouteDefinition;
}

export interface RouterMatcher {
  add(method: HttpMethod | "ALL", path: string, def: RouteDefinition): void;
  match(method: string, path: string): MatchedRoute | null;
  compile(): void;
}

/** Score: more static segments = higher, broad globs = lower */
function specificity(path: string): number {
  return path.split("/").reduce((score, seg) => {
    if (!seg) return score;
    if (seg === "**") return score + 0;
    if (seg.includes("*") || seg.includes("{")) return score + 1;
    if (seg.startsWith(":")) return score + 2;
    return score + 3;
  }, 0);
}

function hasPatternSyntax(path: string): boolean {
  return path.includes(":") || path.includes("*") || path.includes("{");
}

export class Matcher implements RouterMatcher {
  #rawRoutes: Array<
    { method: string; path: string; def: RouteDefinition }
  > = [];
  #compiled = false;

  // Per method: static map + dynamic list
  #staticRoutes = new Map<string, Map<string, RouteDefinition>>();
  #dynamicRoutes = new Map<string, CompiledRoute[]>();

  add(method: HttpMethod | "ALL", path: string, def: RouteDefinition): void {
    if (this.#compiled) {
      throw new Error("Cannot add routes after compile()");
    }
    this.#rawRoutes.push({ method: method.toUpperCase(), path, def });
  }

  compile(): void {
    for (const { method, path, def } of this.#rawRoutes) {
      if (!hasPatternSyntax(path)) {
        // Static path
        if (!this.#staticRoutes.has(method)) {
          this.#staticRoutes.set(method, new Map());
        }
        this.#staticRoutes.get(method)!.set(path, def);
      } else {
        // Dynamic path
        const { regex, paramNames } = buildRouteRegex(path);
        const compiled: CompiledRoute = { regex, paramNames, definition: def };
        if (!this.#dynamicRoutes.has(method)) {
          this.#dynamicRoutes.set(method, []);
        }
        this.#dynamicRoutes.get(method)!.push(compiled);
      }
    }
    // Sort dynamic routes: higher specificity first
    for (const list of this.#dynamicRoutes.values()) {
      list.sort((a, b) =>
        specificity(b.definition.path) - specificity(a.definition.path)
      );
    }
    this.#compiled = true;
  }

  match(method: string, path: string): MatchedRoute | null {
    method = method.toUpperCase();

    // Check static routes (exact method, then ALL)
    const def = this.#staticRoutes.get(method)?.get(path) ??
      this.#staticRoutes.get("ALL")?.get(path);
    if (def) return { definition: def, params: {} };

    // Check dynamic routes (exact method, then ALL)
    const dynamicForMethod = this.#dynamicRoutes.get(method) ?? [];
    const dynamicForAll = this.#dynamicRoutes.get("ALL") ?? [];

    for (const route of [...dynamicForMethod, ...dynamicForAll]) {
      const m = route.regex.exec(path);
      if (m) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          if (m[i + 1] !== undefined) {
            params[name] = m[i + 1];
          }
        });
        return { definition: route.definition, params };
      }
    }

    // 405: check if ANY method matches this path
    const allowed = this.#findAllowedMethods(path);
    if (allowed.length > 0) {
      return {
        definition: undefined as unknown as RouteDefinition,
        params: {},
        allowedMethods: allowed,
      };
    }

    return null;
  }

  #findAllowedMethods(path: string): HttpMethod[] {
    const methods: Set<HttpMethod> = new Set();

    for (const [method, map] of this.#staticRoutes) {
      if (method === "ALL") continue;
      if (map.has(path)) methods.add(method as HttpMethod);
    }

    for (const [method, routes] of this.#dynamicRoutes) {
      if (method === "ALL") continue;
      for (const route of routes) {
        if (route.regex.test(path)) {
          methods.add(method as HttpMethod);
          break;
        }
      }
    }

    return [...methods];
  }
}
