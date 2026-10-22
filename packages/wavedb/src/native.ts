import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeTx {
  execute(statement: string): Promise<string>;
  executeSql(sql: string, params: string): Promise<string>;
  executeSync(statement: string): string;
  executeSqlSync(sql: string, params: string): string;
  commit(): Promise<string>;
  rollback(): void;
}

export interface NativeDb {
  close(): void;
  execute(statement: string): Promise<string>;
  executeSql(sql: string, params: string): Promise<string>;
  executeSync(statement: string): string;
  executeSqlSync(sql: string, params: string): string;
  begin(isolation?: string | null): NativeTx;
  tables(): string;
  stats(): string;
  vacuum(): Promise<string>;
  compact(): Promise<string>;
  flush(): void;
}

interface NativeModule {
  version(): string;
  NativeDb: { open(path: string, options?: string | null): NativeDb };
}

let cached: NativeModule | undefined;

export function loadNative(): NativeModule {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const file = `wave.${process.platform}-${process.arch}.node`;
  const candidates = [
    process.env.WAVE_NATIVE_PATH,
    join(here, "..", "native", file),
    join(here, "native", file),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(c)) {
      cached = require(c) as NativeModule;
      return cached;
    }
  }
  // optional platform packages: @purplemon/wavedb-darwin-arm64, ...
  try {
    cached = require(`@purplemon/wavedb-${process.platform}-${process.arch}`) as NativeModule;
    return cached;
  } catch {}
  throw new Error(
    `WaveDB native addon not found for ${process.platform}-${process.arch}. Looked in:\n  ${candidates.join("\n  ")}\n` +
      `Install optional @purplemon/wavedb-${process.platform}-${process.arch}, set WAVE_NATIVE_PATH, or reinstall with GitHub release assets ` +
      `(postinstall downloads from github.com/purplem0n/wavedb releases; set WAVE_NATIVE_REQUIRED=1 in CI). Monorepo: \`bun run build:native\`.`,
  );
}
