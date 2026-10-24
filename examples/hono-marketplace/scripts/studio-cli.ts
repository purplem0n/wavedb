import { spawnSync } from "node:child_process";
import { marketplaceWavePath } from "../src/db/paths.ts";

const path = marketplaceWavePath();
const r = spawnSync("wave", ["studio", path], { stdio: "inherit" });
process.exit(r.status ?? 1);
