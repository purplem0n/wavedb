import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `wave studio` serves dist/ and /api from the same origin; in dev, proxy /api to a running `wave studio`.
// When hono-marketplace `bun run dev` owns data.wave, use: WAVE_API=http://127.0.0.1:3000 bun run dev
const waveApi = process.env.WAVE_API ?? "http://127.0.0.1:4400";
const waveApiProxy =
  waveApi.includes(":3000")
    ? {
        target: waveApi.replace(/\/$/, ""),
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api/, "/__wave/api"),
      }
    : waveApi;

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5174,
    proxy: { "/api": waveApiProxy },
  },
  build: { outDir: "dist", sourcemap: false },
});
