interface Props {
  name: string;
  color: string | null;
  textColor: string | null;
}

/** A route name in the agency's colours (GTFS gives them as hex without '#'). */
export function RouteBadge({ name, color, textColor }: Props) {
  return (
    <span
      className="route-badge"
      style={{
        background: color ? `#${color}` : undefined,
        color: textColor ? `#${textColor}` : undefined,
      }}
    >
      {name}
    </span>
  );
}

export function NoBikesBadge() {
  return (
    <span className="no-bikes" title="GTFS says bikes are not allowed on this trip">
      No bikes
    </span>
  );
}
