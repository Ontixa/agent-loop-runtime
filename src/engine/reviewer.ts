import { gitStdout, GitOutputLimitError } from '../git/git-runner.js';
import { changedFilesStrict, diffSummary } from '../git/repo-inspector.js';
import { isProtectedPath, pathInScope } from '../policy/command-safety.js';
import type { Mission, ReviewResult } from '../types.js';
import { redactSecrets } from '../util/redact.js';
import { logger } from '../logger.js';

/**
 * Reviewer.
 *
 * The default reviewer is deterministic: it inspects the mission branch diff
 * against base SHA for protected-path violations, scope violations, suspicious
 * content, and diff size. A second agent may be configured as an additional
 * reviewer — its output is advisory only and can never grant git permissions.
 */

const MAX_DIFF_FOR_SCAN = 512 * 1024;

/**
 * Patterns in diffs that warrant a finding (secret leakage, runtime tampering).
 * `^\+(?!\+\+)` matches added CONTENT lines only — the `+++ b/<path>` header
 * is a path, not added content. Path-based findings belong to the scope check:
 * without this, granting a protected path (e.g. agentloop.policy.json) could
 * never resolve — its own diff header would keep the finding alive forever.
 */
const SUSPICIOUS_DIFF_PATTERNS: Array<{ re: RegExp; finding: string }> = [
  { re: /^\+(?!\+\+).*(ghp_|gho_|sk-ant-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)/m, finding: 'possible secret committed in diff' },
  { re: /^\+(?!\+\+).*agentloop\.(config|policy)\.json/m, finding: 'diff references runtime config/policy' },
  { re: /^\+(?!\+\+).*(curl|wget|iwr)\b.*\|.*\b(sh|bash|ps1)\b/m, finding: 'remote script piping added' },
  { re: /^\+(?!\+\+).*process\.env\.[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/m, finding: 'env secret access added' }
];

export interface DeterministicReviewInput {
  worktreePath: string;
  baseSha: string;
  mission: Mission;
  /**
   * Repo-relative paths an approved scope-expansion decision widened the
   * mission envelope by. Granted paths are legitimate scope — they produce no
   * findings. Only UNCOVERED violations surface in `scopeViolation`.
   */
  grantedPaths?: string[];
}

/** Run deterministic review of the mission diff. Never throws. */
export async function deterministicReview(input: DeterministicReviewInput): Promise<ReviewResult> {
  const findings: string[] = [];
  const { worktreePath, baseSha, mission } = input;
  const policy = mission.policy;
  const granted = input.grantedPaths ?? [];
  const isGranted = (f: string) => granted.length > 0 && pathInScope(f, granted);

  try {
    const files = await changedFilesStrict(worktreePath, baseSha);

    // Protected paths — hard violation unless a scope-expansion approval
    // explicitly granted this exact path (operator override is on the record).
    const protectedHits = files.filter(f => isProtectedPath(f, policy.protectedPaths) && !isGranted(f));
    for (const f of protectedHits) {
      findings.push(`protected path modified: ${f}`);
    }

    // Scope check: if spec.scope is set, flag out-of-scope files (advisory → finding)
    const scope = mission.spec.scope ?? [];
    const grantedScope = [...scope, ...granted];
    let outOfScope: string[] = [];
    if (scope.length > 0) {
      outOfScope = files.filter(f =>
        !pathInScope(f, grantedScope) && !isProtectedPath(f, policy.protectedPaths));
      if (outOfScope.length > 0) {
        findings.push(`out-of-scope files modified: ${outOfScope.slice(0, 10).join(', ')}${outOfScope.length > 10 ? ` (+${outOfScope.length - 10} more)` : ''}`);
      }
    }
    const scopeViolation = (protectedHits.length > 0 || outOfScope.length > 0)
      ? { protectedPaths: protectedHits, outOfScopePaths: outOfScope }
      : undefined;

    // Diff-size budget
    const stat = await diffSummary(worktreePath, baseSha);
    if (policy.maxDiffBytes) {
      try {
        const diff = await gitStdout(['diff', baseSha, 'HEAD'], worktreePath);
        const bytes = Buffer.byteLength(diff, 'utf-8');
        if (bytes > policy.maxDiffBytes) {
          findings.push(`diff size ${Math.round(bytes / 1024)} KiB exceeds policy maxDiffBytes ${Math.round(policy.maxDiffBytes / 1024)} KiB`);
        }
        if (bytes <= MAX_DIFF_FOR_SCAN) {
          for (const { re, finding } of SUSPICIOUS_DIFF_PATTERNS) {
            if (re.test(diff)) findings.push(finding);
          }
        }
      } catch (error) {
        if (error instanceof GitOutputLimitError) throw error;
      }
    }

    // Non-goal advisory: flag dependency manifest changes when constrained
    if ((mission.spec.riskConstraints ?? []).some(c => /no[- ]dependency/i.test(c))) {
      const depFiles = files.filter(f => /package(-lock)?\.json|yarn\.lock|pnpm-lock|requirements\.txt|Cargo\.(toml|lock)|go\.(mod|sum)/.test(f));
      if (depFiles.length > 0) {
        findings.push(`dependency manifests modified under 'no-dependency-changes' constraint: ${depFiles.join(', ')}`);
      }
    }

    logger.debug('Deterministic review complete', {
      mission: mission.id, findings: findings.length, stat
    });

    return {
      reviewer: 'deterministic',
      verdict: findings.some(f => f.startsWith('protected path')) ? 'reject'
        : findings.length > 0 ? 'request-changes' : 'approve',
      findings,
      at: new Date().toISOString(),
      ...(scopeViolation ? { scopeViolation } : {})
    };
  } catch (err) {
    return {
      reviewer: 'deterministic',
      verdict: 'request-changes',
      findings: [`review error: ${redactSecrets(err instanceof Error ? err.message : String(err))}`],
      at: new Date().toISOString()
    };
  }
}

/** Compact review summary for repair prompts. */
export function reviewToPrompt(review: ReviewResult): string {
  if (review.findings.length === 0) return '';
  return `Reviewer findings (${review.reviewer}, verdict: ${review.verdict}):\n` +
    review.findings.map(f => `- ${f}`).join('\n');
}
