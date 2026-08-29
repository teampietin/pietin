import type {
  ConversationBlock,
  ConversationEventPayload,
  ConversationMessage,
  ConversationSnapshotPayload,
  ConversationTool,
  TurnState,
} from "./protocol/index.ts";

/** Maximum UTF-8 size of one tool argument or textual result on the wire. */
export const MAX_TOOL_TEXT_BYTES = 256 * 1024;

type PiMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

type SessionEntry = { type?: string; id?: string; message?: PiMessage };

const OMITTED_BINARY = "[binary content omitted by pietin]";
const OMITTED_IMAGE = "[image content omitted by pietin]";

function isImageRecord(value: Record<string, unknown>): boolean {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const mediaType = [value.mimeType, value.mime_type, value.mediaType, value.media_type, value.contentType]
    .find((item): item is string => typeof item === "string");
  const format = typeof value.format === "string" ? value.format.toLowerCase() : "";
  const filename = [value.filename, value.fileName, value.name, value.path]
    .find((item): item is string => typeof item === "string");
  return type === "image" || type === "image_url"
    || mediaType?.toLowerCase().startsWith("image/") === true
    || /^(?:png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/.test(format)
    || /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i.test(filename ?? "");
}

/**
 * Recursively removes bytes and encoded image bodies before serialization.
 * Tool values are otherwise retained as JSON so filenames, dimensions, text,
 * and other useful metadata remain visible to the viewer.
 */
function withoutBinary(value: unknown, imageContext = false, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return OMITTED_IMAGE;
    if (/^blob:/i.test(value) && imageContext) return OMITTED_IMAGE;
    return value;
  }
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return imageContext ? OMITTED_IMAGE : OMITTED_BINARY;
  }
  if (seen.has(value)) return "[circular value omitted by pietin]";
  seen.add(value);
  if (Array.isArray(value)) {
    const clean = value.map((item) => withoutBinary(item, imageContext, seen));
    seen.delete(value);
    return clean;
  }

  const record = value as Record<string, unknown>;
  const inImage = imageContext || isImageRecord(record);
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const imageBodyKey = /^(?:data|body|content)$/i.test(key);
    const binaryKey = /^(?:base64|bytes)$/i.test(key);
    const imageKey = /^(?:image|imageData|image_data)$/i.test(key);
    if ((inImage && imageBodyKey) || binaryKey || (imageKey && typeof item === "string")) {
      clean[key] = OMITTED_IMAGE;
    } else {
      clean[key] = withoutBinary(item, inImage || imageKey, seen);
    }
  }
  seen.delete(value);
  return clean;
}

function capped(value: unknown): { text?: string; truncated?: boolean } {
  if (value === undefined) return {};
  const safe = withoutBinary(value);
  let text: string;
  if (typeof safe === "string") text = safe;
  else {
    try { text = JSON.stringify(safe, null, 2); }
    catch { text = String(safe); }
  }
  // Sanitization must happen after the final value is serialized: data/blob
  // URLs can be nested in otherwise ordinary tool JSON and are not reliably
  // discoverable from field names alone.
  text = sanitizeStructuredText(text);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_TOOL_TEXT_BYTES) return { text };
  const marker = "\n… truncated by pietin …";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  // Leave three bytes of headroom for a replacement character if the slice
  // splits a UTF-8 code point. The final wire field never exceeds the cap.
  const prefix = bytes.subarray(0, MAX_TOOL_TEXT_BYTES - markerBytes - 3).toString("utf8");
  return { text: prefix + marker, truncated: true };
}

const OMITTED_STRUCTURED_URI = "[embedded payload omitted by pietin]";

/** Unambiguous prose/Markdown boundaries. URI-illegal punctuation is not a
 * boundary here: malformed embedded payloads are ambiguous, so conservatively
 * stripping through that punctuation is safer than exposing a suffix. */
