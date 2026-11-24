# The route fixture

`route.json` is frozen. It holds real answers from the public Valhalla server, recorded with the
FastAPI server as it was at commit 1c15be0, the last one that had it, and the routes the
server's Valhalla provider read from them. `routing.test.ts` checks that the page asks for the
same and reads them the same way. The server is gone, so they can't be recorded again; a new
case needs its answer worked out by hand. (The server's answers to `POST /api/route` were here
too, for the site's Worker, until M14 removed it.)
