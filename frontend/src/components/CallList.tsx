import type { PathMode, TransitCall } from '../api';
import { TRIPS_PER_LINE, groupCalls } from '../callGroups';
import { useHoverIntent } from '../hoverIntent';
import { lineCall } from '../linePreviews';
import { routeLabel } from '../plan/build';
import type { TransferNote } from '../plan/transfers';
import { formatDuration, formatTime } from '../time';
import { NoBikesBadge, RouteBadge } from './RouteBadge';

interface Props {
  calls: TransitCall[];
  direction: 'departures' | 'arrivals';
  /** How you'd get between the stop and your point. */
  access: PathMode;
  /** A heads-up about changing to or from the adjacent ride, if any. */
  noteFor?: (call: TransitCall) => TransferNote | null;
  /** When set, each trip's time is a button that picks it. */
  onSelect?: (call: TransitCall) => void;
  /** When set, each line's name is a button that picks its next trip (or last arrival). */
  onChooseLine?: (key: string) => void;
  /** The pointer or keyboard focus moved onto a line's row, or off it (null). */
  onHoverLine?: (key: string | null) => void;
  /**
   * The pointer rested on a line's row, or keyboard focus stayed on it: the line is of
   * interest, not just passed over. Null once the pointer leaves the list.
   */
  onDwellLine?: (key: string | null) => void;
  /** The lines pointed at on the map: their rows are marked. */
  highlight?: string[];
  disabled?: boolean;
}

/**
 * Lines you could board (departures) or alight from (arrivals) near the frontier: one row per
 * route, headsign and stop, with a time for each of its next (or last) few trips.
 */
export function CallList(props: Props) {
  const { calls, direction, access, noteFor, onSelect, onChooseLine, onHoverLine, highlight } =
    props;
  const { disabled } = props;
  const intent = useHoverIntent<string>(props.onDwellLine);
  if (!calls.length) return <p className="muted">No trips found in this window.</p>;
  const timeOf = (c: TransitCall) =>
    formatTime(direction === 'departures' ? c.departure : c.arrival);
  return (
    <>
      <p className="muted">
        {direction === 'departures' ? 'The next' : 'The last'} {TRIPS_PER_LINE} trips of each
        line. Pick a time, or a line (here or on the map) for its{' '}
        {direction === 'departures' ? 'next trip' : 'last arrival'}.
      </p>
      <ul
        className="calls"
        onPointerLeave={() => intent.leave()}
        onBlur={(e) => {
          // Focus left the list, rather than moving to another row or button in it.
          if (!e.currentTarget.contains(e.relatedTarget)) {
            onHoverLine?.(null);
            intent.leave();
          }
        }}
      >
        {groupCalls(calls, direction).map((group) => {
          const { key, calls: trips } = group;
          const { route, headsign, stop } = trips[0];
          const noBikes = trips.filter((c) => c.bikes_allowed === 2).length;
          const notes = trips.flatMap((c) => {
            const note = noteFor?.(c);
            return note ? [{ call: c, note }] : [];
          });
          const name = (
            <>
              <RouteBadge
                name={routeLabel(route)}
                color={route.color}
                textColor={route.text_color}
              />
              <span className="call-headsign">{headsign ?? ''}</span>
              {noBikes > 0 && <NoBikesBadge />}
            </>
          );
          return (
            <li
              key={key}
              className={`call-group${highlight?.includes(key) ? ' highlighted' : ''}`}
              onMouseEnter={() => onHoverLine?.(key)}
              onMouseLeave={() => onHoverLine?.(null)}
              onPointerMove={(e) => {
                // A finger isn't pointing, and a move of nothing is a browser's echo of a scroll.
                if (e.pointerType !== 'touch' && (e.movementX || e.movementY)) {
                  intent.move(key, e.clientX, e.clientY);
                }
              }}
              onFocus={() => {
                onHoverLine?.(key);
                intent.focus(key);
              }}
            >
              {onChooseLine ? (
                <button
                  type="button"
                  className="call-line call-line-button"
                  disabled={disabled}
                  title={`Take the ${timeOf(lineCall(group, direction))} and choose where to get ${
                    direction === 'departures' ? 'off' : 'on'
                  }`}
                  onClick={() => onChooseLine(key)}
                >
                  {name}
                </button>
              ) : (
                <div className="call-line">{name}</div>
              )}
              <span className="call-stop muted">
                {route.agency ? `${route.agency} · ` : ''}
                {stop.name} · {formatDuration(stop.access_s)}{' '}
                {access === 'bike' ? 'by bike' : 'walk'}
              </span>
              <div className="call-times">
                {trips.map((c) => {
                  const level = notes.find((n) => n.call === c)?.note.level;
                  // Marked only when the line mixes trips that take bikes with ones that don't.
                  const bikeless = noBikes < trips.length && c.bikes_allowed === 2;
                  const className = [
                    'call-time-button',
                    level && `has-${level}`,
                    bikeless && 'no-bikes-trip',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  const label = timeOf(c);
                  const id = `${c.trip_id}@${c.service_date}`;
                  return onSelect ? (
                    <button
                      key={id}
                      type="button"
                      className={className}
                      disabled={disabled}
                      title={bikeless ? 'No bikes on this trip' : undefined}
                      aria-label={`${label}: ${routeLabel(route)} ${headsign ?? ''}`.trim()}
                      onClick={() => onSelect(c)}
                    >
                      {label}
                    </button>
                  ) : (
                    <span key={id} className={className}>
                      {label}
                    </span>
                  );
                })}
              </div>
              {notes.map(({ call, note }) => (
                <span
                  key={`${call.trip_id}@${call.service_date}`}
                  className={`call-note issue-${note.level}`}
                >
                  {trips.length > 1 ? `${timeOf(call)}: ` : ''}
                  {note.text}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}
