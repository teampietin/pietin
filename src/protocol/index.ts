import { z } from "zod";

/**
 * Wire protocol for pietin.
 *
 * This package is the SOURCE OF TRUTH. The Go relay hand-maintains matching
 * structs in apps/relay/internal/protocol. A golden-file round-trip test on
 * both sides guards against drift — see testdata/golden.json.
 *
 * Every frame carries `v`. Bump it on any breaking change.
 */

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Extension -> relay
// ---------------------------------------------------------------------------

/** First frame on an extension socket. Authenticates and registers a session. */
export const HelloPayload = z.object({
  token: z.string().min(1),
  sessionName: z.string(),
  cwd: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  piVersion: z.string(),
  /** Optional features understood by this extension. */
  capabilities: z.array(z.string()).optional(),
});

/** A chunk of raw ANSI captured from Pi's stdout. Base64 — it is not text. */
export const OutputPayload = z.object({
  /** base64-encoded bytes */
  data: z.string(),
});

/**
 * Raw keystrokes captured in the browser, forwarded to Pi's stdin so its own
 * input widget echoes them. base64 of the terminal byte sequence (arrows,
 * ctrl-c, and typed text all encode here). Never rendered — it flows the other
 * way. See the "keystroke passthrough" path.
 */
export const InputPayload = z.object({
  /** base64-encoded terminal input bytes */
  data: z.string(),
});

/**
 * The size Pi is currently rendering at, and who chose it.
 *
 * `owner: "local"` means the laptop's physical terminal decides (the default).
 * `owner: "browser"` means a viewer has overridden the size via `set_size` and
 * the laptop's own window no longer constrains the render. Viewers use this to
 * show the right control state, and to drop their override UI the moment the
 * person at the laptop takes the size back.
 */
export const ResizePayload = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  owner: z.enum(["local", "browser"]),
});

/**
 * A viewer claims the render size. The extension overrides Pi's view of
 * `process.stdout.columns/rows` and forces a re-layout, so the laptop's window
 * stops constraining the draw. Any keypress at the laptop releases it.
 */
export const SetSizePayload = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** Structured sidechannel for browser chrome. Never used for rendering. */
export const MetaPayload = z.object({
  model: z.string().nullable(),
  streaming: z.boolean(),
  contextTokens: z.number().int().nonnegative().nullable(),
  contextPercent: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Browser -> relay
// ---------------------------------------------------------------------------

export const AttachPayload = z.object({
  sessionId: z.string().min(1),
  /** Optional features understood by this viewer. */
  capabilities: z.array(z.string()).optional(),
});

export const PromptPayload = z.object({
  text: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Structured conversation projection (extension -> viewer)
// ---------------------------------------------------------------------------

const KnownConversationBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("markdown"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string(), redacted: z.boolean().optional() }),
  z.object({
    type: z.literal("tool"), id: z.string(), name: z.string(),
    status: z.enum(["pending", "running", "success", "error"]),
    arguments: z.string().optional(), result: z.string().optional(),
    argumentsTruncated: z.boolean().optional(), resultTruncated: z.boolean().optional(),
  }),
  z.object({ type: z.literal("unsupported"), label: z.string() }),
]);

/** Unknown future blocks stay renderable as a Terminal fallback card. */
export const ConversationBlock = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const type = (value as { type?: unknown }).type;
  if (typeof type === "string" && !["markdown", "thinking", "tool", "unsupported"].includes(type)) {
    return { type: "unsupported", label: `Unsupported ${type} content — open Terminal` };
  }
  return value;
}, KnownConversationBlock);

export const ConversationMessage = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  timestamp: z.number(),
  blocks: z.array(ConversationBlock),
  streaming: z.boolean().optional(),
  error: z.string().optional(),
});

export const ConversationTool = z.object({
  id: z.string(), name: z.string(),
  status: z.enum(["pending", "running", "success", "error"]),
  arguments: z.string().optional(), result: z.string().optional(),
  argumentsTruncated: z.boolean().optional(), resultTruncated: z.boolean().optional(),
});

export const TurnState = z.enum(["idle", "thinking", "streaming", "error"]);

export const ConversationSnapshotPayload = z.object({
  revision: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  messages: z.array(ConversationMessage),
  tools: z.array(ConversationTool),
  turnState: TurnState,
  model: z.string().nullable().optional(),
  contextTokens: z.number().int().nonnegative().nullable().optional(),
  contextPercent: z.number().nullable().optional(),
});

/** Snapshots are UTF-8 JSON split into bounded base64 chunks. */
export const ConversationSnapshotBeginPayload = z.object({
  snapshotId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  chunks: z.number().int().positive(),
});
export const ConversationSnapshotChunkPayload = z.object({
  snapshotId: z.string().min(1),
  index: z.number().int().nonnegative(),
  data: z.string(),
});
export const ConversationSnapshotEndPayload = z.object({
  snapshotId: z.string().min(1),
  cursor: z.number().int().nonnegative(),
});

