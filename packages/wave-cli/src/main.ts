#!/usr/bin/env node
import { run } from "./cli.ts";

const io = {
  out: (s: string) => void process.stdout.write(s),
  err: (s: string) => void process.stderr.write(s),
};

try {
  const res = await run(process.argv.slice(2), io);
  if ("running" in res) {
    const stop = async () => {
      await res.running.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    process.exit(res.code);
  }
} catch (e) {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(1);
}
