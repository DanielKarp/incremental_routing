import { useState } from 'react';
import type { Place } from '../plan/types';
import { PLAUSIBLE_YEARS, isPlausibleInput } from '../time';

interface Props {
  anchor: Place | null;
  timeInput: string;
  /** Once legs exist the start point can't change (clear or undo instead). */
  locked: boolean;
  moving: boolean;
  onName: (name: string) => void;
  onTime: (value: string) => void;
  onMove: () => void;
}

/** The point in space and time that the plan grows from, forwards or backwards. */
export function StartSection({ anchor, timeInput, locked, moving, onName, onTime, onMove }: Props) {
  // While you type a year it's out of range for a moment, so that's only said once you leave.
  const [typing, setTyping] = useState(false);
  return (
    <section>
      <h2>Plan from</h2>
      {anchor ? (
        <>
          <label className="field">
            Place
            <input
              value={anchor.name ?? ''}
              disabled={locked}
              onChange={(e) => onName(e.target.value)}
            />
          </label>
          <p className="muted">
            {anchor.lat.toFixed(5)}, {anchor.lon.toFixed(5)}
            {!locked &&
              (moving ? (
                ' · click the map to move it'
              ) : (
                <>
                  {' · '}
                  <button type="button" className="link" onClick={onMove}>
                    Move
                  </button>
                </>
              ))}
          </p>
        </>
      ) : (
        <p className="hint">
          Click the map to choose a point. It can be where you set off, where you need to be, or
          anywhere in between.
        </p>
      )}
      <label className="field">
        Time
        <input
          type="datetime-local"
          value={timeInput}
          disabled={locked}
          onChange={(e) => onTime(e.target.value)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
        />
      </label>
      {!locked && !typing && timeInput && !isPlausibleInput(timeInput) && (
        <p className="hint">Choose a date within {PLAUSIBLE_YEARS} years of today.</p>
      )}
      {locked && <p className="muted">Undo or clear the plan to change where it starts from.</p>}
    </section>
  );
}
