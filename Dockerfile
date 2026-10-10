# syntax=docker/dockerfile:1

# Incremental Routing in one image: the Python backend serves the built frontend and keeps the
# 511 transit data current. See "Run with Docker" in README.md.

# --- The frontend, built into a static site ----------------------------------------------------
FROM node:22-slim AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- The backend, serving the site ---------------------------------------------------------------
FROM python:3.13-slim
RUN pip install --no-cache-dir uv==0.11.32 \
    && useradd --create-home --uid 1000 app \
    && mkdir /data \
    && chown app:app /data
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
# Dependencies first, so that a code change doesn't reinstall them.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/src ./src
RUN uv sync --frozen --no-dev
COPY --from=frontend /src/dist ./static
COPY --chmod=0755 docker/start.sh /usr/local/bin/start

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    IR_DATA_DIR=/data \
    IR_STATIC_DIR=/app/static \
    IR_DATA_HINT="It's built automatically when the app starts, which takes about a minute: reload the page then. If it doesn't appear, check the log (docker compose logs app)."
USER app
VOLUME /data
EXPOSE 8000
CMD ["start"]
