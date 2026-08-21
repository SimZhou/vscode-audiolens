export interface VisibleRangeInput {
  duration: number;
  sampleRate: number;
  timeZoom: number;
  timeOffset: number;
}

export interface VisibleRange {
  startSample: number;
  endSample: number;
  startTime: number;
  endTime: number;
}

export interface TimeSelection {
  startTime: number;
  endTime: number;
  timeZoom: number;
  timeOffset: number;
}

export interface DbRange {
  minDb: number;
  maxDb: number;
}

export interface WaveformPeaks {
  min: Float32Array;
  max: Float32Array;
}

export type FrequencyScale = "linear" | "log" | "mel" | "bark" | "erb";

export type SpectrogramPalette = "rose" | "classic" | "grayscale" | "inverseGrayscale";

export function getVisibleRange(input: VisibleRangeInput): VisibleRange {
  const duration = Math.max(0, input.duration);
  const sampleRate = Math.max(1, input.sampleRate);
  const timeZoom = Math.max(1, input.timeZoom);
  const timeOffset = clamp(input.timeOffset, 0, 1);
  const viewDuration = duration / timeZoom;
  const maxStart = Math.max(0, duration - viewDuration);
  const startTime = maxStart * timeOffset;
  const endTime = Math.min(duration, startTime + viewDuration);

  return {
    startSample: Math.floor(startTime * sampleRate),
    endSample: Math.floor(endTime * sampleRate),
    startTime,
    endTime
  };
}

export function selectTimeRange(duration: number, fromRatio: number, toRatio: number): TimeSelection {
  const safeDuration = Math.max(0, duration);
  const startRatio = clamp(Math.min(fromRatio, toRatio), 0, 1);
  const endRatio = clamp(Math.max(fromRatio, toRatio), 0, 1);
  const startTime = startRatio * safeDuration;
  const endTime = endRatio * safeDuration;
  const selectedDuration = Math.max(0.001, endTime - startTime);
  const timeZoom = clamp(safeDuration / selectedDuration, 1, 64);
  const maxStart = Math.max(0, safeDuration - safeDuration / timeZoom);
  const timeOffset = maxStart === 0 ? 0 : clamp(startTime / maxStart, 0, 1);

  return {
    startTime,
    endTime,
    timeZoom,
    timeOffset
  };
}

export function normalizeDbRange(minDb: number, maxDb: number): DbRange {
  const safeMin = clamp(Number.isFinite(minDb) ? minDb : -96, -160, -1);
  const safeMax = clamp(Number.isFinite(maxDb) ? maxDb : 0, -80, 24);
  return {
    minDb: safeMin,
    maxDb: Math.max(safeMax, safeMin + 1)
  };
}

export function createAnalysisCacheKey(parts: {
  channel: number;
  startSample: number;
  endSample: number;
  fftSize: number;
  windowFunction: string;
  zeroPaddingFactor?: number;
  outputBins?: number;
  targetFrames?: number;
  hopSize?: number;
  minDb: number;
  maxDb: number;
  spectrogramMinHz?: number;
  spectrogramMaxHz?: number;
  frequencyScale?: FrequencyScale;
  palette?: SpectrogramPalette;
}): string {
  return [
    parts.channel,
    parts.startSample,
    parts.endSample,
    parts.fftSize,
    parts.windowFunction,
    parts.zeroPaddingFactor ?? 1,
    parts.outputBins ?? 0,
    parts.targetFrames ?? 0,
    parts.hopSize ?? 0,
    parts.minDb,
    parts.maxDb,
    parts.spectrogramMinHz ?? 0,
    parts.spectrogramMaxHz ?? 0,
    parts.frequencyScale ?? "linear",
    parts.palette ?? "classic"
  ].join(":");
}

export function computeWaveformPeaks(samples: Float32Array, startSample: number, endSample: number, width: number): WaveformPeaks {
  const min = new Float32Array(width);
  const max = new Float32Array(width);
  if (width <= 0 || samples.length === 0) {
    return { min, max };
  }

  const start = clamp(Math.floor(startSample), 0, samples.length);
  const end = clamp(Math.ceil(endSample), start, samples.length);
  const sampleCount = Math.max(1, end - start);

  for (let x = 0; x < width; x += 1) {
    const sampleStart = Math.min(end - 1, start + Math.floor((x * sampleCount) / width));
    const sampleEnd = Math.min(end, Math.max(sampleStart + 1, start + Math.ceil(((x + 1) * sampleCount) / width)));
    let minValue = 0;
    let maxValue = 0;
    let hasValue = false;
    for (let index = sampleStart; index < sampleEnd; index += 1) {
      const value = samples[index] ?? 0;
      minValue = hasValue ? Math.min(minValue, value) : value;
      maxValue = hasValue ? Math.max(maxValue, value) : value;
      hasValue = true;
    }
    min[x] = minValue;
    max[x] = maxValue;
  }

  return { min, max };
}

