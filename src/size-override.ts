/**
 * Lets a browser viewer claim Pi's render size, and lets the person at the
 * laptop take it straight back.
 *
 * Why this can work at all: pi-tui reads the size off `process.stdout` on
 * every draw — `get columns() { return process.stdout.columns || ... }` in
 * pi-tui's terminal.js — and re-lays out whenever `process.stdout` emits
 * "resize". So replacing those two property descriptors and emitting the event
 * makes the TUI draw at any size we choose, with no patch to Pi.
 *
 * What this can NOT do: give the laptop and the browser two different sizes at
 * once. There is one renderer and one stdout, so both screens see the same
 * draw. While a viewer owns the size the laptop's own window no longer
 * constrains the render, which is the point — but a laptop window narrower
 * than the claimed size will wrap. That is why reclaiming must be instant and
 * obvious, hence the banner and the any-key release below.
 *
 * Reclaiming: we listen on raw `process.stdin`, upstream of pi-tui's stdin
 * buffer. Browser keystrokes reach Pi through `process.stdin.emit("data", …)`,
 * which runs listeners synchronously, so a flag set around that emit tells the
 * two apart with no guesswork. We deliberately do NOT use pi-tui's parsed
 * input: it defers incomplete sequences behind a timer, and a browser's Escape
 * flushed later would look local and drop the override.
 */

/** A terminal's answer to a query (DA, DSR, kitty flags) — not a keypress. */
const TERMINAL_REPLY = /^(?:\x1b\[[?0-9;]*[cnuR]|\x1bP.*?\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))$/;

export interface SizeOverrideOptions {
  /** Forces a full TUI repaint, so the new layout lands as a clean keyframe. */
  forceRedraw: () => void;
  /** Draws (or clears, on undefined) the laptop-side "browser owns this" banner. */
  setBanner: (lines: string[] | undefined) => void;
  /** Called after the size changes, so the caller can tell viewers. */
  onSizeChanged: (cols: number, rows: number, owner: "local" | "browser") => void;
}

export interface SizeOverride {
  /** True while a viewer owns the size. */
  readonly active: boolean;
  /** Current render size, whoever owns it. */
  size: () => { cols: number; rows: number };
  /** A viewer claims the size. Idempotent; a no-op if nothing changes. */
  claim: (cols: number, rows: number) => void;
  /** Hands the size back to the physical terminal. */
  release: (why: "viewer" | "local_key" | "stop") => void;
  /**
   * Feeds browser keystrokes into Pi's stdin without counting them as the
   * laptop reclaiming the size. Use this instead of a bare
   * `process.stdin.emit("data", …)`.
   */
  injectInput: (text: string) => void;
  /** Restores the original descriptors and listeners. Idempotent. */
  dispose: () => void;
}

export function installSizeOverride(opts: SizeOverrideOptions): SizeOverride {
  const stdout = process.stdout;

  // Keep the real descriptors so release() restores the exact originals — on a
  // TTY these are live getters onto the kernel's winsize, not plain values.
  const realCols = Object.getOwnPropertyDescriptor(stdout, "columns");
  const realRows = Object.getOwnPropertyDescriptor(stdout, "rows");

  let override: { cols: number; rows: number } | undefined;
  let installed = false;
  let disposed = false;
  let injecting = false;

  function physical(): { cols: number; rows: number } {
    // Read through the saved descriptors: our own getters are in the way.
    const cols = realCols?.get ? Number(realCols.get.call(stdout)) : Number(realCols?.value);
    const rows = realRows?.get ? Number(realRows.get.call(stdout)) : Number(realRows?.value);
    return { cols: cols || 80, rows: rows || 24 };
  }

  function install(): void {
    if (installed) return;
    Object.defineProperty(stdout, "columns", {
      configurable: true,
      enumerable: true,
      get: () => override?.cols ?? physical().cols,
    });
    Object.defineProperty(stdout, "rows", {
      configurable: true,
      enumerable: true,
      get: () => override?.rows ?? physical().rows,
    });
    installed = true;
  }

  function uninstall(): void {
    if (!installed) return;
    // A non-TTY stdout may have had no own descriptor at all; deleting our
    // getter then correctly falls back to the prototype.
    if (realCols) Object.defineProperty(stdout, "columns", realCols);
    else delete (stdout as unknown as Record<string, unknown>).columns;
    if (realRows) Object.defineProperty(stdout, "rows", realRows);
    else delete (stdout as unknown as Record<string, unknown>).rows;
    installed = false;
  }

  /** Makes pi-tui re-read the size and repaint every cell at the new one. */
  function relayout(): void {
    try {
      stdout.emit("resize");
    } catch {
      // A listener of Pi's threw; the repaint below still corrects the screen.
    }
    try {
      opts.forceRedraw();
    } catch {
      // Redraw is best-effort — never break the local session over a repaint.
    }
  }

  function banner(cols: number, rows: number): void {
    opts.setBanner([
      `⬤ pietin — a browser set this size (${cols}×${rows}). Press any key to take it back.`,
    ]);
  }

  // Raw stdin, upstream of pi-tui's buffering. Anything that is not ours and
  // not a terminal reply means somebody is at the laptop: give the size back.
  const onStdin = (chunk: unknown): void => {
    if (disposed || injecting || !override) return;
    const text = typeof chunk === "string" ? chunk : String(chunk);
    if (!text || TERMINAL_REPLY.test(text)) return;
    release("local_key");
  };
  // Adding a "data" listener puts the stream into flowing mode, which also
  // keeps the event loop alive. Pi's TUI has already resumed stdin
  // (readableFlowing === true), so this is a no-op there — but a host that
  // never reads stdin must not be held open just because we are watching.
  // `readableFlowing === null` means "never started flowing"; restore that.
  const stdinWasInert = process.stdin.readableFlowing === null;
  process.stdin.on("data", onStdin);
  if (stdinWasInert) process.stdin.pause();

  function claim(cols: number, rows: number): void {
    if (disposed) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    // Clamp: a zero or absurd size would break the layout maths in pi-tui.
    const c = Math.max(20, Math.min(500, Math.trunc(cols)));
    const r = Math.max(6, Math.min(200, Math.trunc(rows)));
    if (override && override.cols === c && override.rows === r) return;

    install();
    override = { cols: c, rows: r };
    banner(c, r);
    relayout();
    opts.onSizeChanged(c, r, "browser");
  }

  function release(_why: "viewer" | "local_key" | "stop"): void {
    if (!override) return;
    override = undefined;
    uninstall();
    opts.setBanner(undefined);
    relayout();
    const { cols, rows } = physical();
    opts.onSizeChanged(cols, rows, "local");
  }

  return {
    get active() {
      return override !== undefined;
    },
    size() {
      return override ? { ...override } : physical();
    },
    claim,
    release,
    injectInput(text: string) {
      if (disposed || !text) return;
      injecting = true;
      try {
        process.stdin.emit("data", text);
      } finally {
        // emit() is synchronous, so the flag covers exactly our own listeners.
        injecting = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      override = undefined;
      uninstall();
      process.stdin.off("data", onStdin);
      try {
        opts.setBanner(undefined);
      } catch {
        // The UI may already be gone during shutdown.
      }
    },
  };
}
