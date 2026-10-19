import { buildRouteRegex } from "../core/index.ts";
import type { StaticRule } from "./types.ts";

export interface CompiledRule {
  regex: RegExp;
  rule: StaticRule;
}

export interface RuleResult {
  deny: boolean;
  cacheControl?: string;
  headers: Record<string, string>;
}

/**
 * Compile a route-style glob for matching relative file paths. Reuses the
 * route compiler so there is one glob dialect and no user-supplied RegExp.
 * Matching is case-insensitive so deny rules hold on case-insensitive disks.
 */
export function compileGlob(pattern: string): RegExp {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new Error("static: glob patterns must be non-empty strings");
  }
  const trimmed = pattern.replace(/^\/+/, "");
  if (trimmed.split("/").some((seg) => seg.startsWith(":"))) {
    throw new Error(
      `static: glob "${pattern}" has a ":param" segment; use * or ** instead`,
    );
  }
  const { regex } = buildRouteRegex(`/${trimmed}`);
  return new RegExp(regex.source, "i");
}

/** True when `rel` (no leading slash) matches the compiled glob. */
export function matchesGlob(regex: RegExp, rel: string): boolean {
  return regex.test(`/${rel}`);
}

export function compileRules(rules: StaticRule[]): CompiledRule[] {
  return rules.map((rule) => {
    if (typeof rule !== "object" || rule === null) {
      throw new Error("static: each rule must be an object");
    }
    for (const key of Object.keys(rule)) {
      if (!["match", "cacheControl", "headers", "deny"].includes(key)) {
        throw new Error(`static: unknown rule option "${key}"`);
      }
    }
    return { regex: compileGlob(rule.match), rule };
  });
}

/** Fold every matching rule in order; later rules win per field. */
export function applyRules(rules: CompiledRule[], rel: string): RuleResult {
  const result: RuleResult = { deny: false, headers: {} };
  for (const { regex, rule } of rules) {
    if (!matchesGlob(regex, rel)) continue;
    if (rule.deny !== undefined) result.deny = rule.deny;
    if (rule.cacheControl !== undefined)
      result.cacheControl = rule.cacheControl;
    if (rule.headers) Object.assign(result.headers, rule.headers);
  }
  return result;
}
