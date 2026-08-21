export interface SpectrogramResult {
  type: "spectrogram";
  requestId: string;
  width: number;
  height: number;
  pixels: ArrayBuffer;
  prefetch?: boolean;
  profile?: {
    totalMs: number;
    setupMs: number;
    fftMs: number;
    rasterizeMs: number;
    frames: number;
    computedFrames: number;
    reusedFrames: number;
    bins: number;
    fftSize: number;
    windowSize: number;
    hopSize: number;
    sampleCount: number;
  };
}

export interface SelectionSpectrumResult {
  type: "selectionSpectrum";
  requestId: string;
  dominantHz: number;
  centroidHz: number;
  bandPercents: number[];
  frames: number;
}

export type AnalysisWorkerResult = SpectrogramResult | SelectionSpectrumResult;

// Worker 内核以源码字符串形式内联（Webview CSP 下用 Blob URL 加载），导出以便本地测试直接执行。
export const analysisWorkerSource = `
    // 常驻的每通道采样存储：loadSamples 一次性传入，analyze 只带范围，避免交互期反复拷贝大数组。
    const channelSamples = new Map();
    // 每通道最新请求代际：旧代际任务在分块让步点自行放弃，取代 Worker 销毁重建。
    const latestGenerationByChannel = new Map();
    const windowCache = new Map();
    const fftTableCache = new Map();
    const recombTableCache = new Map();
    const paletteLutCache = new Map();
    // 幅值瓦片缓存：按 (通道/采样率/FFT 参数/hop) 分组存幅度平方矩阵，
    // 重叠请求按列复用，显示参数（频率范围/调色板/dB）变化只需重新光栅化。
    const magTiles = [];
    let magTileBytes = 0;
    let magTileClock = 0;
    const MAG_TILE_BYTE_CAP = 64 * 1024 * 1024;
    const MAG_TILE_COUNT_CAP = 12;
    const MAX_PADDED_FFT_SIZE = 131072;

    self.onmessage = (event) => {
      const message = event.data;
      if (message.type === "loadSamples") {
        channelSamples.set(message.channel, new Float32Array(message.samples));
        return;
      }
      if (message.type === "clearSamples") {
        channelSamples.clear();
        latestGenerationByChannel.clear();
        magTiles.length = 0;
        magTileBytes = 0;
        return;
      }
      if (message.type === "selectionSpectrum") {
        analyzeSelectionSpectrum(message);
        return;
      }
      if (message.type !== "analyze") return;
      const generation = message.generation || 0;
      const channel = message.channel || 0;
      if (generation > (latestGenerationByChannel.get(channel) || 0)) {
        latestGenerationByChannel.set(channel, generation);
      }
      void renderSpectrogram(message, channel, generation);
    };

    async function renderSpectrogram(message, channel, generation) {
      // 突发合并：先让出一次事件循环，让同一突发中排队的更高代际请求先注册，
      // 过期请求在这里直接退出，一列 FFT 都不算。
      await yieldToQueue();
      if (generation < (latestGenerationByChannel.get(channel) || 0)) {
        return;
      }
      const stored = channelSamples.get(channel);
      const fallback = message.samples ? new Float32Array(message.samples) : undefined;
      const samples = stored || fallback;
      if (!samples) {
        return;
      }
      const settings = message.settings;
      const profile = settings.profile === true;
      const totalStart = profile ? performance.now() : 0;
      const start = Math.max(0, Math.min(samples.length, Math.floor(message.startSample || 0)));
      const end = Math.max(start, Math.min(samples.length, Math.floor(message.endSample === undefined ? samples.length : message.endSample)));
      const sampleCount = end - start;
      const windowSize = Math.min(MAX_PADDED_FFT_SIZE, Math.max(8, Math.floor(settings.fftSize || 512)));
      let zeroPaddingFactor = Math.max(1, Math.floor(settings.zeroPaddingFactor || 1));
      while (windowSize * zeroPaddingFactor > MAX_PADDED_FFT_SIZE && zeroPaddingFactor > 1) {
        zeroPaddingFactor = Math.max(1, Math.floor(zeroPaddingFactor / 2));
      }
      const fftSize = nextPowerOfTwo(windowSize * zeroPaddingFactor);
      const sampleRate = Math.max(1, message.sampleRate || 1);
      let hopSize = Math.max(1, Math.floor(settings.hopSize || 1));
      const bins = Math.max(1, Math.min(Math.floor(settings.outputBins || 384), fftSize / 2));
      const half = fftSize / 2;
      const maxFrames = Math.max(1, Math.floor(MAG_TILE_BYTE_CAP / Math.max(1, half * Float32Array.BYTES_PER_ELEMENT)));
      const analyzableSamples = Math.max(0, sampleCount - windowSize);
      let frames = Math.max(1, Math.floor(analyzableSamples / hopSize) + 1);
      if (frames > maxFrames) {
        hopSize = maxFrames <= 1
          ? analyzableSamples + 1
          : Math.max(hopSize, Math.ceil(analyzableSamples / (maxFrames - 1)));
        frames = Math.max(1, Math.floor(analyzableSamples / hopSize) + 1);
      }
      const nyquist = sampleRate / 2;
      const minFrequencyHz = Math.max(0, Math.min(Number(settings.minFrequencyHz) || 0, Math.max(0, nyquist - 1)));
      const maxFrequencyHz = Math.max(minFrequencyHz + 1, Math.min(Number(settings.maxFrequencyHz) || nyquist, nyquist));
      const setupEnd = profile ? performance.now() : 0;
      const CHUNK_FRAMES = 256;

      // ---- 第一级：幅度平方矩阵（与显示参数无关，可跨请求按列复用） ----
      const groupKey = [channel, sampleRate, windowSize, zeroPaddingFactor, settings.windowFunction, hopSize].join("|");
      const fftStart = profile ? performance.now() : 0;
      const mag = new Float32Array(frames * half);
      const covered = new Uint8Array(frames);
      let reusedFrames = 0;
      for (const tile of message.disableMagCache ? [] : magTiles) {
        if (tile.groupKey !== groupKey || tile.half !== half) continue;
        const delta = (start - tile.baseSample) / hopSize;
        if (!Number.isInteger(delta)) continue;
        const from = Math.max(0, -delta);
        const to = Math.min(frames, tile.frames - delta);
        if (to <= from) continue;
        mag.set(tile.data.subarray((from + delta) * half, (to + delta) * half), from * half);
        for (let i = from; i < to; i += 1) {
          if (!covered[i]) {
            covered[i] = 1;
            reusedFrames += 1;
          }
        }
        tile.lastUsed = ++magTileClock;
      }

      let computedFrames = 0;
      if (reusedFrames < frames) {
        const window = getWindow(settings.windowFunction, windowSize);
        const tables = getFftTables(half);
        const recomb = getRecombTables(fftSize);
        const re = new Float32Array(half);
        const im = new Float32Array(half);
        let sinceYield = 0;
        for (let frame = 0; frame < frames; frame += 1) {
          if (covered[frame]) continue;
          const offset = start + frame * hopSize;
          re.fill(0);
          im.fill(0);
          // 实数序列打包成半长复数序列：z[m] = x[2m] + i*x[2m+1]。
          const limit = Math.min(windowSize, samples.length - offset);
          for (let i = 0; i < limit; i += 1) {
            const value = samples[offset + i] * window[i];
            if (i & 1) im[i >> 1] = value;
            else re[i >> 1] = value;
          }
          fft(re, im, tables);
          // 由半长复数谱重组出实数谱幅度平方（packed real FFT）。
          const base = frame * half;
          mag[base] = (re[0] + im[0]) * (re[0] + im[0]);
          for (let k = 1; k < half; k += 1) {
            const j = half - k;
            const er = (re[k] + re[j]) * 0.5;
            const ei = (im[k] - im[j]) * 0.5;
            const or_ = (im[k] + im[j]) * 0.5;
            const oi = (re[j] - re[k]) * 0.5;
            const wr = recomb.cos[k];
            const wi = recomb.sin[k];
            const xr = er + wr * or_ - wi * oi;
            const xi = ei + wr * oi + wi * or_;
            mag[base + k] = xr * xr + xi * xi;
          }
          computedFrames += 1;
          sinceYield += 1;
          if (sinceYield >= CHUNK_FRAMES) {
            sinceYield = 0;
            await yieldToQueue();
            if (generation < (latestGenerationByChannel.get(channel) || 0)) return;
          }
        }
      }
      if (!message.disableMagCache) {
        storeMagTile(groupKey, start, frames, half, mag);
      }
      const fftEnd = profile ? performance.now() : 0;

      // ---- 第二级：光栅化（行 -> bin 查找表 + 调色板 LUT，显示参数只影响这一级） ----
      const binForRow = new Int32Array(bins);
      for (let y = 0; y < bins; y += 1) {
        const ratio = bins <= 1 ? 0 : (bins - 1 - y) / (bins - 1);
        const freq = frequencyFromRatio(ratio, settings.frequencyScale, minFrequencyHz, maxFrequencyHz);
        binForRow[y] = Math.max(0, Math.min(half - 1, Math.round((freq / sampleRate) * fftSize)));
      }
      const paletteLut = getPaletteLut(settings.palette);
      // db = 20*log10(max(sqrt(m2)/windowSize, 1e-12)) + 算法偏移，等价改写为 m2 域一次 log10。
      const dbAdjust = -20 * Math.log10(windowSize);
      const m2Floor = 1e-24 * windowSize * windowSize;
      const dbSpan = Math.max(1e-6, settings.maxDb - settings.minDb);
      const minDb = settings.minDb;
      const lutScale = 255 / dbSpan;
      const pixels = new Uint8ClampedArray(frames * bins * 4);
      let sinceYield = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        const base = frame * half;
        for (let y = 0; y < bins; y += 1) {
          const m2 = mag[base + binForRow[y]];
          const db = 10 * Math.log10(m2 > m2Floor ? m2 : m2Floor) + dbAdjust;
          let level = (db - minDb) * lutScale;
          if (level < 0) level = 0;
          else if (level > 255) level = 255;
          const lutIndex = (level + 0.5) | 0;
          const colorIndex = lutIndex * 3;
          const index = (y * frames + frame) * 4;
          pixels[index] = paletteLut[colorIndex];
          pixels[index + 1] = paletteLut[colorIndex + 1];
          pixels[index + 2] = paletteLut[colorIndex + 2];
          pixels[index + 3] = 255;
        }
        sinceYield += 1;
        if (sinceYield >= CHUNK_FRAMES * 2 && frame + 1 < frames) {
          sinceYield = 0;
          await yieldToQueue();
          if (generation < (latestGenerationByChannel.get(channel) || 0)) return;
        }
      }
      const rasterizeEnd = profile ? performance.now() : 0;

      const result = { type: "spectrogram", requestId: message.requestId, width: frames, height: bins, pixels: pixels.buffer };
      if (message.prefetch === true) result.prefetch = true;
      if (profile) {
        result.profile = {
          totalMs: performance.now() - totalStart,
          setupMs: setupEnd - totalStart,
          fftMs: fftEnd - fftStart,
          rasterizeMs: rasterizeEnd - fftEnd,
          frames,
          computedFrames,
          reusedFrames,
          bins,
          fftSize,
          windowSize,
          hopSize,
          sampleCount
        };
      }
      self.postMessage(result, [pixels.buffer]);
    }

    function storeMagTile(groupKey, baseSample, frames, half, data) {
      // 同组同范围的旧瓦片直接替换；否则追加并按字节上限淘汰最久未用的瓦片。
      for (let i = 0; i < magTiles.length; i += 1) {
        const tile = magTiles[i];
        if (tile.groupKey === groupKey && tile.baseSample === baseSample && tile.frames === frames && tile.half === half) {
          magTileBytes += data.byteLength - tile.data.byteLength;
          magTiles[i] = { groupKey, baseSample, frames, half, data, lastUsed: ++magTileClock };
          return;
        }
      }
      magTiles.push({ groupKey, baseSample, frames, half, data, lastUsed: ++magTileClock });
      magTileBytes += data.byteLength;
      while (magTiles.length > MAG_TILE_COUNT_CAP || (magTileBytes > MAG_TILE_BYTE_CAP && magTiles.length > 1)) {
        let oldestIndex = 0;
        for (let i = 1; i < magTiles.length; i += 1) {
          if (magTiles[i].lastUsed < magTiles[oldestIndex].lastUsed) oldestIndex = i;
        }
        magTileBytes -= magTiles[oldestIndex].data.byteLength;
        magTiles.splice(oldestIndex, 1);
      }
    }

    // 分块让步：用一次性 MessageChannel 产生 macrotask，让 onmessage 有机会接收更新的代际。
    function yieldToQueue() {
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(0);
      });
    }

    function analyzeSelectionSpectrum(message) {
      const samples = new Float32Array(message.samples);
      const sampleRate = Math.max(1, message.sampleRate || 1);
      const available = samples.length;
      const requestedSize = Math.max(1, Math.floor(message.fftSize || 512));
      const fftSize = largestPowerOfTwo(Math.min(requestedSize, available));
      const bandLimits = Array.isArray(message.bandLimits) ? message.bandLimits : [];
      if (fftSize < 64) {
        self.postMessage({
          type: "selectionSpectrum",
          requestId: message.requestId,
          dominantHz: 0,
          centroidHz: 0,
          bandPercents: bandLimits.map(() => 0),
          frames: 0
        });
        return;
      }

      const re = new Float32Array(fftSize);
      const im = new Float32Array(fftSize);
      const window = getWindow(message.windowFunction, fftSize);
      const tables = getFftTables(fftSize);
      let dominantBin = 1;
      let dominantPower = 0;
      let totalPower = 0;
      let weightedFrequencySum = 0;
      let frames = 0;
      const bandPower = new Float64Array(bandLimits.length);
      const binPower = new Float64Array(Math.floor(fftSize / 2));
      const hopSize = Math.max(1, Math.floor(fftSize / 2));
      const lastFrameStart = Math.max(0, available - fftSize);
      let relativeStart = 0;

      while (relativeStart <= lastFrameStart) {
        im.fill(0);
        for (let index = 0; index < fftSize; index += 1) {
          re[index] = (samples[relativeStart + index] ?? 0) * window[index];
        }
        fft(re, im, tables);
        frames += 1;

        for (let bin = 1; bin < fftSize / 2; bin += 1) {
          const power = re[bin] * re[bin] + im[bin] * im[bin];
          const frequency = (bin * sampleRate) / fftSize;
          totalPower += power;
          weightedFrequencySum += frequency * power;
          binPower[bin] += power;
          const bandIndex = bandLimits.findIndex((band) => frequency >= band.min && frequency < band.max);
          if (bandIndex >= 0) {
            bandPower[bandIndex] += power;
          }
        }

        if (relativeStart === lastFrameStart) {
          break;
        }
        relativeStart = Math.min(relativeStart + hopSize, lastFrameStart);
      }

      for (let bin = 1; bin < binPower.length; bin += 1) {
        if (binPower[bin] > dominantPower) {
          dominantPower = binPower[bin];
          dominantBin = bin;
        }
      }

      self.postMessage({
        type: "selectionSpectrum",
        requestId: message.requestId,
        dominantHz: (dominantBin * sampleRate) / fftSize,
        centroidHz: totalPower <= 0 ? 0 : weightedFrequencySum / totalPower,
        bandPercents: Array.from(bandPower, (power) => totalPower <= 0 ? 0 : (power / totalPower) * 100),
        frames
      });
    }

    function getWindow(type, size) {
      const key = type + ":" + size;
      let values = windowCache.get(key);
      if (!values) {
        values = createWindow(type, size);
        windowCache.set(key, values);
      }
      return values;
    }

    function createWindow(type, size) {
      const values = new Float32Array(size);
      const denom = Math.max(1, size - 1);
      const center = denom / 2;
      for (let i = 0; i < size; i += 1) {
        const phase = (2 * Math.PI * i) / denom;
        const x = center === 0 ? 0 : (i - center) / center;
        if (type === "bartlett") values[i] = 1 - Math.abs(x);
        else if (type === "hamming") values[i] = 0.54 - 0.46 * Math.cos(phase);
        else if (type === "blackman") values[i] = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
        else if (type === "blackmanHarris") values[i] = 0.35875 - 0.48829 * Math.cos(phase) + 0.14128 * Math.cos(2 * phase) - 0.01168 * Math.cos(3 * phase);
        else if (type === "welch") values[i] = 1 - x * x;
        else if (type === "gaussian25") values[i] = Math.exp(-0.5 * Math.pow(2.5 * x, 2));
        else if (type === "gaussian35") values[i] = Math.exp(-0.5 * Math.pow(3.5 * x, 2));
        else if (type === "gaussian45") values[i] = Math.exp(-0.5 * Math.pow(4.5 * x, 2));
        else if (type === "rectangular") values[i] = 1;
        else values[i] = 0.5 - 0.5 * Math.cos(phase);
      }
      return values;
    }

    function getFftTables(size) {
      let tables = fftTableCache.get(size);
      if (!tables) {
        const halfSize = Math.max(1, size / 2);
        const cos = new Float32Array(halfSize);
        const sin = new Float32Array(halfSize);
        for (let k = 0; k < halfSize; k += 1) {
          const angle = (-2 * Math.PI * k) / size;
          cos[k] = Math.cos(angle);
          sin[k] = Math.sin(angle);
        }
        tables = { cos, sin };
        fftTableCache.set(size, tables);
      }
      return tables;
    }

    function getRecombTables(fftSize) {
      let tables = recombTableCache.get(fftSize);
      if (!tables) {
        const half = fftSize / 2;
        const cos = new Float32Array(half);
        const sin = new Float32Array(half);
        for (let k = 0; k < half; k += 1) {
          const angle = (-2 * Math.PI * k) / fftSize;
          cos[k] = Math.cos(angle);
          sin[k] = Math.sin(angle);
        }
        tables = { cos, sin };
        recombTableCache.set(fftSize, tables);
      }
      return tables;
    }

    function getPaletteLut(palette) {
      let lut = paletteLutCache.get(palette);
      if (!lut) {
        lut = new Uint8Array(256 * 3);
        for (let i = 0; i < 256; i += 1) {
          const color = colorize(i / 255, palette);
          lut[i * 3] = color[0];
          lut[i * 3 + 1] = color[1];
          lut[i * 3 + 2] = color[2];
        }
        paletteLutCache.set(palette, lut);
      }
      return lut;
    }

    function nextPowerOfTwo(value) {
      let size = 1;
      while (size < value) size <<= 1;
      return size;
    }

    function largestPowerOfTwo(value) {
      let size = 1;
      while (size * 2 <= value) size *= 2;
      return size;
    }

    function fft(re, im, tables) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i += 1) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
          const tr = re[i]; re[i] = re[j]; re[j] = tr;
          const ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
      }
      const cosTab = tables.cos;
      const sinTab = tables.sin;
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const step = n / len;
        for (let i = 0; i < n; i += len) {
          for (let j = 0, tw = 0; j < half; j += 1, tw += step) {
            const wr = cosTab[tw];
            const wi = sinTab[tw];
            const vR = re[i + j + half] * wr - im[i + j + half] * wi;
            const vI = re[i + j + half] * wi + im[i + j + half] * wr;
            const uR = re[i + j];
            const uI = im[i + j];
            re[i + j] = uR + vR;
            im[i + j] = uI + vI;
            re[i + j + half] = uR - vR;
            im[i + j + half] = uI - vI;
          }
        }
      }
    }

    function frequencyFromRatio(ratio, scale, minHz, maxHz) {
      const r = Math.max(0, Math.min(1, ratio));
      const bottom = Math.max(0, Math.min(minHz, maxHz - 1));
      const top = Math.max(bottom + 1, maxHz);
      if (scale === "log") {
        if (top <= 20) return bottom + r * (top - bottom);
        const low = 20;
        if (bottom <= 0 && r <= 0) return 0;
        const minCoord = bottom <= 0 ? 0 : Math.log(Math.max(low, bottom) / low) / Math.log(top / low);
        return Math.min(top, low * Math.pow(top / low, minCoord + r * (1 - minCoord)));
      }
      if (scale === "mel") {
        const minMel = hzToMel(bottom);
        return melToHz(minMel + r * (hzToMel(top) - minMel));
      }
      if (scale === "bark") {
        const minBark = hzToBark(bottom);
        return barkToHz(minBark + r * (hzToBark(top) - minBark));
      }
      if (scale === "erb") {
        const minErb = hzToErb(bottom);
        return erbToHz(minErb + r * (hzToErb(top) - minErb));
      }
      return bottom + r * (top - bottom);
    }

    function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
    function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }
    function hzToBark(hz) { return 6 * Math.asinh(hz / 600); }
    function barkToHz(bark) { return 600 * Math.sinh(bark / 6); }
    function hzToErb(hz) { return 21.4 * Math.log10(1 + 0.00437 * hz); }
    function erbToHz(erb) { return (Math.pow(10, erb / 21.4) - 1) / 0.00437; }

    function colorize(value, palette) {
      const t = Math.max(0, Math.min(1, value));
      if (palette === "grayscale") {
        const v = Math.round(t * 255);
        return [v, v, v];
      }
      if (palette === "inverseGrayscale") {
        const v = Math.round((1 - t) * 255);
        return [v, v, v];
      }
      if (palette === "rose") {
        if (t < 0.25) return lerp([12, 10, 24], [52, 25, 82], t / 0.25);
        if (t < 0.5) return lerp([52, 25, 82], [165, 43, 108], (t - 0.25) / 0.25);
        if (t < 0.75) return lerp([165, 43, 108], [241, 118, 92], (t - 0.5) / 0.25);
        return lerp([241, 118, 92], [255, 224, 140], (t - 0.75) / 0.25);
      }
      if (t < 0.25) return lerp([12, 18, 28], [25, 86, 134], t / 0.25);
      if (t < 0.5) return lerp([25, 86, 134], [40, 160, 115], (t - 0.25) / 0.25);
      if (t < 0.75) return lerp([40, 160, 115], [230, 174, 55], (t - 0.5) / 0.25);
      return lerp([230, 174, 55], [235, 77, 75], (t - 0.75) / 0.25);
    }

    function lerp(a, b, t) {
      return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t)
      ];
    }
  `;

export function createAnalysisWorker(): Worker {
  const url = URL.createObjectURL(new Blob([analysisWorkerSource], { type: "text/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  return worker;
}
