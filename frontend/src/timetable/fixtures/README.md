# The timetable fixture

The timetable the tests read (`fixture.ts`): `manifest.json` and `timetable-<hash>.sqlite.gz`
are a synthetic feed built and published as the real timetable is. Rebuild them with
`uv run python tests/frontend_fixture.py` in `builder/`; the same code gives the same files.

`expected.json` is frozen. It holds requests the FastAPI server answered on this data, with
its answers, recorded by `frontend_fixture.py` from the server as it was at commit 1c15be0, the
last one that had it. `golden.test.ts` checks that the browser's queries give the same answers.
The server is gone, so the answers can't be recorded again: a change to the fixture's feed
needs its expected answers worked out by hand, or the requests it changes left out.
