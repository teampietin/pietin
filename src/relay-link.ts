/**
 * The extension's dial-out link to the relay.
 *
 * The laptop is behind NAT, so the extension always initiates the connection.
 * This module owns the socket lifecycle and enforces the two hard rules from
 * plans/base.md:
 *
 *  1. Never break the user's local terminal. A relay failure surfaces as a
 *     warning; it never throws into Pi's render path.
 *  2. Never block on the socket. If the send buffer is backed up, the frame
 *     is dropped — the browser detects the gap via `seq` and asks for a
 *     redraw (step 8). We do not await inside the output path.
 *  3. Never let a dropped socket end the session. Pi is still running, so the
 *     link reconnects with backoff and presents its old session id in `hello`
 *     (`resumeSessionId`). The relay hands the SAME id back, so the URL the
 *     user is holding survives a relay restart, a deploy, or a tunnel change.
 *     Frames produced while disconnected are dropped; viewers ask for a redraw
 *     when the relay tells them the laptop is back.
 *
 * We never log ANSI payloads here (plans/base.md §12).
 */

import {
  decode, encode, type ConversationEventPayload, type ConversationSnapshotPayload, type MessageType,
} from "./protocol/index.ts";

/** Above this many buffered bytes we drop output frames instead of queueing. */
const MAX_BUFFERED_BYTES = 1 << 20; // 1 MiB
/** 48 KiB decoded keeps each base64 WebSocket frame comfortably below 80 KiB. */
export const SNAPSHOT_CHUNK_BYTES = 48 * 1024;
/**
 * The relay accepts one atomic snapshot transfer of at most 240 chunks and
 * 16 MiB of framed data. Oversized history stays available through the
 * continuously-running Terminal view instead of consuming unbounded memory.
 */
export const SNAPSHOT_MAX_CHUNKS = 240;

export function conversationSnapshotFrames(
  snapshot: ConversationSnapshotPayload,
  sid: string,
  snapshotId: string = crypto.randomUUID(),
): string[] | undefined {
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  const chunks = Math.max(1, Math.ceil(bytes.length / SNAPSHOT_CHUNK_BYTES));
  if (chunks > SNAPSHOT_MAX_CHUNKS) return undefined;
  const frames = [encode("conversation_snapshot_begin", sid, {
    snapshotId, revision: snapshot.revision, cursor: snapshot.cursor, chunks,
  })];
  for (let index = 0; index < chunks; index += 1) {
    const data = bytes.subarray(index * SNAPSHOT_CHUNK_BYTES, (index + 1) * SNAPSHOT_CHUNK_BYTES).toString("base64");
    frames.push(encode("conversation_snapshot_chunk", sid, { snapshotId, index, data }));
  }
  frames.push(encode("conversation_snapshot_end", sid, { snapshotId, cursor: snapshot.cursor }));
  return frames;
}

export function conversationSnapshotTransfer(
  snapshot: ConversationSnapshotPayload,
  sid: string,
  snapshotId: string = crypto.randomUUID(),
): { frames: string[]; degraded: boolean } {
  const frames = conversationSnapshotFrames(snapshot, sid, snapshotId);
  if (frames) return { frames, degraded: false };

  // Publish a tiny canonical snapshot at the same cursor so clients become
  // synchronized, but make the loss of old history explicit and actionable.
  // ANSI continues independently, so Terminal remains a faithful fallback.
  const fallback: ConversationSnapshotPayload = {
    revision: snapshot.revision,
    cursor: snapshot.cursor,
    messages: [{
      id: "pietin:snapshot-too-large",
      role: "system",
      timestamp: 0,
      blocks: [{
        type: "unsupported",
        label: "Conversation history is too large for live transfer — open Terminal",
      }],
    }],
    tools: [],
    turnState: snapshot.turnState,
    model: snapshot.model,
    contextTokens: snapshot.contextTokens,
    contextPercent: snapshot.contextPercent,
  };
  return { frames: conversationSnapshotFrames(fallback, sid, snapshotId)!, degraded: true };
}

