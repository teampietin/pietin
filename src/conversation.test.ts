import assert from "node:assert/strict";
import test from "node:test";
import { ConversationProjection, MAX_TOOL_TEXT_BYTES, sanitizeStructuredText } from "./conversation.ts";

test("snapshot includes history from before sharing and completed content wins", () => {
  const projection = new ConversationProjection([
    { type: "message", id: "entry-1", message: { role: "user", content: "hello", timestamp: 1 } },
    { type: "message", id: "entry-2", message: {
      role: "assistant", timestamp: 2,
      content: [{ type: "text", text: "hi" }, { type: "thinking", thinking: "reason" }],
    } },
  ]);

  const partial = projection.startMessage({ role: "assistant", content: [{ type: "text", text: "work" }], timestamp: 3 });
  assert.equal(partial?.kind, "message_upsert");
  projection.endMessage({ role: "assistant", content: [{ type: "text", text: "worked" }], timestamp: 3 });

  const snapshot = projection.snapshot();
  assert.deepEqual(snapshot.messages.map((m) => m.id), ["entry:entry-1", "entry:entry-2", "live:1"]);
  assert.equal(snapshot.messages[1]?.blocks[1]?.type, "thinking");
  assert.deepEqual(snapshot.messages[2]?.blocks, [{ type: "markdown", text: "worked" }]);
  assert.equal(snapshot.messages[2]?.streaming, undefined);
});

test("tool details are capped and recursively omit binary image content", () => {
  const projection = new ConversationProjection();
  const event = projection.startTool("call-1", "read", {
    filename: "chart.png",
    data: "filename-inferred-secret-image",
    nested: [{ source: { type: "base64", media_type: "image/png", data: "secret-base64-image" } }],
    preview: "data:image/jpeg;base64,another-secret-image",
    bytes: Buffer.from("raw-secret-bytes"),
    useful: { caption: "quarterly chart", count: 3 },
    largeText: "x".repeat(MAX_TOOL_TEXT_BYTES + 100),
  });
  assert.equal(event.kind, "tool_upsert");
  if (event.kind !== "tool_upsert") return;
  assert.equal(event.tool.argumentsTruncated, true);
  assert.ok(Buffer.byteLength(event.tool.arguments ?? "", "utf8") <= MAX_TOOL_TEXT_BYTES);
  assert.match(event.tool.arguments ?? "", /quarterly chart/);
  assert.match(event.tool.arguments ?? "", /chart\.png/);
  assert.doesNotMatch(event.tool.arguments ?? "", /filename-inferred-secret-image|secret-base64-image|another-secret-image|raw-secret-bytes/);

  const partial = projection.updateTool("call-1", "read", {}, {
    content: [{ type: "image", mimeType: "image/png", data: "partial-secret-image" }],
    text: "useful partial output",
  });
  assert.equal(partial.kind, "tool_upsert");
  if (partial.kind === "tool_upsert") {
    assert.equal(partial.tool.status, "running");
    assert.match(partial.tool.result ?? "", /useful partial output/);
    assert.doesNotMatch(partial.tool.result ?? "", /partial-secret-image/);
  }

  const finished = projection.finishTool("call-1", "read", {
    result: "done",
    image: "final-secret-image",
  }, false);
  assert.equal(finished.kind, "tool_upsert");
  if (finished.kind === "tool_upsert") {
    assert.equal(finished.tool.status, "success");
    assert.match(finished.tool.result ?? "", /done/);
    assert.doesNotMatch(finished.tool.result ?? "", /final-secret-image/);
  }

  const message = projection.startMessage({
    role: "user", timestamp: 4, content: [{ type: "image", data: "secret-message-image", mimeType: "image/png" }],
  });
  assert.equal(message?.kind, "message_upsert");
  if (message?.kind === "message_upsert") {
    assert.deepEqual(message.message.blocks, [{ type: "unsupported", label: "Image content — open Terminal" }]);
    assert.doesNotMatch(JSON.stringify(message), /secret-message-image/);
  }
});

