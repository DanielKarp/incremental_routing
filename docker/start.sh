#!/bin/sh
# The container's command: keep the transit data current in the background (building it on the
# first start, then refreshing it every REFRESH_DAYS days), and serve the app on port 8000.
set -e
ir-load-gtfs --keep-fresh "${REFRESH_DAYS:-7}" &
exec uvicorn --factory incremental_routing.api:create_app --host 0.0.0.0 --port 8000 --no-access-log
