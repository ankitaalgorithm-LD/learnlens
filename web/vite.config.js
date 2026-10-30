import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard runs on :5173 and forwards API calls to the
// LearnLens server on :4000. In production the server serves the built files.
const target = process.env.LEARNLENS_API || 'http://localhost:4000';
const proxy = Object.fromEntries(['/api', '/xapi', '/sdk', '/preview', '/packages'].map((p) => [p, { target, changeOrigin: false }]));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy }
});
