import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLegs, renamePlace } from './plan/plan';
import type { Plan } from './plan/types';
import { HISTORY_MAX_CHARS, loadHistory, loadSession, saveHistory, saveSession } from './storage';
import type { UndoStep } from './undo';

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
  vi.useRealTimers();
});

describe('autosave', () => {
  it('restores what was saved', () => {
    const session = { anchor: HOME, timeInput: '2026-10-12T07:30', plan, direction: 'backward' };
    saveSession({ ...session, direction: 'backward' });
    expect(loadSession()).toEqual(session);
  });

  it('starts a plan without legs forwards', () => {
    saveSession({ anchor: HOME, timeInput: '2026-10-12T07:30', plan: null, direction: 'backward' });
    expect(loadSession()?.direction).toBe('forward');
    // Sessions saved before the direction was.
    storage.setItem(
      'incremental-routing:session:v1',
      JSON.stringify({ anchor: HOME, timeInput: '2026-10-12T07:30', plan }),
    );
    expect(loadSession()?.direction).toBe('forward');
  });

  it('starts fresh when nothing usable is stored', () => {
    expect(loadSession()).toBeNull();
    storage.setItem('incremental-routing:session:v1', '{not json');
    expect(loadSession()).toBeNull();
    vi.useFakeTimers({ now: new Date('2026-10-12T14:30:00Z') });
    storage.setItem('incremental-routing:session:v1', '{"timeInput": "yesterday"}');
    expect(loadSession()).toEqual({
      anchor: null,
      timeInput: '2026-10-12T07:30', // Now, in the Bay Area.
      plan: null,
      direction: 'forward',
    });
  });

  it('keeps the start point and the undo history while the time is cleared or half-typed', () => {
    const cleared = renamePlace(plan, HOME, 'Flat');
    saveHistory([{ label: 'clear plan', plan: cleared, direction: 'backward' }], null);
    for (const timeInput of ['', '202609-10-12T07:30']) {
      saveSession({ anchor: HOME, timeInput, plan: null, direction: 'forward' });
      expect(loadSession()).toEqual({ anchor: HOME, timeInput, plan: null, direction: 'forward' });
      expect(loadHistory(null).map((s) => s.label)).toEqual(['clear plan']);
    }
  });

  it('keeps the start point but drops a damaged plan', () => {
    const damaged = { ...plan, legs: [{ ...plan.legs[0], mode: 'teleport' }] };
    storage.setItem(
      'incremental-routing:session:v1',
      JSON.stringify({ anchor: HOME, timeInput: '2026-10-12T07:30', plan: damaged }),
    );
    expect(loadSession()).toEqual({
      anchor: HOME,
      timeInput: '2026-10-12T07:30',
      plan: null,
      direction: 'forward',
    });
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
    const session = { anchor: null, timeInput: '2026-10-12T07:30', plan: null };
    expect(() => saveSession({ ...session, direction: 'forward' })).not.toThrow();
    expect(loadHistory(plan)).toEqual([]);
    expect(() => saveHistory([{ label: 'add', plan }], plan)).not.toThrow();
  });
});

describe('undo history', () => {
  const empty: Plan = { anchor: plan.anchor, legs: [] };
  const renamed = renamePlace(plan, HOME, 'Flat');
  const longer = appendLegs(plan, [
    {
      id: 'w2',
      mode: 'wait',
      fixed: 'start',
      start: { place: HOME, time: '2026-10-12T14:40:00.000Z' },
      end: { place: HOME, time: '2026-10-12T14:50:00.000Z' },
    },
  ]);
  const steps: UndoStep[] = [
    { label: 'add', plan: empty },
    { label: 'rename', plan },
  ];

  it('restores the steps that lead to the saved plan', () => {
    saveHistory(steps, renamed);
    expect(loadHistory(renamed)).toEqual(steps);
  });

  it('keeps the history of a cleared plan, and the end it was planned from', () => {
    const cleared: UndoStep = { label: 'clear plan', plan: renamed, direction: 'backward' };
    saveHistory([...steps, cleared], null);
    expect(loadHistory(null)).toEqual([...steps, cleared]);
    const data = JSON.parse(storage.getItem('incremental-routing:history:v1')!);
    data.steps[2].direction = 'sideways';
    storage.setItem('incremental-routing:history:v1', JSON.stringify(data));
    expect(loadHistory(null)[2]).toEqual({ label: 'clear plan', plan: renamed });
  });

  it('keeps moves of the start before the first leg', () => {
    const NEAR = { lat: 37.4475, lon: -122.1585, name: 'Near Lytton Av & Ramona St' };
    const moves: UndoStep[] = [
      { label: 'move start', plan: empty },
      { label: 'move start', plan: { ...empty, anchor: { ...empty.anchor, place: NEAR } } },
    ];
    saveHistory(moves, null);
    expect(loadHistory(null)).toEqual(moves);
  });

  it('drops a history saved with another plan', () => {
    // Saved before the last change: undoing would skip it.
    saveHistory(steps, renamed);
    expect(loadHistory(longer)).toEqual([]);
    expect(loadHistory(plan)).toEqual([]);
    expect(loadHistory(null)).toEqual([]);
  });

  it('keeps only the steps after a damaged one', () => {
    saveHistory(steps, renamed);
    const data = JSON.parse(storage.getItem('incremental-routing:history:v1')!);
    data.steps.unshift({ label: 'teleport', plan });
    data.steps.splice(2, 0, { label: 'add', plan: { legs: 'none' } });
    storage.setItem('incremental-routing:history:v1', JSON.stringify(data));
    expect(loadHistory(renamed)).toEqual([steps[1]]);
    storage.setItem('incremental-routing:history:v1', '{not json');
    expect(loadHistory(renamed)).toEqual([]);
  });

  it('keeps the newest steps that fit', () => {
    // Steps of one size: "remove" and "rename" are as long as each other.
    const size = JSON.stringify({ label: 'remove', plan }).length;
    const many: UndoStep[] = Array.from({ length: HISTORY_MAX_CHARS / size + 5 }, (_, i) => ({
      label: i % 2 ? 'remove' : 'rename',
      plan,
    }));
    saveHistory(many, renamed);
    const restored = loadHistory(renamed);
    expect(restored.length).toBe(Math.floor(HISTORY_MAX_CHARS / size));
    expect(restored.at(-1)).toEqual(many.at(-1));
  });

  it('saves a shorter history when storage is nearly full', () => {
    const setItem = storage.setItem;
    storage.setItem = (k: string, v: string) => {
      if (v.length > HISTORY_MAX_CHARS / 5) throw new Error('QuotaExceededError');
      setItem(k, v);
    };
    const big: UndoStep[] = Array.from({ length: 2000 }, () => ({ label: 'add', plan }));
    saveHistory(big, renamed);
    const restored = loadHistory(renamed).length;
    expect(restored).toBeGreaterThan(0);
    expect(restored).toBeLessThan(2000);
  });

  it('gives up the history when the plan needs its room', () => {
    saveHistory(steps, renamed);
    const setItem = storage.setItem;
    storage.setItem = (k: string, v: string) => {
      if (storage.raw.has('incremental-routing:history:v1')) throw new Error('QuotaExceededError');
      setItem(k, v);
    };
    const session = { anchor: HOME, timeInput: '2026-10-12T07:30', plan: renamed };
    saveSession({ ...session, direction: 'forward' });
    expect(loadSession()?.plan).toEqual(renamed);
    expect(loadHistory(renamed)).toEqual([]);
  });
});