export interface RelayLinkOptions {
  url: string;
  token: string;
  sessionName: string;
  cwd: string;
  cols: number;
  rows: number;
  piVersion: string;
  /**
   * Called with the session id every time the relay acks a hello.
   *
   * `previous` is the id held before a reconnect: undefined on the first
   * connect, the SAME id when the session was resumed, and a different id when
   * the relay refused the resume — which means the URL changed and the user
   * has to be told.
   */
  onReady: (sessionId: string, previous: string | undefined) => void;
  /** Called on any non-fatal problem. Must never throw. */
  onError: (message: string) => void;
  /** The socket dropped and the link is retrying. The session is not over. */
  onDisconnected: (reason: string) => void;
  /** The link has given up for good: a fatal refusal, or close() was called. */
  onClose: (reason: string) => void;
  /** A viewer sent a prompt. Deliver it to the agent. */
  onPrompt: (text: string) => void;
  /** A capable viewer attached or reattached and needs canonical history. */
  onConversationSnapshotRequest: () => void;
  /** A viewer asked to interrupt the current turn. */
  onAbort: () => void;
  /** A viewer sent raw keystrokes (base64). Forward them to Pi's stdin. */
  onInput: (dataBase64: string) => void;
  /**
   * A viewer (late join or after a dropped frame) asked for a redraw. Force Pi
   * to re-emit a full-screen keyframe so the viewer gets a clean paint.
   */
  onRedraw: () => void;
  /** A viewer claimed the render size. Override Pi's view of the terminal. */
  onSetSize: (cols: number, rows: number) => void;
  /** A viewer handed the size back to the physical terminal. */
  onReleaseSize: () => void;
}

export interface RelayLink {
  /** True once the relay has acked and we have a session id. */
  readonly ready: boolean;
  /** The session id, once known. */
  readonly sessionId: string | undefined;
  /** Send a base64 output chunk. Non-blocking; drops when backed up. */
  sendOutput: (dataBase64: string, seq: number) => void;
  /** Report the current render size and who owns it. Best-effort. */
  sendResize: (cols: number, rows: number, owner: "local" | "browser") => void;
  /** Send canonical structured history. Best-effort and memory-only. */
  sendConversationSnapshot: (snapshot: ConversationSnapshotPayload) => void;
  /** Send one ordered structured update. */
  sendConversationEvent: (event: ConversationEventPayload, seq: number) => void;
  /** Close the link cleanly (sends `bye` if connected). Idempotent. */
  close: () => void;
}

