import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateKeyPairSync } from 'crypto';
import { canonicalJson } from '../util/canonical-json.js';
import {
  signReceipt, verifySignedReceipt, writeSignedReceipt, readSignedReceipt,
  signedReceiptPath, loadOrCreateReceiptKey
} from '../mission/receipt-signing.js';
import { buildReceipt } from '../mission/receipt.js';
import { MissionStore } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { MissionState, AgentType } from '../types.js';
import type { MissionSpec, AgentConfig } from '../types.js';

let dir: string;
let store: MissionStore;
const savedEnv = process.env.AGENTLOOP_RECEIPT_KEY_FILE;

const spec: MissionSpec = { objective: 'Tighten flaky gate', acceptanceCriteria: ['npm test passes'] };
const agent: AgentConfig = { name: 'fake', type: AgentType.QWEN };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alr-sign-'));
  store = new MissionStore(dir);
  delete process.env.AGENTLOOP_RECEIPT_KEY_FILE;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENTLOOP_RECEIPT_KEY_FILE;
  else process.env.AGENTLOOP_RECEIPT_KEY_FILE = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function terminalMission() {
  const m = createMission({ repoPath: dir, spec, agent }, store);
  store.transition(store.mustLoad(m.id), MissionState.CANCELLED, 'test end');
  store.mutate(m.id, mm => {
    mm.outcome = { result: 'cancelled', summary: 'test', at: new Date().toISOString() };
  });
  return store.mustLoad(m.id);
}

describe('canonicalJson', () => {
  test('member order is canonical regardless of insertion order', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 }, z: [1, { y: 2, x: 3 }] });
    const b = canonicalJson({ z: [1, { x: 3, y: 2 }], a: { c: 3, d: 2 }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"c":3,"d":2},"b":1,"z":[1,{"x":3,"y":2}]}');
  });

  test('undefined members dropped like JSON.stringify; array holes become null', () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson([undefined, 2]), '[null,2]');
  });

  test('fails closed on non-JSON values', () => {
    assert.throws(() => canonicalJson(undefined));
    assert.throws(() => canonicalJson(10n));
    assert.throws(() => canonicalJson(NaN));
    assert.throws(() => canonicalJson(Infinity));
    assert.throws(() => canonicalJson(new Date()));
    assert.throws(() => canonicalJson(new Map()));
  });
});

describe('receipt signing', () => {
  test('loadOrCreateReceiptKey generates a stable repo key', () => {
    const k1 = loadOrCreateReceiptKey(dir);
    assert.equal(k1.source, 'generated');
    assert.match(k1.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.ok(existsSync(join(dir, '.agentloop', 'keys', 'receipt-ed25519-private.pem')));
    const k2 = loadOrCreateReceiptKey(dir);
    assert.equal(k2.source, 'loaded');
    assert.equal(k2.fingerprint, k1.fingerprint);
  });

  test('AGENTLOOP_RECEIPT_KEY_FILE overrides with an external key', () => {
    const pair = generateKeyPairSync('ed25519');
    const ext = join(dir, 'external.pem');
    writeFileSync(ext, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    process.env.AGENTLOOP_RECEIPT_KEY_FILE = ext;
    const k = loadOrCreateReceiptKey(dir);
    assert.equal(k.source, 'env');
    assert.ok(!existsSync(join(dir, '.agentloop', 'keys')), 'env key must not materialize a repo key');
  });

  test('sign → verify roundtrip', () => {
    const m = terminalMission();
    const key = loadOrCreateReceiptKey(dir);
    const env = signReceipt(buildReceipt(m), key);
    const v = verifySignedReceipt(env);
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.equal(v.missionId, m.id);
    assert.equal(v.keyFingerprint, key.fingerprint);
  });

  test('tampered receipt fails verification', () => {
    const key = loadOrCreateReceiptKey(dir);
    const env = signReceipt(buildReceipt(terminalMission()), key);
    env.receipt.mission.objective = 'attacker rewrote the objective';
    const v = verifySignedReceipt(env);
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' '), /does not verify/);
  });

  test('signature from another key fails', () => {
    const key = loadOrCreateReceiptKey(dir);
    const env = signReceipt(buildReceipt(terminalMission()), key);
    const other = generateKeyPairSync('ed25519');
    env.signature.publicKeyPem = other.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    env.signature.keyFingerprint = 'sha256:' + '0'.repeat(64);
    const v = verifySignedReceipt(env);
    assert.equal(v.ok, false);
  });

  test('malformed envelopes fail closed with reasons', () => {
    for (const bad of [null, 42, 'x', {}, { schemaVersion: 2, receiptFormat: 'agentloop/signed-mission-receipt', signature: {}, receipt: {} }]) {
      const v = verifySignedReceipt(bad);
      assert.equal(v.ok, false);
      assert.ok(v.errors.length > 0);
    }
  });
});

describe('signed receipt file', () => {
  test('writeSignedReceipt persists a verifiable envelope', () => {
    const m = terminalMission();
    const path = writeSignedReceipt(dir, m);
    assert.equal(path, signedReceiptPath(dir, m.id));
    const env = readSignedReceipt(path);
    assert.ok(env);
    assert.equal(env!.receiptFormat, 'agentloop/signed-mission-receipt');
    assert.equal(verifySignedReceipt(env).ok, true);
  });

  test('file bytes differ from unsigned receipt.json — envelope is a wrapper', () => {
    const m = terminalMission();
    const path = writeSignedReceipt(dir, m);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    assert.ok(parsed.signature?.value);
    assert.equal(parsed.receipt?.mission?.id, m.id);
  });
});
