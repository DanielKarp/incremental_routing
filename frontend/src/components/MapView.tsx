import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { type Ref, type RefObject, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
const START = '#d1495b';
const END = '#15803d';
const SNAPSHOT_TIMEOUT_MS = 10_000;

export interface PreviewStop {
  lat: number;
  lon: number;
  name: string;
}

/** The trip being chosen: its stops, and the line to draw (following its shape if known). */
export interface TripPreview {
  stops: PreviewStop[];
  line: [number, number][];
}

export interface MapHandle {
  /** A PNG data URL of the map fitted to the whole plan, or null if it can't be captured. */
  snapshot(): Promise<string | null>;
}

interface Props {
  ref?: Ref<MapHandle>;
  /** Where the plan begins (before any legs: the point it is planned from). */
  start: Place | null;
  /** Where the plan ends, once it has legs. */
  end: Place | null;
  /** Stops of the departures or arrivals being listed. */
  stops: NearbyStop[];
  tripPreview: TripPreview | null;
  /** A walk or bike leg being set up: its picked point and route. */
  pendingPoint: Place | null;
  pendingRoute: [number, number][] | null;
  /** Whether a map click picks a point (shows a crosshair). */
  picking: boolean;
  legs: Leg[];
  onPick: (point: LatLon) => void;
}

export function MapView(props: Props) {
  const { ref, start, end, stops, tripPreview, pendingPoint, pendingRoute, picking, legs, onPick } =
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
      // Keeps the last frame readable, so the plan can be captured for printing.
      canvasContextAttributes: { preserveDrawingBuffer: true },
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

  useImperativeHandle(
    ref,
    () => ({
      async snapshot() {
        const m = map.current;
        const bounds = planBounds(legs);
        if (!m || !bounds) return null;
        m.fitBounds(bounds, { padding: 40, maxZoom: 15, animate: false });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SNAPSHOT_TIMEOUT_MS);
          m.once('idle', () => {
            clearTimeout(timer);
            resolve();
          });
          m.triggerRepaint();
        });
        try {
          return m.getCanvas().toDataURL('image/png');
        } catch {
          return null; // A tainted canvas (cross-origin tiles without CORS) can't be read.
        }
      },
    }),
    [legs],
  );

  useMarker(map, start, START);
  useMarker(map, end, END);
  useMarker(map, pendingPoint, PENDING);

  useEffect(() => {
    if (map.current) map.current.getCanvas().style.cursor = picking ? 'crosshair' : '';
  }, [picking]);

  useEffect(() => {
    const source = map.current?.getSource<maplibregl.GeoJSONSource>('pending');
    if (!styleReady || !source) return;
    source.setData(lines(pendingRoute && pendingRoute.length > 1 ? [pendingRoute] : []));
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
    const bounds = planBounds(legs);
    if (map.current && bounds) map.current.fitBounds(bounds, { padding: 60, maxZoom: 15 });
  }, [legs]);

  useEffect(() => {
    const m = map.current;
    const source = m?.getSource<maplibregl.GeoJSONSource>('trip-preview');
    if (!m || !styleReady || !source) return;
    source.setData(previewFeatures(tripPreview));
    if (tripPreview && tripPreview.line.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      tripPreview.line.forEach((c) => bounds.extend(c));
      m.fitBounds(bounds, { padding: 60, maxZoom: 14 });
    }
  }, [styleReady, tripPreview]);

  return <div ref={container} className="map" data-testid="map" />;
}

function useMarker(map: RefObject<maplibregl.Map | null>, place: Place | null, color: string) {
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
const isLine: maplibregl.ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
const isPoint: maplibregl.ExpressionSpecification = ['==', ['geometry-type'], 'Point'];

function addOverlayLayers(m: maplibregl.Map) {
  m.addSource('trip-preview', { type: 'geojson', data: EMPTY });
  m.addSource('legs', { type: 'geojson', data: EMPTY });
  m.addSource('pending', { type: 'geojson', data: EMPTY });
  m.addLayer({
    id: 'trip-preview-line',
    type: 'line',
    source: 'trip-preview',
    filter: isLine,
    paint: { 'line-color': ACCENT, 'line-width': 3, 'line-opacity': 0.5 },
  });
  m.addLayer({
    id: 'trip-preview-stops',
    type: 'circle',
    source: 'trip-preview',
    filter: isPoint,
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
    filter: ['all', isLine, ['==', ['get', 'mode'], 'transit']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['coalesce', ['get', 'color'], ACCENT], 'line-width': 5 },
  });
  m.addLayer({
    id: 'legs-path',
    type: 'line',
    source: 'legs',
    filter: ['all', isLine, ['!=', ['get', 'mode'], 'transit']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'mode'], 'bike', '#15803d', '#374151'],
      'line-width': 3,
      'line-dasharray': [1, 2],
    },
  });
  // The plan's start and end, drawn into the map (unlike the markers) so snapshots show them.
  m.addLayer({
    id: 'legs-ends',
    type: 'circle',
    source: 'legs',
    filter: isPoint,
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'end'], 'start', START, END],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
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

/** A transit leg follows its shape when the feed has one, else runs stop to stop. */
function legLine(leg: Leg): [number, number][] | null {
  if (leg.transit) {
    if (leg.transit.geometry && leg.transit.geometry.length > 1) return leg.transit.geometry;
    return leg.transit.stops.map((s) => [s.lon, s.lat]);
  }
  if (leg.path && leg.path.geometry.length > 1) return leg.path.geometry;
  return null;
}

function planBounds(legs: Leg[]): maplibregl.LngLatBounds | null {
  if (!legs.length) return null;
  const bounds = new maplibregl.LngLatBounds();
  for (const leg of legs) {
    bounds.extend([leg.start.place.lon, leg.start.place.lat]);
    bounds.extend([leg.end.place.lon, leg.end.place.lat]);
    legLine(leg)?.forEach((c) => bounds.extend(c));
  }
  return bounds;
}

function legFeatures(legs: Leg[]): FeatureCollection<LineString | Point> {
  const features: Feature<LineString | Point>[] = [];
  for (const leg of legs) {
    const coordinates = legLine(leg);
    if (!coordinates) continue;
    features.push({
      type: 'Feature',
      properties: { mode: leg.mode, color: leg.transit?.color ? `#${leg.transit.color}` : null },
      geometry: { type: 'LineString', coordinates },
    });
  }
  if (legs.length) {
    const first = legs[0].start.place;
    const last = legs[legs.length - 1].end.place;
    features.push(point(first, { end: 'start' }), point(last, { end: 'end' }));
  }
  return { type: 'FeatureCollection', features };
}

function previewFeatures(preview: TripPreview | null): FeatureCollection<LineString | Point> {
  if (!preview) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [
      ...lines(preview.line.length > 1 ? [preview.line] : []).features,
      ...preview.stops.map((s) => point(s, { name: s.name })),
    ],
  };
}

function lines(coords: [number, number][][]): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: coords.map((coordinates) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    })),
  };
}

function point(p: { lat: number; lon: number }, properties: Record<string, string>): Feature<Point> {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } };
}
