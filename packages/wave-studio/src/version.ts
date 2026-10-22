declare const __WAVE_ENGINE_VERSION__: string;

/** Semver from `@purplemon/wavedb` at Studio build time (e.g. `0.1.6`). */
export const waveEngineVersion: string = __WAVE_ENGINE_VERSION__;

/** Display label such as `v0.1.6`, with optional suffix (e.g. `-embedded`, ` engine`). */
export function waveEngineVersionTag(suffix = ""): string {
  return `v${waveEngineVersion}${suffix}`;
}
