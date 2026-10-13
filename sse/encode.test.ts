import { expect, test } from "bun:test";
import { encodeSseComment, encodeSseEvent, encodeSseRetry } from "./encode.ts";

test("encodeSseEvent: splits multiline data across data: lines", () => {
  expect(encodeSseEvent("line one\nline two")).toEqual(
    "data: line one\ndata: line two\n\n",
  );
});

test("encodeSseEvent: normalizes CRLF and lone CR in data", () => {
  expect(encodeSseEvent("a\r\nb\rc")).toEqual("data: a\ndata: b\ndata: c\n\n");
});

test("encodeSseEvent: serializes objects as JSON on one line", () => {
  expect(
    encodeSseEvent({ id: 1, name: "fish" }, { event: "update", id: "7" }),
  ).toEqual('id: 7\nevent: update\ndata: {"id":1,"name":"fish"}\n\n');
});

test("encodeSseEvent: strips CR/LF/NUL from id and event (frame injection)", () => {
  const frame = encodeSseEvent("ok", {
    id: "1\n\nevent: admin\ndata: pwned",
    event: "safe\nretry: 1",
  });
  expect(frame).toEqual(
    "id: 1event: admindata: pwned\nevent: saferetry: 1\ndata: ok\n\n",
  );
  // Exactly one blank-line terminator == exactly one event.
  expect(frame.split("\n\n").length).toEqual(2);
});

test("encodeSseEvent: writes retry as an integer", () => {
  expect(encodeSseEvent("x", { retry: 1500.9 })).toContain("retry: 1500\n");
});

test("encodeSseRetry: standalone retry frame", () => {
  expect(encodeSseRetry(5000.7)).toEqual("retry: 5000\n\n");
});

test("encodeSseComment: sanitizes the comment body", () => {
  expect(encodeSseComment("ka")).toEqual(": ka\n\n");
  expect(encodeSseComment("a\nb")).toEqual(": ab\n\n");
});
