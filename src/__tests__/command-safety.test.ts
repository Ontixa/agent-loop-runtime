import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, isProtectedPath } from '../policy/command-safety.js';
import { DEFAULT_POLICY, resolvePolicy } from '../policy/policy.js';

describe('command classification', () => {
  test('allowlisted commands pass', () => {
    const policy = resolvePolicy({ allowedCommands: [['npm', 'test'], ['npm', 'run', 'lint']] });
    assert.equal(classifyCommand(['npm', 'test'], policy).risk, 'allowed');
    assert.equal(classifyCommand(['npm', 'run', 'lint', '--fix'], policy).risk, 'allowed'); // prefix match
  });

  test('empty argv refused', () => {
    assert.equal(classifyCommand([], DEFAULT_POLICY).risk, 'refused');
  });

  test('unknown command fails closed to needs-approval', () => {
    const v = classifyCommand(['mystery-tool', '--do-things'], DEFAULT_POLICY);
    assert.equal(v.risk, 'needs-approval');
    assert.ok(v.reason.includes('not in allowedCommands'));
  });

  test('destructive filesystem ops gated by approval', () => {
    for (const argv of [
      ['rm', '-rf', '/'],
      ['rm', '-rf', '~'],
      ['cmd', '/c', 'rmdir', '/s', '/q', 'C:\\'],
      ['del', '/s', '*.*']
    ]) {
      const v = classifyCommand(argv, DEFAULT_POLICY);
      assert.equal(v.risk, 'needs-approval', `${argv.join(' ')} should need approval`);
    }
  });

  test('git force-push and history rewrite refused', () => {
    for (const argv of [
      ['git', 'push', '--force'],
      ['git', 'push', '-f'],
      ['git', 'filter-branch'],
      ['git', 'rebase', 'main']
    ]) {
      const v = classifyCommand(argv, DEFAULT_POLICY);
      assert.equal(v.risk, 'refused', `${argv.join(' ')} should be refused`);
    }
  });

  test('ordinary git push needs approval not refused', () => {
    const v = classifyCommand(['git', 'push', 'origin', 'agentloop/m-1'], DEFAULT_POLICY);
    assert.equal(v.risk, 'needs-approval');
  });

  test('package publishing needs approval', () => {
    assert.equal(classifyCommand(['npm', 'publish'], DEFAULT_POLICY).risk, 'needs-approval');
    assert.equal(classifyCommand(['yarn', 'publish'], DEFAULT_POLICY).risk, 'needs-approval');
  });

  test('cloud/infra mutation needs approval', () => {
    for (const argv of [
      ['aws', 's3', 'rm', 's3://bucket'],
      ['kubectl', 'delete', 'deployment', 'app'],
      ['terraform', 'apply'],
      ['gcloud', 'deploy']
    ]) {
      assert.equal(classifyCommand(argv, DEFAULT_POLICY).risk, 'needs-approval', argv.join(' '));
    }
  });

  test('wallet/crypto ops refused', () => {
    assert.equal(classifyCommand(['cast', 'send', '--private-key', '0xabc'], DEFAULT_POLICY).risk, 'refused');
  });

  test('policy approvalRequiredCommands honored', () => {
    const policy = resolvePolicy({ approvalRequiredCommands: [['deploy.sh']] });
    assert.equal(classifyCommand(['deploy.sh', 'prod'], policy).risk, 'needs-approval');
  });

  test('allowlist wins over dangerous-looking args', () => {
    const policy = resolvePolicy({ allowedCommands: [['npm', 'test']] });
    // npm test is allowlisted even though its args look arbitrary
    assert.equal(classifyCommand(['npm', 'test', '--', '--watch'], policy).risk, 'allowed');
  });
});

describe('protected paths', () => {
  test('exact and glob matches', () => {
    const paths = ['.agentloop/**', '.env', 'secrets/*', 'agentloop.policy.json'];
    assert.ok(isProtectedPath('.agentloop/missions/m-1/mission.json', paths));
    assert.ok(isProtectedPath('.agentloop', paths));
    assert.ok(isProtectedPath('.env', paths));
    assert.ok(isProtectedPath('secrets/key.pem', paths));
    assert.ok(isProtectedPath('agentloop.policy.json', paths));
  });

  test('non-protected paths pass', () => {
    const paths = ['.agentloop/**', '.env'];
    assert.ok(!isProtectedPath('src/index.ts', paths));
    assert.ok(!isProtectedPath('.env.example', paths));
    assert.ok(!isProtectedPath('agentloop.config.json', paths));
  });

  test('windows separators normalized', () => {
    assert.ok(isProtectedPath('.agentloop\\missions\\m-1', ['.agentloop/**']));
  });
});
