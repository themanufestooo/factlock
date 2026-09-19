/**
 * Cross-language conformance tests: shared vectors in packages/vectors/vectors.json.
 * Run compiled: node --test dist/test/vectors.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  canonicalize,
  keypairFromSeed,
  sign,
  verify,
  hexToBytes,
  bytesToHex,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "vectors", "vectors.json"), "utf-8"),
);

const te = new TextEncoder();

for (const c of vectors.canonical) {
  test(`canonical/${c.name}`, () => {
    // round-trip through JSON text so numbers arrive as doubles, like any parser
    const input = JSON.parse(JSON.stringify(c.input));
    assert.equal(canonicalize(input), c.expected);
  });
}

for (const c of vectors.signatures) {
  test(`sign/${c.name} reproduces vector`, () => {
    const msg = te.encode(c.message);
    const { publicKey, privateKey } = keypairFromSeed(hexToBytes(c.seed_hex));
    assert.equal(bytesToHex(publicKey), c.public_key_hex);
    assert.equal(bytesToHex(sign(privateKey, msg)), c.signature_hex);
    assert.equal(verify(publicKey, msg, hexToBytes(c.signature_hex)), true);
  });

  test(`sign/${c.name} rejects tampered message`, () => {
    const msg = te.encode(c.message).slice();
    msg[0] ^= 0x01;
    assert.equal(
      verify(hexToBytes(c.public_key_hex), msg, hexToBytes(c.signature_hex)),
      false,
    );
  });

  test(`sign/${c.name} rejects wrong key`, () => {
    assert.equal(
      verify(
        hexToBytes(vectors.negative.wrong_key_public_hex),
        te.encode(c.message),
        hexToBytes(c.signature_hex),
      ),
      false,
    );
  });
}

test("verify rejects garbage lengths", () => {
  assert.equal(verify(new Uint8Array(4), te.encode("m"), new Uint8Array(4)), false);
});
