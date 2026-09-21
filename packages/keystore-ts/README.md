# @factlock/keystore

Key management for the FactLock attestation protocol (T2): `key_id` registry,
signing backends, rotation protocol, and `/.well-known/factlock-keys.json`.

## Trust model (read first)

v1 is **custodial** and says so openly (spec §1.1, §3): FactLock generates and
holds business keypairs in an HSM/KMS; the business authorizes each use via a
verified channel (logged-in session + SMS confirmation), and every
countersignature references an immutable authorization record that is
hash-committed into the transparency log. The safety property is
**detectability** — a forged attestation leaves permanent public evidence —
not prevention. v2 (committed, month 6): business self-custody /
bring-your-own-key; the authorization-trail schema is designed so v2 is a
key-ownership migration, not a protocol rewrite.

## Backends

```ts
import { SoftwareKeyStore, KmsKeyStore } from "@factlock/keystore";

// DEV/TEST ONLY — private keys live in process memory (+0600 file if dir given)
const dev = new SoftwareKeyStore("./data/keys");

// PRODUCTION — private key material NEVER leaves the KMS/HSM.
// The store only ever sends { KeyId, Message }; it only ever receives
// public keys and detached signatures.
const prod = new KmsKeyStore(kmsClient, "./data/keys");
```

### Production wiring (AWS KMS)

Keys are created **out of band** (Terraform/CloudFormation), then imported:

```ts
import { KMSClient, SignCommand, GetPublicKeyCommand } from "@aws-sdk/client-kms";

const client = new KMSClient({ region: "us-east-1" });
// KeySpec: ECC_ED25519, KeyUsage: SIGN_VERIFY

const store = new KmsKeyStore(
  {
    sign: async ({ KeyId, Message, SigningAlgorithm }) => {
      const out = await client.send(
        new SignCommand({ KeyId, Message, SigningAlgorithm }) // "ED25519"
      );
      return { Signature: out.Signature! };
    },
    getPublicKey: async ({ KeyId }) => {
      const out = await client.send(new GetPublicKeyCommand({ KeyId }));
      return { PublicKey: out.PublicKey! }; // DER SPKI; parsed by spkiToRawEd25519
    },
  },
  "./data/keys",
);

await store.generateKey("factlock", "factlock", "vkey_main_01", "<kms-key-id-or-arn>");
```

For local dev secrets hygiene, prefer the OS keychain (`security` on macOS,
`secret-tool`/libsecret on Linux, Credential Manager on Windows) or a
`.env`-injected `KMS_KEY_ID` over committing key ids to the repo. The
`SoftwareKeyStore` secrets file is written mode `0600` and must be git-ignored.

## Rotation

```ts
const old = await store.activeKey("factlock", "factlock");
const next = await store.rotate(old.key_id, { gracePeriodDays: 30 });
// old: status "grace", valid_until = now+30d  (still signs AND verifies)
// next: status "active", valid_from = now
await store.sunset(old.key_id); // retired: verifies forever, sign() refuses
```

Acceptance property (tested): attestations signed under the old `key_id`
verify after rotation and after sunset — verification always resolves the
public key **by key_id**, so old signatures never break.

## Well-known keys

```ts
import { buildWellKnown } from "@factlock/keystore";
const doc = buildWellKnown(await store.listRecords());
// serve at /.well-known/factlock-keys.json (CDN-cached)
```

Lists current **and** recently-retired keys with `valid_from`/`valid_until` and
`status` (`active` | `grace` | `retired`), so any agent can resolve any
historical `key_id` it encounters in the log.

## Tests

`npm test` — 17 tests: registry CRUD + persistence, rotation AC (old sigs
verify post-rotate), well-known doc correctness through rotation, sunset
semantics, KMS SPKI parsing, and a "private material never crosses the wire"
assertion against a stubbed KMS client.
