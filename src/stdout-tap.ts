/**
 * Mirrors Pi's rendered TUI output without altering it.
 *
 * The extension runs in-process with Pi, so wrapping `process.stdout.write`
 * captures the fully-rendered terminal: theme colors, custom message and
 * entry renderers, widgets, footer, other extensions' output. Nothing is
 * interpreted, so fidelity is exact and cannot drift when Pi updates.
 *
 * Pi uses this same pattern internally (dist/core/output-guard.js).
 *
 * Two rules:
 *  1. Never let a relay failure break the local terminal. The original write
 *     is always called, and the sink is wrapped in try/catch.
 *  2. Coalesce. The TUI emits many small writes; flushing per-write would
 *     swamp the socket.
 */

export type Sink = (chunk: Buffer) => void;

export interface TapOptions {
  /** Coalescing window. ~16ms ≈ one frame at 60fps. */
  flushIntervalMs?: number;
  /** Flush early if the buffer exceeds this. Keeps latency low when busy. */
  maxBufferBytes?: number;
  onError?: (err: unknown) => void;
}

export interface Tap {
  /** Restores the original stdout. Idempotent. */
  stop: () => void;
  /** Flushes pending bytes immediately. */
  flush: () => void;
}

type WriteFn = typeof process.stdout.write;

export function installStdoutTap(sink: Sink, opts: TapOptions = {}): Tap {
  const flushIntervalMs = opts.flushIntervalMs ?? 16;
  const maxBufferBytes = opts.maxBufferBytes ?? 64 * 1024;

  const stream = process.stdout;
  const original: WriteFn = stream.write.bind(stream) as WriteFn;

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;

    const chunk = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;

    try {
      sink(chunk);
    } catch (err) {
      // A broken relay must never break the user's terminal.
      opts.onError?.(err);
    }
  }

  function schedule(): void {
    if (pendingBytes >= maxBufferBytes) {
      flush();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(flush, flushIntervalMs);
      // Do not hold the process open on this timer.
      timer.unref?.();
    }
  }

  const patched = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    try {
      const encoding = typeof encodingOrCb === "string" ? encodingOrCb : undefined;
      const buf =
        typeof chunk === "string"
          ? Buffer.from(chunk, encoding ?? "utf8")
          : Buffer.from(chunk);
      pending.push(buf);
      pendingBytes += buf.length;
      schedule();
    } catch (err) {
      opts.onError?.(err);
    }

    // Always pass through, whatever happened above.
    return typeof encodingOrCb === "function"
      ? original(chunk as never, encodingOrCb)
      : original(chunk as never, encodingOrCb as BufferEncoding, cb);
  }) as WriteFn;

  stream.write = patched;

  return {
    flush,
    stop() {
      if (stopped) return;
      stopped = true;
      flush();
      // Only restore if nobody else patched on top of us; clobbering another
      // extension's wrapper would be worse than leaving ours in place.
      if (stream.write === patched) {
        stream.write = original;
      }
    },
  };
}
