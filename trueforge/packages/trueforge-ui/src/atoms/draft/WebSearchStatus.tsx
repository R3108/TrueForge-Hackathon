'use client';

import { useServerCapabilities } from '../../server/ServerContext.js';
import { cn } from '../lib/cn.js';
import { Tooltip } from '../primitives/Tooltip.js';

type WebSearchStatusValue =
  | { state: 'checking'; label: string; detail: string }
  | { state: 'available'; label: string; detail: string }
  | { state: 'unavailable'; label: string; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readWebSearchStatus(capabilities: unknown): WebSearchStatusValue {
  if (capabilities === null) {
    return { state: 'checking', label: 'Web search', detail: 'Checking whether web_search is available…' };
  }
  if (!isRecord(capabilities) || !isRecord(capabilities.web_search)) {
    return {
      state: 'unavailable',
      label: 'Web search',
      detail: 'web_search is unavailable because this server does not report a configured provider.',
    };
  }

  const capability = capabilities.web_search;
  if (capability.enabled === true) {
    const provider = capability.provider === 'brave' ? ' via Brave' : '';
    return {
      state: 'available',
      label: 'Web search',
      detail: `web_search is available${provider} for current information.`,
    };
  }

  const reason = typeof capability.reason === 'string' ? capability.reason.trim().slice(0, 200) : '';
  return {
    state: 'unavailable',
    label: 'Web search',
    detail: reason.length > 0 ? `web_search is unavailable: ${reason}` : 'web_search is unavailable on this server.',
  };
}

export function WebSearchStatus() {
  const capabilities = useServerCapabilities();
  const status = readWebSearchStatus(capabilities);
  const available = status.state === 'available';

  return (
    <Tooltip content={status.detail} side="top">
      <span
        role="status"
        tabIndex={0}
        aria-label={`${status.label}: ${status.state}`}
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium',
          available
            ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
            : 'border-border bg-secondary-bg text-text-secondary',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            available ? 'bg-green-500' : status.state === 'checking' ? 'bg-amber-500' : 'bg-text-tertiary',
          )}
        />
        {status.label}
      </span>
    </Tooltip>
  );
}
