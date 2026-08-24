import { test } from "node:test";
import assert from "node:assert/strict";

import { installSizeOverride, type SizeOverride } from "./size-override.ts";

/**
 * These tests drive the real `process.stdout` / `process.stdin`, because the
 * module's whole job is to bend those two objects. Every test disposes its
 * override so the next one starts from the untouched originals.
 */

function harness(): {
  size: SizeOverride;
  redraws: () => number;
  banners: () => (string[] | undefined)[];
  changes: () => { cols: number; rows: number; owner: string }[];
} {
  let redraws = 0;
  const banners: (string[] | undefined)[] = [];
  const changes: { cols: number; rows: number; owner: string }[] = [];
  const size = installSizeOverride({
    forceRedraw: () => {
      redraws += 1;
    },
    setBanner: (lines) => banners.push(lines),
    onSizeChanged: (cols, rows, owner) => changes.push({ cols, rows, owner }),
  });
  return { size, redraws: () => redraws, banners: () => banners, changes: () => changes };
}

test("a claim changes what Pi reads off stdout, and release restores it", (t) => {
  const before = { cols: process.stdout.columns, rows: process.stdout.rows };
  const h = harness();
  t.after(() => h.size.dispose());

  h.size.claim(180, 50);
  assert.equal(process.stdout.columns, 180);
  assert.equal(process.stdout.rows, 50);
  assert.equal(h.size.active, true);
  assert.deepEqual(h.size.size(), { cols: 180, rows: 50 });
  // The TUI only re-lays out when it is told to.
  assert.ok(h.redraws() >= 1, "claim must force a repaint");
  assert.deepEqual(h.changes().at(-1), { cols: 180, rows: 50, owner: "browser" });

  h.size.release("viewer");
  assert.equal(h.size.active, false);
  assert.deepEqual({ cols: process.stdout.columns, rows: process.stdout.rows }, before);
  assert.equal(h.changes().at(-1)?.owner, "local");
});

test("dispose restores stdout even while a claim is in force", () => {
  const before = { cols: process.stdout.columns, rows: process.stdout.rows };
  const h = harness();
  h.size.claim(200, 60);
  assert.equal(process.stdout.columns, 200);
  h.size.dispose();
  assert.deepEqual({ cols: process.stdout.columns, rows: process.stdout.rows }, before);
  assert.equal(h.size.active, false);
});

test("absurd sizes are clamped, never passed to the layout", (t) => {
  const h = harness();
  t.after(() => h.size.dispose());
  h.size.claim(1, 1);
  assert.deepEqual(h.size.size(), { cols: 20, rows: 6 });
  h.size.claim(10_000, 10_000);
  assert.deepEqual(h.size.size(), { cols: 500, rows: 200 });
});

test("a banner appears on claim and is cleared on release", (t) => {
  const h = harness();
  t.after(() => h.size.dispose());
  h.size.claim(120, 40);
  const shown = h.banners().at(-1);
  assert.ok(shown, "a claim must draw a banner");
  assert.ok(shown[0]?.includes("120×40"), "banner must name the size");
  assert.ok(shown[0]?.toLowerCase().includes("any key"), "banner must say how to reclaim");
  h.size.release("viewer");
  assert.equal(h.banners().at(-1), undefined);
});

test("a keypress at the laptop takes the size back", (t) => {
  const h = harness();
  t.after(() => h.size.dispose());
  h.size.claim(180, 50);
  process.stdin.emit("data", "j");
  assert.equal(h.size.active, false, "local input must release the claim");
  assert.equal(h.changes().at(-1)?.owner, "local");
});

test("browser keystrokes do not count as somebody at the laptop", (t) => {
  const h = harness();
  t.after(() => h.size.dispose());
  h.size.claim(180, 50);
  h.size.injectInput("hello");
  h.size.injectInput("\r");
  h.size.injectInput("\x1b"); // a bare Escape from the browser
  assert.equal(h.size.active, true, "injected input must keep the claim");
  assert.equal(process.stdout.columns, 180);
});

test("the terminal's own query replies do not take the size back", (t) => {
  const h = harness();
  t.after(() => h.size.dispose());
  h.size.claim(180, 50);
  // Device attributes, cursor position report, kitty flags — answers to
  // queries pi-tui sends, not keys anybody pressed.
  for (const reply of ["\x1b[?62;c", "\x1b[24;80R", "\x1b[?1u", "\x1bP>|pi\x1b\\"]) {
    process.stdin.emit("data", reply);
    assert.equal(h.size.active, true, `reply ${JSON.stringify(reply)} must not release`);
  }
  // A real arrow key still releases.
  process.stdin.emit("data", "\x1b[A");
  assert.equal(h.size.active, false);
});

test("stdin is left clean after dispose", () => {
  const before = process.stdin.listenerCount("data");
  const h = harness();
  assert.equal(process.stdin.listenerCount("data"), before + 1);
  h.size.dispose();
  assert.equal(process.stdin.listenerCount("data"), before);
  // A late keypress must not reach a disposed override.
  process.stdin.emit("data", "x");
});
