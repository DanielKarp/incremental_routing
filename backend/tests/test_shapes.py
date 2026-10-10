from __future__ import annotations

from incremental_routing.gtfs.shapes import stop_indices

# ~111 m per 0.001 degree of latitude.
STEP = 0.001


def line(n: int, lat0: float = 37.4, lon: float = -122.1, dist: bool = False):
    return [(lat0 + STEP * k, lon, 111.0 * k if dist else None) for k in range(n)]


def test_matches_stops_geometrically_in_order():
    shape = line(21)
    stops = [(37.4, -122.1, None), (37.4101, -122.1001, None), (37.42, -122.1, None)]
    assert stop_indices(shape, stops) == [0, 10, 20]


def test_uses_shape_dist_traveled_when_both_sides_have_it():
    shape = line(21, dist=True)
    # Distances say 444 m and 1554 m, whatever the coordinates say.
    stops = [(0, 0, 0.0), (0, 0, 444.0), (0, 0, 1554.0)]
    assert stop_indices(shape, stops) == [0, 4, 14]


def test_mixes_distances_and_geometry_without_going_backwards():
    shape = line(21, dist=True)
    stops = [(37.4, -122.1, 0.0), (37.405, -122.1, None), (37.41, -122.1, 1110.0)]
    assert stop_indices(shape, stops) == [0, 5, 10]


def test_loop_starts_and_ends_at_the_same_place():
    # North 10 steps, east 10, south 10, west 10: back where it started.
    pts = [(37.4 + STEP * k, -122.1) for k in range(11)]
    pts += [(37.41, -122.1 + STEP * k) for k in range(1, 11)]
    pts += [(37.41 - STEP * k, -122.09) for k in range(1, 11)]
    pts += [(37.4, -122.09 - STEP * k) for k in range(1, 11)]
    shape = [(lat, lon, None) for lat, lon in pts]
    stops = [(37.4, -122.1, None), (37.41, -122.09, None), (37.4, -122.1, None)]
    assert stop_indices(shape, stops) == [0, 20, len(shape) - 1]


def test_out_and_back_matches_each_stop_to_its_own_direction():
    # 3 km north, then back south along the other side of the street (~10 m east).
    out = [(37.4 + STEP * k, -122.1, None) for k in range(28)]
    back = [(37.4 + STEP * k, -122.0999, None) for k in range(27, -1, -1)]
    shape = out + back
    middle_out = (37.415, -122.1, None)
    middle_back = (37.415, -122.0999, None)
    stops = [(37.4, -122.1, None), middle_out, (37.427, -122.1, None), middle_back]
    i = stop_indices(shape, stops)
    assert i[1] == 15  # outbound, though the return passes just as close
    assert i[3] == 28 + (27 - 15)  # the matching point on the way back


def test_empty_shape():
    assert stop_indices([], [(37.4, -122.1, None)]) == []
