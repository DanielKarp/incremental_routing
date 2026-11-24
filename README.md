# Incremental Routing

Plan a multi-leg trip one leg at a time, mixing Bay Area transit (every operator, from
511.org's regional feed) with walking and cycling. You choose every ride, walk, bike ride and
wait yourself, so the trip can be the quickest one or the one you want to take.

- Build a trip forwards and backwards from transit, walk, bike and wait legs.
- The lines nearby are listed as soon as you choose Transit, and the map shows where each one
  goes. Pick lines and stops in the list or on the map, and filter them as you type.
- Click the map to walk or bike there.
- Bike or walk to and from stops, and edit when walks, rides and waits leave or arrive.
- Rename places where they're shown, remove legs mid-trip, and undo any step, even after a
  reload.
- Departures are listed by line. Transfer warnings come from the agencies' own rules.
- Hilly bike rides show a simple height profile.
- Print the trip with a map, or export it as CSV, a calendar file or a JSON plan that you can
  open again or send to someone.
- The plan is autosaved in your browser.

## Examples

Five trips planned in the app for a Tuesday morning: four from a single bus ride to a trip
across three agencies, and one that goes the long way on purpose. Each shows the itinerary on
the left and the whole trip on the map. Close-ups of each step are under [Using it](#using-it).

**One bus line.** Union Square to Ocean Beach in San Francisco: a short walk to the stop, a
two-minute wait, the Muni 38R along Geary, and a walk to the beach.

![The itinerary for a walk, the 38R from Union Square to 48th Avenue, and a walk to Ocean Beach,
with the route on the map](docs/screenshots/trip-1-bus.jpg)

**A simple transfer.** Downtown Berkeley to Washington Square: BART to Montgomery Street, a
short walk and a four-minute wait, then the Muni 30 to North Beach.

![The itinerary for BART from Downtown Berkeley to Montgomery Street, a walk and a wait, and
the 30 to Columbus Ave and Union St, with the route on the
map](docs/screenshots/trip-2-transfer.jpg)

**Biking to, between and from transit.** Mountain View to Lake Merritt: bike to Caltrain, ride
the Express to San Francisco, bike across the city to the Ferry Building, take the ferry to
Oakland and bike to the lake.

![The itinerary for a bike ride to Mountain View Caltrain, the Express to San Francisco, a bike
ride to the Ferry Building and the start of the ferry to Oakland, with the whole trip on the
map](docs/screenshots/trip-3-bike.jpg)

**Three agencies, three kinds of transit and a bike.** East San Jose to the Marina: bike to
VTA's Orange Line, take the light rail to Mountain View, Caltrain to San Francisco and the
Muni 30 bus to the Marina, walking at each change.

![The itinerary for a bike ride to McKee station, the VTA Orange Line to Mountain View, a walk,
a wait and the Caltrain Express, with the trip from San Jose to the Marina on the
map](docs/screenshots/trip-4-three-agencies.jpg)

**The long way, for fun.** Sunnyvale Caltrain to San José airport. A journey planner would send
you on the 9:28 Caltrain to Santa Clara and then the 60, into Terminal A at 10:03. Here you
choose every ride instead, across three agencies: the 9:09 Caltrain Express past the airport to
San José Diridon, the Rapid 500 to Berryessa, BART one stop to Milpitas, and the 60 from the
other end of its route, into Terminal A at 10:39. Planning one leg at a time makes room for a
ride you want to take, not just the quickest one.

![The itinerary for the Caltrain Express from Sunnyvale to San José Diridon, a walk and a wait,
and the Rapid 500 to Berryessa, with a loop on the map from Sunnyvale to downtown San José,
north to Milpitas and back south to the airport](docs/screenshots/trip-5-the-long-way.jpg)

## Using it

1. **Plan from a point.** Click the map and set the time. It can be where you set off, where
   you need to be, or anywhere in between. Give it a name such as "Home". Until you add the
   first leg you can drag its pin, or click the map and choose *Move the start here*; *Undo*
   puts it back.
2. **Add legs** under *Next leg*. Choose *After the end* to plan forwards or *Before the
   start* to plan backwards, then a mode:
   - **Transit:** the lines nearby are listed straight away. Each gets a row with up to three
     departures in the next hour (or, backwards, arrivals in the hour before). The list
     updates itself when you change how you'll reach the stop (*Get to the stop by Walking*
     or *Bike*; backwards, how you'll leave it) or the search radius, and after every leg you
     add. Type in *Filter lines* to narrow it, and the map, to a line, a stop or an operator:
     "22", "muni ocean" or "bart, caltrain". If nothing turns up, it offers *Search within
     1 km* and *Look 3 hours ahead*.

     The map shows those lines too, thin and faded in their own colours, each with a dot at
     the stop where you'd catch it. Forwards, a line runs from that stop to the end of its
     route; backwards, from the start of its route to the stop. Point at a row to highlight
     its line, and rest there a moment to zoom to it (the map goes back when you move away).
     Scrolling the list, or sweeping the pointer across it, leaves the map where it is. Point
     at a line on the map to see its next time, its stop and the walk there.

     ![The departures near Union Square filtered to "38", with the pointer resting on the 38R
     row and the 38R's route highlighted on the map](docs/screenshots/list-and-map.jpg)

     With *Get to the stop by Bike* and a wider radius, each row gives the ride to its stop:

     <img src="docs/screenshots/bike-access.png" width="380" alt="Next leg set to reach the
     stop by bike within 3 km, filtered to Caltrain: each row says how many minutes by bike">

     Pick a time, or click a line's name for its next departure (or last arrival). You can
     also click the line itself on the map; where lines overlap, *Which line?* lists them by
     time. Then choose the stop where you get off (or on), in the list or on the map. The walk
     or bike ride to or from the stop, and any wait, are added for you. If that walk or ride
     would miss the trip, the list of stops says so, with a button for the line's next trip
     you can make (*Take the 9:55 AM instead*). *← Lines* stays at the top while you scroll
     the stops; it, or Escape, goes back to the list as you left it.

     ![Choosing where to get off the 38R: the stops with their times in the panel, and the
     trip with its stops on the map](docs/screenshots/stop-chooser.jpg)

     When you change from another ride, the list notes the agency's transfer rules. It warns
     when a connection is shorter than the agency's minimum, or when the agency says the
     transfer isn't possible. You can still choose a warned trip. Changes between different
     agencies have no rules, so judge those yourself.
   - **Walk / Bike:** click the map where you're going (or coming from), check the preview,
     name the place and add the leg (Enter adds it too). *Bike instead* / *Walk instead*
     routes the same point the other way. A bike ride that climbs or descends at least 20 m
     shows a small height profile, with its total climb and descent.

     Quicker: in Transit or Wait mode, click the map (or right-click it, in any mode) and
     choose *Walk here* or *Bike here* (backwards, *Walk from here* or *Bike from here*). The
     leg is added straight away, and *Next leg* stays as it was. A point within 75 m of a
     place you named takes its name, so the walk back home is "Home" again; otherwise it's
     named after a stop nearby (or its coordinates).

     <img src="docs/screenshots/map-menu.jpg" width="490" alt="A click on Ocean Beach opens a
     small menu on the map: Walk here, Bike here">
   - **Wait:** add a stop of a set number of minutes, e.g. for coffee. One click on *5*, *10*,
     *15* or *30 min* adds it, and *Next leg* then goes back to the mode you had.
3. **Adjust** the plan in the itinerary.
   - Change when walk, bike and wait legs leave or arrive, or how long they take; click into
     a time to see how far it can move. An end that meets a ride directly is fixed. Next to a
     wait, or at either end of the plan, it can move. A leg can't run into its neighbours.

     <img src="docs/screenshots/leg-times.png" width="380" alt="Editing the walk between BART
     and the bus: its arrival time is selected, and a note says it leaves as the ride arrives
     and can take up to 7 min, keeping the departure">
   - *Switch to bike* / *Switch to walk* re-routes a leg.
   - Click a place's name, in a leg or in the *From* line, and type over it. Enter renames it
     everywhere it appears, and Escape puts it back. *Rename places* lists every place.
   - Where two walks, two bike rides or two waits meet, *Merge into one…* joins them into one
     leg. The times stay the same, and the place in between drops out of the plan.
   - **Remove** takes off the first or last leg, or a wait you added. A leg in the middle goes
     with the legs after it: point at its row for *Remove this and the 3 after* (backwards,
     *before*).
   - **Undo**, pinned to the bottom of the panel, says what it will undo ("Undo remove") and
     steps back through every change. Ctrl+Z (Cmd+Z on a Mac) does the same, and the steps
     survive a reload.
4. **Finish** with *Summary & export*. It shows a map of the whole trip and the itinerary.
   - Print both.
   - Download a CSV, or add the trip to your calendar (.ics).
   - *Save plan (.json)* to keep the plan or send it to someone. *Open plan…* (top of the
     page) loads it again.

   ![The trip summary for the San Jose to Marina trip: print and export buttons, a map of the
   whole trip, and a table of every leg](docs/screenshots/summary.jpg)

**Good to know.**

- The first visit downloads the timetable, about 9 MB. The panel says how far it's got, and
  the map and the start point work meanwhile. The browser keeps it until a new one is
  published, so later visits don't download it again.
- After each leg the panel scrolls back to *Next leg*, which says what was added. Messages show
  where you're working: under the mode buttons in *Next leg*, or under the leg they're about.
- A double-click (or double tap) on the map only zooms, so a click on empty map acts a moment
  later. On a touch screen, a long press opens the map's menu.
- Escape steps back out of what you're doing: it closes a menu on the map or the summary,
  cancels a move or a walk or bike leg you haven't added, or leaves the list of stops. A field
  you're typing in keeps it.
- On a phone, the map stays at the top of the screen and only the panel below it scrolls, so
  what you pick in the list shows on the map. Held sideways, the panel sits beside the map.

  <img src="docs/screenshots/phone-itinerary.jpg" width="260" alt="On a phone: the whole trip
  on the map at the top, the itinerary below"> <img src="docs/screenshots/phone-list.jpg"
  width="260" alt="On a phone: the lines near the Marina on the map, their departures below">

## How it works

- **The timetable** is 511.org's regional feed: one schedule for every Bay Area operator, 41
  agencies including Caltrain, BART, VTA, Muni, AC Transit, SamTrans, Golden Gate Transit and
  the ferries. Every week it's rebuilt into a compact file (about 9 MB to download) and the site
  is updated with it.
- **Your browser searches it.** The first visit downloads the timetable, and the browser keeps
  it. Departures, arrivals, trips and where each line goes are then looked up on your own
  device, in the background, so the page stays responsive. Transit searches never leave it.
- **Walk and bike routes** come from Valhalla, an open-source router working on OpenStreetMap,
  through a small Cloudflare Worker that passes on the two ends of each leg. Bike times allow
  for hills, and the heights give the hill profile.
- **Your plans stay in your browser.** Each one is saved there as you go, with its undo steps;
  the site stores nothing. Save a plan as a JSON file to keep it or send it to someone.
- **Schedules end at different times** for different agencies. The app names any agency whose
  schedule doesn't cover the day you're planning.

To run your own copy or work on the code, see [DEPLOY.md](DEPLOY.md).

## License

The code is released under the [MIT License](LICENSE). The data it uses comes from the services
below, under their own terms.

## Data and attribution

- Transit schedules: the 511 SF Bay regional GTFS feed (511.org open data).
- Map: © OpenStreetMap contributors, tiles by OpenFreeMap. Rendered with MapLibre GL JS.
- Walk and bike routing and heights: Valhalla (FOSSGIS public server), or openrouteservice
  (HeiGIT) if you choose it.
