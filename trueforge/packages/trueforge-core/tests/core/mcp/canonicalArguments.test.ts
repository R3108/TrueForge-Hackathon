import {
  canonicalArgumentFingerprint,
  canonicalizeArguments,
  decodeArguments,
  fingerprintArguments,
} from '../../../src/core/mcp/canonicalArguments';
import { computeSelectorPolicyVersion } from '../../../src/core/mcp/ToolSelectorPolicy';

describe('canonical argument owner', () => {
  it('canonicalizes objects independent of key order', () => {
    expect(canonicalizeArguments({ b: 2, a: 1 })).toBe(canonicalizeArguments({ a: 1, b: 2 }));
  });

  it('preserves array order in the canonical form', () => {
    expect(canonicalizeArguments([1, 2])).not.toBe(canonicalizeArguments([2, 1]));
  });

  it('produces identical fingerprints for a JSON string and its decoded object', () => {
    expect(canonicalArgumentFingerprint('{"b":2,"a":1}')).toBe(fingerprintArguments({ a: 1, b: 2 }));
  });

  it('fails closed on non-object arguments and still yields a stable fingerprint', () => {
    expect(decodeArguments('   ')).toEqual({ ok: false, reason: expect.any(String) });
    expect(decodeArguments('[1,2]')).toEqual({ ok: false, reason: expect.any(String) });
    // A malformed string fingerprints the raw value; identical raw values match.
    expect(canonicalArgumentFingerprint('{bad')).toBe(canonicalArgumentFingerprint('{bad'));
  });

  it('fingerprints omitted arguments deterministically instead of throwing', () => {
    // `JSON.stringify(undefined)` is `undefined`, which `Hash.update` rejects;
    // a call with no arguments at all must still fingerprint and compare.
    expect(canonicalizeArguments(undefined)).toBe('undefined');
    expect(canonicalArgumentFingerprint(undefined)).toBe(
      canonicalArgumentFingerprint(undefined),
    );
    expect(fingerprintArguments(undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('selector policy version', () => {
  it('is stable across selector order and duplicates', () => {
    const a = computeSelectorPolicyVersion({
      enableTools: ['@all', 'x'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: ['@write', '@destructive'],
      preload: true,
    });
    const b = computeSelectorPolicyVersion({
      enableTools: ['x', '@all', 'x'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: ['@destructive', '@write'],
      preload: true,
    });
    expect(a).toBe(b);
  });

  it('changes when any effective selector or the preload flag changes', () => {
    const base = computeSelectorPolicyVersion({
      enableTools: ['@all'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: ['@write'],
      preload: true,
    });
    const changedApproval = computeSelectorPolicyVersion({
      enableTools: ['@all'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: ['@all'],
      preload: true,
    });
    const changedPreload = computeSelectorPolicyVersion({
      enableTools: ['@all'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: ['@write'],
      preload: false,
    });
    expect(changedApproval).not.toBe(base);
    expect(changedPreload).not.toBe(base);
  });
});
