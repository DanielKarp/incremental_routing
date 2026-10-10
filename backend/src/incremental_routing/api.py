"""HTTP API. Run with:

uv run uvicorn --factory incremental_routing.api:create_app --reload
"""

from __future__ import annotations

import datetime as dt
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .config import Settings
from .gtfs.query import GtfsStore, GtfsUnavailable, TransferContext
from .models import (
    FeedInfo,
    NearbyStop,
    PathMode,
    RouteRequest,
    RouteResult,
    TransitCall,
    TripDetail,
)
from .routing import RoutingError, RoutingProvider, make_provider

Lat = Annotated[float, Query(ge=-90, le=90)]
Lon = Annotated[float, Query(ge=-180, le=180)]
Radius = Annotated[float, Query(gt=0, le=3000, description="Search radius in metres")]
WindowMin = Annotated[int, Query(gt=0, le=360, description="Search window in minutes")]
Limit = Annotated[int, Query(gt=0, le=500)]
PerRoute = Annotated[
    int | None,
    Query(ge=1, le=20, description="At most this many trips per route, headsign and stop"),
]
Access = Annotated[
    PathMode, Query(description="How you get between the point and the stop: walk or bike")
]
TransferStop = Annotated[
    str | None,
    Query(description="Stop of the adjacent transit leg, to look up transfers.txt rules"),
]
TransferTrip = Annotated[str | None, Query(description="Trip of the adjacent transit leg")]


def create_app(
    settings: Settings | None = None, provider: RoutingProvider | None = None
) -> FastAPI:
    settings = settings or Settings()
    store = GtfsStore(settings.db_path)
    router = provider or make_provider(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await router.aclose()

    app = FastAPI(title="Incremental Routing", lifespan=lifespan)

    def localize(when: dt.datetime) -> dt.datetime:
        """Times without a UTC offset are taken as local time in the planning region."""
        return when if when.tzinfo else when.replace(tzinfo=settings.default_timezone)

    @app.exception_handler(GtfsUnavailable)
    async def gtfs_unavailable(_request: Request, exc: GtfsUnavailable) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.get("/api/health")
    def health() -> dict:
        problem = store.problem()
        return {
            "status": "ok",
            "gtfs_loaded": problem is None,
            "gtfs_problem": problem,
            "routing_provider": router.name,
        }

    @app.get("/api/feeds")
    def feeds() -> list[FeedInfo]:
        return store.feeds()

    @app.get("/api/stops/nearby")
    def nearby_stops(
        lat: Lat, lon: Lon, radius_m: Radius = 500, access: Access = "walk"
    ) -> list[NearbyStop]:
        return store.nearby_stops(lat, lon, radius_m, access)

    @app.get("/api/departures")
    def departures(
        lat: Lat,
        lon: Lon,
        time: dt.datetime,
        radius_m: Radius = 500,
        window_min: WindowMin = 60,
        limit: Limit = 40,
        access: Access = "walk",
        transfer_stop: TransferStop = None,
        transfer_trip: TransferTrip = None,
        per_route: PerRoute = None,
    ) -> list[TransitCall]:
        """Trips boardable near (lat, lon) after `time`, allowing for getting to the stop.

        Pass the transit leg you'd change from as transfer_stop/transfer_trip to get each
        call's transfers.txt rule.
        """
        transfer = TransferContext(transfer_stop, transfer_trip) if transfer_stop else None
        return store.departures(
            lat,
            lon,
            localize(time),
            radius_m,
            window_min * 60,
            limit,
            access,
            transfer,
            per_route,
        )

    @app.get("/api/arrivals")
    def arrivals(
        lat: Lat,
        lon: Lon,
        time: dt.datetime,
        radius_m: Radius = 500,
        window_min: WindowMin = 60,
        limit: Limit = 40,
        access: Access = "walk",
        transfer_stop: TransferStop = None,
        transfer_trip: TransferTrip = None,
        per_route: PerRoute = None,
    ) -> list[TransitCall]:
        """Trips you could ride to near (lat, lon), arriving before `time` (backward planning).

        Pass the transit leg you'd change to as transfer_stop/transfer_trip to get each
        call's transfers.txt rule.
        """
        transfer = TransferContext(transfer_stop, transfer_trip) if transfer_stop else None
        return store.arrivals(
            lat,
            lon,
            localize(time),
            radius_m,
            window_min * 60,
            limit,
            access,
            transfer,
            per_route,
        )

    @app.get("/api/trip")
    def trip(trip_id: str, service_date: dt.date) -> TripDetail:
        try:
            return store.trip(trip_id, service_date)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/route")
    async def route(req: RouteRequest) -> RouteResult:
        try:
            return await router.route(req.mode, req.origin, req.destination)
        except RoutingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    return app
