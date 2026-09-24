import { existsSync } from 'fs';
import chalk from 'chalk';
import { MissionStore, CorruptStateError } from '../mission/mission-store.js';
import {
  signedReceiptPath, readSignedReceipt, verifySignedReceipt, writeSignedReceipt
} from '../mission/receipt-signing.js';

/**
 * `agentloop receipt <mission>` — inspect or create the signed execution
 * receipt for a mission.
 *
 * Default action verifies `receipt.signed.json` when present: the Ed25519
 * signature is checked over the canonical receipt and the declared key
 * fingerprint is reconciled with the embedded public key. `--sign` creates
 * (or re-creates) the signed envelope on demand; automatic signing at
 * mission end is enabled via `receipts.sign` in agentloop.config.json.
 */
export function cmdReceipt(id: string, opts: { json?: boolean; sign?: boolean; repo?: string }): void {
  const store = new MissionStore(opts.repo ?? process.cwd());
  let m;
  try {
    m = store.mustLoad(id);
  } catch (err) {
    if (err instanceof CorruptStateError) {
      console.error(chalk.red(`Mission ${id} record is corrupt — cannot produce a receipt.`));
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const path = signedReceiptPath(store.repoRoot, id);

  if (opts.sign) {
    const written = writeSignedReceipt(store.repoRoot, m);
    const env = readSignedReceipt(written);
    const v = env ? verifySignedReceipt(env) : { ok: false, errors: ['signed receipt unreadable after write'] };
    if (opts.json) {
      console.log(JSON.stringify({ path: written, ...v }, null, 2));
    } else {
      console.log(`Signed receipt: ${written}`);
      console.log(`  key: ${v.keyFingerprint ?? 'unknown'}${v.ok ? chalk.green('  (verified)') : ''}`);
      for (const e of v.errors) console.error(chalk.red(`  ${e}`));
    }
    if (!v.ok) process.exitCode = 1;
    return;
  }

  if (!existsSync(path)) {
    if (opts.json) {
      console.log(JSON.stringify({ signed: false, mission: id }, null, 2));
    } else {
      console.log(`Mission ${id} has no signed receipt.`);
      console.log('  Create one:    agentloop receipt ' + id + ' --sign');
      console.log('  Sign at end:   set "receipts": { "sign": true } in agentloop.config.json');
    }
    return;
  }

  const env = readSignedReceipt(path);
  const v = env
    ? verifySignedReceipt(env)
    : { ok: false, errors: [`unparseable signed receipt: ${path}`] };

  if (opts.json) {
    console.log(JSON.stringify({ path, ...v }, null, 2));
  } else {
    console.log(`Signed receipt ${id}`);
    console.log(`  file:         ${path}`);
    console.log(`  key:          ${v.keyFingerprint ?? 'unknown'}`);
    if (env?.signature?.signedAt) console.log(`  signed at:    ${env.signature.signedAt}`);
    if (v.ok) {
      console.log(`  signature:    ${chalk.green('valid')}`);
    } else {
      for (const e of v.errors) console.error(`  ${chalk.red('invalid:')} ${e}`);
    }
  }
  if (!v.ok) process.exitCode = 1;
}
