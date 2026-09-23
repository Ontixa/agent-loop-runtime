import type { Policy } from '../types.js';

/**
 * Command safety classification.
 *
 * Validation gates and agent-requested commands are classified before
 * execution. Only policy-allowed commands run automatically; dangerous
 * commands require explicit human approval, and some are always refused.
 */

export type CommandRisk =
  | 'allowed'        // explicit allowlist match → run
  | 'needs-approval' // dangerous class or approvalRequiredCommands match
  | 'refused';       // always refused regardless of approval

export interface CommandVerdict {
  risk: CommandRisk;
  reason: string;
}

interface DangerPattern {
  pattern: RegExp;
  label: string;
  /** 'approval' → human may approve; 'refused' → never run */
  level: 'approval' | 'refused';
}

/**
 * Dangerous command classes. Patterns match against the argv joined as
 * text (with each arg pre-quoted) — a conservative match is fine because
 * false positives only cost an approval round-trip.
 */
const DANGEROUS: DangerPattern[] = [
  // deployment / hosting
  { pattern: /\b(vercel|netlify|firebase|aws|gcloud|az|heroku|flyctl|wrangler)\b[^|\n]*\b(deploy|publish|release|up|apply|push)\b/i, label: 'deployment', level: 'approval' },
  { pattern: /\b(kubectl|helm|terraform|pulumi|cdk|ansible)\b[^|\n]*\b(apply|deploy|destroy|delete|up)\b/i, label: 'infrastructure mutation', level: 'approval' },
  // package publishing
  { pattern: /\b(npm|yarn|pnpm|pip|twine|cargo|gem|dotnet|nuget|poetry)\b[^|\n]*\b(publish|push|upload|release)\b/i, label: 'package publishing', level: 'approval' },
  { pattern: /\bnpm\b[^|\n]*\b(dist-tag|deprecate|unpublish)\b/i, label: 'package registry mutation', level: 'approval' },
  // database destruction
  { pattern: /\b(drop|truncate|delete)\b[^|\n]*\b(database|table|collection|bucket)\b/i, label: 'data destruction', level: 'approval' },
  { pattern: /\b(psql|mysql|mongo|redis-cli|sqlite3)\b[^|\n]*\b(drop|delete|flushall|flushdb|remove)\b/i, label: 'database destruction', level: 'approval' },
  // cloud resource mutation
  { pattern: /\b(aws|gcloud|az)\b[^|\n]*\b(delete|terminate|destroy|remove|stop|revoke)\b/i, label: 'cloud resource mutation', level: 'approval' },
  // wallet / chain operations
  { pattern: /\b(wallet|solana|cast|forge|hardhat|truffle|bitcoin|eth)\b[^|\n]*\b(send|transfer|sign|broadcast|swap)\b/i, label: 'wallet operation', level: 'refused' },
  { pattern: /\b(private[-_]?key|mnemonic|seed[-_]?phrase)\b/i, label: 'credential handling', level: 'refused' },
  // credential changes
  { pattern: /\b(passwd|chpasswd|net user|dscl|htpasswd|aws iam|gcloud iam)\b/i, label: 'credential change', level: 'refused' },
  { pattern: /\b(ssh-keygen|openssl req|certbot)\b/i, label: 'credential change', level: 'approval' },
  // system package/service mutation
  { pattern: /\b(apt|apt-get|yum|dnf|brew|winget|choco|pacman|snap)\b[^|\n]*\b(install|remove|uninstall|upgrade|purge)\b/i, label: 'system package modification', level: 'approval' },
  { pattern: /\b(systemctl|service|sc\.exe|launchctl)\b[^|\n]*\b(start|stop|restart|enable|disable|delete)\b/i, label: 'service mutation', level: 'approval' },
  // destructive filesystem ops (beyond repo scope)
  { pattern: /\b(rm|del|rmdir|rd|Remove-Item)\b[^|\n]*(-rf?|-recurse|\/s|\*)\b/i, label: 'destructive filesystem operation', level: 'approval' },
  { pattern: /\b(format|mkfs|diskpart|fdisk)\b/i, label: 'disk operation', level: 'refused' },
  // shell eval of remote content
  { pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|\n]*(\||\bash\b|\bsh\b|\bps1\b|\beval\b)/i, label: 'remote script execution', level: 'approval' },
  // git destructive ops (runtime-managed ops go through git-runner, not here).
  // REFUSED patterns must precede the generic git-mutation approval below.
  // NOTE: argv is matched as quoted tokens, so 'push' and '--force' are
  // separate words — the pattern must span quoted args, not literal spaces.
  { pattern: /\bgit\b[^|\n]*\bpush\b[^|\n]*(-f\b|force\b)|\bgit\b[^|\n]*\b(filter-branch|rebase)\b/i, label: 'destructive git operation', level: 'refused' },
  { pattern: /\bgit\b[^|\n]*\bpush\b|\bgit\b[^|\n]*\b(reset|clean)\b|\bgit\b[^|\n]*\b(checkout|restore)\b[^|\n]*(--|\.|-f\b|source)/i, label: 'git mutation', level: 'approval' },
  // process / kernel
  { pattern: /\b(kill|taskkill|pkill)\b[^|\n]*(-9|\/F)\b.*\b(1|init|systemd)\b/i, label: 'system process kill', level: 'refused' }
];

