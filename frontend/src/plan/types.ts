// The trip plan: an ordered chain of legs through space-time. See PLAN.md "Data model".

export type LegMode = 'transit' | 'walk' | 'bike' | 'wait';

/** Which way the plan is being extended: after its end, or before its start. */
export type Direction = 'forward' | 'backward';

/** Which end of a leg stays put when its duration is edited. */
export type FixedEnd = 'start' | 'end';

export interface Place {
  lat: number;
  lon: number;
  name?: string;
  /** Set when the place is a transit stop. */
  stopId?: string;
  /**
   * Set when you gave the place its name, rather than it being named after a stop nearby or by
   * its coordinates. A new walk or bike end point near such a place takes its name.
   */
  named?: boolean;
}

/** A point in space-time: where the traveller is, and when. */
export interface Waypoint {
  place: Place;
  /** ISO 8601 instant. */
  time: string;
}

export interface TransitInfo {
  tripId: string;
  serviceDate: string;
  routeName: string;
  headsign: string | null;
  color: string | null;
  textColor: string | null;
  /** From GTFS bikes_allowed: true (1), false (2), null (no information). */
  bikesAllowed: boolean | null;
  /** Stops ridden, boarding to alighting inclusive. */
  stops: { stopId: string; name: string; lat: number; lon: number; time: string }[];
  /** Operating agency, when the feed names it. Absent in plans saved before it existed. */
  agency?: string | null;
  /** The ridden part of the trip's shape as [lon, lat] pairs, when the feed has shapes. */
  geometry?: [number, number][];
}

export interface PathInfo {
  /** Routing provider, or 'estimate' when the router was unavailable. */
  provider: string;
  distanceM: number;
  /** What the router estimated; the leg's own times win if the user overrode them. */
  routedDurationS: number;
  /** [lon, lat] pairs. */
  geometry: [number, number][];
  /** Bike routes: heights in metres from the start, one every intervalM (the last at the end). */
  elevation?: { intervalM: number; heightsM: number[] };
}

export interface Leg {
  id: string;
  mode: LegMode;
  start: Waypoint;
  end: Waypoint;
  /** Derived by the planner (waits filling gaps) and rebuilt on every change. */
  auto?: boolean;
  /**
   * For walk, bike and manual wait legs: 'start' when planned forwards (and for walks to or
   * from a stop, which leave immediately), 'end' when planned backwards.
   */
  fixed?: FixedEnd;
  transit?: TransitInfo;
  path?: PathInfo;
}

export interface Plan {
  /** Where and when planning began. Legs extend forwards and/or backwards from here. */
  anchor: Waypoint;
  /** Chronological, contiguous in time once normalized. */
  legs: Leg[];
}

export type IssueKind = 'overlap' | 'location-gap' | 'negative-duration' | 'bikes-not-allowed';

export interface PlanIssue {
  kind: IssueKind;
  /** Errors make the plan inconsistent; warnings are informational only. */
  severity: 'error' | 'warning';
  legId: string;
  message: string;
}
