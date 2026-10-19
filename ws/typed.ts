/**
 * A contract-typed view of a {@link WsConnection} for `c.ws().messages()`
 * sockets: inbound JSON is validated against the client schema, outbound
 * messages are typed (and validated in development).
 */

import * as v from "valibot";
import type { AnySchema } from "../core/index.ts";
import type { WsCloseListener, WsConnection } from "./connection.ts";
import type { WsMessage } from "./message.ts";
import {
  type WsCleanupFn,
  WsProtocolError,
  type WsSendResult,
} from "./types.ts";

/** Thrown in development when the server sends something off-contract. */
export class ContractViolationError extends Error {
  readonly issues: v.BaseIssue<unknown>[];

  constructor(what: string, issues: v.BaseIssue<unknown>[]) {
    const first = issues[0];
    const path = first?.path?.map((p) => String(p.key)).join(".") ?? "";
    super(
      `${what} does not match the contract${path ? ` at "${path}"` : ""}: ${first?.message ?? "invalid"}`,
    );
    this.name = "ContractViolationError";
    this.issues = issues;
  }
}

/**
 * Validate an inbound payload. Failure is the *client's* fault → protocol
 * error (`1008`); the reason names the first issue only in development.
 */
export function parseInbound<S extends AnySchema>(
  schema: S,
  value: unknown,
  development: boolean,
): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;
  const issue = result.issues[0];
  throw new WsProtocolError(
    development && issue
      ? `Invalid message: ${issue.message}`
      : "Invalid message",
  );
}

/**
 * In development, validate an outbound payload so contract drift surfaces
 * immediately. A no-op in production (types are the guarantee there).
 */
export function checkOutbound(
  schema: AnySchema | undefined,
  value: unknown,
  development: boolean,
  what: string,
): void {
  if (!development || schema == null) return;
  const result = v.safeParse(schema, value);
  if (!result.success) throw new ContractViolationError(what, result.issues);
}

export class TypedWsConnection<In, Out> {
  /** The untyped connection — pass this to hubs. */
  readonly connection: WsConnection;
  readonly #client: AnySchema;
  readonly #server: AnySchema;
  readonly #development: () => boolean;

  /** @internal Created by contract routes. */
  constructor(
    connection: WsConnection,
    schemas: { client: AnySchema; server: AnySchema },
    development: () => boolean,
  ) {
    this.connection = connection;
    this.#client = schemas.client;
    this.#server = schemas.server;
    this.#development = development;
  }

  get id(): string {
    return this.connection.id;
  }
  get req(): Request {
    return this.connection.req;
  }
  get protocol(): string | null {
    return this.connection.protocol;
  }
  get closed(): boolean {
    return this.connection.closed;
  }
  get remoteAddress(): string {
    return this.connection.remoteAddress;
  }
  get bufferedBytes(): number {
    return this.connection.bufferedBytes;
  }
  get data(): Record<string, unknown> {
    return this.connection.data;
  }
  set data(value: Record<string, unknown>) {
    this.connection.data = value;
  }

  /**
   * Validated inbound messages. Non-JSON or off-contract input closes the
   * socket with `1008` before `fn` runs.
   */
  onMessage(fn: (data: In, message: WsMessage) => unknown): () => void {
    return this.connection.onMessage((message) =>
      fn(
        parseInbound(this.#client, message.json(), this.#development()) as In,
        message,
      ),
    );
  }

  /** JSON-encode and send. Validated against the server schema in development. */
  send(data: Out): WsSendResult {
    checkOutbound(this.#server, data, this.#development(), "Outbound message");
    return this.connection.sendJson(data);
  }

  close(code?: number, reason?: string): void {
    this.connection.close(code, reason);
  }

  expireAt(when: Date | number): void {
    this.connection.expireAt(when);
  }

  onClose(fn: WsCloseListener | WsCleanupFn): void {
    this.connection.onClose(fn);
  }

  onDrain(fn: () => void): () => void {
    return this.connection.onDrain(fn);
  }
}
