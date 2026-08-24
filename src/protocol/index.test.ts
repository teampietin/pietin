import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decode, encode, PROTOCOL_VERSION, type MessageType } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(here, "..", "testdata", "golden.json"), "utf8"),
) as { cases: { name: string; json: string }[] };

test("golden fixtures decode and round-trip", async (t) => {
  for (const c of golden.cases) {
    await t.test(c.name, () => {
      const res = decode(c.json);
      assert.equal(res.ok, true, `expected decode to succeed: ${JSON.stringify(res)}`);
      if (!res.ok) return;

      const { v, type, sid, seq, payload } = res.envelope;
      assert.equal(v, PROTOCOL_VERSION);

      // Re-encoding must produce semantically identical JSON.
      const reencoded = encode(type as MessageType, sid, payload as never, seq);
      assert.deepEqual(
        JSON.parse(reencoded),
        JSON.parse(c.json),
        "re-encoded frame differs from golden",
      );
    });
  }
});

test("decode rejects malformed input", () => {
  assert.equal(decode("not json").ok, false);
  assert.equal(decode("{}").ok, false);
  // wrong version
  assert.equal(decode('{"v":2,"type":"abort","sid":"x","payload":{}}').ok, false);
  // unknown type
  assert.equal(decode('{"v":1,"type":"nope","sid":"x","payload":{}}').ok, false);
  // payload does not match its type
  assert.equal(decode('{"v":1,"type":"prompt","sid":"x","payload":{}}').ok, false);
});

test("output payload carries base64, not text", () => {
  const raw = "\x1b[0mHello\x1b[0m";
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const res = decode(encode("output", "s_1", { data: b64 }, 1));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const { data } = res.envelope.payload as { data: string };
  assert.equal(Buffer.from(data, "base64").toString("utf8"), raw);
});