test("tool start, update, and final sanitize every data URI and blob URL", () => {
  const projection = new ConversationProjection();
  const start = projection.startTool("call-urls", "fetch", {
    base64Document: "start before data:application/pdf;base64,c3RhcnQtc2VjcmV0 start after",
    percentEncoded: "encoded before data:text/plain;charset=UTF-8,start%20secret encoded after",
    blob: "blob before blob:https://example.test/start-secret blob after",
  });
  assert.equal(start.kind, "tool_upsert");
  if (start.kind !== "tool_upsert") return;
  assert.doesNotMatch(start.tool.arguments ?? "", /c3RhcnQtc2VjcmV0|start%20secret|blob:https/);
  assert.match(start.tool.arguments ?? "", /start before.*start after/s);
  assert.match(start.tool.arguments ?? "", /encoded before.*encoded after/s);
  assert.match(start.tool.arguments ?? "", /blob before.*blob after/s);
  assert.match(start.tool.arguments ?? "", /embedded payload omitted by pietin/);

  const update = projection.updateTool("call-urls", "fetch", {}, {
    base64Audio: "update before data:audio/ogg;base64,dXBkYXRlLXNlY3JldA== update after",
    percentEncoded: "percent before data:application/json,%7B%22secret%22%3Atrue%7D percent after",
    nested: ["url before blob:https://example.test/update-secret url after"],
  });
  assert.equal(update.kind, "tool_upsert");
  if (update.kind !== "tool_upsert") return;
  assert.doesNotMatch(update.tool.result ?? "", /dXBkYXRlLXNlY3JldA==|%7B%22secret|update-secret|blob:https/);
  assert.match(update.tool.result ?? "", /update before.*update after/s);
  assert.match(update.tool.result ?? "", /percent before.*percent after/s);
  assert.match(update.tool.result ?? "", /url before.*url after/s);

  const final = projection.finishTool("call-urls", "fetch", {
    base64Archive: "final before data:application/zip;base64,ZmluYWwtc2VjcmV0 final after",
    percentDefaultMedia: "default before data:,final%20secret default after",
    link: "link before blob:http://example.test/final-secret link after",
  }, false);
  assert.equal(final.kind, "tool_upsert");
  if (final.kind !== "tool_upsert") return;
  assert.doesNotMatch(final.tool.result ?? "", /ZmluYWwtc2VjcmV0|final%20secret|final-secret|blob:http/);
  assert.match(final.tool.result ?? "", /final before.*final after/s);
  assert.match(final.tool.result ?? "", /default before.*default after/s);
  assert.match(final.tool.result ?? "", /link before.*link after/s);
  assert.match(final.tool.result ?? "", /embedded payload omitted by pietin/);
});

test("live message identity survives lifecycle and same-timestamp messages do not collide", () => {
  const projection = new ConversationProjection([
    { type: "message", id: "a", message: { role: "assistant", content: "one", timestamp: 9 } },
    { type: "message", id: "b", message: { role: "assistant", content: "two", timestamp: 9 } },
  ]);
  const start = projection.startMessage({ role: "assistant", content: "h", timestamp: 9 });
  const update = projection.updateMessage({ role: "assistant", content: "he", timestamp: 10 });
  const end = projection.endMessage({ role: "assistant", content: "hello", timestamp: 11 });
  if (start?.kind !== "message_upsert" || update?.kind !== "message_upsert" || end?.kind !== "message_upsert") {
    return assert.fail("expected messages");
  }
  assert.equal(start.message.id, update.message.id);
  assert.equal(update.message.id, end.message.id);
  const snapshot = projection.snapshot();
  assert.equal(new Set(snapshot.messages.map((message) => message.id)).size, 3);
  assert.deepEqual(snapshot.messages.filter((message) => message.id.startsWith("entry:")).map((message) => message.id), ["entry:a", "entry:b"]);
});

