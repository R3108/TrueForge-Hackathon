/**
 * The write perimeter.
 *
 * `LTP_TARGET_REPO` is repo-granular: once the agent may write to a repository,
 * the harness will let it write anywhere in that repository - including, when
 * the agent's own source lives there, to the approval gate that is supposed to
 * be restraining it.
 *
 * The perimeter closes that gap. It is a declared, version-controlled allowlist
 * of paths the agent may write to. Anything outside it is denied before a human
 * is ever asked, so the boundary is not something an operator can be talked
 * through at 3am.
 *
 * A pattern prefixed with `!` is an exclusion, and exclusions win. That matters
 * because an allowlist alone is coarse: `fixture/**` is the right grant for a
 * service under repair, but nothing inside it should let the agent rewrite the
 * fixture's own CI workflow, which is what verifies its patch.
 *
 *     LTP_WRITE_PATHS=fixture/**,!fixture/.github/**
 *
 * Scope, stated honestly: this is enforced in the dispatch client, so it governs
 * `npm run dispatch`. Driving the same agent from the TrueForge chat UI bypasses
 * it, because the harness itself only knows the repository-level gate.
 */

import { pathsIn } from './render.ts';

/** Why a single path was refused. */
export interface Offender {
  path: string;
  /** `outside`: matched no allow pattern. `excluded`: matched a `!` pattern. */
  rule: 'outside' | 'excluded';
  /** The exclusion that caught it, when there was one. */
  pattern?: string;
}

export type PerimeterVerdict =
  /** The call writes only inside the perimeter, or carries no paths to judge. */
  | { status: 'allowed' }
  /** The call writes outside the perimeter and must never reach a human. */
  | { status: 'blocked'; offending: Offender[] };

/** A perimeter split into what it grants and what it takes back. */
export interface PerimeterRules {
  allow: string[];
  deny: string[];
}

export type PathVerdict =
  | { status: 'inside'; pattern: string }
  | { status: 'outside' }
  | { status: 'excluded'; pattern: string };

/**
 * Normalise a repository path for comparison: forward slashes, no leading
 * `./` or `/`, and `.`/`..` segments resolved. A path that climbs above the
 * repository root returns undefined - it cannot be inside any perimeter, and
 * treating it as a literal string would let `fixture/../src/agent/spec.ts`
 * walk straight out.
 */
export function normalizePath(path: string): string | undefined {
  const segments = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }

  return out.length > 0 ? out.join('/') : undefined;
}

/**
 * Compile a glob to an anchored regular expression.
 *
 * `**` crosses directory separators, `*` and `?` do not. Deliberately small:
 * a perimeter nobody can read is a perimeter nobody can audit.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';

  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);

    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i++;
        // `fixture/**/x` and `fixture/**` should both work, so swallow a
        // separator that immediately follows the wildcard.
        if (glob[i + 1] === '/') i++;
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

function tidyPattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Split a declared perimeter into grants and exclusions.
 *
 * A perimeter of exclusions only (`!secrets/**` and nothing else) grants
 * nothing at all rather than everything-but. Read as an allowlist it is empty,
 * and an empty allowlist should fail closed - the alternative silently turns a
 * typo into blanket write access to the repository.
 */
export function compilePerimeter(patterns: string[]): PerimeterRules {
  const allow: string[] = [];
  const deny: string[] = [];

  for (const raw of patterns) {
    const pattern = tidyPattern(raw);
    if (!pattern) continue;
    if (pattern.startsWith('!')) {
      // Re-tidy: the `./` in `!./fixture/.env` sits after the negation marker.
      const negated = tidyPattern(pattern.slice(1));
      if (negated) deny.push(negated);
    } else {
      allow.push(pattern);
    }
  }

  return { allow, deny };
}

/** Judge one path, and say which rule decided it. */
export function judgePath(path: string, rules: PerimeterRules): PathVerdict {
  const normalized = normalizePath(path);
  if (!normalized) return { status: 'outside' };

  const excluded = rules.deny.find((pattern) => globToRegExp(pattern).test(normalized));
  if (excluded) return { status: 'excluded', pattern: excluded };

  const granted = rules.allow.find((pattern) => globToRegExp(pattern).test(normalized));
  return granted ? { status: 'inside', pattern: granted } : { status: 'outside' };
}

/** Does this path sit inside at least one grant, and outside every exclusion? */
export function isInsidePerimeter(path: string, patterns: string[]): boolean {
  return judgePath(path, compilePerimeter(patterns)).status === 'inside';
}

/**
 * Judge one tool call against the perimeter.
 *
 * An empty perimeter means "not declared", and nothing is blocked - the feature
 * is opt-in, so an operator who has not configured it keeps the plain gate.
 * Calls that carry no paths at all (opening a pull request, commenting on an
 * issue) are not the perimeter's business and go to the human as usual.
 */
export function checkPerimeter(args: unknown, patterns: string[]): PerimeterVerdict {
  if (patterns.length === 0) return { status: 'allowed' };

  const rules = compilePerimeter(patterns);
  const paths = pathsIn((args ?? {}) as Record<string, unknown>);
  if (paths.length === 0) return { status: 'allowed' };

  const offending: Offender[] = [];
  for (const path of paths) {
    const verdict = judgePath(path, rules);
    if (verdict.status === 'inside') continue;
    offending.push(
      verdict.status === 'excluded'
        ? { path, rule: 'excluded', pattern: verdict.pattern }
        : { path, rule: 'outside' },
    );
  }

  return offending.length > 0 ? { status: 'blocked', offending } : { status: 'allowed' };
}

/** One offending path, phrased for a denial reason or a terminal line. */
export function describeOffender(offender: Offender): string {
  return offender.rule === 'excluded'
    ? `${offender.path} (excluded by !${offender.pattern})`
    : offender.path;
}
