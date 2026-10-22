import { seedOnly } from "../src/db/seed.ts";

const force = process.argv.includes("--force");

await seedOnly(force);
