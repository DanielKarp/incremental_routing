import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The timetable fixture the tests read, inlined as a data: URL (src/timetable/fixtures).
  assetsInclude: ['**/*.sqlite.gz'],
  // maplibre-gl alone is ~1 MB minified; fine for a locally served app.
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    // The FastAPI backend (uvicorn's default port).
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
});
