import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify
} from 'crypto';
import { createHash } from 'crypto';
import { writeJsonAtomic, writeFileAtomic, readJsonFileChecked } from '../util/atomic-file.js';
import { canonicalJson } from '../util/canonical-json.js';
import { missionDir } from './mission-store.js';
import type { Mission } from '../types.js';
import { buildReceipt, type MissionReceipt } from './receipt.js';

/**
 * Signed execution receipts — an Ed25519 signature over the canonical
 * (RFC 8785 JCS-style) serialization of the existing mission receipt.
 *
 * The signed envelope is a WRAPPER: `receipt.json` stays the unsigned,
 * self-contained record; `receipt.signed.json` carries the same receipt plus
 * the signature and the public key needed to verify it. An external
 * transparency layer (e.g. ReasoningReceipt) can countersign the same
 * canonical bytes later without the runtime depending on it.
 *
 * Trust boundary (honest): the signing key is a local key under
 * `.agentloop/keys/` (or an operator-provided PEM via
 * AGENTLOOP_RECEIPT_KEY_FILE). It binds a receipt to THIS installation's
 * key — it is tamper evidence for the record, not remote attestation or a
 * multi-operator identity. Protecting the private key is the operator's
 * responsibility, same as any local credential.
 */

export interface ReceiptSignatureBlock {
  algorithm: 'ed25519';
  canonicalization: 'jcs-rfc8785';
  /** sha256 hex of the signer's SPKI DER — stable key identity */
  keyFingerprint: string;
  /** Embedded so the envelope verifies without out-of-band key fetch */
  publicKeyPem: string;
  signedAt: string;
  /** base64 signature over canonicalJson(receipt) */
  value: string;
}

export interface SignedMissionReceipt {
  schemaVersion: 1;
  receiptFormat: 'agentloop/signed-mission-receipt';
  signature: ReceiptSignatureBlock;
  receipt: MissionReceipt;
}

export interface ReceiptSigningKey {
  privateKeyPem: string;
  publicKeyPem: string;
  fingerprint: string;
  /** Where the private key material came from (never the secret itself) */
  source: 'generated' | 'loaded' | 'env';
}

export const SIGNED_RECEIPT_FILE = 'receipt.signed.json';
const KEY_DIR = 'keys';
const PRIVATE_KEY_FILE = 'receipt-ed25519-private.pem';
const PUBLIC_KEY_FILE = 'receipt-ed25519-public.pem';
const KEY_ENV = 'AGENTLOOP_RECEIPT_KEY_FILE';

export function signedReceiptPath(repoRoot: string, missionId: string): string {
  return join(missionDir(repoRoot, missionId), SIGNED_RECEIPT_FILE);
}

function keyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

/**
 * Resolve the signing key for a repo. Operator-supplied PEM via
 * AGENTLOOP_RECEIPT_KEY_FILE wins and is never written to. Otherwise the
 * repo's `.agentloop/keys/` pair is loaded, or generated on first use
 * (private key written mode 0600; `.agentloop/` is fully git-ignored).
 */
export function loadOrCreateReceiptKey(repoRoot: string): ReceiptSigningKey {
  const envPath = process.env[KEY_ENV];
  if (envPath) {
    const privateKeyPem = readFileSync(envPath, 'utf-8');
    const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ format: 'pem', type: 'spki' }).toString();
    return { privateKeyPem, publicKeyPem, fingerprint: keyFingerprint(publicKeyPem), source: 'env' };
  }

  const dir = join(repoRoot, '.agentloop', KEY_DIR);
  const privPath = join(dir, PRIVATE_KEY_FILE);
  const pubPath = join(dir, PUBLIC_KEY_FILE);

  if (existsSync(privPath)) {
    const privateKeyPem = readFileSync(privPath, 'utf-8');
    const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ format: 'pem', type: 'spki' }).toString();
    if (!existsSync(pubPath)) writeFileAtomic(pubPath, publicKeyPem, 0o644);
    return { privateKeyPem, publicKeyPem, fingerprint: keyFingerprint(publicKeyPem), source: 'loaded' };
  }

  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  writeFileAtomic(privPath, privateKeyPem, 0o600);
  writeFileAtomic(pubPath, publicKeyPem, 0o644);
  return { privateKeyPem, publicKeyPem, fingerprint: keyFingerprint(publicKeyPem), source: 'generated' };
}

