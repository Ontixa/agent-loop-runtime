import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigManager, CONFIG_FILE } from '../config/config-manager.js';
import { AgentType } from '../types.js';

/**
 * Config migration: qwen-loop.config.json → agentloop.config.json
 * The legacy file is detected, backed up, translated; never destroyed.
 */

let dir: string;
let savedCwd: string;

const LEGACY = {
  agents: [
    { name: 'qwen-1', type: 'qwen', model: 'qwen3-coder', timeout: 600000 },
    { name: 'my-cli', type: 'custom', command: 'myagent', additionalArgs: ['--fast'] }
  ],
  workingDirectory: '.',
  loopInterval: 5000,
  maxConcurrentTasks: 2,
  autoCommit: true,
  autoPush: true,
  enableSelfTasks: true,
  maxRetries: 3
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alr-cfg-'));
  savedCwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(savedCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('legacy config detection', () => {
  test('qwen-loop.config.json is detected and loaded via migration path', () => {
    writeFileSync(join(dir, 'qwen-loop.config.json'), JSON.stringify(LEGACY));
    const cfg = new ConfigManager();
    assert.ok(cfg.hasLegacyConfig());
    assert.ok(cfg.legacyPath!.includes('qwen-loop.config.json'));
    assert.equal(cfg.getConfig().agents.length, 2);
  });

  test('legacy agent entries translate to new shape (qwen stays qwen, custom keeps command)', () => {
    writeFileSync(join(dir, 'qwen-loop.config.json'), JSON.stringify(LEGACY));
    const cfg = new ConfigManager();
    const agents = cfg.getConfig().agents;
    assert.equal(agents[0].type, AgentType.QWEN);
    assert.equal(agents[0].name, 'qwen-1');
    assert.equal(agents[0].model, 'qwen3-coder');
    assert.equal(agents[1].type, AgentType.CUSTOM);
    assert.equal(agents[1].command, 'myagent');
    assert.deepEqual(agents[1].additionalArgs, ['--fast']);
  });

  test('no config file → defaults, no legacy flag', () => {
    const cfg = new ConfigManager();
    assert.equal(cfg.hasLegacyConfig(), false);
    assert.equal(cfg.getConfig().agents.length, 0);
  });
});

describe('on-disk migration', () => {
  test('migrate writes agentloop.config.json + keeps legacy + makes backup', () => {
    const legacyPath = join(dir, 'qwen-loop.config.json');
    writeFileSync(legacyPath, JSON.stringify(LEGACY));
    const cfg = new ConfigManager();
    const result = cfg.migrateOnDisk();
    assert.ok(result);
    assert.ok(existsSync(result!.configPath));
    assert.ok(existsSync(result!.backupPath));
    // legacy file untouched
    assert.equal(readFileSync(legacyPath, 'utf8'), JSON.stringify(LEGACY));
    // new config contains migrated agents, drops loop mechanics
    const migrated = JSON.parse(readFileSync(result!.configPath, 'utf8'));
    assert.equal(migrated.agents.length, 2);
    assert.equal(migrated.autoPush, undefined, 'autoPush must not carry over — policy gates it now');
    assert.equal(migrated.autoCommit, undefined);
    assert.equal(migrated.loopInterval, undefined);
  });

  test('migrate is a no-op when agentloop.config.json already exists', () => {
    writeFileSync(join(dir, 'qwen-loop.config.json'), JSON.stringify(LEGACY));
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ agents: [], workingDirectory: '.', logLevel: 'info' }));
    const cfg = new ConfigManager();
    assert.equal(cfg.migrateOnDisk(), null);
  });

  test('migrate is a no-op with nothing to migrate', () => {
    const cfg = new ConfigManager();
    assert.equal(cfg.migrateOnDisk(), null);
  });
});

describe('new config file', () => {
  test('agentloop.config.json loads directly', () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({
      agents: [{ name: 'a1', type: 'codex' }],
      defaultAgent: 'a1',
      workingDirectory: '.',
      logLevel: 'warn',
      validationCommands: { test: ['npm', 'test'] }
    }));
    const cfg = new ConfigManager();
    assert.ok(cfg.loadedFromFile);
    assert.equal(cfg.getConfig().agents[0].type, 'codex');
    assert.equal(cfg.getConfig().logLevel, 'warn');
    assert.deepEqual(cfg.getConfig().validationCommands!.test, ['npm', 'test']);
    assert.equal(cfg.hasLegacyConfig(), false);
  });

  test('corrupt config throws with file path', () => {
    writeFileSync(join(dir, CONFIG_FILE), '{bad json');
    assert.throws(() => new ConfigManager(), /agentloop\.config\.json/);
  });

  test('validation catches malformed agent entries', () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({
      agents: [{ name: 'x', type: 'custom' }], // custom without command
      workingDirectory: '.', logLevel: 'info'
    }));
    const cfg = new ConfigManager();
    const errors = cfg.validateConfig();
    assert.ok(errors.length > 0);
  });
});
