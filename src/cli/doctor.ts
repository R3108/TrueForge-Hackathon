/**
 * Pre-flight check. Run this before a demo so you find out the connector is
 * unauthorized now, and not on camera.
 *
 *   npm run doctor
 */
import { loadConfig, type Config } from '../config.ts';
import { createClient } from '../client.ts';
import { AGENT_NAME } from '../agent/spec.ts';
import { banner, style } from '../runtime/render.ts';

interface Check {
  label: string;
  run: () => Promise<string>;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`\n${style.red('Config error:')} ${describe(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const client = createClient(config);
  banner('LICENCE TO PATCH — pre-flight', config.baseUrl);

  const checks: Check[] = [
    {
      label: 'Node 22.14+',
      run: async () => {
        const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
        if (major > 22 || (major === 22 && minor >= 14)) return process.versions.node;
        throw new Error(`found ${process.versions.node}; TrueForge needs 22.14 or newer`);
      },
    },
    {
      label: 'TrueForge server reachable',
      run: async () => {
        const res = await fetch(`${config.baseUrl}/api/v1/docs`, { redirect: 'manual' });
        if (res.status >= 500) throw new Error(`server returned ${res.status}`);
        return `${config.baseUrl} responded`;
      },
    },
    {
      label: `Agent "${AGENT_NAME}" provisioned`,
      run: async () => {
        const agents = client.agents as unknown as { list: () => Promise<{ data: unknown }> };
        const { data } = await agents.list();
        const items = Array.isArray(data) ? data : ((data as { items?: unknown[] })?.items ?? []);
        const found = (items as Array<{ name?: string }>).some((a) => a?.name === AGENT_NAME);
        if (!found) throw new Error('not found - run: npm run provision');
        return 'found';
      },
    },
  ];

  let failed = 0;
  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`  ${style.green('PASS')}  ${check.label} ${style.dim(detail)}`);
    } catch (error) {
      failed++;
      console.log(`  ${style.red('FAIL')}  ${check.label} ${style.dim(describe(error))}`);
    }
  }

  console.log(
    `\n${failed === 0 ? style.green('All clear. Cleared for dispatch.') : style.red(`${failed} check(s) failed.`)}\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  console.error(`\n${style.red('Doctor crashed:')} ${describe(error)}\n`);
  process.exitCode = 1;
});
