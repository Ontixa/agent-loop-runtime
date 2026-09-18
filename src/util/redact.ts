/**
 * Secret redaction for logs, events, and persisted metadata.
 *
 * Repository content and agent output are untrusted — anything we persist or
 * emit passes through here first. Patterns cover common token shapes; this is
 * best-effort defense, not a guarantee.
 */

const SECRET_PATTERNS: RegExp[] = [
  // GitHub / GitLab / common cloud tokens
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /ghr_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[0-9A-Za-z_-]+/g,
  // Bearer / basic auth in text
  /(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  // key=value secrets
  /([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*['"]?)[^\s'"]{8,}/gi,
  // URLs with embedded credentials
  /(https?:\/\/)[^/\s:]+:[^/\s@]+@/gi,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

const REPLACEMENT = '[REDACTED]';

/** Redact known secret shapes from a string. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, g1) =>
      g1 !== undefined ? `${g1}${REPLACEMENT}` : REPLACEMENT
    );
  }
  return out;
}

/**
 * Recursively redact secrets from a JSON-serializable value.
 * Object keys that look secret-bearing are replaced wholesale.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(key|token|secret|password|credential)/i.test(k) && typeof v === 'string') {
        out[k] = REPLACEMENT;
      } else {
        out[k] = redactValue(v);
      }
    }
    return out as T;
  }
  return value;
}

/** Bound a string to maxBytes, keeping the tail (most recent output). */
export function boundTail(input: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(input, 'utf-8') <= maxBytes) {
    return { text: input, truncated: false };
  }
  // Slice conservatively by chars; multibyte boundaries handled by Buffer
  const buf = Buffer.from(input, 'utf-8');
  const tail = buf.subarray(buf.length - maxBytes).toString('utf-8');
  return { text: `…[truncated]\n${tail}`, truncated: true };
}
