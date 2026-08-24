/**
 * pietin — remote-control a Pi session from a browser.
 *
 * Build step 3: `/rc` dials the relay, taps stdout, and streams live ANSI.
 * See plans/base.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installStdoutTap, type Tap } from "./stdout-tap.ts";
import { connectRelay, type RelayLink } from "./relay-link.ts";
import { installSizeOverride, type SizeOverride } from "./size-override.ts";
import { deviceLogin, httpBase, loadStoredToken, type DeviceLoginResult } from "./device-login.ts";

const RELAY_URL = process.env.PIETIN_RELAY_URL ?? "wss://pietin.sh/ws/extension";

/**
 * The machine token: ~/.pi/pietin.json (written by `/rc login`) first, then
 * PIETIN_TOKEN as a dev fallback. Read at call time so a login mid-session takes
 * effect without a restart.
 */
function currentToken(): string {
  return loadStoredToken() ?? process.env.PIETIN_TOKEN ?? "";
}

/** Widget key for the "a browser set this size" banner. */
const SIZE_WIDGET = "pietin-size";

export default function pietin(pi: ExtensionAPI) {
  let tap: Tap | undefined;
  let link: RelayLink | undefined;
  let sessionId: string | undefined;
  // Per-session, monotonic, starts at 1 — lets the browser detect gaps.
  let seq = 0;
  let onResize: (() => void) | undefined;
  // Owns the browser's claim on the render size. Installed at /rc time and
  // torn down by stop(), so Pi's stdout is untouched when we are not sharing.
  let size: SizeOverride | undefined;
  // Forces Pi's TUI to re-emit a full-screen keyframe. Captured at /rc time
  // (see captureRedraw); undefined outside interactive mode.
  let forceRedraw: (() => void) | undefined;

  pi.registerCommand("rc", {
    description: "Share this session to pietin. Subcommands: login, stop",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (sub === "login") {
        await runLogin(ctx);
        return;
      }
      if (sub === "stop") {
        if (!link && !tap) {
          ctx.ui.notify("Not sharing.", "info");
          return;
        }
        stop();
        ctx.ui.notify("Stopped sharing.", "info");
        return;
      }

      if (link) {
        ctx.ui.notify(`Already sharing: ${sessionUrl(sessionId)}`, "info");
        return;
      }

      // Auth up front. A stored token (from `/rc login`) or PIETIN_TOKEN wins;
      // otherwise run the device-code flow inline, then keep sharing (§13).
      let token = currentToken();
      if (!token) {
        ctx.ui.notify("Not logged in — starting login…", "info");
        const result = await runLogin(ctx);
        if (!result) return; // runLogin already surfaced the failure
        token = result.token;
      }

      // Grab a handle that forces a full TUI repaint, for viewer redraw
      // requests. No-op outside interactive mode (nothing to repaint).
      forceRedraw = captureRedraw(ctx);

      // Lets a viewer claim the render size (see size-override.ts). It reports
      // every size change back to the viewers, so the browser always knows who
      // owns the size and can drop its override UI when the laptop takes over.
      size = installSizeOverride({
        forceRedraw: () => forceRedraw?.(),
        setBanner: (lines) => {
          try {
            ctx.ui.setWidget(SIZE_WIDGET, lines);
          } catch {
            // No widget support (non-TUI mode) — the override still works,
            // it just goes unannounced on this screen.
          }
        },
        onSizeChanged: (c, r, owner) => link?.sendResize(c, r, owner),
      });

      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;

      link = connectRelay({
        url: RELAY_URL,
        token,
        sessionName: pi.getSessionName() ?? "pietin",
        cwd: ctx.cwd,
        cols,
        rows,
        piVersion: piVersion(),
        onReady: (id) => {
          sessionId = id;
          ctx.ui.notify(`Sharing at ${sessionUrl(id)}`, "info");
        },
        onError: (message) => {
          // A relay problem must never break the local session — warn only.
          ctx.ui.notify(`pietin: ${message}`, "warning");
        },
        onClose: (reason) => {
          if (link) {
            ctx.ui.notify(`pietin: relay disconnected (${reason})`, "warning");
          }
          stop();
        },
        onPrompt: (text) => {
          // Close the loop: a browser prompt becomes a real user message.
          // `deliverAs` is REQUIRED while streaming or the call throws
          // (plans/base.md §7); omit it only when the agent is idle.
          try {
            pi.sendUserMessage(text, ctx.isIdle() ? {} : { deliverAs: "steer" });
          } catch (err) {
            ctx.ui.notify(`pietin: could not deliver prompt: ${String(err)}`, "warning");
          }
        },
        onAbort: () => {
          try {
            ctx.abort();
          } catch (err) {
            ctx.ui.notify(`pietin: could not abort: ${String(err)}`, "warning");
          }
        },
        onRedraw: () => {
          // A viewer joined late or missed a frame and asked for a clean
          // paint. Pi renders differentially, so a late viewer's ghostty
          // starts blank and only gets subsequent diffs — forcing a full
          // repaint re-emits every cell, which the stdout tap captures and
          // fans out to all viewers. Best-effort: never throw into Pi.
          try {
            forceRedraw?.();
            // A viewer asks for a redraw the moment it attaches, so this is
            // also where a late joiner learns the size and who owns it — the
            // relay never replays past frames, and `hello` only reaches the
            // relay. Without this the viewer would show no size until the
            // next resize.
            const s = size?.size();
            if (s) link?.sendResize(s.cols, s.rows, size?.active ? "browser" : "local");
          } catch (err) {
            ctx.ui.notify(`pietin: could not redraw: ${String(err)}`, "warning");
          }
        },
        onInput: (dataBase64) => {
          // Keystroke passthrough: feed the browser's keys into Pi's own input
          // reader. Pi's TUI listens on `process.stdin` ("data" events), so an
          // emitted event is indistinguishable from a local keypress — its
          // input widget echoes it, arrows/ctrl-c/slash-commands all work.
          // We decode to a utf8 string to match the real stdin path (Pi sets
          // stdin encoding to utf8). Never throw into Pi — a bad frame is
          // dropped, the local terminal is untouched.
          try {
            const text = Buffer.from(dataBase64, "base64").toString("utf8");
            // Route through the size override, never `process.stdin.emit`
            // directly: it flags the emit as ours so a browser keystroke does
            // not read as somebody typing at the laptop and drop the override.
            if (text) size?.injectInput(text);
          } catch {
            // ignore malformed input; the viewer just retypes
          }
        },
        onSetSize: (c, r) => {
          // The browser claims the size. Pi re-lays out at it, and the laptop
          // gets a banner saying any key takes it back.
          try {
            size?.claim(c, r);
          } catch (err) {
            ctx.ui.notify(`pietin: could not set size: ${String(err)}`, "warning");
          }
        },
        onReleaseSize: () => {
          try {
            size?.release("viewer");
          } catch (err) {
            ctx.ui.notify(`pietin: could not release size: ${String(err)}`, "warning");
          }
        },
      });

      // Install the tap immediately so nothing is missed between now and the
      // ack. Frames sent before `ready` are dropped by the link, which is
      // fine: the first real paint comes after the URL is opened, and late
      // joiners get a redraw (step 8).
      tap = installStdoutTap(
        (chunk) => {
          seq += 1;
          link?.sendOutput(chunk.toString("base64"), seq);
        },
        {
          onError: (err) => ctx.ui.notify(`pietin: ${String(err)}`, "warning"),
        },
      );

      // Track terminal resizes so the browser can adopt the new size.
      onResize = () => {
        // While a viewer owns the size, the laptop's window is not the render
        // size — stay quiet and let the override keep reporting. Releasing
        // sends the fresh physical size, so viewers never miss the handover.
        if (size?.active) return;
        const c = process.stdout.columns ?? 80;
        const r = process.stdout.rows ?? 24;
        link?.sendResize(c, r, "local");
      };
      process.stdout.on("resize", onResize);

      ctx.ui.notify("pietin: connecting…", "info");
    },
  });

  pi.registerCommand("rc-stop", {
    description: "Stop sharing this session",
    handler: async (_args, ctx) => {
      if (!link && !tap) {
        ctx.ui.notify("Not sharing.", "info");
        return;
      }
      stop();
      ctx.ui.notify("Stopped sharing.", "info");
    },
  });

  // Alias for `/rc login`, kept for discoverability.
  pi.registerCommand("pietin-login", {
    description: "Log in to pietin on this machine",
    handler: async (_args, ctx) => {
      await runLogin(ctx);
    },
  });

  // Always restore stdout on shutdown, or the user's terminal keeps a dead
  // wrapper installed for the rest of the process.
  pi.on("session_shutdown", async (_event: unknown, _ctx: ExtensionContext) => {
    stop();
  });

  // Runs the device-code login flow and reports the outcome. Returns the token
  // on success, or undefined (after notifying) on failure — the caller decides
  // whether to proceed.
  async function runLogin(ctx: ExtensionContext): Promise<DeviceLoginResult | undefined> {
    try {
      const result = await deviceLogin(RELAY_URL, {
        onVerificationUri: (uri) => {
          ctx.ui.notify(`pietin login — open this URL and click Approve:\n${uri}`, "info");
        },
      });
      ctx.ui.notify("pietin: logged in. Token saved to ~/.pi/pietin.json", "info");
      return result;
    } catch (err) {
      ctx.ui.notify(`pietin login failed: ${String(err)}`, "error");
      return undefined;
    }
  }

  function stop(): void {
    // Order matters: stop the tap first so no further frames are produced,
    // then tear down the socket.
    tap?.stop();
    tap = undefined;
    // Restore the real stdout size before anything else — a stale override
    // would leave Pi drawing at a size this terminal does not have.
    size?.dispose();
    size = undefined;
    if (onResize) {
      process.stdout.off("resize", onResize);
      onResize = undefined;
    }
    const l = link;
    link = undefined;
    l?.close();
    sessionId = undefined;
    seq = 0;
    forceRedraw = undefined;
  }
}

