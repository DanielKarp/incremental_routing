import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { LatLon, NearbyStop } from '../api';
import type { Leg, Place } from '../plan/types';

// MapLibre finds its worker next to its own module by default, which breaks once Vite
// pre-bundles (dev) or bundles (build) it: the map would show only its background colour.
maplibregl.setWorkerUrl(workerUrl);

// OpenFreeMap: free vector tiles from OpenStreetMap data, no API key.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const BAY_AREA: [number, number] = [-122.05, 37.5];
const ACCENT = '#2563eb';
const PENDING = '#7c3aed';

export interface PreviewStop {
  lat: number;
  lon: number;
  name: string;
}

interface Props {
  /** Where the plan begins (before any legs: the point it is planned from). */
  start: Place | null;
  /** Where the plan ends, once it has legs. */
  end: Place | null;
  /** Stops of the departures or arrivals being listed. */
  stops: NearbyStop[];
  /** Stops of the trip being chosen. */
  tripPreview: PreviewStop[] | null;
  /** A walk or bike leg being set up: its picked point and route. */
  pendingPoint: Place | null;
  pendingRoute: [number, number][] | null;
  /** Whether a map click picks a point (shows a crosshair). */
  picking: boolean;
  legs: Leg[];
  onPick: (point: LatLon) => void;
}

export function MapView(props: Props) {
  const { start, end, stops, tripPreview, pendingPoint, pendingRoute, picking, legs, onPick } =
    props;
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const onPickRef = useRef(onPick);
  // Sources and layers can only be added once the style has loaded.
  const [styleReady, setStyleReady] = useState(false);

  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    const m = new maplibregl.Map({
      container: container.current!,
      style: MAP_STYLE,
      center: BAY_AREA,
      zoom: 9.5,
    });
    m.addControl(new maplibregl.NavigationControl(), 'top-right');
    m.on('click', (e) => onPickRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    m.on('load', () => {
      addOverlayLayers(m);
      setStyleReady(true);
    });
    map.current = m;
    // Lets browser tests (and the console) reach the map in development builds.
    if (import.meta.env.DEV) Object.assign(window, { __map: m });
    return () => {
      m.remove();
      map.current = null;
      setStyleReady(false);
    };
  }, []);

  useMarker(map, start, '#d1495b');
  useMarker(map, end, '#15803d');
  useMarker(map, pendingPoint, PENDING);

  useEffect(() => {
    if (map.current) map.current.getCanvas().style.cursor = picking ? 'crosshair' : '';
  }, [picking]);

  useEffect(() => {
    const source = map.current?.getSource<maplibregl.GeoJSONSource>('pending');
    if (!styleReady || !source) return;
    source.setData({
      type: 'FeatureCollection',
      features:
        pendingRoute && pendingRoute.length > 1
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: pendingRoute },
              },
            ]
          : [],
    });
  }, [styleReady, pendingRoute]);

  // Markers rather than style layers, so they work before (or without) the style loading.
  useEffect(() => {
    if (!map.current) return;
    const markers = stops.map((stop) => {
      const el = document.createElement('div');
      el.className = 'stop-marker';
      el.title = stop.name;
      return new maplibregl.Marker({ element: el })
        .setLngLat([stop.lon, stop.lat])
        .addTo(map.current!);
    });
    return () => markers.forEach((m) => m.remove());
  }, [stops]);

  useEffect(() => {
    const source = map.current?.getSource<maplibregl.GeoJSONSource>('legs');
    if (styleReady && source) source.setData(legFeatures(legs));
  }, [styleReady, legs]);

  // Show the whole plan whenever it changes.
  useEffect(() => {
    if (!map.current || !legs.length) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const leg of legs) {
      bounds.extend([leg.start.place.lon, leg.start.place.lat]);
      bounds.extend([leg.end.place.lon, leg.end.place.lat]);
      leg.transit?.stops.forEach((s) => bounds.extend([s.lon, s.lat]));
    }
    map.current.fitBounds(bounds, { padding: 60, maxZoom: 15 });
  }, [legs]);

  useEffect(() => {
    const m = map.current;
    const source = m?.getSource<maplibregl.GeoJSONSource>('trip-preview');
    if (!m || !styleReady || !source) return;
    source.setData(previewFeatures(tripPreview ?? []));
    if (tripPreview && tripPreview.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      tripPreview.forEach((s) => bounds.extend([s.lon, s.lat]));
      m.fitBounds(bounds, { padding: 60, maxZoom: 14 });
    }
  }, [styleReady, tripPreview]);

  return <div ref={container} className="map" data-testid="map" />;
}

function useMarker(
  map: RefObject<maplibregl.Map | null>,
  place: Place | null,
  color: string,
) {
  const lat = place?.lat;
  const lon = place?.lon;
  useEffect(() => {
    if (!map.current || lat === undefined || lon === undefined) return;
    const marker = new maplibregl.Marker({ color }).setLngLat([lon, lat]).addTo(map.current);
    return () => {
      marker.remove();
    };
  }, [map, lat, lon, color]);
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function addOverlayLayers(m: maplibregl.Map) {
  m.addSource('trip-preview', { type: 'geojson', data: EMPTY });
  m.addSource('legs', { type: 'geojson', data: EMPTY });
  m.addSource('pending', { type: 'geojson', data: EMPTY });
  m.addLayer({
    id: 'trip-preview-line',
    type: 'line',
    source: 'trip-preview',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': ACCENT, 'line-width': 3, 'line-opacity': 0.5 },
  });
  m.addLayer({
    id: 'trip-preview-stops',
    type: 'circle',
    source: 'trip-preview',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#ffffff',
      'circle-stroke-color': ACCENT,
      'circle-stroke-width': 2,
    },
  });
  m.addLayer({
    id: 'legs-transit',
    type: 'line',
    source: 'legs',
    filter: ['==', ['get', 'mode'], 'transit'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'color'], ACCENT], 'line-width': 5 },
  });
  m.addLayer({
    id: 'legs-path',
    type: 'line',
    source: 'legs',
    filter: ['!=', ['get', 'mode'], 'transit'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'mode'], 'bike', '#15803d', '#374151'],
      'line-width': 3,
      'line-dasharray': [1, 2],
    },
  });
  m.addLayer({
    id: 'pending-path',
    type: 'line',
    source: 'pending',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': PENDING, 'line-width': 4, 'line-dasharray': [1, 1.5] },
  });
}

function legFeatures(legs: Leg[]): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (const leg of legs) {
    let coordinates: [number, number][];
    if (leg.transit) {
      // Stop to stop; shapes.txt would follow the track more closely (PLAN.md §10).
      coordinates = leg.transit.stops.map((s) => [s.lon, s.lat]);
    } else if (leg.path && leg.path.geometry.length > 1) {
      coordinates = leg.path.geometry;
    } else {
      continue;
    }
    features.push({
      type: 'Feature',
      properties: { mode: leg.mode, color: leg.transit?.color ? `#${leg.transit.color}` : null },
      geometry: { type: 'LineString', coordinates },
    });
  }
  return { type: 'FeatureCollection', features };
}

function previewFeatures(stops: PreviewStop[]): FeatureCollection<LineString | Point> {
  const points: Feature<Point>[] = stops.map((s) => ({
    type: 'Feature',
    properties: { name: s.name },
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
  }));
  const line: Feature<LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: stops.map((s) => [s.lon, s.lat]) },
  };
  return { type: 'FeatureCollection', features: stops.length > 1 ? [line, ...points] : points };
}
