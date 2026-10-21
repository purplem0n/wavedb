import type { Database } from "@purplemon/wavedb";
import type { AppSchema } from "./schema.ts";

export type MarketplaceDb = Database<AppSchema>;

export type AppEnv = {
  Variables: {
    db: MarketplaceDb;
  };
};