/**
 * Returns a function that forces Pi's TUI to re-emit a full-screen keyframe,
 * or undefined outside interactive mode.
 *
 * The extension has no direct handle on the renderer, but every ctx.ui widget
 * factory is invoked synchronously with the live TUI. So we register a
 * zero-height throwaway widget purely to capture that reference, then remove
 * it — leaving no visible footprint. `tui.requestRender(true)` resets the
 * differential renderer's cached lines, so the next paint writes every cell
 * (see pi-tui TuiMainScreen.resetRenderState). That is exactly what late
 * joiners and dropped viewers need.
 */
function captureRedraw(ctx: ExtensionContext): (() => void) | undefined {
  if (ctx.mode !== "tui") return undefined;
  let redraw: (() => void) | undefined;
  const key = "__pietin_redraw_capture";
  try {
    ctx.ui.setWidget(key, (tui) => {
      redraw = () => tui.requestRender(true);
      return { render: () => [], invalidate: () => {} };
    });
  } catch {
    // If widget registration is unavailable, redraw is simply unsupported.
  } finally {
    // We only needed the reference; drop the widget so nothing renders.
    try {
      ctx.ui.setWidget(key, undefined);
    } catch {
      // ignore
    }
  }
  return redraw;
}

function sessionUrl(id: string | undefined): string {
  const base = process.env.PIETIN_PUBLIC_URL ?? httpBase(RELAY_URL);
  return `${base}/s/${id ?? "unknown"}`;
}

function piVersion(): string {
  return process.env.PI_VERSION ?? "unknown";
}