export function computeSpectrogramRequestPlan(options: {
  visibleStartSample: number;
  visibleEndSample: number;
  totalSamples: number;
  plotWidthPixels: number;
  plotHeightPixels: number;
  devicePixelRatio: number;
  paddedFftSize: number;
  magnitudeByteBudget: number;
  rasterByteBudget: number;
  maxTargetFrames?: number;
}): { startSample: number; endSample: number; hopSize: number; outputBins: number; targetFrames: number } {
  const totalSamples = Math.max(0, Math.floor(options.totalSamples));
  const visibleStart = clamp(Math.floor(options.visibleStartSample), 0, totalSamples);
  const visibleEnd = clamp(Math.floor(options.visibleEndSample), visibleStart, totalSamples);
  const visibleSpan = Math.max(1, visibleEnd - visibleStart);

  let block = 1;
  while (block < visibleSpan) block *= 2;
  const grid = Math.max(1, Math.floor(block / 4));
  const alignedStart = Math.floor(visibleStart / grid) * grid - grid;
  const startSample = Math.max(0, alignedStart);
  const endSample = Math.max(startSample, Math.min(totalSamples, alignedStart + block + 3 * grid));
  const requestSpan = Math.max(1, endSample - startSample);

  const ratio = Math.max(1, Number.isFinite(options.devicePixelRatio) ? options.devicePixelRatio : 1);
  const cssWidth = Math.max(1, options.plotWidthPixels / ratio);
  const visibleTargetFrames = Math.max(360, Math.min(1800, Math.floor(cssWidth)));
  const preferredTargetFrames = Math.ceil(visibleTargetFrames * requestSpan / visibleSpan);
  const outputBins = Math.max(192, Math.min(900, Math.floor(options.plotHeightPixels)));
  const halfFftSize = Math.max(1, Math.floor(options.paddedFftSize / 2));
  // hop 向下取 2 的幂后，实际帧数可能接近 targetFrames 的两倍。
  const magnitudeBudgetFrames = Math.max(1, Math.floor(options.magnitudeByteBudget / (halfFftSize * 4 * 2)));
  const rasterBudgetFrames = Math.max(1, Math.floor(options.rasterByteBudget / (outputBins * 4 * 2)));
  const targetFrames = Math.max(1, Math.min(
    preferredTargetFrames,
    magnitudeBudgetFrames,
    rasterBudgetFrames,
    options.maxTargetFrames ?? 4096
  ));

  const idealHop = Math.max(1, requestSpan / targetFrames);
  let hopSize = 1;
  while (hopSize * 2 <= idealHop) hopSize *= 2;
  return { startSample, endSample, hopSize, outputBins, targetFrames };
}

export function computeStreamedSpectrogramMaxFrames(
  targetFrames: number,
  windowSize: number,
  byteBudget: number,
  maxFrames: number
): number {
  const framesByTransfer = Math.max(1, Math.floor(byteBudget / (Math.max(1, windowSize) * 4)));
  return Math.max(1, Math.min(maxFrames, framesByTransfer, Math.max(1, Math.floor(targetFrames) * 2)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeAxisIntervals(
  heightCssPx: number,
  options: { min?: number; max?: number; even?: boolean } = {}
): number {
  const min = options.min ?? 2;
  const max = options.max ?? 8;
  const raw = Math.round((Number.isFinite(heightCssPx) ? heightCssPx : 0) / 44);
  let n = Math.min(max, Math.max(min, raw));
  if (options.even && n % 2 !== 0) {
    n = Math.max(min, n - 1);
  }
  return n;
}

export function formatAxisFrequency(hz: number): string {
  const v = Math.max(0, Number.isFinite(hz) ? hz : 0);
  if (v >= 1000) {
    const k = v / 1000;
    const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
    return `${rounded}k`;
  }
  return `${Math.round(v)}`;
}

const MIN_RANGE_SPAN = 1e-6;

export function zoomRange(
  range: { min: number; max: number },
  anchor: number,
  factor: number,
  lower: number,
  upper: number
): { min: number; max: number } {
  const outerSpan = Math.max(MIN_RANGE_SPAN, upper - lower);
  const curSpan = Math.max(MIN_RANGE_SPAN, range.max - range.min);
  const newSpan = Math.min(outerSpan, Math.max(MIN_RANGE_SPAN, curSpan * factor));
  const a = Math.min(range.max, Math.max(range.min, anchor));
  const ratio = (a - range.min) / curSpan;
  let lo = a - ratio * newSpan;
  let hi = lo + newSpan;
  if (lo < lower) { lo = lower; hi = lower + newSpan; }
  if (hi > upper) { hi = upper; lo = upper - newSpan; }
  return { min: Math.max(lower, lo), max: Math.min(upper, hi) };
}

export function panRange(
  range: { min: number; max: number },
  delta: number,
  lower: number,
  upper: number
): { min: number; max: number } {
  const span = Math.max(MIN_RANGE_SPAN, range.max - range.min);
  const maxLo = Math.max(lower, upper - span);
  const lo = Math.min(maxLo, Math.max(lower, range.min + delta));
  return { min: lo, max: lo + span };
}
