// The trip plan: an ordered chain of legs through space-time. See PLAN.md "Data model".

export type LegMode = 'transit' | 'walk' | 'bike' | 'wait';

export interface Place {
  lat: number;
  lon: number;
  name?: string;
  /** Set when the place is a transit stop. */
  stopId?: string;
}

/** A point in space-time: where the traveller is, and when. */
export interface Waypoint {
  place: Place;
  /** ISO 8601 with UTC offset. */
  time: string;
}

export interface TransitInfo {
  tripId: string;
  serviceDate: string;
  routeName: string;
  headsign: string | null;
  color: string | null;
  /** Stops ridden, boarding to alighting inclusive. */
  stops: { name: string; lat: number; lon: number; time: string }[];
}

export interface PathInfo {
  provider: string;
  distanceM: number;
  /** What the router estimated; the leg's own times win if the user overrode them. */
  routedDurationS: number;
  /** [lon, lat] pairs. */
  geometry: [number, number][];
}

export interface Leg {
  id: string;
  mode: LegMode;
  start: Waypoint;
  end: Waypoint;
  /** Derived by the planner (waits filling gaps) and rebuilt on every change. */
  auto?: boolean;
  transit?: TransitInfo;
  path?: PathInfo;
}

export interface Plan {
  /** Where and when planning began. Legs extend forwards and/or backwards from here. */
  anchor: Waypoint;
  /** Chronological, contiguous in time once normalized. */
  legs: Leg[];
}

export type IssueKind = 'overlap' | 'location-gap' | 'negative-duration';

export interface PlanIssue {
  kind: IssueKind;
  legId: string;
  message: string;
}
