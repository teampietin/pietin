import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode, type ConversationSnapshotPayload } from "./protocol/index.ts";
import {
  connectRelay,
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

// --- reconnect -------------------------------------------------------------
// These drive connectRelay against a stub socket. The link's job when the relay
// goes away is to come back with the same session id; both tests below failed
// against a real relay before the fixes they cover.

class StubSocket {
  static instances: StubSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = StubSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  private listeners = new Map<string, ((ev: unknown) => void)[]>();

  // Not a parameter property: node --experimental-strip-types cannot compile
  // those, and this file runs under it.
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    StubSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  send(frame: string): void { this.sent.push(frame); }
  close(): void { this.readyState = StubSocket.CLOSED; }

  private emit(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  /** The handshake completed; the link sends its hello. */
  accept(): void {
    this.readyState = StubSocket.OPEN;
    this.emit("open");
  }

  /** The relay acks, handing back a session id. */
  ack(sid: string): void {
    this.emit("message", { data: encode("ack", sid, {}) });
  }

  /** The socket dropped — a relay restart, or a refused dial. */
  drop(code = 1006, reason = ""): void {
    this.readyState = StubSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  static reset(): void { StubSocket.instances.length = 0; }
}

function linkOptions(over: Partial<Parameters<typeof connectRelay>[0]> = {}) {
  return {
    url: "ws://relay.test/ws/extension",
    token: "ptm_test",
    sessionName: "pietin",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    piVersion: "0",
    onReady: () => {},
    onError: () => {},
    onDisconnected: () => {},
    onClose: () => {},
    onPrompt: () => {},
    onConversationSnapshotRequest: () => {},
    onAbort: () => {},
    onInput: () => {},
    onRedraw: () => {},
    onSetSize: () => {},
    onReleaseSize: () => {},
    ...over,
  };
}

function helloOf(socket: StubSocket) {
  const raw = socket.sent.find((f) => f.includes('"hello"'));
  assert.ok(raw, "no hello was sent");
  const res = decode(raw);
  assert.ok(res.ok, "hello did not decode");
  return res.envelope.payload as { resumeSessionId?: string };
}

test("a reconnect asks for the session it had, so the user's URL survives", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = StubSocket;
  StubSocket.reset();
  t.after(() => { (globalThis as { WebSocket: unknown }).WebSocket = original; });

  const link = connectRelay(linkOptions());
  const first = StubSocket.instances[0]!;
  first.accept();
  first.ack("s_abc123");
  assert.equal(link.sessionId, "s_abc123");
  assert.equal(helloOf(first).resumeSessionId, undefined, "a first hello resumes nothing");

  // The relay restarts under us.
  first.drop();
  t.mock.timers.tick(1000);

  const second = StubSocket.instances[1];
  assert.ok(second, "the link did not dial again after the socket dropped");
  second.accept();
  assert.equal(helloOf(second).resumeSessionId, "s_abc123",
    "the reconnect did not ask for the old session back");
});

test("a consumer callback that throws cannot stop the link reconnecting", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = StubSocket;
  StubSocket.reset();
  t.after(() => { (globalThis as { WebSocket: unknown }).WebSocket = original; });

  // ctx.ui.notify throws in some TUI states. It used to take the retry chain
  // with it: the laptop never came back and the session expired.
  connectRelay(linkOptions({
    onDisconnected: () => { throw new Error("ui.notify blew up"); },
    onReady: () => { throw new Error("ui.notify blew up"); },
  }));

  const first = StubSocket.instances[0]!;
  first.accept();
  first.ack("s_abc123");
  first.drop();
  t.mock.timers.tick(1000);

  const second = StubSocket.instances[1];
  assert.ok(second, "a throwing callback killed the reconnect");
  second.accept();
  assert.equal(helloOf(second).resumeSessionId, "s_abc123");
});
