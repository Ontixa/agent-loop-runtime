import type { MissionPreset } from '../types.js';

/**
 * Built-in maintenance-mission presets.
 *
 * Each preset ships a strict scope: a bounded path allowlist (spec.scope),
 * an explicit command envelope, tight budgets, required validation gates and
 * a restrictive approval posture. They resolve through
 * engine/mission-presets.ts into an ordinary Mission — no parallel permission
 * system. Config-defined presets (`presets` in agentloop.config.json) may
 * shadow these by name.
 *
 * Keep these conservative: a preset that needs wider scope should get it via
 * the scope-expansion approval gate, not by broadening the defaults here.
 */

export const BUILTIN_PRESETS: Readonly<Record<string, MissionPreset>> = {
  'dep-update': {
    name: 'dep-update',
    description: 'Update outdated dependencies to compatible versions; verify with the project test gate.',
    objective: 'Update outdated dependencies to their latest compatible versions, keeping manifests and lockfiles consistent.',
    scope: [
      // npm / node
      'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
      'yarn.lock', '.yarnrc.yml', '.yarn/',
      'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      '.nvmrc', '.node-version', '.tool-versions',
      // python
      'requirements.txt', 'requirements-dev.txt', 'requirements/',
      'pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock',
      'setup.py', 'setup.cfg', '.python-version',
      // rust / go
      'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
      // ruby / php / jvm
      'Gemfile', 'Gemfile.lock', 'gems.rb', 'gems.locked', '.ruby-version',
      'composer.json', 'composer.lock',
      'pom.xml', 'build.gradle', 'build.gradle.kts',
      'settings.gradle', 'settings.gradle.kts',
      'gradle.properties', 'gradle/'
    ],
    nonGoals: [
      'new features or behavior changes beyond what the update requires',
      'unrelated refactoring',
      'major-version upgrades that require source-code migration'
    ],
    acceptanceCriteria: [
      'Dependency manifests and lockfiles reflect the updated compatible versions',
      'Required validation gates pass'
    ],
    requiredGates: ['test'],
    tasks: [
      'Inventory outdated dependencies using the project package manager',
      'Apply compatible version updates to manifests and regenerate lockfiles',
      'Reinstall and verify the updated dependency set'
    ],
    allowedCommands: [
      ['npm', 'install'], ['npm', 'ci'], ['npm', 'update'], ['npm', 'outdated'],
      ['npm', 'audit'], ['npm', 'test'], ['npm', 'run'],
      ['npx', 'npm-check-updates'],
      ['pnpm', 'install'], ['pnpm', 'update'], ['pnpm', 'outdated'],
      ['pnpm', 'audit'], ['pnpm', 'test'], ['pnpm', 'run'],
      ['yarn', 'install'], ['yarn', 'upgrade'], ['yarn', 'outdated'],
      ['yarn', 'audit'], ['yarn', 'test'], ['yarn', 'run'],
      ['pip', 'install'], ['pip', 'list'], ['pip-compile'], ['pip-sync'],
      ['poetry', 'update'], ['poetry', 'install'], ['poetry', 'lock'], ['poetry', 'check'],
      ['cargo', 'update'], ['cargo', 'build'], ['cargo', 'test'], ['cargo', 'outdated'],
      ['go', 'get'], ['go', 'mod'], ['go', 'build'], ['go', 'test'],
      ['bundle', 'update'], ['bundle', 'install'], ['bundle', 'exec'],
      ['composer', 'update'], ['composer', 'install'], ['composer', 'validate'],
      ['mvn', 'compile'], ['mvn', 'test'], ['mvn', 'versions:display-dependency-updates'],
      ['gradle', 'build'], ['./gradlew', 'build'], ['gradlew', 'build']
    ],
    budget: {
      maxMissionMinutes: 60,
      maxRepairPasses: 2,
      maxAgentInvocations: 6,
      agentTimeoutMs: 15 * 60 * 1000
    },
    approvals: {
      allowPush: 'never',
      allowPullRequest: 'approval',
      // Dependency resolution needs the package registry.
      allowNetwork: true
    }
  },

  'test-coverage': {
    name: 'test-coverage',
    description: 'Add tests for high-risk uncovered code paths; production code stays out of scope.',
    objective: 'Increase automated test coverage for the highest-risk untested code paths without changing production behavior.',
    scope: [
      'test/', 'tests/', 'spec/', 'specs/', 'e2e/',
      '__tests__/', 'src/__tests__/', 'test-utils/', 'fixtures/',
      // test-runner configuration
      'jest.config.js', 'jest.config.ts', 'jest.config.json',
      'vitest.config.js', 'vitest.config.ts', 'vitest.config.mts',
      'vitest.workspace.ts', 'vitest.workspace.js',
      '.mocharc.yml', '.mocharc.yaml', '.mocharc.json', '.mocharc.js',
      '.nycrc', '.nycrc.json', 'karma.conf.js', 'karma.conf.ts',
      'pytest.ini', 'tox.ini', '.coveragerc', 'coverage/',
      'phpunit.xml', 'phpunit.xml.dist',
      // manifests that carry test scripts/config
      'package.json', 'pyproject.toml', 'setup.cfg'
    ],
    nonGoals: [
      'production-code changes',
      'refactoring implementation files',
      'new features'
    ],
    acceptanceCriteria: [
      'New or extended tests exercise previously untested paths',
      'Required validation gates pass'
    ],
    requiredGates: ['test'],
    tasks: [
      'Identify the highest-risk code paths lacking test coverage',
      'Add focused tests for the uncovered behavior',
      'Run the test suite and fix test-only failures'
    ],
    allowedCommands: [
      ['npm', 'test'], ['npm', 'run'], ['npm', 'exec'],
      ['npx', 'vitest'], ['npx', 'jest'], ['npx', 'nyc'], ['npx', 'c8'],
      ['npx', 'tsx', '--test'], ['npx', 'mocha'], ['npx', 'tsc'],
      ['node', '--test'],
      ['pnpm', 'test'], ['pnpm', 'run'], ['pnpm', 'exec'],
      ['yarn', 'test'], ['yarn', 'run'],
      ['pytest'], ['python', '-m', 'pytest'], ['python', '-m', 'coverage'],
      ['python3', '-m', 'pytest'], ['python3', '-m', 'coverage'],
      ['cargo', 'test'], ['go', 'test'],
      ['phpunit'], ['composer', 'test'],
      ['bundle', 'exec'], ['rspec'],
      ['mvn', 'test'], ['gradle', 'test'], ['./gradlew', 'test'], ['gradlew', 'test']
    ],
    budget: {
      maxMissionMinutes: 60,
      maxRepairPasses: 2,
      maxAgentInvocations: 6,
      agentTimeoutMs: 15 * 60 * 1000
    },
    approvals: {
      allowPush: 'never',
      allowPullRequest: 'approval'
    }
  }
};
