/**
 * The credential tripwire.
 *
 * The perimeter answers "where may the agent write". This answers "what may it
 * write", and the two failures are different. Stage 3 runs real code in a
 * sandbox: an agent debugging an auth bug can legitimately end up holding a
 * token in its context, and the most natural thing in the world is to paste the
 * value that made the test pass straight into the patch.
 *
 * So every payload bound for the repository is scanned before it is offered for
 * approval. A hit is not a colour on a prompt - under the default policy it is
 * an automatic denial, for the same reason the perimeter is: a leaked
 * credential is not something a tired operator should have the option to wave
 * through at 3am, and the cost of a false positive is one word in
 * `LTP_SECRET_POLICY`.
 *
 * The rules are deliberately narrow. A scanner that fires on every long string
 * is a scanner people turn off.
 */

export type SecretPolicy = 'block' | 'warn' | 'off';

export interface SecretFinding {
  /** What was recognised, e.g. "GitHub personal access token". */
  label: string;
  /** 1-based line within the scanned payload, so a reviewer can go look. */
  line: number;
  /** Enough of the match to recognise it, never enough to use it. */
  redacted: string;
}

interface Rule {
  label: string;
  pattern: RegExp;
}

/**
 * Shapes that are credentials by construction - the prefix and length are the
 * issuer's, so a match is a real key or a deliberate imitation of one.
 */
const RULES: Rule[] = [
  { label: 'GitHub personal access token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { label: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'OpenAI API key', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/g },
  { label: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'Sentry auth token', pattern: /\bsntrys_[A-Za-z0-9+/=_.-]{40,}\b/g },
  { label: 'private key block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  {
    label: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

/**
 * A hardcoded assignment to a credential-shaped name. Far noisier than the
 * rules above, so the value has to look like a real one to count.
 */
const ASSIGNMENT =
  /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)\b\s*[:=]\s*(['"`])([^'"`\n]{12,})\1/gi;

/**
 * Values that look like credentials but are documentation. `.env.example` files
 * and test fixtures are full of these, and flagging them trains operators to
 * ignore the tripwire - which is worse than not having one.
 */
const PLACEHOLDER =
  /^(?:\$\{|process\.env|import\.meta|<|\{\{|your[_-]?|my[_-]?|some[_-]?|test[_-]?|fake[_-]?|dummy[_-]?|placeholder|example|changeme|redacted|xxx|\.\.\.|\*{3,})/i;

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER.test(value.trim())) return true;
  // "sk-xxxxxxxx", "ghp_****": a value with no variety carries no secret.
  return new Set(value.replace(/[^A-Za-z0-9]/g, '')).size <= 4;
}

/** Show enough to identify the finding, never enough to reuse it. */
function redact(match: string): string {
  const head = match.slice(0, Math.min(7, Math.max(3, match.indexOf('_') + 1)));
  return `${head}${'*'.repeat(6)} (${match.length} chars)`;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Scan one payload for credentials. Findings are deduplicated by label so a
 * file with forty JWTs produces one warning, not forty.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  if (!text) return [];

  const found = new Map<string, SecretFinding>();

  const note = (label: string, match: string, index: number): void => {
    if (found.has(label)) return;
    found.set(label, { label, line: lineOf(text, index), redacted: redact(match) });
  };

  for (const rule of RULES) {
    // Fresh lastIndex per scan: these are module-level /g regexes.
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      if (!isPlaceholder(match[0])) note(rule.label, match[0], match.index);
    }
  }

  ASSIGNMENT.lastIndex = 0;
  let assignment: RegExpExecArray | null;
  while ((assignment = ASSIGNMENT.exec(text)) !== null) {
    const value = assignment[2] ?? '';
    if (!isPlaceholder(value)) {
      note('hardcoded credential assignment', value, assignment.index);
    }
  }

  return [...found.values()];
}

/** Scan several labelled payloads - a multi-file push, a PR body, a message. */
export function scanPayloads(
  payloads: Array<{ label: string; text: string }>,
): Array<SecretFinding & { where: string }> {
  const findings: Array<SecretFinding & { where: string }> = [];
  for (const payload of payloads) {
    for (const finding of scanForSecrets(payload.text)) {
      findings.push({ ...finding, where: payload.label });
    }
  }
  return findings;
}

/** How a finding reads on a terminal line or in a denial reason. */
export function describeFinding(finding: SecretFinding & { where?: string }): string {
  const where = finding.where ? `${finding.where}:${finding.line}` : `line ${finding.line}`;
  return `${finding.label} in ${where} — ${finding.redacted}`;
}

/** Parse `LTP_SECRET_POLICY`, defaulting to the safe direction. */
export function parseSecretPolicy(value: string | undefined): SecretPolicy {
  const policy = value?.trim().toLowerCase();
  return policy === 'warn' || policy === 'off' ? policy : 'block';
}
