import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config } from './config.ts';

/**
 * A TrueForge client pointed at the configured server.
 *
 * The default SDK timeout is 60s, which a real repair turn blows straight
 * through - reproducing a bug and running a test suite in the sandbox takes
 * minutes, not seconds.
 */
export function createClient(config: Config): TrueForge {
  return new TrueForge({
    baseUrl: config.baseUrl,
    ...(config.token ? { token: config.token } : {}),
    timeoutInSeconds: 900,
  });
}
