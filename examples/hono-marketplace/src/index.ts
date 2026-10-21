import { join } from "node:path";
import { createApp } from "./app.ts";
import { openMarketplaceDb } from "./db/seed.ts";

const dataDir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
const port = Number(process.env.PORT ?? 3000);

console.log(`Opening database in ${dataDir}…`);
const db = await openMarketplaceDb(dataDir, true);
const app = createApp(db);

console.log(`Marketplace API listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
