// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { DraftComposerLeftSection, DraftComposerRightSection } from '@/atoms/draft/DraftComposerSections.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentSpec } from '@/server/types.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

let agentSpec: AgentSpec;
const updateAgentSpec = vi.fn();

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

function DraftSections({
  onAttach,
  disabled = false,
  isRunning = false,
  webSearch,
}: {
  onAttach?: () => void;
  disabled?: boolean;
  isRunning?: boolean;
  webSearch?: { enabled: boolean; provider?: 'brave'; reason?: string };
}) {
  const webSearchField = webSearch === undefined ? {} : { web_search: webSearch };
  const server = createMockAgentUIServer({
    getCapabilities: async () => ({
      data: {
        sandbox: { enabled: true },
        skill: { enabled: true },
        settings: { enabled: true },
        ...webSearchField,
      },
    }),
    getModels: async () => [
      {
        id: 'gpt-4.1',
        name: 'openai/gpt-4.1',
        provider: { name: 'OpenAI' },
        properties: { reasoningEfforts: ['low', 'high'] },
      },
    ],
  });

  return (
    <ServerProvider server={server}>
      <DraftCatalogProvider>
        <DraftComposerLeftSection disabled={disabled} isRunning={isRunning} onAttach={onAttach} />
        <DraftComposerRightSection disabled={disabled} isRunning={isRunning} />
      </DraftCatalogProvider>
    </ServerProvider>
  );
}

describe('draft composer sections', () => {
  beforeEach(() => {
    agentSpec = {
      model: { name: 'openai/gpt-4.1', params: { reasoningEffort: 'high' } },
      mcpServers: [{ id: 'github', name: 'GitHub' }],
      skills: [
        { id: 'research', name: 'Research' },
        { id: 'writer', name: 'Writer' },
      ],
    };
    updateAgentSpec.mockReset();
  });

  it('composes the Tools count and standalone attachment control', () => {
    const onAttach = vi.fn();
    render(<DraftSections onAttach={onAttach} />);

    expect(screen.getByRole('button', { name: 'Tools (3)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }));

    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it('composes model and reasoning selectors in the right section', async () => {
    render(<DraftSections />);

    expect(await screen.findByTitle('Select model')).toHaveTextContent('gpt-4.1');
    expect(await screen.findByTitle('Select reasoning effort')).toHaveTextContent('high');
  });

  it('shows configured web search as available and names the executable tool', async () => {
    render(<DraftSections webSearch={{ enabled: true, provider: 'brave' }} />);

    const status = await screen.findByRole('status', { name: 'Web search: available' });
    fireEvent.focus(status);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'web_search is available via Brave for current information.',
    );
  });

  it('shows the server reason when web search is unavailable', async () => {
    render(<DraftSections webSearch={{ enabled: false, reason: 'Web search is not configured on this server.' }} />);

    const status = await screen.findByRole('status', { name: 'Web search: unavailable' });
    fireEvent.focus(status);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Web search is not configured on this server.');
  });

  it('handles older servers with no web-search field', async () => {
    render(<DraftSections />);

    const status = await screen.findByRole('status', { name: 'Web search: unavailable' });
    fireEvent.focus(status);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('does not report a configured provider');
  });

  it('propagates disabled and running state to composed controls', async () => {
    const { rerender } = render(<DraftSections disabled />);

    expect(screen.getByRole('button', { name: 'Tools (3)' })).toBeDisabled();
    expect(await screen.findByTitle('Select model')).toBeDisabled();
    expect(await screen.findByTitle('Select reasoning effort')).toBeDisabled();

    rerender(<DraftSections isRunning />);
    expect(screen.getByRole('button', { name: 'Tools (3)' })).toBeDisabled();
    expect(await screen.findByTitle('Select model')).toBeDisabled();
    expect(await screen.findByTitle('Select reasoning effort')).toBeDisabled();
  });
});
