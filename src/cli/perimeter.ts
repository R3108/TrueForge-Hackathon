/**
 * Ask the perimeter what it would do, without running the agent.
 *
 *   npm run perimeter                                  # show the compiled rules
 *   npm run perimeter -- fixture/src/cart.js src/agent/spec.ts
 *   npm run perimeter -- --expect-blocked src/agent/spec.ts
 *
 * A boundary you can only observe by dispatching a live incident is a boundary
 * nobody checks. The `--expect-*` forms turn it into an assertion, which is how
 * CI proves on every pull request that the agent still cannot rewrite its own
 * approval gate - see `.github/workflows/ci.yml`.
 *
 * This reads only `LTP_WRITE_PATHS`, so it needs no server, no model and no
 * connectors.
 */
import { compilePerimeter, judgePath } from '../runtime/perimeter.ts';
import { banner, style, table } from '../runtime/render.ts';

type Expectation = 'none' | 'blocked' | 'allowed';

function main(): void {
  const paths: string[] = [];
  let expect: Expectation = 'none';

  for (const arg of process.argv.slice(2)) {
    if (arg === '--expect-blocked') expect = 'blocked';
    else if (arg === '--expect-allowed') expect = 'allowed';
    else paths.push(arg);
  }

  const patterns = (process.env.LTP_WRITE_PATHS ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);

  const rules = compilePerimeter(patterns);

  banner('WRITE PERIMETER', patterns.join(', ') || 'not declared');

  if (patterns.length === 0) {
    console.log(
      style.yellow(
        '  No perimeter declared (LTP_WRITE_PATHS is empty). Every path the harness allows\n' +
          '  is writable, subject only to the human gate.\n',
      ),
    );
    // An expectation against an undeclared perimeter is a configuration error,
    // not a passing test - say so rather than reporting a hollow success.
    process.exitCode = expect === 'none' ? 0 : 1;
    return;
  }

  console.log(`  ${style.green('grant')}    ${rules.allow.join(', ') || style.dim('(none)')}`);
  console.log(`  ${style.red('exclude')}  ${rules.deny.join(', ') || style.dim('(none)')}`);

  if (rules.allow.length === 0) {
    console.log(
      `\n  ${style.yellow('This perimeter grants nothing: it is exclusions only, so every write is refused.')}`,
    );
  }

  if (paths.length === 0) {
    console.log(
      `\n${style.dim('  Pass paths to judge them: npm run perimeter -- fixture/src/cart.js\n')}`,
    );
    return;
  }

  const rows: string[][] = [];
  let blocked = 0;

  for (const path of paths) {
    const verdict = judgePath(path, rules);
    if (verdict.status !== 'inside') blocked++;

    rows.push([
      verdict.status === 'inside' ? style.green('ALLOW') : style.red('BLOCK'),
      path,
      verdict.status === 'inside'
        ? `matches ${verdict.pattern}`
        : verdict.status === 'excluded'
          ? `excluded by !${verdict.pattern}`
          : 'outside every grant',
    ]);
  }

  console.log('');
  console.log(table(['', 'PATH', 'RULE'], rows));
  console.log('');

  if (expect === 'blocked' && blocked !== paths.length) {
    console.error(
      style.red(
        `  Expected every path to be blocked; ${paths.length - blocked} of ${paths.length} would be written.\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (expect === 'allowed' && blocked > 0) {
    console.error(
      style.red(`  Expected every path to be allowed; ${blocked} of ${paths.length} were blocked.\n`),
    );
    process.exitCode = 1;
    return;
  }

  if (expect !== 'none') console.log(style.green(`  Expectation held for ${paths.length} path(s).\n`));
}

main();
