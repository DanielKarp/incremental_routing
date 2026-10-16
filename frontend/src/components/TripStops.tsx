import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { TransitCall, TripDetail } from '../api';
import { type MissedTrip, routeLabel, stopChoices } from '../plan/build';
import type { TransferNote } from '../plan/transfers';
import type { Direction } from '../plan/types';
import { bringIntoView, bringTopIntoView } from '../scroll';
import { formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  trip: TripDetail;
  /** The departure (forwards) or arrival (backwards) that was picked. */
  call: TransitCall;
  direction: Direction;
  onChoose: (stopSequence: number) => void;
  /** Back to the list of lines (Escape does it too). */
  onBack: () => void;
  /** Set when the routed walk or bike ride to (or from) the stop misses the trip. */
  missed?: MissedTrip | null;
  /** Take the same line's trip that the route does make instead. */
  onTakeInstead?: (call: TransitCall) => void;
  noteFor?: (call: TransitCall) => TransferNote | null;
  disabled?: boolean;
}

// A screen this short, such as a phone on its side, has room under the whole header for only a
// couple of stops.
const SHORT = '(max-height: 500px)';

function onScreenChange(onChange: () => void) {
  const query = window.matchMedia(SHORT);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const isShort = () => window.matchMedia(SHORT).matches;

/**
 * After picking a trip: choose where to get off among its later stops (forwards), or where
 * to get on among its earlier stops (backwards). Its header, with the way back to the list,
 * the trip and where you board it, stays at the top of the panel while you scroll the stops.
 */
export function TripStops(props: Props) {
  const { trip, call, direction, onChoose, onBack, missed, disabled } = props;
  const forward = direction === 'forward';
  const choices = stopChoices(trip, call.stop_sequence, direction);
  const short = useSyncExternalStore(onScreenChange, isShort);
  const chooser = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const warning = useRef<HTMLDivElement>(null);
  // A trip just picked starts at its header, however far down the list you picked it from. The
  // button you used has gone, so keyboard focus comes here rather than to the top of the page.
  // The route to the stop may arrive later; if it misses the trip, the warning comes into view.
  // Only one of them scrolls, as a second scroll would stop the first on its way: a warning
  // known at once is near the chooser's top, so it comes into view with it.
  const reason = missed?.reason;
  const shown = useRef<{ trip: TripDetail; reason?: string } | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = { trip, reason };
    if (before?.trip !== trip) {
      bringTopIntoView(chooser.current);
      if (document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
    } else if (reason && reason !== before.reason) bringIntoView(warning.current);
  }, [trip, reason]);
  const instead = missed?.instead;
  const note = instead && props.noteFor?.(instead);
  // In the header, so the stops scrolling under it can't hide it; on a short screen, under the
  // header, so the stops have room.
  const warningBox = missed && (
    <div className="missed" ref={warning}>
      <p className="warning" role="alert">
        {missed.reason}
      </p>
      {instead && (
        <div className="row wrap align-center">
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            onClick={() => props.onTakeInstead?.(instead)}
          >
            Take the {formatTime(forward ? instead.departure : instead.arrival)} instead
          </button>
          {note && <span className={`call-note issue-${note.level}`}>{note.text}</span>}
        </div>
      )}
    </div>
  );
  return (
    <div className="trip-stops" ref={chooser}>
      <h3 ref={heading} tabIndex={-1}>
        {forward ? 'Where do you get off?' : 'Where do you get on?'}
      </h3>
      <p className="muted">Choose a stop here or on the map.</p>
      <div className="trip-stops-header">
        <div className="row align-center">
          <button
            type="button"
            className="secondary trip-stops-back"
            disabled={disabled}
            aria-label="Back to the lines"
            title="Back to the list (Esc)"
            onClick={onBack}
          >
            <span aria-hidden="true">←</span> Lines
          </button>
          <span className="trip-stops-trip">
            <RouteBadge
              name={routeLabel(trip.route)}
              color={trip.route.color}
              textColor={trip.route.text_color}
            />{' '}
            {trip.headsign} {trip.bikes_allowed === 2 && <NoBikesBadge />}
          </span>
        </div>
        <p className="muted">
          {forward
            ? `Boards at ${call.stop.name}, ${formatTime(call.departure)}`
            : `Gets off at ${call.stop.name}, ${formatTime(call.arrival)}`}
        </p>
        {!short && warningBox}
      </div>
      {short && warningBox}
      <ul className="calls">
        {choices.map((s) => (
          <li key={s.stop_sequence}>
            <button
              type="button"
              className="call call-button stop-choice"
              disabled={disabled}
              onClick={() => onChoose(s.stop_sequence)}
            >
              <span className="call-time">{formatTime(forward ? s.arrival : s.departure)}</span>
              <span>{s.stop.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
