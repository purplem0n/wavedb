declare const __WAVE_ENGINE_VERSION__: string;

function resolveWaveEngineVersion(): string {
  if (typeof window !== "undefined" && window.__WAVE_ENGINE_VERSION__) return window.__WAVE_ENGINE_VERSION__;
  return __WAVE_ENGINE_VERSION__;
}

/** Semver from runtime config (server) or Studio build time fallback (e.g. `0.1.7`). */
export const waveEngineVersion: string = resolveWaveEngineVersion();

/** Display label such as `v0.1.6`, with optional suffix (e.g. `-embedded`, ` engine`). */
export function waveEngineVersionTag(suffix = ""): string {
  return `v${waveEngineVersion}${suffix}`;
}