function isURIStop(character: string): boolean {
  return /[\s\u0000-\u001f\u007f<>"`]/.test(character);
}

function hasSchemeBoundary(text: string, index: number): boolean {
  return index === 0 || !/[A-Za-z0-9+.-]/.test(text[index - 1]!);
}

/**
 * Return the end of a data/blob URI beginning at `start`.
 *
 * Plain URIs consume every legal URI character. In the two explicit Markdown
 * forms, `<scheme:...>` and `[label](scheme:...)`, the surrounding delimiter is
 * preserved. Link destinations may contain balanced parentheses, so only the
 * unmatched closing parenthesis ends that destination. If punctuation is
 * ambiguous, it remains part of the URI and is removed rather than risking a
 * payload suffix leak.
 */
function structuredURIEnd(text: string, uriStart: number, contentStart: number): number {
  const angleDelimited = uriStart > 0 && text[uriStart - 1] === "<";
  const markdownDelimited = uriStart >= 2 && text[uriStart - 1] === "(" && text[uriStart - 2] === "]";
  let parentheses = 0;

  for (let index = contentStart; index < text.length; index += 1) {
    const character = text[index]!;
    if (angleDelimited && character === ">") return index;
    if (markdownDelimited) {
      if (character === "(") {
        parentheses += 1;
        continue;
      }
      if (character === ")") {
        if (parentheses === 0) return index;
        parentheses -= 1;
        continue;
      }
    }
    if (isURIStop(character)) return index;
  }
  return text.length;
}

/** Remove complete data/blob URIs while preserving explicit Markdown wrappers
 * and surrounding prose. This scanner is intentionally conservative: URI-legal
 * punctuation is stripped with the token instead of being guessed as prose. */
export function sanitizeStructuredText(text: string): string {
  let output = "";
  let cursor = 0;
  let index = 0;

  while (index < text.length) {
    const remainder = text.slice(index);
    const scheme = remainder.match(/^(?:data|blob):/i)?.[0];
    if (!scheme || !hasSchemeBoundary(text, index)) {
      index += 1;
      continue;
    }

    output += text.slice(cursor, index) + OMITTED_STRUCTURED_URI;
    const uriStart = index;
    index = structuredURIEnd(text, uriStart, uriStart + scheme.length);
    cursor = index;
  }

  return output + text.slice(cursor);
}

function blocksFor(message: PiMessage): ConversationBlock[] {
  const content = message.content;
  if (typeof content === "string") return [{ type: "markdown", text: sanitizeStructuredText(content) }];
  if (!Array.isArray(content)) return [{ type: "unsupported", label: "Unsupported Pi content" }];

  const blocks: ConversationBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") {
      blocks.push({ type: "unsupported", label: "Unsupported Pi content" });
      continue;
    }
    const part = raw as Record<string, unknown>;
    if (part.type === "text") {
      blocks.push({ type: "markdown", text: sanitizeStructuredText(typeof part.text === "string" ? part.text : "") });
    } else if (part.type === "thinking") {
      blocks.push({
        type: "thinking",
        text: sanitizeStructuredText(typeof part.thinking === "string" ? part.thinking : ""),
        ...(part.redacted === true ? { redacted: true } : {}),
      });
    } else if (part.type === "toolCall") {
      const args = capped(part.arguments);
      blocks.push({
        type: "tool",
        id: typeof part.id === "string" ? part.id : `tool-${blocks.length}`,
        name: sanitizeStructuredText(typeof part.name === "string" ? part.name : "tool"),
        status: "pending",
        ...(args.text !== undefined ? { arguments: args.text } : {}),
        ...(args.truncated ? { argumentsTruncated: true } : {}),
      });
    } else if (part.type === "image") {
      // Never put raw image/base64 content on the structured stream.
      blocks.push({ type: "unsupported", label: "Image content — open Terminal" });
    } else {
      blocks.push({ type: "unsupported", label: "Unsupported Pi content — open Terminal" });
    }
  }
  return blocks;
}

export function normalizeMessage(message: PiMessage, id: string, streaming = false): ConversationMessage | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const error = typeof message.errorMessage === "string" ? sanitizeStructuredText(message.errorMessage) : undefined;
  return {
    id,
    role: message.role,
    timestamp: message.timestamp ?? Date.now(),
    blocks: blocksFor(message),
    ...(streaming ? { streaming: true } : {}),
    ...(error ? { error } : {}),
  };
}

function toolFromResult(message: PiMessage): ConversationTool | undefined {
  if (message.role !== "toolResult" || !message.toolCallId) return undefined;
  const result = capped(Array.isArray(message.content)
    ? message.content.filter((p): p is { type: string; text?: string } => !!p && typeof p === "object")
      .filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n")
    : message.content);
  return {
    id: message.toolCallId,
    name: sanitizeStructuredText(message.toolName ?? "tool"),
    status: message.isError ? "error" : "success",
    ...(result.text !== undefined ? { result: result.text } : {}),
    ...(result.truncated ? { resultTruncated: true } : {}),
  };
}

/** In-memory canonical projection. The relay never stores this state. */
export class ConversationProjection {
  private messages = new Map<string, ConversationMessage>();
  private tools = new Map<string, ConversationTool>();
  private cursor = 0;
  private revision = 1;
  private turnState: TurnState = "idle";
  private model: string | null = null;
  private contextTokens: number | null = null;
  private contextPercent: number | null = null;
  private liveMessageCounter = 0;
  private activeMessageIDs = new Map<string, string>();

