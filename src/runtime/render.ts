/** Terminal rendering for a streaming agent turn. */

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

const wrap = (code: string) => (s: string) => `${ESC}[${code}m${s}${RESET}`;

export const style = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
};

export function banner(title: string, subtitle?: string): void {
  const width = Math.max(title.length, subtitle?.length ?? 0) + 4;
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