export const ConversationEventPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message_upsert"), message: ConversationMessage }),
  z.object({ kind: z.literal("tool_upsert"), tool: ConversationTool }),
  z.object({ kind: z.literal("turn_state"), state: TurnState }),
  z.object({
    kind: z.literal("meta"), model: z.string().nullable(),
    contextTokens: z.number().int().nonnegative().nullable(),
    contextPercent: z.number().nullable(),
  }),
]);

// ---------------------------------------------------------------------------
// Relay -> browser
// ---------------------------------------------------------------------------

export const SessionEndPayload = z.object({
  reason: z.enum(["extension_disconnected", "stopped", "error"]),
});

export const ErrorPayload = z.object({
  code: z.string(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const MessageType = z.enum([
  // extension -> relay
  "hello",
  "output",
  "resize",
  "meta",
  "conversation_snapshot_begin",
  "conversation_snapshot_chunk",
  "conversation_snapshot_end",
  "conversation_event",
  "bye",
  // browser -> relay
  "attach",
  "prompt",
  "conversation_snapshot_request",
  "abort",
  "input",
  "request_redraw",
  "set_size",
  "release_size",
  // relay -> client
  "session_end",
  "error",
  "ack",
]);
export type MessageType = z.infer<typeof MessageType>;

export const Envelope = z.object({
  /** Protocol version. Always PROTOCOL_VERSION when sending. */
  v: z.literal(PROTOCOL_VERSION),
  type: MessageType,
  /** Session id. Empty on `hello`, which is what creates the session. */
  sid: z.string(),
  /**
   * Monotonic stream counter on `output` (terminal gaps) and
   * `conversation_event` (semantic snapshot/event ordering).
   */
  seq: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof Envelope>;

export type HelloPayload = z.infer<typeof HelloPayload>;
export type OutputPayload = z.infer<typeof OutputPayload>;
export type ResizePayload = z.infer<typeof ResizePayload>;
export type SetSizePayload = z.infer<typeof SetSizePayload>;
export type MetaPayload = z.infer<typeof MetaPayload>;
export type AttachPayload = z.infer<typeof AttachPayload>;
export type PromptPayload = z.infer<typeof PromptPayload>;
export type InputPayload = z.infer<typeof InputPayload>;
export type SessionEndPayload = z.infer<typeof SessionEndPayload>;
export type ErrorPayload = z.infer<typeof ErrorPayload>;
export type ConversationBlock = z.infer<typeof ConversationBlock>;
export type ConversationMessage = z.infer<typeof ConversationMessage>;
export type ConversationTool = z.infer<typeof ConversationTool>;
export type TurnState = z.infer<typeof TurnState>;
export type ConversationSnapshotPayload = z.infer<typeof ConversationSnapshotPayload>;
export type ConversationSnapshotBeginPayload = z.infer<typeof ConversationSnapshotBeginPayload>;
export type ConversationSnapshotChunkPayload = z.infer<typeof ConversationSnapshotChunkPayload>;
export type ConversationSnapshotEndPayload = z.infer<typeof ConversationSnapshotEndPayload>;
export type ConversationEventPayload = z.infer<typeof ConversationEventPayload>;

/** Maps each message type to its payload schema. */
export const PayloadSchemas = {
  hello: HelloPayload,
  output: OutputPayload,
  resize: ResizePayload,
  meta: MetaPayload,
  conversation_snapshot_begin: ConversationSnapshotBeginPayload,
  conversation_snapshot_chunk: ConversationSnapshotChunkPayload,
  conversation_snapshot_end: ConversationSnapshotEndPayload,
  conversation_event: ConversationEventPayload,
  bye: z.object({}),
  attach: AttachPayload,
  prompt: PromptPayload,
  conversation_snapshot_request: z.object({}),
  abort: z.object({}),
  input: InputPayload,
  request_redraw: z.object({}),
  set_size: SetSizePayload,
  release_size: z.object({}),
  session_end: SessionEndPayload,
  error: ErrorPayload,
  ack: z.object({}),
} as const satisfies Record<MessageType, z.ZodType>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function encode<T extends MessageType>(
  type: T,
  sid: string,
  payload: z.infer<(typeof PayloadSchemas)[T]>,
  seq?: number,
): string {
  const env: Envelope = { v: PROTOCOL_VERSION, type, sid, payload };
  if (seq !== undefined) env.seq = seq;
  return JSON.stringify(env);
}

export type DecodeResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string };

/** Parses and validates a frame. Never throws — callers get a result. */
export function decode(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `invalid json: ${(e as Error).message}` };
  }

  const env = Envelope.safeParse(parsed);
  if (!env.success) {
    return { ok: false, error: `invalid envelope: ${env.error.message}` };
  }

  const schema = PayloadSchemas[env.data.type];
  const payload = schema.safeParse(env.data.payload);
  if (!payload.success) {
    return {
      ok: false,
      error: `invalid ${env.data.type} payload: ${payload.error.message}`,
    };
  }

  return { ok: true, envelope: { ...env.data, payload: payload.data } };
}
