import type { TrueForge } from '@truefoundry/trueforge-sdk';

/**
 * Look up a saved agent by name.
 *
 * Agents are addressed by an immutable server-generated id, but everything in
 * this repository refers to the agent by its stable name - so every entry point
 * needs this hop. A server with no agents yet is a normal state, not an error:
 * callers treat `undefined` as "not provisioned".
 */
export async function findAgentId(client: TrueForge, name: string): Promise<string | undefined> {
  try {
    const { data } = await client.agents.list();
    return data.find((agent) => agent.name === name)?.id;
  } catch {
    return undefined;
  }
}
