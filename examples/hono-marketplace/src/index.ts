import { createApp } from "./app.ts";
import { marketplaceWavePath } from "./db/paths.ts";
import { openMarketplaceDb } from "./db/seed.ts";

const wavePath = marketplaceWavePath();
const port = Number(process.env.PORT ?? 3000);

console.log(`Opening database at ${wavePath}…`);
const db = await openMarketplaceDb(true, wavePath);
const app = createApp(db);

console.log(`Marketplace API listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
