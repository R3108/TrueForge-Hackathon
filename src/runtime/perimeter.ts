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
 * Scope, stated honestly: this is enforced in the dispatch client, so it governs
 * `npm run dispatch`. Driving the same agent from the TrueForge chat UI bypasses
 * it, because the harness itself only knows the repository-level gate.
 */

import { pathsIn } from './render.ts';

export type PerimeterVerdict =
  /** The call writes only inside the perimeter, or carries no paths to judge. */
  | { status: 'allowed' }
  /** The call writes outside the perimeter and must never reach a human. */
  | { status: 'blocked'; offending: string[] };

/**
 * Normalise a repository path for comparison: forward slashes, no leading
 * `./` or `/`, and `.`/`..` segments resolved. A path that climbs above the
 * repository root returns undefined - it cannot be inside any perimeter, and
 * treating it as a literal string would let `fixture/../src/agent/spec.ts`
 * walk straight out.
 */
export function normalizePath(path: string): string | undefined {
  // Repository paths must be relative. Normalizing an absolute path by merely
  // dropping its root would turn an unsafe input into an apparently safe one.
  if (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(path)) return undefined;

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

/** Does this path sit inside at least one of the perimeter's patterns? */
export function isInsidePerimeter(path: string, patterns: string[]): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;

  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    return globToRegExp(normalizedPattern).test(normalized);
  });
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

  const paths = pathsIn((args ?? {}) as Record<string, unknown>);
  if (paths.length === 0) return { status: 'allowed' };

  const offending = paths.filter((path) => !isInsidePerimeter(path, patterns));
  return offending.length > 0 ? { status: 'blocked', offending } : { status: 'allowed' };
}
