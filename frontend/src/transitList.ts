import { useEffect, useRef, useState } from 'react';
import { api, type CallQuery, type LinePath, type TransitCall } from './api';
import { groupCalls } from './callGroups';
import { lineCall } from './linePreviews';
import type { Direction } from './plan/types';

// A search starts this long after its last change, so typing a radius or a time doesn't
// search at every keystroke.
export const SEARCH_DELAY_MS = 300;

/** Everything the departure (or arrival) list depends on. */
export interface TransitSearch {
  direction: Direction;
  query: CallQuery;
  /** The trip you're already on at this end of the plan: it isn't offered again. */
  skip?: { tripId: string; serviceDate: string };
}

export interface TransitList {
  /** The departures (or arrivals) found, or null until they are. */
  calls: TransitCall[] | null;
  /** Whether the search stopped at its limit, so later departures (earlier arrivals) are cut. */
  cut: boolean;
  /** Where each listed line goes, once that has loaded too. */
  paths: LinePath[];
  searching: boolean;
  /** Why the search failed, if it did. */
  error: string | null;
  retry: () => void;
}

type Outcome =
  | { key: string; status: 'searching' }
  | { key: string; status: 'found'; calls: TransitCall[]; cut: boolean }
  | { key: string; status: 'failed'; reason: string };

const NO_PATHS: LinePath[] = [];

/**
 * The departures (or arrivals) for `search`, found again whenever it changes, then where each
 * listed line goes. A result is only ever shown for the search it answers: while a newer one
 * is under way, nothing is listed. A null search finds nothing.
 */
export function useTransitList(search: TransitSearch | null): TransitList {
  const key = search && JSON.stringify(search);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [paths, setPaths] = useState<{ key: string; paths: LinePath[] } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The search whose answers are wanted; an earlier one's are dropped when they arrive.
  const wanted = useRef<string | null>(null);

  useEffect(() => {
    if (!search || !key) return;
    // Found already, or still on its way (when a change was undone before the search ended).
    if (outcome?.key === key && outcome.status !== 'failed') return;
    const timer = setTimeout(async () => {
      wanted.current = key;
      setOutcome({ key, status: 'searching' });
      let found: Found;
      try {
        found = await findCalls(search);
      } catch (e) {
        if (wanted.current === key) {
          setOutcome({ key, status: 'failed', reason: (e as Error).message });
        }
        return;
      }
      if (wanted.current !== key) return;
      setOutcome({ key, status: 'found', ...found });
      try {
        const paths = await findPaths(search.direction, found.calls);
        if (wanted.current === key) setPaths({ key, paths });
      } catch {
        // The paths are extra: the list works without them.
      }
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // `key` describes `search` fully; `outcome` is only read to skip repeat searches.
  }, [key, attempt]);

  const current = outcome && outcome.key === key ? outcome : null;
  return {
    calls: current?.status === 'found' ? current.calls : null,
    cut: current?.status === 'found' && current.cut,
    paths: paths && paths.key === key ? paths.paths : NO_PATHS,
    searching: key !== null && (!current || current.status === 'searching'),
    error: current?.status === 'failed' ? current.reason : null,
    retry: () => setAttempt((n) => n + 1),
  };
}

interface Found {
  calls: TransitCall[];
  cut: boolean;
}

/**
 * The departures (or arrivals) for a search, without the trip you're already on, and whether
 * the search stopped at its limit.
 */
export async function findCalls({ direction, query, skip }: TransitSearch): Promise<Found> {
  const found = await (direction === 'forward' ? api.departures(query) : api.arrivals(query));
  return {
    calls: found.filter(
      (c) => !skip || c.trip_id !== skip.tripId || c.service_date !== skip.serviceDate,
    ),
    cut: !!query.limit && found.length >= query.limit,
  };
}

/** Where each line in the list goes, from the trip it stands for (see lineCall). */
export async function findPaths(direction: Direction, calls: TransitCall[]) {
  const listing = direction === 'forward' ? 'departures' : 'arrivals';
  const trips = groupCalls(calls, listing).map((group) => {
    const call = lineCall(group, listing);
    return { trip_id: call.trip_id, stop_sequence: call.stop_sequence };
  });
  return trips.length ? api.lines(direction, trips) : [];
}
