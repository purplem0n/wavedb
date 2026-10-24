/**
 * Release helpers for CHANGELOG.md (Keep a Changelog).
 *
 *   node scripts/changelog-release.mjs extract [--file PATH] [--out PATH]
 *   node scripts/changelog-release.mjs reset [--file PATH]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPath = join(root, "CHANGELOG.md");

const HEADER = `# Changelog

All notable changes to \`@purplemon/wavedb\`, \`@purplemon/wave-cli\`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

`;

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  let file = defaultPath;
  let out = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) {
      file = args[++i];
      continue;
    }
    if (args[i] === "--out" && args[i + 1]) {
      out = args[++i];
      continue;
    }
  }
  return { cmd, file, out };
}

/** Content under ## [Unreleased] until the next ## [version] or EOF. */
function extractUnreleased(markdown) {
  const marker = "## [Unreleased]";
  const start = markdown.indexOf(marker);
  if (start === -1) {
    throw new Error("CHANGELOG.md is missing ## [Unreleased]");
  }
  let rest = markdown.slice(start + marker.length);
  const nextSection = rest.search(/\n## \[[^\]]+\]/);
  if (nextSection !== -1) {
    rest = rest.slice(0, nextSection);
  }
  return rest.trim();
}

function resetChangelogTemplate() {
  return HEADER;
}

function extractCmd(file, out) {
  const markdown = readFileSync(file, "utf8");
  const body = extractUnreleased(markdown);
  const text =
    body.length > 0
      ? body
      : "_No changelog entries for this release._";
  if (out) {
    writeFileSync(out, text + "\n");
  } else {
    process.stdout.write(text + "\n");
  }
}

function resetCmd(file) {
  writeFileSync(file, resetChangelogTemplate());
}

const { cmd, file, out } = parseArgs();
if (cmd === "extract") {
  extractCmd(file, out);
} else if (cmd === "reset") {
  resetCmd(file);
} else {
  console.error("Usage: changelog-release.mjs extract|reset [--file PATH] [--out PATH]");
  process.exit(1);
}