/** Sign a receipt with the resolved repo key. */
export function signReceipt(receipt: MissionReceipt, key: ReceiptSigningKey): SignedMissionReceipt {
  const payload = Buffer.from(canonicalJson(receipt), 'utf-8');
  const signature = sign(null, payload, createPrivateKey(key.privateKeyPem));
  return {
    schemaVersion: 1,
    receiptFormat: 'agentloop/signed-mission-receipt',
    signature: {
      algorithm: 'ed25519',
      canonicalization: 'jcs-rfc8785',
      keyFingerprint: key.fingerprint,
      publicKeyPem: key.publicKeyPem,
      signedAt: new Date().toISOString(),
      value: signature.toString('base64')
    },
    receipt
  };
}

export interface ReceiptVerification {
  ok: boolean;
  errors: string[];
  keyFingerprint?: string;
  missionId?: string;
}

/**
 * Verify a signed receipt envelope. Fails closed: malformed shape, wrong
 * format/algorithm, fingerprint/public-key mismatch, tampered receipt, or an
 * invalid signature all produce ok=false with reasons — never a guess.
 */
export function verifySignedReceipt(envelope: unknown): ReceiptVerification {
  const errors: string[] = [];
  const env = envelope as Partial<SignedMissionReceipt> | null;
  if (!env || typeof env !== 'object') {
    return { ok: false, errors: ['not a JSON object'] };
  }
  if (env.schemaVersion !== 1) errors.push(`unsupported schemaVersion: ${String(env.schemaVersion)}`);
  if (env.receiptFormat !== 'agentloop/signed-mission-receipt') {
    errors.push(`unexpected receiptFormat: ${String(env.receiptFormat)}`);
  }
  const sig = env.signature as Partial<ReceiptSignatureBlock> | undefined;
  if (!sig || typeof sig !== 'object') {
    errors.push('missing signature block');
  }
  const receipt = env.receipt as MissionReceipt | undefined;
  if (!receipt || typeof receipt !== 'object') {
    errors.push('missing receipt object');
  }
  if (errors.length > 0 || !sig || !receipt) return { ok: false, errors };

  if (sig.algorithm !== 'ed25519') errors.push(`unsupported algorithm: ${String(sig.algorithm)}`);
  if (sig.canonicalization !== 'jcs-rfc8785') {
    errors.push(`unsupported canonicalization: ${String(sig.canonicalization)}`);
  }
  if (typeof sig.publicKeyPem !== 'string' || !sig.publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    errors.push('signature.publicKeyPem is not a PEM public key');
  }
  if (typeof sig.value !== 'string' || sig.value.length === 0) {
    errors.push('signature.value missing');
  }
  if (typeof sig.keyFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(sig.keyFingerprint)) {
    errors.push('signature.keyFingerprint malformed');
  }
  if (errors.length > 0) return { ok: false, errors };

  // The declared fingerprint must match the embedded public key — a signer
  // identity claim that does not match the verifying key is malformed.
  let actualFingerprint: string;
  try {
    actualFingerprint = keyFingerprint(sig.publicKeyPem!);
  } catch {
    return { ok: false, errors: ['signature.publicKeyPem unparseable'] };
  }
  if (actualFingerprint !== sig.keyFingerprint) {
    return { ok: false, errors: ['keyFingerprint does not match embedded public key'], keyFingerprint: actualFingerprint };
  }

  let payload: Buffer;
  try {
    payload = Buffer.from(canonicalJson(receipt), 'utf-8');
  } catch (err) {
    return { ok: false, errors: [`receipt not canonically serializable: ${err instanceof Error ? err.message : String(err)}`], keyFingerprint: actualFingerprint };
  }

  let valid = false;
  try {
    valid = verify(null, payload, createPublicKey(sig.publicKeyPem!), Buffer.from(sig.value!, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, errors: ['signature does not verify — receipt was modified or signed by another key'], keyFingerprint: actualFingerprint, missionId: receipt.mission?.id };
  }
  return { ok: true, errors: [], keyFingerprint: actualFingerprint, missionId: receipt.mission?.id };
}

/** Build + sign + persist a mission's signed receipt; returns the file path. */
export function writeSignedReceipt(repoRoot: string, mission: Mission): string {
  const key = loadOrCreateReceiptKey(repoRoot);
  const path = signedReceiptPath(repoRoot, mission.id);
  writeJsonAtomic(path, signReceipt(buildReceipt(mission), key));
  return path;
}

/** Read + parse a signed receipt file; undefined when missing or corrupt. */
export function readSignedReceipt(path: string): SignedMissionReceipt | undefined {
  const res = readJsonFileChecked<SignedMissionReceipt>(path);
  return res.status === 'ok' ? res.value : undefined;
}
