import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { workerApi } from './worker/vitePlugin.ts';

export default defineConfig({
  // /api/* answered as the Cloudflare Worker answers it, by its own code (worker/api.ts).
  plugins: [react(), workerApi()],
  // The timetable fixture the tests read, inlined as a data: URL (src/timetable/fixtures).
  assetsInclude: ['**/*.sqlite.gz'],
  // maplibre-gl alone is ~1 MB minified; fine for a locally served app.
  build: { chunkSizeWarningLimit: 1500 },
});
