# The route fixture

`route.json` is frozen. It was recorded from the FastAPI server as it was at commit 1c15be0,
the last one that had it: `requests` holds what its `POST /api/route` answered (with the
straight-line router) to requests it accepted and refused, and `valhalla` real answers from
the public Valhalla server, with the routes the server's Valhalla provider read from them.
`api.test.ts` and `routing.test.ts` check that the Worker answers and reads them the same way.
The server is gone, so they can't be recorded again; a new case needs its answer worked out by
hand.
