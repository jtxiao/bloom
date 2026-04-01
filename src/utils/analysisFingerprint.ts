import type { PowerState } from '../types';

/** Drop UI-only keys and non-cloneable values so fingerprints match analysis inputs. */
function stripForFingerprint(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(stripForFingerprint);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as object)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'function') continue;
    out[k] = stripForFingerprint(v);
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'string') return JSON.stringify(value);
  if (t === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(value as object).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** Fingerprint one power node's `data` plus id (order-independent list is built in App). */
export function fingerprintNodeDataForAnalysis(data: Record<string, unknown>, nodeId: string): string {
  return `${nodeId}:${stableStringify(stripForFingerprint(data))}`;
}

/** Fingerprint all power states; array order does not affect the result. */
export function fingerprintPowerStates(states: PowerState[]): string {
  const sorted = [...states].sort((a, b) => a.id.localeCompare(b.id));
  return stableStringify(sorted);
}