/** Check argv prefix match: does `argv` start with `prefix`? */
function argvHasPrefix(argv: string[], prefix: string[]): boolean {
  if (prefix.length > argv.length) return false;
  return prefix.every((p, i) => p === argv[i]);
}

/**
 * Classify a command (as argv) against policy.
 * First match wins in order: allowlist → refused → approvalRequired →
 * dangerous-approval → refused-by-default? No — unknown commands are
 * needs-approval (fail closed).
 */
export function classifyCommand(argv: string[], policy: Policy): CommandVerdict {
  if (!argv || argv.length === 0) {
    return { risk: 'refused', reason: 'empty command' };
  }

  // 1. explicit allowlist → allowed
  for (const allowed of policy.allowedCommands) {
    if (argvHasPrefix(argv, allowed)) {
      return { risk: 'allowed', reason: `matched allowlist: ${allowed.join(' ')}` };
    }
  }

  const text = argv.map(a => JSON.stringify(a)).join(' ');

  // 2. user-configured approval-required list
  for (const req of policy.approvalRequiredCommands) {
    if (argvHasPrefix(argv, req)) {
      return { risk: 'needs-approval', reason: `matched approval-required list: ${req.join(' ')}` };
    }
  }

  // 3. extra user patterns
  for (const pat of policy.dangerousCommandPatterns) {
    try {
      if (new RegExp(pat, 'i').test(text)) {
        return { risk: 'needs-approval', reason: `matched policy pattern: ${pat}` };
      }
    } catch { /* bad user pattern — ignore */ }
  }

  // 4. built-in dangerous classes
  for (const d of DANGEROUS) {
    if (d.pattern.test(text)) {
      return d.level === 'refused'
        ? { risk: 'refused', reason: `refused class: ${d.label}` }
        : { risk: 'needs-approval', reason: `dangerous class: ${d.label}` };
    }
  }

  // 5. fail closed: unknown commands need approval
  return { risk: 'needs-approval', reason: 'not in allowedCommands policy' };
}

/**
 * Check if a repo-relative path is inside a declared scope list. A scope entry
 * covers an exact path match or anything beneath it — the entry is a directory
 * prefix, so 'src' covers 'src/x' but never 'srcfoo/x' (a bare prefix match
 * would let scope silently bleed into sibling names). This is the same
 * matching rule the deterministic reviewer applies to `spec.scope` and to
 * granted scope-expansion paths — keep both call sites on this implementation.
 */
export function pathInScope(relPath: string, scope: string[]): boolean {
  const f = relPath.replace(/\\/g, '/');
  return scope.some(s => {
    const e = s.replace(/\\/g, '/');
    return f === e || f.startsWith(e.endsWith('/') ? e : e + '/');
  });
}

/** Check if a repo-relative path falls under protected paths (glob-lite). */
export function isProtectedPath(relPath: string, protectedPaths: string[]): boolean {
  const norm = relPath.replace(/\\/g, '/');
  for (const pattern of protectedPaths) {
    const p = pattern.replace(/\\/g, '/');
    if (p.endsWith('/**')) {
      const base = p.slice(0, -3);
      if (norm === base || norm.startsWith(base + '/')) return true;
    } else if (p.endsWith('/*')) {
      const base = p.slice(0, -2);
      if (norm.startsWith(base + '/') && !norm.slice(base.length + 1).includes('/')) return true;
    } else if (norm === p || norm.startsWith(p + '/')) {
      return true;
    }
  }
  return false;
}
