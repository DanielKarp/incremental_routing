"""API schemas shared by the GTFS store, routing providers and HTTP layer."""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel

PathMode = Literal["walk", "bike"]


class LatLon(BaseModel):
    lat: float
    lon: float


class FeedInfo(BaseModel):
    feed_id: str
    timezone: str
    start_date: dt.date | None
    end_date: dt.date | None
    loaded_at: dt.datetime
    has_frequencies: bool


class Stop(BaseModel):
    stop_id: str
    feed_id: str
    name: str
    lat: float
    lon: float
    parent_station: str | None = None


class NearbyStop(Stop):
    distance_m: float
    # Estimated time to get between the queried point and the stop, walking or cycling.
    access_s: int


class RouteInfo(BaseModel):
    route_id: str
    short_name: str | None
    long_name: str | None
    route_type: int
    color: str | None
    text_color: str | None
    agency: str | None = None


class TransferRule(BaseModel):
    """What transfers.txt says about changing between two trips at these stops.

    type: 0 recommended point, 1 timed (the vehicle waits), 2 needs min_transfer_s,
    3 not possible.
    """

    type: int
    min_transfer_s: int | None = None


class TransitCall(BaseModel):
    """A trip calling at a stop near the queried point: a candidate to board or alight."""

    trip_id: str
    service_date: dt.date
    route: RouteInfo
    headsign: str | None
    stop: NearbyStop
    stop_sequence: int
    arrival: dt.datetime
    departure: dt.datetime
    bikes_allowed: int | None
    # The rule for changing to (or from) the adjacent transit leg, when one was given.
    transfer: TransferRule | None = None


class TripStop(BaseModel):
    stop: Stop
    stop_sequence: int
    arrival: dt.datetime
    departure: dt.datetime
    can_board: bool
    can_alight: bool
    # Where the stop falls on TripDetail.shape.
    shape_index: int | None = None


class TripDetail(BaseModel):
    trip_id: str
    service_date: dt.date
    route: RouteInfo
    headsign: str | None
    bikes_allowed: int | None
    stops: list[TripStop]
    # The trip's path from shapes.txt as [lon, lat] pairs, when the feed has one.
    shape: list[tuple[float, float]] | None = None


class RouteRequest(BaseModel):
    mode: PathMode
    origin: LatLon
    destination: LatLon


class RouteResult(BaseModel):
    mode: PathMode
    provider: str
    distance_m: float
    duration_s: float
    # [lon, lat] pairs, GeoJSON order.
    geometry: list[tuple[float, float]]
