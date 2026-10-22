import { SEED_PROFILES } from "../src/db/seed-profile.ts";
import { seedOnly } from "../src/db/seed.ts";

const force = process.argv.includes("--force");

await seedOnly(force, SEED_PROFILES.small);
