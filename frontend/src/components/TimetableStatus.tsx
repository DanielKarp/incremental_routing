import { useSyncExternalStore } from 'react';
import { type TimetableState, timetableState } from '../api';

/** Whether the timetable is loading, ready or failed; only a change of that re-renders. */
export function useTimetableStatus(): TimetableState['status'] {
  const status = () => timetableState.get().status;
  return useSyncExternalStore(timetableState.subscribe, status, status);
}

/**
 * How getting the timetable is going, at the top of the panel until it's there: how much has
 * arrived, or why it couldn't be had, and Try again. The map, and choosing a start point, work
 * meanwhile; the departures wait for it.
 */
export function TimetableStatus() {
  const state = useSyncExternalStore(
    timetableState.subscribe,
    timetableState.get,
    timetableState.get,
  );
  return <TimetableStatusView state={state} onRetry={timetableState.load} />;
}

export function TimetableStatusView({
  state,
  onRetry,
}: {
  state: TimetableState;
  onRetry: () => void;
}) {
  if (state.status === 'ready') return null;
  if (state.status === 'failed') {
    return (
      <div className="row align-end">
        <p className="error grow" role="alert">
          Couldn't load the timetable: {state.reason}
        </p>
        <button type="button" className="secondary" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  // Said once to a screen reader, not at every step.
  return (
    <p className="muted" role="status">
      Loading the timetable…{' '}
      {state.progress && <span aria-hidden="true">{progressText(state.progress)}</span>}
    </p>
  );
}

/** "3.1 of 8.6 MB". */
export function progressText({ loaded, total }: { loaded: number; total: number }): string {
  const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
  return `${mb(Math.min(loaded, total))} of ${mb(total)} MB`;
}