test("structured text strips all data/blob URLs but preserves ambiguous base64", () => {
  const ambiguous = "This token may be useful: aGVsbG8gd29ybGQ=";
  assert.equal(sanitizeStructuredText(ambiguous), ambiguous);
  const projection = new ConversationProjection();
  const event = projection.startMessage({
    role: "assistant",
    timestamp: 1,
    errorMessage: "failed data:application/problem+json,%7B%22secret%22%3Atrue%7D then blob:https://example.test/id safely",
    content: [
      { type: "text", text: "[document](data:application/pdf;base64,c2VjcmV0) useful prose" },
      { type: "thinking", thinking: "inspect data:text/plain,think%20secret and blob:https://example.test/secret then continue" },
    ],
  });
  assert.equal(event?.kind, "message_upsert");
  const wire = JSON.stringify(event);
  assert.doesNotMatch(wire, /c2VjcmV0|think%20secret|blob:https/);
  assert.match(wire, /useful prose|then continue|failed|safely/);
});

test("structured URI scanning strips legal apostrophes and parentheses without eating Markdown delimiters", () => {
  const omitted = "[embedded payload omitted by pietin]";
  assert.equal(sanitizeStructuredText("data:text/plain,abc'def"), omitted);
  assert.equal(sanitizeStructuredText("data:text/plain,abc(def)ghi"), omitted);
  assert.equal(sanitizeStructuredText("blob:https://example.test/abc'def"), omitted);
  assert.equal(sanitizeStructuredText("blob:https://example.test/abc(def)ghi"), omitted);
  assert.equal(
    sanitizeStructuredText("before data:application/json,{secret:[payload]} after"),
    `before ${omitted} after`,
  );
  assert.equal(
    sanitizeStructuredText("before <data:text/plain,secret's(payload)> after"),
    `before <${omitted}> after`,
  );
  assert.equal(
    sanitizeStructuredText("before [download](data:text/plain,secret's(nested(payload))) after"),
    `before [download](${omitted}) after`,
  );
  assert.equal(
    sanitizeStructuredText("before [download](blob:https://example.test/secret's(payload)) after"),
    `before [download](${omitted}) after`,
  );
  assert.equal(
    sanitizeStructuredText("before data:text/plain,secret's(payload) after"),
    `before ${omitted} after`,
  );
  assert.equal(
    sanitizeStructuredText("metadata:text/plain,not-a-uri and xblob:https://example.test/not-a-uri"),
    "metadata:text/plain,not-a-uri and xblob:https://example.test/not-a-uri",
  );
});

test("tool start, update, and final values strip complete embedded URI payloads", () => {
  const projection = new ConversationProjection();
  const start = projection.startTool("tool-1", "fetch", {
    source: "data:text/plain,start's(payload)",
  });
  const update = projection.updateTool(
    "tool-1",
    "fetch",
    undefined,
    "partial blob:https://example.test/update's(payload) prose",
  );
  const final = projection.finishTool(
    "tool-1",
    "fetch",
    { result: "[result](data:application/octet-stream;base64,final's(payload)) okay" },
    false,
  );

  for (const event of [start, update, final]) {
    const wire = JSON.stringify(event);
    assert.doesNotMatch(wire, /start's|update's|final's|blob:https|data:/);
  }
  assert.match(JSON.stringify(start), /embedded payload omitted by pietin/);
  assert.match(JSON.stringify(update), /partial .* prose/);
  assert.match(JSON.stringify(final), /okay/);
});

test("structured event sequence is monotonic", () => {
  const projection = new ConversationProjection();
  const one = projection.next(projection.setTurnState("streaming"));
  const two = projection.next(projection.setTurnState("idle"));
  assert.equal(one.seq, 1);
  assert.equal(two.seq, 2);
  assert.equal(projection.snapshot().cursor, 2);
});
