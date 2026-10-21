import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `wave studio` serves dist/ and /api from the same origin; in dev, proxy /api to a running `wave studio`.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5174,
    proxy: { "/api": process.env.WAVE_API ?? "http://127.0.0.1:4400" },
  },
  build: { outDir: "dist", sourcemap: false },
});
