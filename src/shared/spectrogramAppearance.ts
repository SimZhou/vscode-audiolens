import type { AudioLensPreferences } from "./protocol";

export const DEFAULT_SPECTROGRAM_BRIGHTNESS = {
  gainDb: 20,
  rangeDb: 80,
  highBoostDb: 0
};

export function normalizeSpectrogramBrightness(gainDb: number, rangeDb: number, highBoostDb: number) {
  const bounded = (value: number, fallback: number, min: number, max: number) =>
    Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
  return {
    gainDb: bounded(gainDb, 20, -60, 100),
    rangeDb: bounded(rangeDb, 80, 1, 160),
    highBoostDb: bounded(highBoostDb, 0, 0, 60)
  };
}

export function restoreSpectrogramBrightness(preferences: AudioLensPreferences) {
  // 旧版每次保存其他设置时也写入默认开启的自动亮度，无法判断是否由用户选择。
  // 只恢复新版本的显式状态；旧版手动 dB 范围仍可迁移。
  const current = preferences.brightnessVersion === 1;
  const legacyManual = !current && preferences.autoBrightness === false
    && Number.isFinite(preferences.minDb) && Number.isFinite(preferences.maxDb);
  return {
    ...normalizeSpectrogramBrightness(
      current ? preferences.gainDb ?? 20 : legacyManual ? -preferences.maxDb! : 20,
      current ? preferences.rangeDb ?? 80 : legacyManual ? preferences.maxDb! - preferences.minDb! : 80,
      current ? preferences.highBoostDb ?? 0 : 0
    ),
    autoBrightness: current && preferences.autoBrightness === true
  };
}
