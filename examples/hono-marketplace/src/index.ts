import { waveHost } from "@purplemon/wavedb/server";
import { createApp } from "./app.ts";
import { marketplaceWavePath } from "./db/paths.ts";
import { openMarketplaceDb } from "./db/seed.ts";

const wavePath = marketplaceWavePath();
const port = Number(process.env.PORT ?? 3000);

console.log(`Opening database at ${wavePath}…`);
const db = await openMarketplaceDb(true, wavePath);
const host = waveHost(db);
const app = createApp(db);

app.use(host.hono());

console.log(`Marketplace API listening on http://localhost:${port}`);
console.log(`Wave Studio at http://localhost:${port}${host.studioPath}`);

export default {
  port,
  fetch: app.fetch,
};