  constructor(entries: readonly SessionEntry[] = []) {
    entries.forEach((entry, index) => {
      if (entry.type !== "message" || !entry.message) return;
      // Session entry ids are Pi's durable identity. The index fallback remains
      // collision-safe within this snapshot when importing legacy entries.
      const id = `entry:${entry.id ?? index}`;
      const message = normalizeMessage(entry.message, id);
      if (message) this.messages.set(message.id, message);
      const tool = toolFromResult(entry.message);
      if (tool) this.tools.set(tool.id, tool);
      for (const block of message?.blocks ?? []) {
        if (block.type === "tool") this.tools.set(block.id, { ...block });
      }
    });
  }

  setMeta(model: string | null, tokens: number | null, percent: number | null): ConversationEventPayload {
    const safeModel = model === null ? null : sanitizeStructuredText(model);
    this.model = safeModel;
    this.contextTokens = tokens;
    this.contextPercent = percent;
    return { kind: "meta", model: safeModel, contextTokens: tokens, contextPercent: percent };
  }

  setTurnState(state: TurnState): ConversationEventPayload {
    this.turnState = state;
    return { kind: "turn_state", state };
  }

  startMessage(raw: PiMessage): ConversationEventPayload | undefined {
    const key = raw.role ?? "message";
    const id = `live:${++this.liveMessageCounter}`;
    this.activeMessageIDs.set(key, id);
    return this.upsertLiveMessage(raw, id, raw.role === "assistant");
  }

  updateMessage(raw: PiMessage): ConversationEventPayload | undefined {
    const key = raw.role ?? "message";
    const id = this.activeMessageIDs.get(key) ?? `live:${++this.liveMessageCounter}`;
    this.activeMessageIDs.set(key, id);
    return this.upsertLiveMessage(raw, id, true);
  }

  endMessage(raw: PiMessage): ConversationEventPayload | undefined {
    const key = raw.role ?? "message";
    const id = this.activeMessageIDs.get(key) ?? `live:${++this.liveMessageCounter}`;
    this.activeMessageIDs.delete(key);
    return this.upsertLiveMessage(raw, id, false);
  }

  startTool(id: string, name: string, args: unknown): ConversationEventPayload {
    const value = capped(args);
    return this.upsertTool({
      id, name: sanitizeStructuredText(name), status: "running",
      ...(value.text !== undefined ? { arguments: value.text } : {}),
      ...(value.truncated ? { argumentsTruncated: true } : {}),
    });
  }

  updateTool(id: string, name: string, args: unknown, partialResult: unknown): ConversationEventPayload {
    const previous = this.tools.get(id);
    const argumentValue = previous?.arguments === undefined ? capped(args) : undefined;
    const resultValue = capped(partialResult);
    return this.upsertTool({
      id, name: sanitizeStructuredText(name), status: "running",
      ...(previous?.arguments !== undefined ? { arguments: previous.arguments } : {}),
      ...(previous?.argumentsTruncated ? { argumentsTruncated: true } : {}),
      ...(argumentValue?.text !== undefined ? { arguments: argumentValue.text } : {}),
      ...(argumentValue?.truncated ? { argumentsTruncated: true } : {}),
      ...(resultValue.text !== undefined ? { result: resultValue.text } : {}),
      ...(resultValue.truncated ? { resultTruncated: true } : {}),
    });
  }

  finishTool(id: string, name: string, result: unknown, isError: boolean): ConversationEventPayload {
    const previous = this.tools.get(id);
    const value = capped(result);
    return this.upsertTool({
      id, name: sanitizeStructuredText(name), status: isError ? "error" : "success",
      ...(previous?.arguments !== undefined ? { arguments: previous.arguments } : {}),
      ...(previous?.argumentsTruncated ? { argumentsTruncated: true } : {}),
      ...(value.text !== undefined ? { result: value.text } : {}),
      ...(value.truncated ? { resultTruncated: true } : {}),
    });
  }

  next(event: ConversationEventPayload): { seq: number; payload: ConversationEventPayload } {
    this.cursor += 1;
    return { seq: this.cursor, payload: event };
  }

  snapshot(): ConversationSnapshotPayload {
    return {
      revision: this.revision,
      cursor: this.cursor,
      messages: [...this.messages.values()].sort((a, b) => a.timestamp - b.timestamp),
      tools: [...this.tools.values()],
      turnState: this.turnState,
      model: this.model,
      contextTokens: this.contextTokens,
      contextPercent: this.contextPercent,
    };
  }

  private upsertLiveMessage(raw: PiMessage, id: string, streaming: boolean): ConversationEventPayload | undefined {
    const message = normalizeMessage(raw, id, streaming);
    if (!message) {
      const tool = toolFromResult(raw);
      return tool ? this.upsertTool(tool) : undefined;
    }
    this.messages.set(message.id, message);
    for (const block of message.blocks) {
      if (block.type === "tool") this.tools.set(block.id, { ...block });
    }
    return { kind: "message_upsert", message };
  }

  private upsertTool(tool: ConversationTool): ConversationEventPayload {
    this.tools.set(tool.id, tool);
    return { kind: "tool_upsert", tool };
  }
}