/**
 * Backoff for the extension's reconnect. The same shape the browser uses, but
 * it never gives up: Pi is still running, and as long as it is, the laptop
 * should keep trying to get its session back.
 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export function connectRelay(opts: RelayLinkOptions): RelayLink {
  let sessionId: string | undefined;
  let ready = false;
  /** The link is finished for good: close() was called, or the relay refused us. */
  let closed = false;
  let ws: WebSocket | undefined;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const open = (): boolean => !closed && ready && ws?.readyState === WebSocket.OPEN;

  const link: RelayLink = {
    get ready() {
      return ready;
    },
    get sessionId() {
      return sessionId;
    },
    sendOutput(dataBase64, seq) {
      if (!open()) return;
      // Drop rather than block Pi's render path.
      if (ws!.bufferedAmount > MAX_BUFFERED_BYTES) return;
      trySend("output", sessionId!, { data: dataBase64 }, seq);
    },
    sendResize(cols, rows, owner) {
      if (!open()) return;
      trySend("resize", sessionId!, { cols, rows, owner });
    },
    sendConversationSnapshot(snapshot) {
      if (!open()) return;
      const transfer = conversationSnapshotTransfer(snapshot, sessionId!);
      if (transfer.degraded) {
        const limitMiB = Math.floor(SNAPSHOT_MAX_CHUNKS * SNAPSHOT_CHUNK_BYTES / (1024 * 1024));
        opts.onError(`conversation snapshot exceeds the ${limitMiB} MiB relay transfer limit; use Terminal view`);
      }
      // This loop is deliberately synchronous: the relay accepts only a
      // contiguous transfer and publishes it to each viewer as one queue unit.
      for (const frame of transfer.frames) {
        try {
          ws!.send(frame);
        } catch (err) {
          opts.onError(`relay send failed: ${String(err)}`);
          return;
        }
      }
    },
    sendConversationEvent(event, seq) {
      if (!open()) return;
      trySend("conversation_event", sessionId!, event, seq);
    },
    close() {
      if (closed) return;
      closed = true;
      ready = false;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      try {
        // `bye` tells the relay this is a deliberate stop, not a drop — it ends
        // the session at once instead of holding the id open for a resume.
        if (ws?.readyState === WebSocket.OPEN) ws.send(encode("bye", sessionId ?? "", {}));
      } catch {
        // ignore — we are closing anyway
      }
      try {
        ws?.close();
      } catch {
        // ignore
      }
    },
  };

  function trySend<T extends MessageType>(
    type: T,
    sid: string,
    payload: unknown,
    seq?: number,
  ): void {
    try {
      // encode is typed per message; cast is safe because callers pass the
      // matching payload for `type`.
      ws!.send(encode(type, sid, payload as never, seq));
    } catch (err) {
      opts.onError(`relay send failed: ${String(err)}`);
    }
  }

  /** Gives up for good. Only a refusal we cannot outlast gets here. */
  function fail(reason: string): void {
    if (closed) return;
    closed = true;
    ready = false;
    opts.onClose(reason);
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    const delay = backoff + Math.random() * backoff * 0.25; // jitter, avoid stampede
    attempt += 1;
    reconnectTimer = setTimeout(dial, delay);
  }

  function dial(): void {
    if (closed) return;
    reconnectTimer = undefined;

    let socket: WebSocket;
    try {
      socket = new WebSocket(opts.url);
    } catch (err) {
      // A URL the WebSocket constructor rejects will never become valid.
      fail(`could not open relay socket: ${String(err)}`);
      return;
    }
    ws = socket;

    socket.addEventListener("open", () => {
      if (closed || ws !== socket) return;
      trySend("hello", "", {
        token: opts.token,
        sessionName: opts.sessionName,
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        piVersion: opts.piVersion,
        capabilities: ["structured_session"],
        // Ask for the session back. Empty on the first connect; after that it
        // is what keeps the user's URL alive across a relay restart.
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
      });
    });

    socket.addEventListener("message", (ev) => {
      if (closed || ws !== socket) return;
      const data = (ev as { data: unknown }).data;
      const raw = typeof data === "string" ? data : undefined;
      if (raw === undefined) return; // relay only sends text frames to the extension
      const res = decode(raw);
      if (!res.ok) {
        opts.onError(`relay sent an invalid frame: ${res.error}`);
        return;
      }
      const env = res.envelope;
      if (env.type === "ack") {
        const previous = sessionId;
        sessionId = env.sid;
        ready = true;
        attempt = 0; // a working connection earns a clean backoff
        opts.onReady(sessionId, previous);
      } else if (env.type === "error") {
        const p = env.payload as { code: string; message: string };
        if (p.code === "unauthorized") {
          // Retrying cannot fix a token the relay does not know.
          fail(`relay refused connection: ${p.message} (${p.code})`);
          return;
        }
        opts.onError(`relay refused connection: ${p.message} (${p.code})`);
      } else if (env.type === "prompt") {
        // Never log prompt text (plans/base.md §12). Hand it straight to Pi.
        const p = env.payload as { text: string };
        opts.onPrompt(p.text);
      } else if (env.type === "conversation_snapshot_request") {
        opts.onConversationSnapshotRequest();
      } else if (env.type === "abort") {
        opts.onAbort();
      } else if (env.type === "input") {
        // Raw keystrokes — never logged (plans/base.md §12). Pass the base64
        // through; the caller decodes and feeds Pi's stdin.
        const p = env.payload as { data: string };
        opts.onInput(p.data);
      } else if (env.type === "request_redraw") {
        // Empty control frame — force a full repaint. Nothing to log.
        opts.onRedraw();
      } else if (env.type === "set_size") {
        const p = env.payload as { cols: number; rows: number };
        opts.onSetSize(p.cols, p.rows);
      } else if (env.type === "release_size") {
        opts.onReleaseSize();
      }
    });

    socket.addEventListener("error", () => {
      if (closed || ws !== socket) return;
      // Always followed by close, which drives the reconnect. Report only.
      opts.onError("relay connection error");
    });

    socket.addEventListener("close", (ev) => {
      if (ws !== socket) return; // a newer socket already took over
      ready = false;
      if (closed) return;
      const { code, reason } = ev as { code: number; reason: string };
      opts.onDisconnected(reason || `code ${code}`);
      scheduleReconnect();
    });
  }

  dial();

  return link;
}
