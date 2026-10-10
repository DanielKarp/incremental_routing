import * as maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { LatLon, NearbyStop } from '../api';

// OpenFreeMap: free vector tiles from OpenStreetMap data, no API key.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const BAY_AREA: [number, number] = [-122.05, 37.5];

interface Props {
  anchor: LatLon | null;
  stops: NearbyStop[];
  onPick: (point: LatLon) => void;
}

export function MapView({ anchor, stops, onPick }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const onPickRef = useRef(onPick);

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
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // Markers rather than style layers, so they work before (or without) the style loading.
  useEffect(() => {
    if (!map.current || !anchor) return;
    const marker = new maplibregl.Marker({ color: '#d1495b' })
      .setLngLat([anchor.lon, anchor.lat])
      .addTo(map.current);
    return () => {
      marker.remove();
    };
  }, [anchor]);

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

  return <div ref={container} className="map" data-testid="map" />;
}
