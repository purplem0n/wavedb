// Verifies the native addon loads without compiling Rust (uses packages/wavedb/native or optional pkg).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const file = `wave.${process.platform}-${process.arch}.node`;
const bundled = join(root, "packages", "wavedb", "native", file);
let mod;
if (existsSync(bundled)) {
  mod = require(bundled);
} else {
  mod = require(`wavedb-${process.platform}-${process.arch}`);
}
assert.equal(typeof mod.version(), "string");

const dir = mkdtempSync(join(tmpdir(), "wave-prebuild-"));
try {
  const db = mod.NativeDb.open(join(dir, "data.wave"), JSON.stringify({ durability: "async" }));
  const out = db.executeSqlSync("SELECT 1 AS n", "");
  const parsed = JSON.parse(out);
  assert.equal(parsed.rows[0][0], 1);
  db.close();
  console.log(`prebuild smoke ok (${process.platform}-${process.arch})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
