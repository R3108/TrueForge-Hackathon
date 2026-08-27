/** Terminal rendering for a streaming agent turn. */

import { stdout, env } from 'node:process';

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

/**
 * Colour is opt-out. Piping a run into a log file, a CI job or `tee` should
 * produce readable text rather than escape codes - and an approval transcript
 * is exactly the kind of thing someone keeps. Honours the NO_COLOR convention;
 * FORCE_COLOR wins both ways, which is how you keep colour while recording
 * through a pipe.
 */
const useColor =
  'FORCE_COLOR' in env ? env.FORCE_COLOR !== '0' : Boolean(stdout.isTTY) && !('NO_COLOR' in env);

const wrap = (code: string) => (s: string) => (useColor ? `${ESC}[${code}m${s}${RESET}` : s);

export const style = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
};

/** Printable width, ignoring any ANSI colour already applied. */
function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').length;
}

export function banner(title: string, subtitle?: string): void {
  const width = Math.max(visibleWidth(title), visibleWidth(subtitle ?? '')) + 4;
  const line = '─'.repeat(width);
  console.log(`\n${style.cyan(line)}`);
  console.log(`  ${style.bold(title)}`);
  if (subtitle) console.log(`  ${style.dim(subtitle)}`);
  console.log(`${style.cyan(line)}\n`);
}

export function stage(n: number, label: string): void {
  console.log(`\n${style.cyan(`[${n}/6]`)} ${style.bold(label)}`);
}

/** Truncate tool arguments so a 400-line file body doesn't flood the terminal. */
export function preview(value: unknown, max = 400): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined || text === null) return '';
  return text.length > max
    ? `${text.slice(0, max)}${style.dim(` … (+${text.length - max} more chars)`)}`
    : text;
}

/**
 * Render text as numbered source lines, the way a reviewer expects to read a
 * patch. Capped by line count rather than characters: a human approving a write
 * needs whole lines, not a string sliced mid-token.
 */
export function numberLines(text: string, maxLines = 24): string {
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines);
  const gutter = String(Math.min(lines.length, maxLines)).length;

  const body = shown
    .map((line, i) => `${style.dim(String(i + 1).padStart(gutter) + ' │')} ${line}`)
    .join('\n');

  const hidden = lines.length - shown.length;
  return hidden > 0 ? `${body}\n${style.dim(`${' '.repeat(gutter)} └ … ${hidden} more lines`)}` : body;
}

/** Compact age for a listing: "just now", "7m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now';

  const units: Array<[number, string]> = [
    [60, 's'],
    [60, 'm'],
    [24, 'h'],
    [Number.POSITIVE_INFINITY, 'd'],
  ];

  let value = seconds;
  for (const [step, suffix] of units) {
    if (value < step) return `${value}${suffix} ago`;
    value = Math.round(value / step);
  }
  return `${value}d ago`;
}

/** Left-aligned columns with a dim header. Widths ignore ANSI. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(visibleWidth(header), ...rows.map((row) => visibleWidth(row[column] ?? ''))),
  );

  const pad = (cell: string, column: number): string =>
    cell + ' '.repeat(Math.max(0, (widths[column] ?? 0) - visibleWidth(cell)));

  const head = style.dim(headers.map((h, i) => pad(h, i)).join('  '));
  const body = rows.map((row) => headers.map((_, i) => pad(row[i] ?? '', i)).join('  '));

  return [head, ...body].join('\n');
}

/** Paths where a write deserves a second look before anyone types "y". */
const SENSITIVE: Array<{ test: RegExp; note: string }> = [
  { test: /^\.github\//i, note: 'modifies CI / workflow configuration' },
  { test: /(^|\/)package(-lock)?\.json$/i, note: 'changes dependencies' },
  { test: /(^|\/)\.env/i, note: 'touches an environment file' },
  { test: /secret|credential|token|password/i, note: 'path looks credential-related' },
];

/** Tools whose blast radius is bigger than "one file on a branch". */
const DESTRUCTIVE: Record<string, string> = {
  delete_file: 'deletes a file',
  merge_pull_request: 'merges into the base branch',
  update_issue: 'edits an existing issue',
  update_pull_request: 'edits an existing pull request',
};

export interface CallSummary {
  /** Aligned label/value pairs: the "what and where" of the call. */
  fields: Array<[string, string]>;
  /** The payload a reviewer actually has to read - file content, PR body. */
  body?: { label: string; text: string };
  /** Reasons to look twice, shown in yellow above the prompt. */
  risks: string[];
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Every repository path a tool call would write to. */
export function pathsIn(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const single = str(args.path);
  if (single) paths.push(single);

  if (Array.isArray(args.files)) {
    for (const file of args.files) {
      const p = str((file as Record<string, unknown>)?.path);
      if (p) paths.push(p);
    }
  }
  return paths;
}

/**
 * Turn a raw tool call into something a human can approve on sight.
 *
 * The gate is the whole safety argument of this project, and an operator who
 * cannot see what they are approving is not really approving it. This picks the
 * fields that matter per tool instead of dumping the argument JSON.
 */
export function summarizeCall(toolName: string, rawArgs: unknown): CallSummary {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const fields: Array<[string, string]> = [];
  const risks: string[] = [];
  let body: CallSummary['body'];

  const add = (label: string, value: unknown): void => {
    const text = str(value);
    if (text) fields.push([label, text]);
  };

  const owner = str(args.owner);
  const repo = str(args.repo);
  if (owner && repo) fields.push(['repo', `${owner}/${repo}`]);
  else add('repo', repo);

  add('branch', args.branch ?? args.head ?? args.ref);
  add('base', args.base);
  add('path', args.path);
  add('title', args.title);
  add('message', args.message ?? args.commit_message);

  if (Array.isArray(args.files) && args.files.length > 0) {
    const paths = pathsIn(args).join(', ');
    fields.push(['files', `${args.files.length} · ${paths}`]);

    const first = args.files[0] as Record<string, unknown>;
    const content = str(first?.content);
    if (content) body = { label: `content of ${str(first?.path) ?? 'first file'}`, text: content };
  }

  const content = str(args.content);
  if (content) body = { label: 'content', text: content };

  const prose = str(args.body);
  if (prose && !body) body = { label: 'body', text: prose };

  for (const path of pathsIn(args)) {
    for (const rule of SENSITIVE) {
      if (rule.test.test(path) && !risks.includes(rule.note)) risks.push(rule.note);
    }
  }

  const destructive = DESTRUCTIVE[toolName];
  if (destructive) risks.push(destructive);

  return { fields, body, risks };
}

/** The aligned label/value block used under a tool name. */
export function renderFields(fields: Array<[string, string]>, indent = '        '): string {
  if (fields.length === 0) return '';
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields
    .map(([label, value]) => `${indent}${style.dim(label.padEnd(width))}  ${value}`)
    .join('\n');
}

/** One-line description of a call, for the streaming log. */
export function summarizeInline(toolName: string, args: unknown): string {
  const { fields } = summarizeCall(toolName, args);
  const interesting = fields.find(([label]) => label === 'path' || label === 'files')?.[1];
  return interesting ? `${toolName} ${style.dim(interesting)}` : toolName;
}
