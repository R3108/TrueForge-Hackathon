'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '../lib/cn.js';

export const ADAPTIVE_COMMANDS = [
  { command: 'goal', syntax: '/goal <text>', insert: '/goal ', description: 'Set the durable objective.' },
  { command: 'plan', syntax: '/plan [text]', insert: '/plan', description: 'Request or provide a durable plan.' },
  {
    command: 'context',
    syntax: '/context add <text>',
    insert: '/context add ',
    description: 'Add bounded user context; use /context clear to reset.',
  },
  { command: 'task', syntax: '/task <text>', insert: '/task ', description: 'Append a deterministic task.' },
  {
    command: 'request',
    syntax: '/request <text>',
    insert: '/request ',
    description: 'Set the explicit current request.',
  },
  {
    command: 'completion',
    syntax: '/completion <text>',
    insert: '/completion ',
    description: 'Set completion verification criteria.',
  },
  {
    command: 'model',
    syntax: '/model <provider/model>',
    insert: '/model ',
    description: 'Override the backend-resolved model; use /model clear to reset.',
  },
  {
    command: 'effort',
    syntax: '/effort <value>',
    insert: '/effort ',
    description: 'Set model reasoning effort; use /effort clear to reset.',
  },
] as const;

type AdaptiveCommandName = (typeof ADAPTIVE_COMMANDS)[number]['command'];

export interface ActiveAdaptiveControl {
  command: AdaptiveCommandName;
  line: string;
  start: number;
  end: number;
}

const commandNames = new Set<string>(ADAPTIVE_COMMANDS.map(item => item.command));
const singletonCommands = new Set<AdaptiveCommandName>(['goal', 'plan', 'request', 'completion', 'model', 'effort']);

export function parseActiveAdaptiveControls(text: string): ActiveAdaptiveControl[] {
  const controls: ActiveAdaptiveControl[] = [];
  let offset = 0;
  while (offset < text.length) {
    const lineEnd = text.indexOf('\n', offset);
    const contentEnd = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(offset, contentEnd).replace(/\r$/, '');
    const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+.*)?$/i.exec(line);
    const command = match?.[1]?.toLowerCase();
    if (command === undefined || !commandNames.has(command)) {
      break;
    }
    const definition = ADAPTIVE_COMMANDS.find(item => item.command === command);
    if (definition === undefined) {
      break;
    }
    controls.push({
      command: definition.command,
      line,
      start: offset,
      end: lineEnd === -1 ? text.length : lineEnd + 1,
    });
    offset = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  return controls;
}

export function removeActiveAdaptiveControl(text: string, control: ActiveAdaptiveControl): string {
  return text.slice(0, control.start) + text.slice(control.end);
}

export function upsertAdaptiveCommand(text: string, command: AdaptiveCommandName, insertion: string): string {
  const slashQuery = /^\/[a-z0-9_-]*$/i.test(text) ? text : undefined;
  if (slashQuery !== undefined) {
    return insertion;
  }

  const active = parseActiveAdaptiveControls(text);
  if (singletonCommands.has(command)) {
    const existing = active.find(control => control.command === command);
    if (existing !== undefined) {
      const newline = existing.end > existing.start + existing.line.length ? '\n' : '';
      return text.slice(0, existing.start) + insertion + newline + text.slice(existing.end);
    }
  }

  const prefixEnd = active.at(-1)?.end ?? 0;
  const separator = prefixEnd === 0 || text.slice(0, prefixEnd).endsWith('\n') ? '' : '\n';
  const suffixSeparator = text.slice(prefixEnd).length > 0 ? '\n' : '';
  return text.slice(0, prefixEnd) + separator + insertion + suffixSeparator + text.slice(prefixEnd);
}

function commandLabel(control: ActiveAdaptiveControl): string {
  const value = control.line.slice(control.command.length + 1).trim();
  if (value.length === 0) {
    return `/${control.command}`;
  }
  const bounded = value.length > 32 ? `${value.slice(0, 29)}…` : value;
  return `/${control.command} ${bounded}`;
}

export function AdaptiveControlsComposerInput({ input, disabled }: { input: ReactNode; disabled?: boolean }) {
  const aui = useAui();
  const text = useAuiState(state => state.composer.text);
  const [manualOpen, setManualOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const controls = parseActiveAdaptiveControls(text);
  const slashQuery = /^\/([a-z0-9_-]*)$/i.exec(text)?.[1]?.toLowerCase();
  const filtered = ADAPTIVE_COMMANDS.filter(item => slashQuery === undefined || item.command.startsWith(slashQuery));
  const open = !disabled && (manualOpen || slashQuery !== undefined);

  useEffect(() => {
    setActiveIndex(0);
  }, [slashQuery, manualOpen]);

  useEffect(() => {
    if (!manualOpen) {
      return;
    }
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (containerRef.current && target instanceof Node && !containerRef.current.contains(target)) {
        setManualOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [manualOpen]);

  const choose = (item: (typeof ADAPTIVE_COMMANDS)[number]) => {
    aui.composer().setText(upsertAdaptiveCommand(text, item.command, item.insert));
    setManualOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setManualOpen(false);
      return;
    }
    if (filtered.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = (activeIndex + direction + filtered.length) % filtered.length;
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
      return;
    }
  };

  return (
    <div ref={containerRef} className="relative" onKeyDownCapture={handleKeyDown}>
      {controls.length > 0 ? (
        <div aria-label="Active adaptive controls" className="mb-1 flex flex-wrap gap-1" role="group">
          {controls.map(control => (
            <span
              key={`${control.start}-${control.line}`}
              className="bg-button-hover text-text-secondary inline-flex max-w-full items-center rounded-full border border-border px-2 py-0.5 text-xs"
            >
              <span className="truncate">{commandLabel(control)}</span>
              <button
                type="button"
                className="hover:text-text-primary ml-1 rounded px-0.5"
                aria-label={`Clear ${commandLabel(control)}`}
                disabled={disabled}
                onClick={() => aui.composer().setText(removeActiveAdaptiveControl(text, control))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-start gap-1">
        <button
          type="button"
          aria-controls={open ? menuId : undefined}
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn(
            'text-text-secondary hover:bg-ghost-button-hover mt-1 rounded-md px-2 py-1 text-xs font-medium',
            disabled && 'cursor-not-allowed opacity-50',
          )}
          disabled={disabled}
          title="Adaptive controls"
          onClick={() => setManualOpen(value => !value)}
        >
          / Controls
        </button>
        <div className="min-w-0 flex-1">{input}</div>
      </div>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Adaptive slash commands"
          className="bg-card-bg text-text-primary absolute bottom-full left-0 z-50 mb-2 max-h-80 w-full max-w-md overflow-y-auto rounded-lg border border-border p-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <p className="text-text-secondary px-3 py-2 text-sm">No matching adaptive command.</p>
          ) : (
            filtered.map((item, index) => (
              <button
                key={item.command}
                ref={element => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitem"
                tabIndex={index === activeIndex ? 0 : -1}
                className={cn(
                  'flex w-full flex-col rounded-md px-3 py-2 text-left',
                  index === activeIndex ? 'bg-dropdown-selected-item-bg' : 'hover:bg-ghost-button-hover',
                )}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    choose(item);
                  }
                }}
                onClick={() => choose(item)}
              >
                <span className="font-mono text-sm font-semibold">{item.syntax}</span>
                <span className="text-text-secondary text-xs">{item.description}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
