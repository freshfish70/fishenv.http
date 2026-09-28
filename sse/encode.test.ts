import { assertEquals, assertStringIncludes } from "@std/assert";
import { encodeSseComment, encodeSseEvent, encodeSseRetry } from "./encode.ts";

Deno.test("encodeSseEvent: splits multiline data across data: lines", () => {
  assertEquals(
    encodeSseEvent("line one\nline two"),
    "data: line one\ndata: line two\n\n",
  );
});

Deno.test("encodeSseEvent: normalizes CRLF and lone CR in data", () => {
  assertEquals(encodeSseEvent("a\r\nb\rc"), "data: a\ndata: b\ndata: c\n\n");
});

Deno.test("encodeSseEvent: serializes objects as JSON on one line", () => {
  assertEquals(
    encodeSseEvent({ id: 1, name: "fish" }, { event: "update", id: "7" }),
    'id: 7\nevent: update\ndata: {"id":1,"name":"fish"}\n\n',
  );
});

Deno.test(
  "encodeSseEvent: strips CR/LF/NUL from id and event (frame injection)",
  () => {
    const frame = encodeSseEvent("ok", {
      id: "1\n\nevent: admin\ndata: pwned",
      event: "safe\nretry: 1",
    });
    assertEquals(
      frame,
      "id: 1event: admindata: pwned\nevent: saferetry: 1\ndata: ok\n\n",
    );
    // Exactly one blank-line terminator == exactly one event.
    assertEquals(frame.split("\n\n").length, 2);
  },
);

Deno.test("encodeSseEvent: writes retry as an integer", () => {
  assertStringIncludes(encodeSseEvent("x", { retry: 1500.9 }), "retry: 1500\n");
});

Deno.test("encodeSseRetry: standalone retry frame", () => {
  assertEquals(encodeSseRetry(5000.7), "retry: 5000\n\n");
});

Deno.test("encodeSseComment: sanitizes the comment body", () => {
  assertEquals(encodeSseComment("ka"), ": ka\n\n");
  assertEquals(encodeSseComment("a\nb"), ": ab\n\n");
});
