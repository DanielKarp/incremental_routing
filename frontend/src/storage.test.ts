import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from './plan/types';
import { loadSession, saveSession } from './storage';

const HOME = { lat: 37.44528, lon: -122.16167, name: 'Home' };
const plan: Plan = {
  anchor: { place: HOME, time: '2026-10-12T14:30:00.000Z' },
  legs: [
    {
      id: 'w',
      mode: 'wait',
      fixed: 'start',
      start: { place: HOME, time: '2026-10-12T14:30:00.000Z' },
      end: { place: HOME, time: '2026-10-12T14:40:00.000Z' },
    },
  ],
};

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    raw: items,
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('autosave', () => {
  it('restores what was saved', () => {
    saveSession({ anchor: HOME, timeInput: '2026-10-12T07:30', plan });
    expect(loadSession()).toEqual({ anchor: HOME, timeInput: '2026-10-12T07:30', plan });
  });

  it('starts fresh when nothing usable is stored', () => {
    expect(loadSession()).toBeNull();
    storage.setItem('incremental-routing:session:v1', '{not json');
    expect(loadSession()).toBeNull();
    storage.setItem('incremental-routing:session:v1', '{"timeInput": "yesterday"}');
    expect(loadSession()).toBeNull();
  });

  it('keeps the start point but drops a damaged plan', () => {
    const damaged = { ...plan, legs: [{ ...plan.legs[0], mode: 'teleport' }] };
    storage.setItem(
      'incremental-routing:session:v1',
      JSON.stringify({ anchor: HOME, timeInput: '2026-10-12T07:30', plan: damaged }),
    );
    expect(loadSession()).toEqual({ anchor: HOME, timeInput: '2026-10-12T07:30', plan: null });
  });

  it('never throws when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(loadSession()).toBeNull();
    expect(() => saveSession({ anchor: null, timeInput: '2026-10-12T07:30', plan: null })).not.toThrow();
  });
});
