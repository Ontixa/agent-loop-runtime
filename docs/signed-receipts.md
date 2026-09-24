# Signed execution receipts

Every terminal mission already writes `receipt.json` — a portable record of
what the mission did. Signed receipts add `receipt.signed.json`: the same
receipt wrapped in an Ed25519 signature envelope, so a receipt taken out of
`.agentloop/` can be checked for tampering without trusting the runtime that
produced it.

## Envelope format

```json
{
  "schemaVersion": 1,
  "receiptFormat": "agentloop/signed-mission-receipt",
  "signature": {
    "algorithm": "ed25519",
    "canonicalization": "jcs-rfc8785",
    "keyFingerprint": "sha256:<64 hex of SPKI DER>",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
    "signedAt": "<iso8601>",
    "value": "<base64 signature>"
  },
  "receipt": { "…": "the exact MissionReceipt object" }
}
```

The signature covers the **canonical** (RFC 8785 JCS-style) UTF-8
serialization of the embedded `receipt` object — the same bytes
`canonicalJson()` produces. `signedAt` is metadata; the receipt's own
`generatedAt` is what the signature binds.

## Keys

- Per-repo keypair at `.agentloop/keys/receipt-ed25519-{private,public}.pem`,
  generated on first use (private key mode `0600`). `.agentloop/` is fully
  git-ignored, so keys and receipts never enter commits.
- `AGENTLOOP_RECEIPT_KEY_FILE=/path/to/key.pem` overrides with an
  operator-held PKCS8 Ed25519 private key — for keeping signing material
  outside the repo entirely. The file is only ever read.
- `keyFingerprint` is `sha256:` hex of the public key's SPKI DER — a stable
  identity you can record out-of-band to detect key substitution.

## Use

```bash
# Sign automatically at mission end
# agentloop.config.json:
{ "receipts": { "sign": true } }

# Or on demand:
agentloop receipt <missionId> --sign   # create/re-create receipt.signed.json
agentloop receipt <missionId>          # verify; exit 1 on any failure
agentloop receipt <missionId> --json   # machine-readable verdict
```

Verification is self-contained — the envelope carries its public key —
and fail-closed: malformed shape, format/algorithm mismatch,
fingerprint/key disagreement, tampered receipt, or a bad signature all
report `ok: false` with reasons. `report` and `status` surface the signed
path via `outcome.signedReceiptPath`.

## Trust boundary

The signing key is a **local** key. A signed receipt proves the record was
signed by this installation's key and has not changed since — tamper
evidence, not remote attestation, not a multi-operator identity, and not
proof the mission ran correctly (the receipt itself is the runtime's
honest record; interrupted work is marked `interrupted`, never hidden).
Protect the private key like any local credential. Rotating it only
changes which key signs *new* receipts — old envelopes still verify
against their embedded key.

The envelope is designed as a ReasoningReceipt-compatible wrapper: an
external transparency or countersigning layer can re-sign the same
canonical receipt bytes without the runtime depending on that layer.

Programmatic surface: `signReceipt`, `verifySignedReceipt`,
`writeSignedReceipt`, `readSignedReceipt`, `signedReceiptPath`,
`loadOrCreateReceiptKey`, `canonicalJson` — all exported from the package
root.
