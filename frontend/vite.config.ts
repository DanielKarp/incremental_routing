import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The timetable fixture the tests read, inlined as a data: URL (src/timetable/fixtures).
  assetsInclude: ['**/*.sqlite.gz'],
  // maplibre-gl alone is ~1 MB minified, and the browser keeps it (public/_headers).
  build: { chunkSizeWarningLimit: 1500 },
});
