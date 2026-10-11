from __future__ import annotations

from incremental_routing.geo import simplify_line


def test_simplify_drops_points_close_to_a_straight_line():
    # About 110 m north, with a 3 m wobble halfway: one straight segment.
    wobble = [(-122.1, 37.4), (-122.10003, 37.4005), (-122.1, 37.401)]
    assert simplify_line(wobble, 10) == [(-122.1, 37.4), (-122.1, 37.401)]


def test_simplify_keeps_corners_and_short_lines():
    corner = [(-122.1, 37.4), (-122.1, 37.401), (-122.099, 37.401)]
    assert simplify_line(corner, 10) == corner
    assert simplify_line(corner[:2], 10) == corner[:2]
