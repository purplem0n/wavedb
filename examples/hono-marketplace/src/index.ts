import { waveHost } from "@purplemon/wavedb/server";
import { createApp } from "./app.ts";
import { marketplaceWavePath } from "./db/paths.ts";
import { openMarketplaceDb } from "./db/seed.ts";

const wavePath = marketplaceWavePath();
const port = Number(process.env.PORT ?? 3000);

console.log(`Opening database at ${wavePath}…`);
const db = await openMarketplaceDb(true, wavePath);
const host = waveHost(db, { dataPath: wavePath });
const app = createApp(db);

app.use(host.hono());

const base = `http://localhost:${port}`;
console.log(`Marketplace API listening on ${base}`);
console.log(`Wave Studio at ${base}${host.studioPath}`);
console.log(`Wave connect base: ${base}${host.connectPath} (use WAVE_SERVE_TOKEN or Studio login)`);

export default {
  port,
  fetch: app.fetch,
};
