import assert from "node:assert/strict";
import test from "node:test";
import { decode, type ConversationSnapshotPayload } from "./protocol/index.ts";
import {
  conversationSnapshotFrames,
  conversationSnapshotTransfer,
  SNAPSHOT_CHUNK_BYTES,
  SNAPSHOT_MAX_CHUNKS,
} from "./relay-link.ts";

function snapshot(text: string): ConversationSnapshotPayload {
  return {
    revision: 1,
    cursor: 0,
    messages: [{
      id: "large-history",
      role: "assistant",
      timestamp: 1,
      blocks: [{ type: "markdown", text }],
    }],
    tools: [],
    turnState: "idle",
  };
}

test("snapshot transfer always fits the relay's 256-frame viewer queue", () => {
  const frames = conversationSnapshotFrames(
    snapshot("x".repeat(SNAPSHOT_CHUNK_BYTES * (SNAPSHOT_MAX_CHUNKS - 1))),
    "s_test",
    "snap-fit",
  );
  assert.ok(frames);
  assert.ok(frames.length <= 242, `begin + chunks + end produced ${frames.length} frames`);
});

test("snapshot beyond the relay queue bound degrades atomically to Terminal fallback", () => {
  const oversized = snapshot("secret-history".repeat(SNAPSHOT_CHUNK_BYTES * 24));
  assert.equal(conversationSnapshotFrames(oversized, "s_test", "snap-too-large"), undefined);

  const transfer = conversationSnapshotTransfer(oversized, "s_test", "snap-fallback");
  assert.equal(transfer.degraded, true);
  assert.equal(transfer.frames.length, 3, "fallback is one bounded chunk plus begin/end");
  assert.doesNotMatch(transfer.frames.join(""), /secret-history/);

  const chunk = decode(transfer.frames[1]!);
  assert.equal(chunk.ok, true);
  if (!chunk.ok || chunk.envelope.type !== "conversation_snapshot_chunk") return;
  const data = (chunk.envelope.payload as { data: string }).data;
  const fallback = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as ConversationSnapshotPayload;
  assert.equal(fallback.cursor, oversized.cursor);
  assert.equal(fallback.messages[0]?.blocks[0]?.type, "unsupported");
});
