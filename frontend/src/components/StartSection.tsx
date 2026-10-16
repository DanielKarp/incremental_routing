import { useState } from 'react';
import type { Place } from '../plan/types';
import { PLAUSIBLE_YEARS, formatDayAndTime, isPlausibleInput } from '../time';
import { NameField } from './NameField';

interface Props {
  anchor: Place | null;
  timeInput: string;
  /**
   * Once legs exist the start point can't change (clear or undo instead), so it's one line:
   * its name, which can still be changed, and its time.
   */
  locked: boolean;
  /** The plan's start time, for that line. */
  anchorTime?: string;
  /** Legs reach before the start point, or no longer start there: it's "Planned from". */
  plannedFrom?: boolean;
  /** Move was clicked: the next click on the map moves the start. */
  moving: boolean;
  /** Before the first leg, as you type. */
  onName: (name: string) => void;
  /** Once there are legs: a new name, given on Enter or on leaving the field. */
  onRename: (name: string) => void;
  /** While a request is in flight, renaming waits so it can't race it. */
  busy?: boolean;
  onTime: (value: string) => void;
  onMove: () => void;
  onCancelMove: () => void;
}

/** The point in space and time that the plan grows from, forwards or backwards. */
export function StartSection(props: Props) {
  const { anchor, timeInput, locked, moving, onName, onTime, onMove, onCancelMove } = props;
  // While you type a year it's out of range for a moment, so that's only said once you leave.
  const [typing, setTyping] = useState(false);
  if (locked && anchor && props.anchorTime) {
    return (
      <section className="start-line" aria-label="Plan from">
        <label>
          {props.plannedFrom ? 'Planned from' : 'From'}{' '}
          <NameField
            name={anchor.name ?? ''}
            placeholder={`${anchor.lat.toFixed(5)}, ${anchor.lon.toFixed(5)}`}
            disabled={props.busy}
            onSave={props.onRename}
          />
        </label>{' '}
        <span title="Undo or clear the plan to change where or when it starts.">
          · {formatDayAndTime(props.anchorTime)}
        </span>
      </section>
    );
  }
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
            {!locked && (
              <>
                {moving ? ' · click the map to move it · ' : ' · '}
                <button type="button" className="link" onClick={moving ? onCancelMove : onMove}>
                  {moving ? 'Cancel' : 'Move'}
                </button>
              </>
            )}
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
