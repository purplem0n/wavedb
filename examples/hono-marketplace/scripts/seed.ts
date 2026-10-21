import { join } from "node:path";
import { seedOnly } from "../src/db/seed.ts";

const dataDir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
const force = process.argv.includes("--force");

await seedOnly(dataDir, force);
