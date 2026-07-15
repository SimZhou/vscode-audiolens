"use strict";(()=>{function ne(n,e){return n===0&&e>0||n===4294967295||n>e?e:n}function Fe(n){let e=Math.max(0,n.duration),a=Math.max(1,n.sampleRate),t=Math.max(1,n.timeZoom),i=q(n.timeOffset,0,1),r=e/t,s=Math.max(0,e-r)*i,l=Math.min(e,s+r);return{startSample:Math.floor(s*a),endSample:Math.floor(l*a),startTime:s,endTime:l}}function W(n,e){let a=q(Number.isFinite(n)?n:-96,-160,-1),t=q(Number.isFinite(e)?e:0,-80,24);return{minDb:a,maxDb:Math.max(t,a+1)}}function Re(n){return[n.channel,n.startSample,n.endSample,n.fftSize,n.windowFunction,n.zeroPaddingFactor??1,n.outputBins??0,n.targetFrames??0,n.hopSize??0,n.minDb,n.maxDb,n.spectrogramMinHz??0,n.spectrogramMaxHz??0,n.frequencyScale??"linear",n.palette??"classic"].join(":")}function He(n,e,a,t){let i=new Float32Array(t),r=new Float32Array(t);if(t<=0||n.length===0)return{min:i,max:r};let o=q(Math.floor(e),0,n.length),s=q(Math.ceil(a),o,n.length),l=Math.max(1,s-o);for(let d=0;d<t;d+=1){let c=Math.min(s-1,o+Math.floor(d*l/t)),u=Math.min(s,Math.max(c+1,o+Math.ceil((d+1)*l/t))),p=0,g=0,h=!1;for(let b=c;b<u;b+=1){let y=n[b]??0;p=h?Math.min(p,y):y,g=h?Math.max(g,y):y,h=!0}i[d]=p,r[d]=g}return{min:i,max:r}}function q(n,e,a){return Math.max(e,Math.min(a,n))}function ie(n,e={}){let a=e.min??2,t=e.max??8,i=Math.round((Number.isFinite(n)?n:0)/44),r=Math.min(t,Math.max(a,i));return e.even&&r%2!==0&&(r=Math.max(a,r-1)),r}function K(n){let e=Math.max(0,Number.isFinite(n)?n:0);if(e>=1e3){let a=e/1e3;return`${a>=100?Math.round(a):Math.round(a*10)/10}k`}return`${Math.round(e)}`}var Z=1e-6;function _(n,e,a,t,i){let r=Math.max(Z,i-t),o=Math.max(Z,n.max-n.min),s=Math.min(r,Math.max(Z,o*a)),l=Math.min(n.max,Math.max(n.min,e)),d=(l-n.min)/o,c=l-d*s,u=c+s;return c<t&&(c=t,u=t+s),u>i&&(u=i,c=i-s),{min:Math.max(t,c),max:Math.min(i,u)}}function re(n,e,a,t){let i=Math.max(Z,n.max-n.min),r=Math.max(a,t-i),o=Math.min(r,Math.max(a,n.min+e));return{min:o,max:o+i}}var za=`
    // \u5E38\u9A7B\u7684\u6BCF\u901A\u9053\u91C7\u6837\u5B58\u50A8\uFF1AloadSamples \u4E00\u6B21\u6027\u4F20\u5165\uFF0Canalyze \u53EA\u5E26\u8303\u56F4\uFF0C\u907F\u514D\u4EA4\u4E92\u671F\u53CD\u590D\u62F7\u8D1D\u5927\u6570\u7EC4\u3002
    const channelSamples = new Map();
    // \u6BCF\u901A\u9053\u6700\u65B0\u8BF7\u6C42\u4EE3\u9645\uFF1A\u65E7\u4EE3\u9645\u4EFB\u52A1\u5728\u5206\u5757\u8BA9\u6B65\u70B9\u81EA\u884C\u653E\u5F03\uFF0C\u53D6\u4EE3 Worker \u9500\u6BC1\u91CD\u5EFA\u3002
    const latestGenerationByChannel = new Map();
    const windowCache = new Map();
    const fftTableCache = new Map();
    const recombTableCache = new Map();
    const paletteLutCache = new Map();
    // \u5E45\u503C\u74E6\u7247\u7F13\u5B58\uFF1A\u6309 (\u901A\u9053/\u91C7\u6837\u7387/FFT \u53C2\u6570/hop) \u5206\u7EC4\u5B58\u5E45\u5EA6\u5E73\u65B9\u77E9\u9635\uFF0C
    // \u91CD\u53E0\u8BF7\u6C42\u6309\u5217\u590D\u7528\uFF0C\u663E\u793A\u53C2\u6570\uFF08\u9891\u7387\u8303\u56F4/\u8C03\u8272\u677F/dB\uFF09\u53D8\u5316\u53EA\u9700\u91CD\u65B0\u5149\u6805\u5316\u3002
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
      // \u7A81\u53D1\u5408\u5E76\uFF1A\u5148\u8BA9\u51FA\u4E00\u6B21\u4E8B\u4EF6\u5FAA\u73AF\uFF0C\u8BA9\u540C\u4E00\u7A81\u53D1\u4E2D\u6392\u961F\u7684\u66F4\u9AD8\u4EE3\u9645\u8BF7\u6C42\u5148\u6CE8\u518C\uFF0C
      // \u8FC7\u671F\u8BF7\u6C42\u5728\u8FD9\u91CC\u76F4\u63A5\u9000\u51FA\uFF0C\u4E00\u5217 FFT \u90FD\u4E0D\u7B97\u3002
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

      // ---- \u7B2C\u4E00\u7EA7\uFF1A\u5E45\u5EA6\u5E73\u65B9\u77E9\u9635\uFF08\u4E0E\u663E\u793A\u53C2\u6570\u65E0\u5173\uFF0C\u53EF\u8DE8\u8BF7\u6C42\u6309\u5217\u590D\u7528\uFF09 ----
      const groupKey = [channel, sampleRate, windowSize, zeroPaddingFactor, settings.windowFunction, hopSize].join("|");
      const fftStart = profile ? performance.now() : 0;
      const mag = new Float32Array(frames * half);
      const covered = new Uint8Array(frames);
      let reusedFrames = 0;
      for (const tile of magTiles) {
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
          // \u5B9E\u6570\u5E8F\u5217\u6253\u5305\u6210\u534A\u957F\u590D\u6570\u5E8F\u5217\uFF1Az[m] = x[2m] + i*x[2m+1]\u3002
          const limit = Math.min(windowSize, samples.length - offset);
          for (let i = 0; i < limit; i += 1) {
            const value = samples[offset + i] * window[i];
            if (i & 1) im[i >> 1] = value;
            else re[i >> 1] = value;
          }
          fft(re, im, tables);
          // \u7531\u534A\u957F\u590D\u6570\u8C31\u91CD\u7EC4\u51FA\u5B9E\u6570\u8C31\u5E45\u5EA6\u5E73\u65B9\uFF08packed real FFT\uFF09\u3002
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
      storeMagTile(groupKey, start, frames, half, mag);
      const fftEnd = profile ? performance.now() : 0;

      // ---- \u7B2C\u4E8C\u7EA7\uFF1A\u5149\u6805\u5316\uFF08\u884C -> bin \u67E5\u627E\u8868 + \u8C03\u8272\u677F LUT\uFF0C\u663E\u793A\u53C2\u6570\u53EA\u5F71\u54CD\u8FD9\u4E00\u7EA7\uFF09 ----
      const binForRow = new Int32Array(bins);
      for (let y = 0; y < bins; y += 1) {
        const ratio = bins <= 1 ? 0 : (bins - 1 - y) / (bins - 1);
        const freq = frequencyFromRatio(ratio, settings.frequencyScale, minFrequencyHz, maxFrequencyHz);
        binForRow[y] = Math.max(0, Math.min(half - 1, Math.round((freq / sampleRate) * fftSize)));
      }
      const paletteLut = getPaletteLut(settings.palette);
      // db = 20*log10(max(sqrt(m2)/windowSize, 1e-12)) + \u7B97\u6CD5\u504F\u79FB\uFF0C\u7B49\u4EF7\u6539\u5199\u4E3A m2 \u57DF\u4E00\u6B21 log10\u3002
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
      // \u540C\u7EC4\u540C\u8303\u56F4\u7684\u65E7\u74E6\u7247\u76F4\u63A5\u66FF\u6362\uFF1B\u5426\u5219\u8FFD\u52A0\u5E76\u6309\u5B57\u8282\u4E0A\u9650\u6DD8\u6C70\u6700\u4E45\u672A\u7528\u7684\u74E6\u7247\u3002
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

    // \u5206\u5757\u8BA9\u6B65\uFF1A\u7528\u4E00\u6B21\u6027 MessageChannel \u4EA7\u751F macrotask\uFF0C\u8BA9 onmessage \u6709\u673A\u4F1A\u63A5\u6536\u66F4\u65B0\u7684\u4EE3\u9645\u3002
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
  `;function N(){let n=URL.createObjectURL(new Blob([za],{type:"text/javascript"})),e=new Worker(n);return URL.revokeObjectURL(n),e}function Ee(n,e){let a=e.toLowerCase().split(".").pop();return a==="wav"||a==="wave"?{sampleRate:Ca(n)}:a==="flac"?{sampleRate:Ba(n)}:{}}function Ie(n,e){let a=e.toLowerCase().split(".").pop();if(a==="wav"||a==="wave")return Aa(n);if(a==="flac")return La(n);if(a==="ogg"||a==="opus")return Ia(n);if(a==="m4a"||a==="mp4")return Be(n);if(a==="aac")return Na(n)??Be(n);if(a==="mp3")return Va(n)}function Ca(n){if(n.byteLength<28||S(n,0,4)!=="RIFF"||S(n,8,12)!=="WAVE")return;let e=new DataView(n.buffer,n.byteOffset,n.byteLength),a=12;for(;a+8<=n.byteLength;){let t=S(n,a,a+4),i=e.getUint32(a+4,!0),r=a+8;if(t==="fmt "&&r+8<=n.byteLength){let o=e.getUint32(r+4,!0);return o>0?o:void 0}a=r+i+i%2}}function Aa(n){if(n.byteLength<12||S(n,0,4)!=="RIFF"||S(n,8,12)!=="WAVE")return;let e=new DataView(n.buffer,n.byteOffset,n.byteLength),a=[{offset:0,size:4,field:"ChunkID",value:S(n,0,4),note:"RIFF"},{offset:4,size:4,field:"ChunkSize",value:`${e.getUint32(4,!0)} B`,note:"\u6587\u4EF6\u5927\u5C0F - 8"},{offset:8,size:4,field:"Format",value:S(n,8,12),note:"WAVE"}],t=12,i,r,o,s=[];for(;t+8<=n.byteLength;){let l=S(n,t,t+4),d=l.trimEnd()||l,c=e.getUint32(t+4,!0),u=t+8,p=Math.min(u+c,n.byteLength);a.push({offset:t,size:4,field:`${d}.ChunkID`,value:l,note:"\u5B50\u5757 ID"}),a.push({offset:t+4,size:4,field:`${d}.ChunkSize`,value:`${c} B`,note:"\u5B50\u5757\u6570\u636E\u957F\u5EA6"}),l==="fmt "?(r=c,u+2<=p&&(o=e.getUint16(u,!0)),Ha(a,e,u,p)):l==="data"?(i=u,a.push({offset:u,size:c,field:"data.Payload",value:"",note:"\u97F3\u9891\u6570\u636E\u533A\u57DF"})):c>0&&(i===void 0&&s.push(d),a.push({offset:u,size:c,field:`${d}.Payload`,value:`${c} B`,note:"\u672A\u5C55\u5F00\u5B50\u5757"})),t=u+c+c%2}return{format:"WAV / RIFF",summary:Ta(i,r,o,s),rows:a}}function Ta(n,e,a,t){if(n===void 0)return{tone:"warning",kind:"wavHeader",missingData:!0,text:"\u672A\u627E\u5230 data chunk",detail:"\u65E0\u6CD5\u5224\u65AD WAV \u5934\u957F\u5EA6\u3002"};if(n===44&&e===16&&a===1)return{tone:"info",kind:"wavHeader",headerSize:n,standard:!0,text:`WAV \u5934\u957F\u5EA6 ${n} B`,detail:"\u6807\u51C6 44 \u5B57\u8282 PCM \u5934\u3002"};let r=Fa(e,a,t);return{tone:"warning",kind:"wavHeader",headerSize:n,standard:!1,reasons:r,text:`WAV \u5934\u957F\u5EA6 ${n} B`,detail:Ra(r).join("\uFF1B")}}function Fa(n,e,a){let t=[];return n!==void 0&&n!==16&&t.push({type:"fmtExtended",size:n}),e!==void 0&&e!==1&&t.push({type:"format",format:e,name:De(e)}),a.length>0&&t.push({type:"extraChunks",chunks:a}),t}function Ra(n){return n.map(e=>{switch(e.type){case"fmtExtended":return`fmt \u5B50\u5757\u4E3A ${e.size} B\uFF0C\u5305\u542B\u6269\u5C55\u683C\u5F0F\u5B57\u6BB5`;case"format":return`\u7F16\u7801\u683C\u5F0F\u4E3A ${e.format} (${e.name})`;case"extraChunks":return`data \u524D\u6709\u989D\u5916\u5B50\u5757 ${e.chunks.join(", ")}`;case"dataOffset":return"data \u8D77\u59CB\u504F\u79FB\u4E0D\u662F 44 B"}})}function Ha(n,e,a,t){if(a+16>t){n.push({offset:a,size:Math.max(0,t-a),field:"fmt.Payload",value:"\u4E0D\u5B8C\u6574",note:"fmt \u5B50\u5757\u8FC7\u77ED"});return}let i=e.getUint16(a,!0),r=e.getUint16(a+2,!0),o=e.getUint32(a+4,!0),s=e.getUint32(a+8,!0),l=e.getUint16(a+12,!0),d=e.getUint16(a+14,!0);n.push({offset:a,size:2,field:"fmt.AudioFormat",value:`${i} (${De(i)})`,note:"\u7F16\u7801\u683C\u5F0F"}),n.push({offset:a+2,size:2,field:"fmt.NumChannels",value:String(r),note:"\u901A\u9053\u6570"}),n.push({offset:a+4,size:4,field:"fmt.SampleRate",value:`${o} Hz`,note:"\u91C7\u6837\u7387"}),n.push({offset:a+8,size:4,field:"fmt.ByteRate",value:`${s} B/s`,note:"\u5B57\u8282\u7387"}),n.push({offset:a+12,size:2,field:"fmt.BlockAlign",value:`${l} B`,note:"\u6BCF\u5E27\u5B57\u8282\u6570"}),n.push({offset:a+14,size:2,field:"fmt.BitsPerSample",value:`${d} bit`,note:"\u4F4D\u6DF1"}),a+18<=t&&n.push({offset:a+16,size:2,field:"fmt.CbSize",value:`${e.getUint16(a+16,!0)} B`,note:"\u6269\u5C55\u53C2\u6570\u957F\u5EA6"}),a+24<=t&&i===65534&&(n.push({offset:a+18,size:2,field:"fmt.ValidBitsPerSample",value:`${e.getUint16(a+18,!0)} bit`,note:"\u6709\u6548\u4F4D\u6DF1"}),n.push({offset:a+20,size:4,field:"fmt.ChannelMask",value:`0x${e.getUint32(a+20,!0).toString(16)}`,note:"\u58F0\u9053\u5E03\u5C40\u63A9\u7801"}))}function De(n){switch(n){case 1:return"PCM";case 3:return"IEEE Float";case 6:return"A-law";case 7:return"Mu-law";case 65534:return"Extensible";default:return"Unknown"}}function Ba(n){if(n.byteLength<42||S(n,0,4)!=="fLaC")return;let e=n[4]&127,a=n[5]<<16|n[6]<<8|n[7];if(e!==0||a<34||n.byteLength<42)return;let t=8,i=n[t+10]<<12|n[t+11]<<4|n[t+12]>>4;return i>0?i:void 0}function La(n){if(n.byteLength<4||S(n,0,4)!=="fLaC")return;let e=[{offset:0,size:4,field:"Marker",value:"fLaC",note:"FLAC \u6807\u8BC6"}],a=4;for(;a+4<=n.byteLength;){let t=n[a]??0,i=(t&128)!==0,r=t&127,o=oe(n,a+1),s=a+4,l=Ua(r);if(e.push({offset:a,size:1,field:`${l}.Header`,value:`last=${i}, type=${r}`,note:"\u5143\u6570\u636E\u5757\u5934"}),e.push({offset:a+1,size:3,field:`${l}.Length`,value:`${o} B`,note:"\u5143\u6570\u636E\u5757\u957F\u5EA6"}),r===0&&s+34<=n.byteLength?Ea(e,n,s):o>0&&e.push({offset:s,size:o,field:`${l}.Payload`,value:`${o} B`,note:"\u5143\u6570\u636E\u5757\u5185\u5BB9"}),a=s+o,i)break}return{format:"FLAC",rows:e}}function Ea(n,e,a){let t=Le(e,a),i=Le(e,a+2),r=oe(e,a+4),o=oe(e,a+7),s=e[a+10]<<12|e[a+11]<<4|e[a+12]>>4,l=(e[a+12]>>1&7)+1,d=((e[a+12]&1)<<4|e[a+13]>>4)+1,c=(BigInt(e[a+13]&15)<<32n|BigInt(e[a+14])<<24n|BigInt(e[a+15])<<16n|BigInt(e[a+16])<<8n|BigInt(e[a+17])).toString();n.push({offset:a,size:2,field:"STREAMINFO.MinBlockSize",value:String(t),note:"\u6700\u5C0F\u5757\u5927\u5C0F"}),n.push({offset:a+2,size:2,field:"STREAMINFO.MaxBlockSize",value:String(i),note:"\u6700\u5927\u5757\u5927\u5C0F"}),n.push({offset:a+4,size:3,field:"STREAMINFO.MinFrameSize",value:`${r} B`,note:"\u6700\u5C0F\u5E27\u5927\u5C0F"}),n.push({offset:a+7,size:3,field:"STREAMINFO.MaxFrameSize",value:`${o} B`,note:"\u6700\u5927\u5E27\u5927\u5C0F"}),n.push({offset:a+10,size:3,bits:"80-99 (20 bit)",field:"STREAMINFO.SampleRate",value:`${s} Hz`,note:"\u91C7\u6837\u7387"}),n.push({offset:a+12,size:1,bits:"100-102 (3 bit)",field:"STREAMINFO.Channels",value:String(l),note:"\u901A\u9053\u6570"}),n.push({offset:a+12,size:2,bits:"103-107 (5 bit)",field:"STREAMINFO.BitsPerSample",value:`${d} bit`,note:"\u4F4D\u6DF1"}),n.push({offset:a+13,size:5,bits:"108-143 (36 bit)",field:"STREAMINFO.TotalSamples",value:c,note:"\u603B\u91C7\u6837\u6570"}),n.push({offset:a+18,size:16,field:"STREAMINFO.MD5",value:We(e,a+18,a+34),note:"\u539F\u59CB\u97F3\u9891 MD5"})}function Ia(n){if(n.byteLength<27||S(n,0,4)!=="OggS")return;let e=new DataView(n.buffer,n.byteOffset,n.byteLength),a=[],t=0,i=0;for(;t+27<=n.byteLength&&i<4&&S(n,t,t+4)==="OggS";){let r=n[t+26]??0;if(t+27+r>n.byteLength)break;let o=ja(n,t+27,t+27+r),s=`Page${i}`;a.push({offset:t,size:4,field:`${s}.CapturePattern`,value:"OggS",note:"Ogg \u9875\u6807\u8BC6"}),a.push({offset:t+4,size:1,field:`${s}.Version`,value:String(n[t+4]??0),note:"\u6D41\u7ED3\u6784\u7248\u672C"}),a.push({offset:t+5,size:1,field:`${s}.HeaderType`,value:Za(n[t+5]??0),note:"\u9875\u7C7B\u578B\u6807\u5FD7"}),a.push({offset:t+6,size:8,field:`${s}.GranulePosition`,value:e.getBigUint64(t+6,!0).toString(),note:"\u7EDD\u5BF9\u4F4D\u7F6E"}),a.push({offset:t+14,size:4,field:`${s}.BitstreamSerialNumber`,value:String(e.getUint32(t+14,!0)),note:"\u903B\u8F91\u6D41\u5E8F\u53F7"}),a.push({offset:t+18,size:4,field:`${s}.PageSequenceNumber`,value:String(e.getUint32(t+18,!0)),note:"\u9875\u5E8F\u53F7"}),a.push({offset:t+22,size:4,field:`${s}.Checksum`,value:`0x${e.getUint32(t+22,!0).toString(16)}`,note:"\u9875\u6821\u9A8C\u548C"}),a.push({offset:t+26,size:1,field:`${s}.PageSegments`,value:String(r),note:"segment \u6570"}),a.push({offset:t+27,size:r,field:`${s}.SegmentTable`,value:`${r} B`,note:"segment \u957F\u5EA6\u8868"}),a.push({offset:t+27+r,size:o,field:`${s}.Payload`,value:`${o} B`,note:"\u9875\u6570\u636E"}),i===0&&Da(a,n,t+27+r,o),t+=27+r+o,i+=1}return{format:"OGG",rows:a}}function Da(n,e,a,t){if(t>=19&&S(e,a,a+8)==="OpusHead"){n.push({offset:a,size:8,field:"OpusHead.Magic",value:"OpusHead",note:"Opus \u8BC6\u522B\u5934"}),n.push({offset:a+8,size:1,field:"OpusHead.Version",value:String(e[a+8]??0),note:"\u7248\u672C"}),n.push({offset:a+9,size:1,field:"OpusHead.ChannelCount",value:String(e[a+9]??0),note:"\u901A\u9053\u6570"}),n.push({offset:a+10,size:2,field:"OpusHead.PreSkip",value:String(Ne(e,a+10)),note:"\u9884\u8DF3\u8FC7\u91C7\u6837\u6570"}),n.push({offset:a+12,size:4,field:"OpusHead.InputSampleRate",value:`${se(e,a+12)} Hz`,note:"\u8F93\u5165\u91C7\u6837\u7387"}),n.push({offset:a+16,size:2,field:"OpusHead.OutputGain",value:String(Ga(e,a+16)),note:"\u8F93\u51FA\u589E\u76CA"}),n.push({offset:a+18,size:1,field:"OpusHead.ChannelMappingFamily",value:String(e[a+18]??0),note:"\u58F0\u9053\u6620\u5C04\u65CF"});return}t>=30&&e[a]===1&&S(e,a+1,a+7)==="vorbis"&&(n.push({offset:a,size:1,field:"Vorbis.PacketType",value:"1",note:"\u8BC6\u522B\u5934"}),n.push({offset:a+1,size:6,field:"Vorbis.Magic",value:"vorbis",note:"Vorbis \u6807\u8BC6"}),n.push({offset:a+7,size:4,field:"Vorbis.Version",value:String(se(e,a+7)),note:"\u7248\u672C"}),n.push({offset:a+11,size:1,field:"Vorbis.Channels",value:String(e[a+11]??0),note:"\u901A\u9053\u6570"}),n.push({offset:a+12,size:4,field:"Vorbis.SampleRate",value:`${se(e,a+12)} Hz`,note:"\u91C7\u6837\u7387"}))}function Be(n){if(n.byteLength<8)return;let e=[];return qe(e,n,0,n.byteLength,0),e.length>0?{format:"M4A / MP4",rows:e}:void 0}function qe(n,e,a,t,i){let r=qa(e,a,t);r.forEach((o,s)=>{if(n.length>=420)return;let l=s===r.length-1;n.push({offset:o.offset,size:o.boxSize,depth:i,treePrefix:l?"\u2514\u2500":"\u251C\u2500",kind:"box",field:o.type,value:"",note:"box \u7C7B\u578B"});let d=o.offset+o.headerSize,c=o.offset+o.boxSize;if(Wa(n,e,o.type,d,c,i+1,l),_a(o.type)){let u=o.type==="meta"?d+4:d;u<=c&&qe(n,e,u,c,i+1)}})}function qa(n,e,a){let t=[],i=e;for(;i+8<=a&&t.length<420;){let r=H(n,i),o=S(n,i+4,i+8);if(!Ka(o))break;let s=8,l=r;if(r===1&&i+16<=a?(l=Number(Ve(n,i+8)),s=16):r===0&&(l=a-i),l<s||i+l>a)break;t.push({offset:i,type:o,boxSize:l,headerSize:s}),i+=l}return t}function Wa(n,e,a,t,i,r,o){let s=o?"  \u251C\u2500":"\u2502 \u251C\u2500";if(a==="ftyp"&&t+8<=i){n.push({offset:t,size:4,depth:r,treePrefix:s,kind:"field",field:"MajorBrand",value:S(e,t,t+4),note:"\u4E3B\u54C1\u724C"}),n.push({offset:t+4,size:4,depth:r,treePrefix:s,kind:"field",field:"MinorVersion",value:String(H(e,t+4)),note:"\u6B21\u7248\u672C"}),t+8<i&&n.push({offset:t+8,size:i-t-8,depth:r,treePrefix:s,kind:"field",field:"CompatibleBrands",value:$a(e,t+8,i),note:"\u517C\u5BB9\u54C1\u724C"});return}if((a==="mvhd"||a==="mdhd")&&t+20<=i){let l=e[t]??0;n.push({offset:t,size:1,depth:r,treePrefix:s,kind:"field",field:"Version",value:String(l),note:"\u7248\u672C"}),n.push({offset:t+1,size:3,depth:r,treePrefix:s,kind:"field",field:"Flags",value:`0x${We(e,t+1,t+4)}`,note:"\u6807\u5FD7"}),l===1&&t+32<=i?(n.push({offset:t+20,size:4,depth:r,treePrefix:s,kind:"field",field:"Timescale",value:String(H(e,t+20)),note:"\u65F6\u95F4\u523B\u5EA6"}),n.push({offset:t+24,size:8,depth:r,treePrefix:s,kind:"field",field:"Duration",value:Ve(e,t+24).toString(),note:"\u65F6\u957F\u5355\u4F4D\u6570"})):t+20<=i&&(n.push({offset:t+12,size:4,depth:r,treePrefix:s,kind:"field",field:"Timescale",value:String(H(e,t+12)),note:"\u65F6\u95F4\u523B\u5EA6"}),n.push({offset:t+16,size:4,depth:r,treePrefix:s,kind:"field",field:"Duration",value:String(H(e,t+16)),note:"\u65F6\u957F\u5355\u4F4D\u6570"}));return}if(a==="hdlr"&&t+12<=i){n.push({offset:t,size:1,depth:r,treePrefix:s,kind:"field",field:"Version",value:String(e[t]??0),note:"\u7248\u672C"}),n.push({offset:t+8,size:4,depth:r,treePrefix:s,kind:"field",field:"HandlerType",value:S(e,t+8,t+12),note:"\u5904\u7406\u5668\u7C7B\u578B"});return}a==="stsd"&&t+16<=i&&(n.push({offset:t,size:1,depth:r,treePrefix:s,kind:"field",field:"Version",value:String(e[t]??0),note:"\u7248\u672C"}),n.push({offset:t+4,size:4,depth:r,treePrefix:s,kind:"field",field:"EntryCount",value:String(H(e,t+4)),note:"\u6837\u672C\u63CF\u8FF0\u6570\u91CF"}),n.push({offset:t+12,size:4,depth:r,treePrefix:s,kind:"field",field:"SampleEntryType",value:S(e,t+12,t+16),note:"\u6837\u672C\u7C7B\u578B"}))}function Na(n){if(n.byteLength<7||n[0]!==255||((n[1]??0)&240)!==240)return;let e=n[1]&1,a=n[2]>>6&3,t=n[2]>>2&15,i=(n[2]&1)<<2|n[3]>>6&3,r=(n[3]&3)<<11|n[4]<<3|n[5]>>5&7,o=(n[5]&31)<<6|n[6]>>2&63,s=n[6]&3;return{format:"AAC / ADTS",rows:[{offset:0,size:2,bits:"0-11 (12 bit)",field:"ADTS.Syncword",value:"0xfff",note:"\u540C\u6B65\u5B57"},{offset:1,size:1,bits:"12 (1 bit)",field:"ADTS.MpegVersion",value:(n[1]>>3&1)===0?"MPEG-4":"MPEG-2",note:"MPEG \u7248\u672C"},{offset:1,size:1,bits:"13-14 (2 bit)",field:"ADTS.Layer",value:String(n[1]>>1&3),note:"\u5C42"},{offset:1,size:1,bits:"15 (1 bit)",field:"ADTS.ProtectionAbsent",value:String(e),note:"CRC \u662F\u5426\u7701\u7565"},{offset:2,size:1,bits:"16-17 (2 bit)",field:"ADTS.Profile",value:`${a} (${Xa(a)})`,note:"AAC profile"},{offset:2,size:1,bits:"18-21 (4 bit)",field:"ADTS.SamplingFrequencyIndex",value:`${t} (${Ya(t)})`,note:"\u91C7\u6837\u7387\u7D22\u5F15"},{offset:2,size:2,bits:"23-25 (3 bit)",field:"ADTS.ChannelConfiguration",value:String(i),note:"\u58F0\u9053\u914D\u7F6E"},{offset:3,size:3,bits:"30-42 (13 bit)",field:"ADTS.FrameLength",value:`${r} B`,note:"ADTS \u5E27\u957F\u5EA6"},{offset:5,size:2,bits:"43-53 (11 bit)",field:"ADTS.BufferFullness",value:String(o),note:"\u7F13\u51B2 fullness"},{offset:6,size:1,bits:"54-55 (2 bit)",field:"ADTS.RawDataBlocks",value:String(s),note:"\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5"}]}}function Va(n){let e=[],a=0;if(n.byteLength>=10&&S(n,0,3)==="ID3"){let t=Oa(n,6);e.push({offset:0,size:3,field:"ID3.Identifier",value:"ID3",note:"ID3v2 \u6807\u8BC6"}),e.push({offset:3,size:2,field:"ID3.Version",value:`${n[3]??0}.${n[4]??0}`,note:"ID3 \u7248\u672C"}),e.push({offset:5,size:1,field:"ID3.Flags",value:`0x${(n[5]??0).toString(16)}`,note:"\u6807\u5FD7"}),e.push({offset:6,size:4,field:"ID3.Size",value:`${t} B`,note:"\u6807\u7B7E\u957F\u5EA6"}),a=10+t}for(;a+4<=n.byteLength&&!(n[a]===255&&((n[a+1]??0)&224)===224);)a+=1;return a+4>n.byteLength?e.length>0?{format:"MP3",rows:e}:void 0:(e.push({offset:a,size:2,bits:"frame 0-10 (11 bit)",field:"MPEG.Sync",value:"0x7ff",note:"\u5E27\u540C\u6B65"}),e.push({offset:a+1,size:1,bits:"frame 11-12 (2 bit)",field:"MPEG.Version",value:Ja(n[a+1]>>3&3),note:"MPEG \u97F3\u9891\u7248\u672C"}),e.push({offset:a+1,size:1,bits:"frame 13-14 (2 bit)",field:"MPEG.Layer",value:Qa(n[a+1]>>1&3),note:"Layer"}),e.push({offset:a+1,size:1,bits:"frame 15 (1 bit)",field:"MPEG.ProtectionBit",value:String(n[a+1]&1),note:"CRC \u6807\u5FD7"}),e.push({offset:a+2,size:1,bits:"frame 16-19 (4 bit)",field:"MPEG.BitrateIndex",value:String(n[a+2]>>4&15),note:"\u7801\u7387\u7D22\u5F15"}),e.push({offset:a+2,size:1,bits:"frame 20-21 (2 bit)",field:"MPEG.SamplingRateIndex",value:String(n[a+2]>>2&3),note:"\u91C7\u6837\u7387\u7D22\u5F15"}),e.push({offset:a+3,size:1,bits:"frame 24-25 (2 bit)",field:"MPEG.ChannelMode",value:et(n[a+3]>>6&3),note:"\u58F0\u9053\u6A21\u5F0F"}),{format:"MP3",rows:e})}function S(n,e,a){let t="";for(let i=e;i<a;i+=1)t+=String.fromCharCode(n[i]??0);return t}function We(n,e,a){let t="";for(let i=e;i<a;i+=1)t+=(n[i]??0).toString(16).padStart(2,"0");return t}function Le(n,e){return(n[e]??0)<<8|(n[e+1]??0)}function Ne(n,e){return(n[e]??0)|(n[e+1]??0)<<8}function Ga(n,e){let a=Ne(n,e);return a>=32768?a-65536:a}function oe(n,e){return(n[e]??0)<<16|(n[e+1]??0)<<8|(n[e+2]??0)}function H(n,e){return(n[e]??0)*16777216+((n[e+1]??0)<<16|(n[e+2]??0)<<8|(n[e+3]??0))}function se(n,e){return(n[e]??0)|(n[e+1]??0)<<8|(n[e+2]??0)<<16|(n[e+3]??0)*16777216}function Ve(n,e){return BigInt(n[e]??0)<<56n|BigInt(n[e+1]??0)<<48n|BigInt(n[e+2]??0)<<40n|BigInt(n[e+3]??0)<<32n|BigInt(n[e+4]??0)<<24n|BigInt(n[e+5]??0)<<16n|BigInt(n[e+6]??0)<<8n|BigInt(n[e+7]??0)}function Oa(n,e){return(n[e]&127)<<21|(n[e+1]&127)<<14|(n[e+2]&127)<<7|n[e+3]&127}function ja(n,e,a){let t=0;for(let i=e;i<a;i+=1)t+=n[i]??0;return t}function Ua(n){return["STREAMINFO","PADDING","APPLICATION","SEEKTABLE","VORBIS_COMMENT","CUESHEET","PICTURE"][n]??`BLOCK_${n}`}function Za(n){let e=[];return(n&1)!==0&&e.push("continued"),(n&2)!==0&&e.push("first"),(n&4)!==0&&e.push("last"),e.length?`${n} (${e.join(", ")})`:String(n)}function Ka(n){return/^[A-Za-z0-9 _-]{4}$/.test(n)}function _a(n){return["moov","trak","mdia","minf","stbl","edts","udta","meta","ilst"].includes(n)}function $a(n,e,a){let t=[];for(let i=e;i+4<=a;i+=4)t.push(S(n,i,i+4));return t.join(", ")}function Xa(n){return["Main","LC","SSR","Reserved"][n]??"Unknown"}function Ya(n){return["96000 Hz","88200 Hz","64000 Hz","48000 Hz","44100 Hz","32000 Hz","24000 Hz","22050 Hz","16000 Hz","12000 Hz","11025 Hz","8000 Hz","7350 Hz"][n]??"reserved"}function Ja(n){return["MPEG 2.5","reserved","MPEG 2","MPEG 1"][n]??"unknown"}function Qa(n){return["reserved","Layer III","Layer II","Layer I"][n]??"unknown"}function et(n){return["Stereo","Joint stereo","Dual channel","Single channel"][n]??"unknown"}function m(n,e){let a=document.querySelector(n);if(!(a instanceof e))throw new Error(`Missing element: ${n}`);return a}function B(n){let e=n.getBoundingClientRect(),a=window.devicePixelRatio||1,t=Math.max(1,Math.floor(e.width*a)),i=Math.max(1,Math.floor(e.height*a));(n.width!==t||n.height!==i)&&(n.width=t,n.height=i);let r=n.getContext("2d",{alpha:!1});if(!r)throw new Error("Canvas 2D context unavailable");return r}function le(n){let e=Math.floor(n/60),a=Math.floor(n%60),t=Math.floor((n-Math.floor(n))*1e3);return`${e}:${String(a).padStart(2,"0")}.${String(t).padStart(3,"0")}`}function de(n){if(n<1024)return`${n} B`;let e=["KB","MB","GB"],a=n/1024,t=0;for(;a>=1024&&t<e.length-1;)a/=1024,t+=1;return`${a.toFixed(a>=10?1:2)} ${e[t]}`}function f(n,e,a){return Math.max(e,Math.min(a,n))}var Ge={waitingAudioFile:"Warte auf Audiodatei",initializing:"Initialisierung",spectrogramSettings:"Spectrogram-Einstellungen",playPause:"Wiedergabe / Pause",playbackPosition:"Wiedergabeposition",closeSettings:"Einstellungen schliessen",spectrogramDisplay:"Spectrogram-Anzeige",algorithmFrequency:"Frequenz",windowSize:"Fenstergroesse",windowType:"Fenstertyp",windowRectangular:"Rechteck",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gauss (\u03B1=2.5)",windowGaussian35:"Gauss (\u03B1=3.5)",windowGaussian45:"Gauss (\u03B1=4.5)",zeroPaddingFactor:"Null-Padding-Faktor",frequencyScale:"Frequenzskala",frequencyRange:"Frequenzbereich (nur Anzeige)",minFrequencyHz:"Min. Frequenz (Hz)",maxFrequencyHz:"Max. Frequenz (Hz)",maxFrequencyNyquist:"Max folgt Nyquist",spectrogramAppearance:"Spectrogram-Darstellung",palette:"Palette",paletteRose:"Rose",paletteClassic:"Klassisch",paletteGrayscale:"Graustufen",paletteInverseGrayscale:"Inverse Graustufen",minDb:"Min. dB (Helligkeit)",maxDb:"Max. dB (Helligkeit)",autoBrightness:"Auto-Helligkeit",amplitudeRange:"Amplitudenbereich (Wellenform)",minAmplitude:"Min. Amplitude",maxAmplitude:"Max. Amplitude",amplitudeAuto:"Auto (pro Kanal)",channel:"Kanal",timeZoom:"Zeitzoom",timePosition:"Zeitposition",mouseWheel:"Mausrad",help:"Hilfe",downloadAudio:"Audio herunterladen",downloadSelection:"Auswahl herunterladen",downloadSelectionWav:"Auswahl als WAV herunterladen",clearSelection:"Auswahl loeschen",noSelectionToDownload:"Keine Audioauswahl zum Herunterladen",headerInfo:"Header-Info",headerInfoTitle:"Header-Info",headerInfoAudioUnread:"Audiodaten wurden noch nicht gelesen.",headerInfoUnsupported:"Header-Parsing wird f\xFCr dieses Format noch nicht unterst\xFCtzt.",headerInfoOffset:"Offset",headerInfoByteOffset:"Byte-Offset",headerInfoSize:"L\xE4nge",headerInfoBits:"Bits",headerInfoField:"Feld",headerInfoValue:"Wert",headerInfoDescription:"Beschreibung",headerInfoWavMissingData:"data-Chunk nicht gefunden",headerInfoWavCannotDetermine:"WAV-Headerl\xE4nge kann nicht bestimmt werden.",headerInfoWavHeaderLength:"WAV-Headerl\xE4nge {size} B",headerInfoWavStandardPcm:"Standardm\xE4\xDFiger 44-Byte-PCM-Header.",headerInfoWavNonStandardPrefix:"Nicht standardm\xE4\xDFiger 44-Byte-PCM-Header",headerInfoWavFmtExtended:"fmt-Chunk ist {size} B gro\xDF und enth\xE4lt erweiterte Formatfelder",headerInfoWavFormat:"Audioformat ist {format} ({name})",headerInfoWavExtraChunks:"zus\xE4tzliche Chunks vor data: {chunks}",headerInfoWavDataOffsetNon44:"data beginnt nicht bei Offset 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"ARK-Offset",settings:"Einstellungen",pcmReadAs:"Als PCM lesen",pcmParams:"PCM-Dateiparameter",editPcmParams:"Parameter bearbeiten",wavPcmRead:"WAV als PCM lesen",currentFileOnly:"Nur aktuelle Datei",sampleRate:"Abtastrate",channels:"Kan\xE4le",startOffsetBytes:"Offset (B)",bitDepth:"Kodierung",sampleFormat:"Format",endianness:"Byte order",read:"Lesen",saveDefault:"Standard speichern",cancel:"Abbrechen",defaultView:"Standardansicht",view:"Ansicht",viewBoth:"Mehrfachansicht",mute:"Stumm",solo:"Solo",timeLabel:"Zeit",helpTimeZoom:"Zeitzoom",helpTimePan:"Zeit verschieben",helpAmplitudeZoom:"Amplitudenzoom",helpRightClick:"Rechtsklick",helpPinch:"Pinch",helpHorizontalSwipe:"Horizontal wischen",helpDoubleClick:"Doppelklick",helpPlaybackGroup:"Wiedergabe & Auswahl",helpViewGroup:"Ansichtsnavigation",helpMouseGroup:"Maus & Trackpad",helpGainGroup:"Gain & Panorama",helpPlayPause:"Wiedergabe / Pause",helpClearSelection:"Men\xFC schlie\xDFen, Auswahl l\xF6schen oder Wiedergabecursor zur\xFCcksetzen",helpResetTimeZoom:"Zeitzoom zur\xFCcksetzen",helpTrackpadZoom:"Mit Trackpad-Pinch die Zeit zoomen",helpTrackpadPan:"Horizontaler Trackpad-Swipe verschiebt die Zeit",helpGainReset:"Gain- oder Panorama-Regler doppelklicken, um ihn zur\xFCckzusetzen",helpSelectionPlayback:"Wellenform oder Spektrogramm ziehen, um einen Bereich auszuw\xE4hlen. Bei aktiver Auswahl wird nur dieser Bereich abgespielt.",refreshSpectrogram:"Spectrogram aktualisieren",resetView:"Ansicht zuruecksetzen",selectionAnalysis:"Auswahlanalyse",selectionStart:"Start",selectionEnd:"Ende",selectionDuration:"Dauer",rmsLevel:"RMS-Pegel",peakLevel:"Peak-Pegel",dominant:"Dominant",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"Noise Floor",spectralCentroid:"Zentroid",zeroCrossingRate:"ZCR",basicMetrics:"Basiswerte",selectionAnalysisHelp:`Auswahlanalyse:
Analysiert den ausgew\xE4hlten Zeitbereich und hilft bei Pegel, Dynamik, Clipping-Risiko, Noise Floor und Frequenzverteilung.

Umfang:
Die Ergebnisse werden nur f\xFCr den aktiven Kanal berechnet; Kan\xE4le werden nicht gemischt.

Kanal wechseln:
Klicken Sie auf eine Spur, um sie aktiv zu machen.`,rmsLevelHelp:`RMS-Pegel:
Zeigt die mittlere Energie des ausgew\xE4hlten Bereichs. Stabiler als Peak und n\xFCtzlich, um zu leise oder zu laute Sprache zu erkennen.`,peakLevelHelp:`Peak-Pegel:
Zeigt den h\xF6chsten Momentanpegel im ausgew\xE4hlten Bereich. N\xFCtzlich f\xFCr N\xE4he zu 0 dBFS und Clipping-Risiko.`,dominantHelp:`Dominante Frequenz:
Die FFT-Bin-Frequenz mit der h\xF6chsten aufsummierten Leistung im ausgew\xE4hlten Bereich. Nicht zwingend Grundfrequenz oder wahrgenommene Tonh\xF6he.`,crestFactorHelp:`Crest Factor:
Verh\xE4ltnis von Peak zu RMS. Gr\xF6\xDFere Werte bedeuten st\xE4rkere Peaks gegen\xFCber der mittleren Energie.`,clippingRatioHelp:`Clipping-Anteil:
Prozentualer Anteil von Samples nahe Full Scale. Hilft, \xDCbersteuerung und digitales Clipping schnell zu erkennen.`,noiseFloorHelp:`Noise Floor:
Sch\xE4tzung aus einem niedrigen Perzentil kurzer RMS-Fenster. Bei \xFCberwiegend Sprache oder Musik kann der Wert vom echten Noise Floor abweichen.`,spectralCentroidHelp:`Spektraler Zentroid:
Schwerpunkt der spektralen Energie in Hz. Hilft einzusch\xE4tzen, ob ein Klang eher hell oder dunkel ist.`,zeroCrossingRateHelp:`Zero-Crossing-Rate:
Rate der Vorzeichenwechsel. Eine einfache Zeitbereichsgr\xF6\xDFe f\xFCr hochfrequentes Rauschen, unvoiced speech und Frikative.`,frequencyAnalysis:"Frequenzanalyse",frequencyAnalysisHelp:`Bedeutung:
Linearer Energieanteil pro Frequenzband. Es ist kein RMS-Pegel und kein dB-Wert.

Berechnung:
Der ausgew\xE4hlte Bereich wird in Frames mit 50% \xDCberlappung geteilt. FFT-Bin-Leistung wird aufsummiert und auf Frequenzb\xE4nder verteilt.`,selectionAnalysisCalculating:"Wird berechnet...",bands:"Baender",waveform:"Wellenform",spectrogram:"Spectrogram",adjustWaveformHeight:"Wellenformhoehe anpassen",adjustSpectrogramHeight:"Spectrogram-Hoehe anpassen",ready:"Bereit",workspaceNotTrusted:"Arbeitsbereich nicht vertrauenswuerdig; Audioinhalte werden nicht uebertragen",fileTooLarge:"Datei ueberschreitet Limit",readingAudio:"Audio wird gelesen",readingAudioProgress:"Audio wird gelesen",decodingAudio:"Audio wird decodiert",transcodingAudio:"Audio wird mit FFmpeg transcodiert",encodedPlaybackOnly:"Die Audiodekodierung ist fehlgeschlagen.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"Warte auf PCM-Parameter",pcmUsedDefaultParams:"Mit Standard-PCM-Parametern geladen.",pcmFillParams:"PCM-Parameter ausf\xFCllen und dann Lesen klicken.",wavPcmFillParams:"Parameter ausf\xFCllen und Lesen klicken, um die aktuelle WAV als PCM zu parsen.",currentPcmFormat:"Aktuell",savedDefaultPcmFormat:"Gespeicherter Standard",audioLoaded:"Audio geladen",audioNotReady:"Audio ist nicht bereit",audioCannotPlay:"Dieses Audio kann im Webview nicht abgespielt werden",playbackFailed:"Wiedergabe fehlgeschlagen",analyzingSpectrogram:"Spectrogram wird analysiert",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens-Initialisierung fehlgeschlagen",trackGain:"Gain",trackPan:"Panorama",panLeft:"L",panRight:"R",panCenter:"M",doubleClickReset:"Doppelklick zum Zur\xFCcksetzen",freqScaleMenuTitle:"Kanal-Frequenzskala",restoreChannelDefault:"Kanal-Standard wiederherstellen",helpAxisGroup:"Vertikale Achse",helpAxisZoom:"Strg + Rad / Pinch auf einer Achse: diese Achse zoomen (pro Kanal)",helpAxisPan:"Umschalt + Rad / horizontales Wischen auf einer Achse: diese Achse verschieben (pro Kanal)",helpAxisAlt:"Alt + Rad auf einer Wellenform: Amplitude des Kanals zoomen",helpAxisScaleMenu:"Rechtsklick auf die Frequenzachse: Skala dieses Kanals festlegen",helpAxisReset:"Doppelklick auf eine Achse: Kanal-Standard wiederherstellen"};var ce={waitingAudioFile:"Waiting for audio file",initializing:"Initializing",spectrogramSettings:"Spectrogram settings",help:"Help",downloadAudio:"Download audio",downloadSelection:"Download Selection",downloadSelectionWav:"Download selection as WAV",clearSelection:"Clear selection",noSelectionToDownload:"No audio selection to download",headerInfo:"Header info",headerInfoTitle:"Header info",headerInfoAudioUnread:"Audio data has not been read.",headerInfoUnsupported:"Header parsing is not supported for this format yet.",headerInfoOffset:"Offset",headerInfoByteOffset:"Byte Offset",headerInfoSize:"Size",headerInfoBits:"Bits",headerInfoField:"Field",headerInfoValue:"Value",headerInfoDescription:"Description",headerInfoWavMissingData:"data chunk not found",headerInfoWavCannotDetermine:"Cannot determine WAV header length.",headerInfoWavHeaderLength:"WAV header length {size} B",headerInfoWavStandardPcm:"Standard 44-byte PCM header.",headerInfoWavNonStandardPrefix:"Non-44-byte PCM header",headerInfoWavFmtExtended:"fmt chunk is {size} B and contains extended format fields",headerInfoWavFormat:"audio format is {format} ({name})",headerInfoWavExtraChunks:"extra chunk(s) before data: {chunks}",headerInfoWavDataOffsetNon44:"data starts at an offset other than 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"ARK offset",settings:"Settings",playPause:"Play / pause",playbackPosition:"Playback position",closeSettings:"Close settings",spectrogramDisplay:"Spectrogram display",algorithmFrequency:"Frequency",windowSize:"Window size",windowType:"Window type",windowRectangular:"Rectangular",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"Zero padding factor",frequencyScale:"Frequency scale",frequencyRange:"Frequency range (display only)",minFrequencyHz:"Min frequency (Hz)",maxFrequencyHz:"Max frequency (Hz)",maxFrequencyNyquist:"Max follows Nyquist",spectrogramAppearance:"Spectrogram appearance",palette:"Palette",paletteRose:"Rose",paletteClassic:"Classic",paletteGrayscale:"Grayscale",paletteInverseGrayscale:"Inverse grayscale",minDb:"Min dB (brightness)",maxDb:"Max dB (brightness)",autoBrightness:"Auto brightness",amplitudeRange:"Amplitude range (waveform)",minAmplitude:"Min amplitude",maxAmplitude:"Max amplitude",amplitudeAuto:"Auto (fit each channel)",channel:"Channel",timeZoom:"Time zoom",timePosition:"Time position",mouseWheel:"Mouse wheel",refreshSpectrogram:"Refresh spectrogram",resetView:"Reset view",pcmReadAs:"Read as PCM",pcmParams:"PCM file parameters",editPcmParams:"Edit parameters",wavPcmRead:"Read WAV as PCM",currentFileOnly:"Current file only",sampleRate:"Sample rate",channels:"Channels",startOffsetBytes:"Offset (B)",bitDepth:"Encoding",sampleFormat:"Format",endianness:"Byte order",read:"Read",saveDefault:"Save default",cancel:"Cancel",defaultView:"Default view",view:"View",viewBoth:"Multi-view",mute:"Mute",solo:"Solo",timeLabel:"Time",helpTimeZoom:"Time zoom",helpTimePan:"Time pan",helpAmplitudeZoom:"Amplitude zoom",helpRightClick:"Right click",helpPinch:"Pinch",helpHorizontalSwipe:"Horizontal swipe",helpDoubleClick:"Double click",helpPlaybackGroup:"Playback & selection",helpViewGroup:"View navigation",helpMouseGroup:"Mouse & trackpad",helpGainGroup:"Gain & pan",helpPlayPause:"Play / pause",helpClearSelection:"Close menu, clear selection, or reset playback cursor",helpResetTimeZoom:"Reset time zoom",helpTrackpadZoom:"Pinch on trackpad to zoom time",helpTrackpadPan:"Horizontal trackpad swipe pans time",helpGainReset:"Double-click a channel's gain or pan slider to reset it",helpSelectionPlayback:"Drag waveform or spectrogram to select a segment. Playing with a selection active only plays that range.",selectionAnalysis:"Selection analysis",selectionAnalysisHelp:`Selection analysis:
Quickly analyzes the selected time range to help inspect recording level, dynamic range, clipping risk, noise floor, and frequency distribution.

Scope:
Results are calculated for the active channel only; channels are not mixed.

Switch channel:
Click a track to make it active. RMS, Peak, Dominant, and frequency analysis then use that channel.`,basicMetrics:"Basic metrics",selectionStart:"Start",selectionEnd:"End",selectionDuration:"Duration",rmsLevel:"RMS Level",peakLevel:"Peak Level",dominant:"Dominant",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"Noise floor",spectralCentroid:"Centroid",zeroCrossingRate:"ZCR",rmsLevelHelp:`RMS Level:
Calculation:
rms = sqrt(mean(sample\xB2))
rmsDb = 20 \xD7 log10(rms)

Use:
Shows average energy/loudness trend for the selected region. More stable than peak, useful for checking speech that is too quiet or too loud.

Limit:
RMS is not LUFS; it has no perceptual weighting or gating. Very long selections are sampled evenly to keep the UI responsive.

References:
MathWorks rms; librosa.feature.rms; Audacity Measure RMS.`,peakLevelHelp:`Peak Level:
Calculation:
peak = max(abs(sample))
peakDb = 20 \xD7 log10(peak)

Use:
Shows the highest instantaneous level in the selection. Useful for checking whether audio is close to 0 dBFS or at clipping risk.

Limit:
Peak only reflects the maximum instant, not overall loudness. Very long selections are sampled evenly to keep the UI responsive.

References:
Adobe Audition Amplitude Statistics; Audacity Amplify; AES17 0 dBFS.`,dominantHelp:`Dominant Frequency:
The FFT frequency bin with the highest accumulated power over the selected region.

Bin mapping:
For bin k:
freq = k \xD7 sampleRate / FFT size

Power:
For each frame:
power = re\xB2 + im\xB2

Selection accumulation:
binPower[k] += power

Result:
dominantHz = k \xD7 sampleRate / FFT size, where k has max binPower.

Meaning:
It is not necessarily the fundamental frequency or perceived pitch. Frequency resolution is sampleRate / FFT size.

References:
NumPy fftfreq; librosa spectral features.`,crestFactorHelp:`Crest Factor:
The ratio between peak and RMS.

Calculation:
crest = peak / rms
crestDb = peakDb - rmsDb

Use:
Shows dynamic range and transient strength. Larger values mean peaks stand out more from average energy.

Limit:
Unstable for silence or very low-level audio. It describes dynamics but does not directly judge quality.

References:
MathWorks peak2rms; Signal Processing Toolbox descriptive statistics.`,clippingRatioHelp:`Clipping Ratio:
The percentage of samples close to full scale.

Calculation:
clippingRatio = count(abs(sample) >= 0.999) / measuredSamples \xD7 100%

Use:
Quickly detects digital full-scale samples, recording overload, or hard clipping risk.

Limit:
Audio may already be limited or distorted before AudioLens; it can sound distorted even without full-scale samples.

References:
Audacity Find Clipping; Adobe Audition Amplitude Statistics; Netflix AudioClippingInspector.`,noiseFloorHelp:`Noise Floor:
Estimated from a low percentile of short-time RMS levels in quieter parts of the selection.

Calculation:
1. Split the selection into about 20 ms windows with 50% overlap.
2. Compute RMS for each window.
3. Use the 10th percentile RMS and convert it to dBFS.

Use:
Estimates background noise, silence cleanliness, and recording environment noise.

Limit:
This is an unsupervised estimate. If the selection is mostly speech or music, it may not equal the true noise floor.

References:
Adobe Audition Minimum RMS; librosa.feature.rms; Audacity Noise Reduction.`,spectralCentroidHelp:`Spectral Centroid:
The center of mass of spectral energy, in Hz.

Calculation:
centroid = sum(freq[k] \xD7 power[k]) / sum(power[k])

Use:
Indicates whether the sound is brighter or darker. Speech with more high-frequency content usually has a higher centroid.

Limit:
Affected by noise, sibilance, and bandwidth. It is not pitch and cannot alone judge clarity.

References:
librosa.feature.spectral_centroid; MathWorks spectralCentroid.`,zeroCrossingRateHelp:`Zero Crossing Rate:
The rate at which the signal changes sign.

Calculation:
zeroCrossingRate = zeroCrossings / durationSeconds

Use:
A rough time-domain feature for high-frequency noise, unvoiced speech, and fricatives.

Limit:
Sensitive to noise and DC offset. It is not the same as frequency or pitch.

References:
librosa.feature.zero_crossing_rate; librosa.zero_crossings.`,frequencyAnalysis:"Frequency analysis",frequencyAnalysisHelp:`Meaning:
Linear energy percentage by frequency band. It is not RMS level and not dB.

Calculation:
1. Sample the active channel in the selection.
2. Use the current window function and FFT size, split the full selection into frames with 50% overlap.
3. Each bin power is re\xB2 + im\xB2.
4. Accumulate bin power across all frames and assign bins into frequency bands.
5. Display bandPower / totalPower \xD7 100%.

Note:
This is a multi-frame spectral energy distribution for the whole selection; it is still not dB/RMS.`,selectionAnalysisCalculating:"Calculating...",bands:"Bands",waveform:"Waveform",spectrogram:"Spectrogram",adjustWaveformHeight:"Adjust waveform height",adjustSpectrogramHeight:"Adjust spectrogram height",ready:"Ready",workspaceNotTrusted:"Workspace not trusted; audio content is not transferred",fileTooLarge:"File exceeds limit",readingAudio:"Reading audio",readingAudioProgress:"Reading audio",decodingAudio:"Decoding audio",transcodingAudio:"Transcoding audio with FFmpeg",encodedPlaybackOnly:"Audio decoding failed.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"Waiting for PCM parameters",pcmUsedDefaultParams:"Loaded with default PCM parameters.",pcmFillParams:"Fill PCM parameters, then click Read.",wavPcmFillParams:"Fill parameters, then click Read to parse the current WAV as PCM.",currentPcmFormat:"Current",savedDefaultPcmFormat:"Saved default",audioLoaded:"Audio loaded",audioNotReady:"Audio is not ready",audioCannotPlay:"This audio cannot be played in the webview",playbackFailed:"Playback failed",analyzingSpectrogram:"Analyzing spectrogram",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens initialization failed",trackGain:"Gain",trackPan:"Pan",panLeft:"L",panRight:"R",panCenter:"C",doubleClickReset:"Double-click to reset",freqScaleMenuTitle:"Channel frequency scale",restoreChannelDefault:"Restore channel default",helpAxisGroup:"Vertical axis",helpAxisZoom:"Ctrl + wheel / pinch on an axis: zoom that axis (per channel)",helpAxisPan:"Shift + wheel / horizontal swipe on an axis: pan that axis (per channel)",helpAxisAlt:"Alt + wheel on a waveform: zoom that channel's amplitude",helpAxisScaleMenu:"Right-click the frequency axis: set this channel's scale",helpAxisReset:"Double-click an axis: restore this channel's default"};var Oe={waitingAudioFile:"Esperando archivo de audio",initializing:"Inicializando",spectrogramSettings:"Ajustes del espectrograma",playPause:"Reproducir / pausar",playbackPosition:"Posici\xF3n de reproducci\xF3n",closeSettings:"Cerrar ajustes",spectrogramDisplay:"Vista del espectrograma",algorithmFrequency:"Frecuencia",windowSize:"Tama\xF1o de ventana",windowType:"Tipo de ventana",windowRectangular:"Rectangular",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussiana (\u03B1=2.5)",windowGaussian35:"Gaussiana (\u03B1=3.5)",windowGaussian45:"Gaussiana (\u03B1=4.5)",zeroPaddingFactor:"Factor de relleno cero",frequencyScale:"Escala de frecuencia",frequencyRange:"Rango de frecuencia (solo visual)",minFrequencyHz:"Frecuencia m\xEDn. (Hz)",maxFrequencyHz:"Frecuencia m\xE1x. (Hz)",maxFrequencyNyquist:"M\xE1x. sigue Nyquist",spectrogramAppearance:"Apariencia del espectrograma",palette:"Paleta",paletteRose:"Rosa",paletteClassic:"Cl\xE1sica",paletteGrayscale:"Escala de grises",paletteInverseGrayscale:"Grises invertidos",minDb:"dB m\xEDn. (brillo)",maxDb:"dB m\xE1x. (brillo)",autoBrightness:"Brillo autom\xE1tico",amplitudeRange:"Rango de amplitud (onda)",minAmplitude:"Amplitud m\xEDn",maxAmplitude:"Amplitud m\xE1x",amplitudeAuto:"Auto (por canal)",channel:"Canal",timeZoom:"Zoom de tiempo",timePosition:"Posici\xF3n temporal",mouseWheel:"Rueda del rat\xF3n",help:"Ayuda",downloadAudio:"Descargar audio",downloadSelection:"Descargar selecci\xF3n",downloadSelectionWav:"Descargar selecci\xF3n como WAV",clearSelection:"Borrar selecci\xF3n",noSelectionToDownload:"No hay selecci\xF3n de audio para descargar",headerInfo:"Informaci\xF3n de cabecera",headerInfoTitle:"Informaci\xF3n de cabecera",headerInfoAudioUnread:"Los datos de audio a\xFAn no se han le\xEDdo.",headerInfoUnsupported:"El an\xE1lisis de cabecera a\xFAn no es compatible con este formato.",headerInfoOffset:"Desplazamiento",headerInfoByteOffset:"Desplazamiento byte",headerInfoSize:"Longitud",headerInfoBits:"Bits",headerInfoField:"Campo",headerInfoValue:"Valor",headerInfoDescription:"Descripci\xF3n",headerInfoWavMissingData:"no se encontr\xF3 el chunk data",headerInfoWavCannotDetermine:"No se puede determinar la longitud de la cabecera WAV.",headerInfoWavHeaderLength:"Longitud de cabecera WAV {size} B",headerInfoWavStandardPcm:"Cabecera PCM est\xE1ndar de 44 bytes.",headerInfoWavNonStandardPrefix:"Cabecera PCM no est\xE1ndar de 44 bytes",headerInfoWavFmtExtended:"el chunk fmt mide {size} B e incluye campos de formato extendidos",headerInfoWavFormat:"el formato de audio es {format} ({name})",headerInfoWavExtraChunks:"chunk(s) extra antes de data: {chunks}",headerInfoWavDataOffsetNon44:"data comienza en un desplazamiento distinto de 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"Offset ARK",settings:"Ajustes",pcmReadAs:"Leer como PCM",pcmParams:"Par\xE1metros de archivo PCM",editPcmParams:"Editar par\xE1metros",wavPcmRead:"Leer WAV como PCM",currentFileOnly:"Solo archivo actual",sampleRate:"Frecuencia de muestreo",channels:"Canales",startOffsetBytes:"Desplazamiento (B)",bitDepth:"Codificaci\xF3n",sampleFormat:"Formato",endianness:"Byte order",read:"Leer",saveDefault:"Guardar predeterminado",cancel:"Cancelar",defaultView:"Vista predeterminada",view:"Vista",viewBoth:"Vista m\xFAltiple",mute:"Silenciar",solo:"Solo",timeLabel:"Tiempo",helpTimeZoom:"Zoom de tiempo",helpTimePan:"Desplazar tiempo",helpAmplitudeZoom:"Zoom de amplitud",helpRightClick:"Clic derecho",helpPinch:"Pellizcar",helpHorizontalSwipe:"Deslizamiento horizontal",helpDoubleClick:"Doble clic",helpPlaybackGroup:"Reproducci\xF3n y selecci\xF3n",helpViewGroup:"Navegaci\xF3n de vista",helpMouseGroup:"Rat\xF3n y trackpad",helpGainGroup:"Ganancia y panorama",helpPlayPause:"Reproducir / pausar",helpClearSelection:"Cerrar men\xFA, borrar selecci\xF3n o reiniciar cursor de reproducci\xF3n",helpResetTimeZoom:"Reiniciar zoom de tiempo",helpTrackpadZoom:"Pellizcar en el trackpad para ampliar el tiempo",helpTrackpadPan:"Deslizamiento horizontal del trackpad para mover el tiempo",helpGainReset:"Doble clic en un control de ganancia o panorama para restablecerlo",helpSelectionPlayback:"Arrastra la forma de onda o el espectrograma para seleccionar un segmento. Con una selecci\xF3n activa, solo se reproduce ese rango.",refreshSpectrogram:"Actualizar espectrograma",resetView:"Restablecer vista",selectionAnalysis:"An\xE1lisis de selecci\xF3n",selectionStart:"Inicio",selectionEnd:"Fin",selectionDuration:"Duraci\xF3n",rmsLevel:"Nivel RMS",peakLevel:"Nivel Peak",dominant:"Dominante",crestFactor:"Cresta",clippingRatio:"Clipping",noiseFloor:"Ruido base",spectralCentroid:"Centroide",zeroCrossingRate:"ZCR",basicMetrics:"M\xE9tricas b\xE1sicas",selectionAnalysisHelp:`An\xE1lisis de selecci\xF3n:
Analiza r\xE1pidamente el rango seleccionado para revisar nivel, rango din\xE1mico, riesgo de clipping, ruido base y distribuci\xF3n de frecuencias.

\xC1mbito:
Los resultados se calculan solo para el canal activo; no se mezclan canales.

Cambiar canal:
Haz clic en una pista para activarla.`,rmsLevelHelp:`Nivel RMS:
Muestra la energ\xEDa media de la selecci\xF3n. Es m\xE1s estable que el pico y ayuda a detectar voz demasiado baja o alta.`,peakLevelHelp:`Nivel pico:
Muestra el nivel instant\xE1neo m\xE1ximo de la selecci\xF3n. \xDAtil para revisar cercan\xEDa a 0 dBFS y riesgo de clipping.`,dominantHelp:`Frecuencia dominante:
Bin FFT con mayor potencia acumulada en la selecci\xF3n. No necesariamente es la fundamental ni el pitch percibido.`,crestFactorHelp:`Factor de cresta:
Relaci\xF3n entre pico y RMS. Valores mayores indican picos m\xE1s destacados respecto a la energ\xEDa media.`,clippingRatioHelp:`Proporci\xF3n de clipping:
Porcentaje de muestras cercanas a escala completa. Ayuda a detectar sobrecarga o clipping digital.`,noiseFloorHelp:`Ruido base:
Estimado a partir de un percentil bajo de RMS de ventanas cortas. Si la selecci\xF3n es sobre todo voz o m\xFAsica, puede no coincidir con el ruido real.`,spectralCentroidHelp:`Centroide espectral:
Centro de masa de la energ\xEDa espectral en Hz. Indica si el sonido tiende a ser m\xE1s brillante u oscuro.`,zeroCrossingRateHelp:`Tasa de cruces por cero:
Frecuencia con la que la se\xF1al cambia de signo. \xDAtil para ruido de alta frecuencia, habla no sonora y fricativas.`,frequencyAnalysis:"An\xE1lisis de frecuencia",frequencyAnalysisHelp:`Significado:
Porcentaje de energ\xEDa lineal por banda de frecuencia. No es nivel RMS ni dB.

C\xE1lculo:
La selecci\xF3n se divide en tramas con 50% de solape. Se acumula la potencia de bins FFT y se reparte por bandas.`,selectionAnalysisCalculating:"Calculando...",bands:"Bandas",waveform:"Forma de onda",spectrogram:"Espectrograma",adjustWaveformHeight:"Ajustar altura de forma de onda",adjustSpectrogramHeight:"Ajustar altura del espectrograma",ready:"Listo",workspaceNotTrusted:"\xC1rea no confiable; no se transfiere audio",fileTooLarge:"El archivo supera el l\xEDmite",readingAudio:"Leyendo audio",readingAudioProgress:"Leyendo audio",decodingAudio:"Decodificando audio",transcodingAudio:"Transcodificando audio con FFmpeg",encodedPlaybackOnly:"No se pudo decodificar el audio.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"Esperando par\xE1metros PCM",pcmUsedDefaultParams:"Cargado con par\xE1metros PCM predeterminados.",pcmFillParams:"Completa los par\xE1metros PCM y haz clic en Leer.",wavPcmFillParams:"Completa los par\xE1metros y haz clic en Leer para interpretar el WAV actual como PCM.",currentPcmFormat:"Actual",savedDefaultPcmFormat:"Predeterminado guardado",audioLoaded:"Audio cargado",audioNotReady:"El audio no est\xE1 listo",audioCannotPlay:"Este audio no se puede reproducir en el webview",playbackFailed:"Error de reproducci\xF3n",analyzingSpectrogram:"Analizando espectrograma",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"Error al inicializar AudioLens",trackGain:"Ganancia",trackPan:"Panorama",panLeft:"I",panRight:"D",panCenter:"C",doubleClickReset:"Doble clic para restablecer",freqScaleMenuTitle:"Escala de frecuencia del canal",restoreChannelDefault:"Restaurar valor del canal",helpAxisGroup:"Eje vertical",helpAxisZoom:"Ctrl + rueda / pellizco en un eje: zoom de ese eje (por canal)",helpAxisPan:"May\xFAs + rueda / deslizar horizontal en un eje: desplazar ese eje (por canal)",helpAxisAlt:"Alt + rueda en una onda: zoom de amplitud del canal",helpAxisScaleMenu:"Clic derecho en el eje de frecuencia: definir la escala del canal",helpAxisReset:"Doble clic en un eje: restaurar el valor del canal"};var je={waitingAudioFile:"En attente d'un fichier audio",initializing:"Initialisation",spectrogramSettings:"R\xE9glages du spectrogramme",playPause:"Lire / pause",playbackPosition:"Position de lecture",closeSettings:"Fermer les r\xE9glages",spectrogramDisplay:"Affichage du spectrogramme",algorithmFrequency:"Fr\xE9quence",windowSize:"Taille de fen\xEAtre",windowType:"Type de fen\xEAtre",windowRectangular:"Rectangulaire",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussienne (\u03B1=2.5)",windowGaussian35:"Gaussienne (\u03B1=3.5)",windowGaussian45:"Gaussienne (\u03B1=4.5)",zeroPaddingFactor:"Facteur de z\xE9ro-padding",frequencyScale:"\xC9chelle de fr\xE9quence",frequencyRange:"Plage de fr\xE9quences (affichage seul)",minFrequencyHz:"Fr\xE9quence min (Hz)",maxFrequencyHz:"Fr\xE9quence max (Hz)",maxFrequencyNyquist:"Max suit Nyquist",spectrogramAppearance:"Apparence du spectrogramme",palette:"Palette",paletteRose:"Couleur (rose)",paletteClassic:"Couleur (classique)",paletteGrayscale:"Niveaux de gris",paletteInverseGrayscale:"Gris invers\xE9s",minDb:"dB min (luminosit\xE9)",maxDb:"dB max (luminosit\xE9)",autoBrightness:"Luminosit\xE9 auto",amplitudeRange:"Plage d'amplitude (onde)",minAmplitude:"Amplitude min",maxAmplitude:"Amplitude max",amplitudeAuto:"Auto (par canal)",channel:"Canal",timeZoom:"Zoom temporel",timePosition:"Position temporelle",mouseWheel:"molette",help:"Aide",downloadAudio:"T\xE9l\xE9charger l'audio",downloadSelection:"T\xE9l\xE9charger la s\xE9lection",downloadSelectionWav:"T\xE9l\xE9charger la s\xE9lection en WAV",clearSelection:"Effacer la s\xE9lection",noSelectionToDownload:"Aucune s\xE9lection audio \xE0 t\xE9l\xE9charger",headerInfo:"Infos d'en-t\xEAte",headerInfoTitle:"Infos d'en-t\xEAte",headerInfoAudioUnread:"Les donn\xE9es audio n'ont pas encore \xE9t\xE9 lues.",headerInfoUnsupported:"L'analyse de l'en-t\xEAte n'est pas encore prise en charge pour ce format.",headerInfoOffset:"D\xE9calage",headerInfoByteOffset:"D\xE9calage octet",headerInfoSize:"Taille",headerInfoBits:"Bits",headerInfoField:"Champ",headerInfoValue:"Valeur",headerInfoDescription:"Description",headerInfoWavMissingData:"chunk data introuvable",headerInfoWavCannotDetermine:"Impossible de d\xE9terminer la longueur de l'en-t\xEAte WAV.",headerInfoWavHeaderLength:"Longueur de l'en-t\xEAte WAV {size} B",headerInfoWavStandardPcm:"En-t\xEAte PCM standard de 44 octets.",headerInfoWavNonStandardPrefix:"En-t\xEAte PCM non standard de 44 octets",headerInfoWavFmtExtended:"le chunk fmt fait {size} B et contient des champs de format \xE9tendus",headerInfoWavFormat:"le format audio est {format} ({name})",headerInfoWavExtraChunks:"chunk(s) suppl\xE9mentaire(s) avant data : {chunks}",headerInfoWavDataOffsetNon44:"data commence \xE0 un d\xE9calage diff\xE9rent de 44 B",headerInfoReasonSeparator:" ; ",arkOffsetLabel:"Offset ARK",settings:"R\xE9glages",pcmReadAs:"Lire en PCM",pcmParams:"Param\xE8tres du fichier PCM",editPcmParams:"Modifier les param\xE8tres",wavPcmRead:"Lire le WAV en PCM",currentFileOnly:"Fichier courant seulement",sampleRate:"Fr\xE9quence d'\xE9chantillonnage",channels:"Canaux",startOffsetBytes:"D\xE9calage (B)",bitDepth:"Encodage",sampleFormat:"Format",endianness:"Ordre des octets",read:"Lire",saveDefault:"Enregistrer par d\xE9faut",cancel:"Annuler",defaultView:"Vue par d\xE9faut",view:"Vue",viewBoth:"Vue mixte",mute:"Muet",solo:"Solo",timeLabel:"Temps",helpTimeZoom:"Zoom temporel",helpTimePan:"Pan temporel",helpAmplitudeZoom:"Zoom d'amplitude",helpRightClick:"Clic droit",helpPinch:"Pincer",helpHorizontalSwipe:"Balayage horizontal",helpDoubleClick:"Double-clic",helpPlaybackGroup:"Lecture et s\xE9lection",helpViewGroup:"Navigation",helpMouseGroup:"Souris et pav\xE9 tactile",helpGainGroup:"Gain et panoramique",helpPlayPause:"Lire / pause",helpClearSelection:"Fermer le menu, effacer la s\xE9lection ou r\xE9initialiser le curseur",helpResetTimeZoom:"R\xE9initialiser le zoom temporel",helpTrackpadZoom:"Pincer le pav\xE9 tactile pour zoomer le temps",helpTrackpadPan:"Balayage horizontal du pav\xE9 tactile pour d\xE9placer le temps",helpGainReset:"Double-cliquer un curseur de gain ou de panoramique pour le r\xE9initialiser",helpSelectionPlayback:"Faites glisser la forme d'onde ou le spectrogramme pour s\xE9lectionner un segment. Avec une s\xE9lection active, seule cette plage est lue.",refreshSpectrogram:"Actualiser le spectrogramme",resetView:"R\xE9initialiser la vue",selectionAnalysis:"Analyse de la s\xE9lection",selectionStart:"D\xE9but",selectionEnd:"Fin",selectionDuration:"Dur\xE9e",rmsLevel:"Niveau RMS",peakLevel:"Niveau Peak",dominant:"Dominante",crestFactor:"Cr\xEAte",clippingRatio:"\xC9cr\xEAtage",noiseFloor:"Bruit de fond",spectralCentroid:"Centro\xEFde",zeroCrossingRate:"ZCR",basicMetrics:"Mesures de base",selectionAnalysisHelp:`Analyse de la s\xE9lection:
Analyse rapidement la plage s\xE9lectionn\xE9e pour inspecter le niveau, la dynamique, le risque d'\xE9cr\xEAtage, le bruit de fond et la distribution fr\xE9quentielle.

Port\xE9e:
Les r\xE9sultats sont calcul\xE9s uniquement pour le canal actif; les canaux ne sont pas mix\xE9s.

Changer de canal:
Cliquez sur une piste pour la rendre active.`,rmsLevelHelp:`Niveau RMS:
Indique l'\xE9nergie moyenne de la s\xE9lection. Plus stable que le pic, utile pour rep\xE9rer une parole trop faible ou trop forte.`,peakLevelHelp:`Niveau cr\xEAte:
Indique le niveau instantan\xE9 le plus \xE9lev\xE9 de la s\xE9lection. Utile pour v\xE9rifier la proximit\xE9 de 0 dBFS et le risque d'\xE9cr\xEAtage.`,dominantHelp:`Fr\xE9quence dominante:
Bin FFT dont la puissance cumul\xE9e est la plus \xE9lev\xE9e dans la s\xE9lection. Ce n'est pas forc\xE9ment la fondamentale ni la hauteur per\xE7ue.`,crestFactorHelp:`Facteur de cr\xEAte:
Rapport entre le pic et le RMS. Une valeur \xE9lev\xE9e signifie que les pics ressortent davantage de l'\xE9nergie moyenne.`,clippingRatioHelp:`Taux d'\xE9cr\xEAtage:
Pourcentage d'\xE9chantillons proches du plein niveau. Permet de d\xE9tecter rapidement une surcharge ou un \xE9cr\xEAtage num\xE9rique.`,noiseFloorHelp:`Bruit de fond:
Estim\xE9 \xE0 partir d'un percentile bas des RMS court terme. Si la s\xE9lection contient surtout de la parole ou de la musique, il peut diff\xE9rer du vrai bruit de fond.`,spectralCentroidHelp:`Centro\xEFde spectral:
Centre de masse de l'\xE9nergie spectrale en Hz. Indique si le son est plut\xF4t clair ou sombre.`,zeroCrossingRateHelp:`Taux de passage par z\xE9ro:
Nombre de changements de signe par seconde. Indice temporel utile pour le bruit haute fr\xE9quence, les sons non vois\xE9s et les fricatives.`,frequencyAnalysis:"Analyse fr\xE9quentielle",frequencyAnalysisHelp:`Signification:
Pourcentage d'\xE9nergie lin\xE9aire par bande de fr\xE9quences. Ce n'est ni un niveau RMS ni un dB.

Calcul:
La s\xE9lection est d\xE9coup\xE9e en trames avec 50% de recouvrement. La puissance des bins FFT est cumul\xE9e puis r\xE9partie dans les bandes.`,selectionAnalysisCalculating:"Calcul en cours...",bands:"Bandes",waveform:"Forme d'onde",spectrogram:"Spectrogramme",adjustWaveformHeight:"Ajuster la hauteur de la forme d'onde",adjustSpectrogramHeight:"Ajuster la hauteur du spectrogramme",ready:"Pr\xEAt",workspaceNotTrusted:"Espace non fiable",fileTooLarge:"Fichier au-del\xE0 de la limite",readingAudio:"Lecture de l'audio",readingAudioProgress:"Lecture de l'audio",decodingAudio:"D\xE9codage de l'audio",transcodingAudio:"Transcodage audio avec FFmpeg",encodedPlaybackOnly:"Le d\xE9codage audio a \xE9chou\xE9.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"En attente des param\xE8tres PCM",pcmUsedDefaultParams:"Charg\xE9 avec les param\xE8tres PCM par d\xE9faut.",pcmFillParams:"Renseignez les param\xE8tres PCM, puis cliquez sur Lire.",wavPcmFillParams:"Renseignez les param\xE8tres, puis cliquez sur Lire pour analyser le WAV courant comme PCM.",currentPcmFormat:"Courant",savedDefaultPcmFormat:"Par d\xE9faut enregistr\xE9",audioLoaded:"Audio charg\xE9",audioNotReady:"L'audio n'est pas pr\xEAt",audioCannotPlay:"Cet audio ne peut pas \xEAtre lu dans le Webview",playbackFailed:"\xC9chec de lecture",analyzingSpectrogram:"Analyse du spectrogramme",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"\xC9chec d'initialisation d'AudioLens",trackGain:"Gain",trackPan:"Panoramique",panLeft:"G",panRight:"D",panCenter:"C",doubleClickReset:"Double-clic pour r\xE9initialiser",freqScaleMenuTitle:"\xC9chelle de fr\xE9quence du canal",restoreChannelDefault:"R\xE9tablir le d\xE9faut du canal",helpAxisGroup:"Axe vertical",helpAxisZoom:"Ctrl + molette / pincement sur un axe : zoom de cet axe (par canal)",helpAxisPan:"Maj + molette / balayage horizontal sur un axe : panoramique de cet axe (par canal)",helpAxisAlt:"Alt + molette sur une onde : zoom de l'amplitude du canal",helpAxisScaleMenu:"Clic droit sur l'axe de fr\xE9quence : d\xE9finir l'\xE9chelle du canal",helpAxisReset:"Double-clic sur un axe : r\xE9tablir le d\xE9faut du canal"};var Ue={waitingAudioFile:"Menunggu file audio",initializing:"Menginisialisasi",spectrogramSettings:"Pengaturan spectrogram",playPause:"Putar / jeda",playbackPosition:"Posisi putar",closeSettings:"Tutup pengaturan",spectrogramDisplay:"Tampilan spectrogram",algorithmFrequency:"Frekuensi",windowSize:"Ukuran window",windowType:"Jenis window",windowRectangular:"Rectangular",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"Faktor zero padding",frequencyScale:"Skala frekuensi",frequencyRange:"Rentang frekuensi (tampilan saja)",minFrequencyHz:"Frekuensi min (Hz)",maxFrequencyHz:"Frekuensi maks (Hz)",maxFrequencyNyquist:"Maks mengikuti Nyquist",spectrogramAppearance:"Tampilan spectrogram",palette:"Palet",paletteRose:"Rose",paletteClassic:"Klasik",paletteGrayscale:"Grayscale",paletteInverseGrayscale:"Grayscale terbalik",minDb:"Min dB (kecerahan)",maxDb:"Maks dB (kecerahan)",autoBrightness:"Kecerahan otomatis",amplitudeRange:"Rentang amplitudo (gelombang)",minAmplitude:"Amplitudo min",maxAmplitude:"Amplitudo maks",amplitudeAuto:"Auto (per kanal)",channel:"Kanal",timeZoom:"Zoom waktu",timePosition:"Posisi waktu",mouseWheel:"Roda mouse",help:"Bantuan",downloadAudio:"Unduh audio",downloadSelection:"Unduh seleksi",downloadSelectionWav:"Unduh seleksi sebagai WAV",clearSelection:"Hapus seleksi",noSelectionToDownload:"Tidak ada seleksi audio untuk diunduh",headerInfo:"Info header",headerInfoTitle:"Info header",headerInfoAudioUnread:"Data audio belum dibaca.",headerInfoUnsupported:"Penguraian header belum didukung untuk format ini.",headerInfoOffset:"Offset",headerInfoByteOffset:"Offset byte",headerInfoSize:"Panjang",headerInfoBits:"Bit",headerInfoField:"Kolom",headerInfoValue:"Nilai",headerInfoDescription:"Deskripsi",headerInfoWavMissingData:"chunk data tidak ditemukan",headerInfoWavCannotDetermine:"Tidak dapat menentukan panjang header WAV.",headerInfoWavHeaderLength:"Panjang header WAV {size} B",headerInfoWavStandardPcm:"Header PCM standar 44 byte.",headerInfoWavNonStandardPrefix:"Header PCM bukan 44 byte",headerInfoWavFmtExtended:"chunk fmt berukuran {size} B dan berisi kolom format tambahan",headerInfoWavFormat:"format audio adalah {format} ({name})",headerInfoWavExtraChunks:"chunk tambahan sebelum data: {chunks}",headerInfoWavDataOffsetNon44:"data dimulai pada offset selain 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"Offset ARK",settings:"Pengaturan",pcmReadAs:"Baca sebagai PCM",pcmParams:"Parameter file PCM",editPcmParams:"Edit parameter",wavPcmRead:"Baca WAV sebagai PCM",currentFileOnly:"Hanya file saat ini",sampleRate:"Sample rate",channels:"Jumlah kanal",startOffsetBytes:"Offset (B)",bitDepth:"Encoding",sampleFormat:"Format",endianness:"Byte order",read:"Baca",saveDefault:"Simpan default",cancel:"Batal",defaultView:"Tampilan default",view:"Tampilan",viewBoth:"Multi-view",mute:"Bisukan",solo:"Solo",timeLabel:"Waktu",helpTimeZoom:"Zoom waktu",helpTimePan:"Geser waktu",helpAmplitudeZoom:"Zoom amplitudo",helpRightClick:"Klik kanan",helpPinch:"Cubit",helpHorizontalSwipe:"Geser horizontal",helpDoubleClick:"Klik ganda",helpPlaybackGroup:"Pemutaran & pilihan",helpViewGroup:"Navigasi tampilan",helpMouseGroup:"Mouse & trackpad",helpGainGroup:"Gain & pan",helpPlayPause:"Putar / jeda",helpClearSelection:"Tutup menu, hapus pilihan, atau reset kursor putar",helpResetTimeZoom:"Reset zoom waktu",helpTrackpadZoom:"Cubit trackpad untuk zoom waktu",helpTrackpadPan:"Geser horizontal trackpad untuk menggeser waktu",helpGainReset:"Klik ganda slider gain atau pan untuk mengatur ulang",helpSelectionPlayback:"Seret waveform atau spectrogram untuk memilih segmen. Saat pilihan aktif, hanya rentang itu yang diputar.",refreshSpectrogram:"Segarkan spectrogram",resetView:"Reset tampilan",selectionAnalysis:"Analisis pilihan",selectionStart:"Mulai",selectionEnd:"Akhir",selectionDuration:"Durasi",rmsLevel:"Level RMS",peakLevel:"Level Peak",dominant:"Dominan",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"Noise floor",spectralCentroid:"Centroid",zeroCrossingRate:"ZCR",basicMetrics:"Metrik dasar",selectionAnalysisHelp:`Analisis pilihan:
Menganalisis rentang waktu yang dipilih untuk memeriksa level, rentang dinamis, risiko clipping, noise floor, dan distribusi frekuensi.

Cakupan:
Hasil dihitung hanya untuk kanal aktif; kanal tidak dicampur.

Ganti kanal:
Klik track untuk membuatnya aktif.`,rmsLevelHelp:`Level RMS:
Menunjukkan energi rata-rata pada pilihan. Lebih stabil daripada peak dan berguna untuk memeriksa suara terlalu pelan atau terlalu keras.`,peakLevelHelp:`Level peak:
Menunjukkan level sesaat tertinggi pada pilihan. Berguna untuk memeriksa kedekatan dengan 0 dBFS dan risiko clipping.`,dominantHelp:`Frekuensi dominan:
Bin FFT dengan daya akumulasi tertinggi pada pilihan. Tidak selalu frekuensi dasar atau pitch yang terdengar.`,crestFactorHelp:`Crest factor:
Rasio peak terhadap RMS. Nilai lebih besar berarti peak lebih menonjol dibanding energi rata-rata.`,clippingRatioHelp:`Rasio clipping:
Persentase sample yang dekat full scale. Membantu mendeteksi overload rekaman atau clipping digital.`,noiseFloorHelp:`Noise floor:
Estimasi dari persentil rendah RMS jangka pendek. Jika pilihan berisi banyak suara atau musik, nilainya bisa berbeda dari noise floor asli.`,spectralCentroidHelp:`Spectral centroid:
Pusat massa energi spektral dalam Hz. Menunjukkan apakah suara cenderung terang atau gelap.`,zeroCrossingRateHelp:`Zero crossing rate:
Laju perubahan tanda sinyal. Berguna untuk noise frekuensi tinggi, ucapan tak bersuara, dan frikatif.`,frequencyAnalysis:"Analisis frekuensi",frequencyAnalysisHelp:`Makna:
Persentase energi linear per band frekuensi. Ini bukan level RMS dan bukan dB.

Perhitungan:
Pilihan dibagi menjadi frame dengan 50% overlap; power bin FFT diakumulasi lalu dibagi ke band frekuensi.`,selectionAnalysisCalculating:"Menghitung...",bands:"Band",waveform:"Waveform",spectrogram:"Spectrogram",adjustWaveformHeight:"Atur tinggi waveform",adjustSpectrogramHeight:"Atur tinggi spectrogram",ready:"Siap",workspaceNotTrusted:"Workspace tidak tepercaya; konten audio tidak ditransfer",fileTooLarge:"File melebihi batas",readingAudio:"Membaca audio",readingAudioProgress:"Membaca audio",decodingAudio:"Mendekode audio",transcodingAudio:"Mengonversi audio dengan FFmpeg",encodedPlaybackOnly:"Dekode audio gagal.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"Menunggu parameter PCM",pcmUsedDefaultParams:"Dimuat dengan parameter PCM default.",pcmFillParams:"Isi parameter PCM, lalu klik Baca.",wavPcmFillParams:"Isi parameter, lalu klik Baca untuk membaca WAV saat ini sebagai PCM.",currentPcmFormat:"Saat ini",savedDefaultPcmFormat:"Default tersimpan",audioLoaded:"Audio dimuat",audioNotReady:"Audio belum siap",audioCannotPlay:"Audio ini tidak dapat diputar di webview",playbackFailed:"Pemutaran gagal",analyzingSpectrogram:"Menganalisis spectrogram",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"Inisialisasi AudioLens gagal",trackGain:"Gain",trackPan:"Pan",panLeft:"L",panRight:"R",panCenter:"C",doubleClickReset:"Klik ganda untuk mengatur ulang",freqScaleMenuTitle:"Skala frekuensi kanal",restoreChannelDefault:"Pulihkan default kanal",helpAxisGroup:"Sumbu vertikal",helpAxisZoom:"Ctrl + roda / cubit pada sumbu: zoom sumbu itu (per kanal)",helpAxisPan:"Shift + roda / geser horizontal pada sumbu: geser sumbu itu (per kanal)",helpAxisAlt:"Alt + roda pada gelombang: zoom amplitudo kanal",helpAxisScaleMenu:"Klik kanan sumbu frekuensi: atur skala kanal ini",helpAxisReset:"Klik ganda sumbu: pulihkan default kanal ini"};var Ze={waitingAudioFile:"In attesa del file audio",initializing:"Inizializzazione",spectrogramSettings:"Impostazioni spettrogramma",playPause:"Riproduci / pausa",playbackPosition:"Posizione di riproduzione",closeSettings:"Chiudi impostazioni",spectrogramDisplay:"Visualizzazione spettrogramma",algorithmFrequency:"Frequenza",windowSize:"Dimensione finestra",windowType:"Tipo finestra",windowRectangular:"Rettangolare",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussiana (\u03B1=2.5)",windowGaussian35:"Gaussiana (\u03B1=3.5)",windowGaussian45:"Gaussiana (\u03B1=4.5)",zeroPaddingFactor:"Fattore zero padding",frequencyScale:"Scala frequenza",frequencyRange:"Intervallo frequenze (solo vista)",minFrequencyHz:"Frequenza min (Hz)",maxFrequencyHz:"Frequenza max (Hz)",maxFrequencyNyquist:"Max segue Nyquist",spectrogramAppearance:"Aspetto dello spettrogramma",palette:"Palette",paletteRose:"Rosa",paletteClassic:"Classica",paletteGrayscale:"Scala di grigi",paletteInverseGrayscale:"Grigi invertiti",minDb:"dB min (luminosit\xE0)",maxDb:"dB max (luminosit\xE0)",autoBrightness:"Luminosit\xE0 auto",amplitudeRange:"Intervallo ampiezza (onda)",minAmplitude:"Ampiezza min",maxAmplitude:"Ampiezza max",amplitudeAuto:"Auto (per canale)",channel:"Canale",timeZoom:"Zoom tempo",timePosition:"Posizione tempo",mouseWheel:"Rotella mouse",help:"Aiuto",downloadAudio:"Scarica audio",downloadSelection:"Scarica selezione",downloadSelectionWav:"Scarica selezione come WAV",clearSelection:"Cancella selezione",noSelectionToDownload:"Nessuna selezione audio da scaricare",headerInfo:"Info intestazione",headerInfoTitle:"Info intestazione",headerInfoAudioUnread:"I dati audio non sono ancora stati letti.",headerInfoUnsupported:"L'analisi dell'intestazione non \xE8 ancora supportata per questo formato.",headerInfoOffset:"Offset",headerInfoByteOffset:"Offset byte",headerInfoSize:"Lunghezza",headerInfoBits:"Bit",headerInfoField:"Campo",headerInfoValue:"Valore",headerInfoDescription:"Descrizione",headerInfoWavMissingData:"chunk data non trovato",headerInfoWavCannotDetermine:"Impossibile determinare la lunghezza dell'intestazione WAV.",headerInfoWavHeaderLength:"Lunghezza intestazione WAV {size} B",headerInfoWavStandardPcm:"Intestazione PCM standard da 44 byte.",headerInfoWavNonStandardPrefix:"Intestazione PCM non standard da 44 byte",headerInfoWavFmtExtended:"il chunk fmt \xE8 {size} B e contiene campi di formato estesi",headerInfoWavFormat:"il formato audio \xE8 {format} ({name})",headerInfoWavExtraChunks:"chunk extra prima di data: {chunks}",headerInfoWavDataOffsetNon44:"data inizia a un offset diverso da 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"Offset ARK",settings:"Impostazioni",pcmReadAs:"Leggi come PCM",pcmParams:"Parametri file PCM",editPcmParams:"Modifica parametri",wavPcmRead:"Leggi WAV come PCM",currentFileOnly:"Solo file corrente",sampleRate:"Frequenza di campionamento",channels:"Canali",startOffsetBytes:"Offset (B)",bitDepth:"Codifica",sampleFormat:"Formato",endianness:"Byte order",read:"Leggi",saveDefault:"Salva predefinito",cancel:"Annulla",defaultView:"Vista predefinita",view:"Vista",viewBoth:"Vista multipla",mute:"Muto",solo:"Solo",timeLabel:"Tempo",helpTimeZoom:"Zoom tempo",helpTimePan:"Pan tempo",helpAmplitudeZoom:"Zoom ampiezza",helpRightClick:"Clic destro",helpPinch:"Pizzica",helpHorizontalSwipe:"Scorrimento orizzontale",helpDoubleClick:"Doppio clic",helpPlaybackGroup:"Riproduzione e selezione",helpViewGroup:"Navigazione vista",helpMouseGroup:"Mouse e trackpad",helpGainGroup:"Guadagno e pan",helpPlayPause:"Riproduci / pausa",helpClearSelection:"Chiudi menu, cancella selezione o reimposta cursore",helpResetTimeZoom:"Reimposta zoom tempo",helpTrackpadZoom:"Pizzica sul trackpad per zoomare il tempo",helpTrackpadPan:"Scorrimento orizzontale del trackpad per spostare il tempo",helpGainReset:"Doppio clic su un cursore guadagno o pan per reimpostarlo",helpSelectionPlayback:"Trascina forma d'onda o spettrogramma per selezionare un segmento. Con una selezione attiva, viene riprodotto solo quel range.",refreshSpectrogram:"Aggiorna spettrogramma",resetView:"Reimposta vista",selectionAnalysis:"Analisi selezione",selectionStart:"Inizio",selectionEnd:"Fine",selectionDuration:"Durata",rmsLevel:"Livello RMS",peakLevel:"Livello Peak",dominant:"Dominante",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"Rumore di fondo",spectralCentroid:"Centroide",zeroCrossingRate:"ZCR",basicMetrics:"Metriche base",selectionAnalysisHelp:`Analisi selezione:
Analizza rapidamente il range selezionato per controllare livello, dinamica, rischio clipping, rumore di fondo e distribuzione in frequenza.

Ambito:
I risultati sono calcolati solo sul canale attivo; i canali non vengono mixati.

Cambio canale:
Fai clic su una traccia per renderla attiva.`,rmsLevelHelp:`Livello RMS:
Mostra l'energia media della selezione. \xC8 pi\xF9 stabile del picco ed \xE8 utile per verificare parlato troppo basso o troppo alto.`,peakLevelHelp:`Livello picco:
Mostra il massimo livello istantaneo nella selezione. Utile per controllare vicinanza a 0 dBFS e rischio clipping.`,dominantHelp:`Frequenza dominante:
Il bin FFT con potenza accumulata maggiore nella selezione. Non \xE8 necessariamente la fondamentale o il pitch percepito.`,crestFactorHelp:`Fattore di cresta:
Rapporto tra picco e RMS. Valori pi\xF9 alti indicano picchi pi\xF9 evidenti rispetto all'energia media.`,clippingRatioHelp:`Percentuale di clipping:
Percentuale di sample vicini al fondo scala. Aiuta a rilevare sovraccarico o clipping digitale.`,noiseFloorHelp:`Rumore di fondo:
Stimato da un percentile basso degli RMS a breve termine. Se la selezione contiene soprattutto voce o musica, pu\xF2 differire dal rumore reale.`,spectralCentroidHelp:`Centroide spettrale:
Centro di massa dell'energia spettrale in Hz. Indica se il suono tende a essere pi\xF9 brillante o pi\xF9 scuro.`,zeroCrossingRateHelp:`Tasso di attraversamenti dello zero:
Frequenza con cui il segnale cambia segno. Utile per rumore ad alta frequenza, parlato non sonoro e fricative.`,frequencyAnalysis:"Analisi frequenze",frequencyAnalysisHelp:`Significato:
Percentuale di energia lineare per banda di frequenza. Non \xE8 livello RMS n\xE9 dB.

Calcolo:
La selezione viene divisa in frame con 50% di overlap; la potenza dei bin FFT viene accumulata e assegnata alle bande.`,selectionAnalysisCalculating:"Calcolo...",bands:"Bande",waveform:"Forma d'onda",spectrogram:"Spettrogramma",adjustWaveformHeight:"Regola altezza forma d'onda",adjustSpectrogramHeight:"Regola altezza spettrogramma",ready:"Pronto",workspaceNotTrusted:"Workspace non attendibile; il contenuto audio non viene trasferito",fileTooLarge:"Il file supera il limite",readingAudio:"Lettura audio",readingAudioProgress:"Lettura audio",decodingAudio:"Decodifica audio",transcodingAudio:"Transcodifica audio con FFmpeg",encodedPlaybackOnly:"Decodifica audio non riuscita.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"In attesa dei parametri PCM",pcmUsedDefaultParams:"Caricato con i parametri PCM predefiniti.",pcmFillParams:"Inserisci i parametri PCM, poi fai clic su Leggi.",wavPcmFillParams:"Inserisci i parametri, poi fai clic su Leggi per interpretare il WAV corrente come PCM.",currentPcmFormat:"Corrente",savedDefaultPcmFormat:"Predefinito salvato",audioLoaded:"Audio caricato",audioNotReady:"Audio non pronto",audioCannotPlay:"Questo audio non puo essere riprodotto nella webview",playbackFailed:"Riproduzione non riuscita",analyzingSpectrogram:"Analisi spettrogramma",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"Inizializzazione di AudioLens non riuscita",trackGain:"Guadagno",trackPan:"Pan",panLeft:"S",panRight:"D",panCenter:"C",doubleClickReset:"Doppio clic per reimpostare",freqScaleMenuTitle:"Scala di frequenza del canale",restoreChannelDefault:"Ripristina predefinito del canale",helpAxisGroup:"Asse verticale",helpAxisZoom:"Ctrl + rotellina / pinch su un asse: zoom di quell'asse (per canale)",helpAxisPan:"Maiusc + rotellina / scorrimento orizzontale su un asse: pan di quell'asse (per canale)",helpAxisAlt:"Alt + rotellina su un'onda: zoom dell'ampiezza del canale",helpAxisScaleMenu:"Clic destro sull'asse di frequenza: imposta la scala del canale",helpAxisReset:"Doppio clic su un asse: ripristina il predefinito del canale"};var Ke={waitingAudioFile:"\u97F3\u58F0\u30D5\u30A1\u30A4\u30EB\u5F85\u6A5F\u4E2D",initializing:"\u521D\u671F\u5316\u4E2D",spectrogramSettings:"\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u8A2D\u5B9A",help:"\u30D8\u30EB\u30D7",downloadAudio:"\u97F3\u58F0\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9",downloadSelection:"\u9078\u629E\u7BC4\u56F2\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9",downloadSelectionWav:"\u9078\u629E\u7BC4\u56F2\u3092 WAV \u3068\u3057\u3066\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9",clearSelection:"\u9078\u629E\u7BC4\u56F2\u3092\u30AF\u30EA\u30A2",noSelectionToDownload:"\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3067\u304D\u308B\u9078\u629E\u7BC4\u56F2\u304C\u3042\u308A\u307E\u305B\u3093",headerInfo:"\u30D8\u30C3\u30C0\u30FC\u60C5\u5831",headerInfoTitle:"\u30D8\u30C3\u30C0\u30FC\u60C5\u5831",headerInfoAudioUnread:"\u97F3\u58F0\u30C7\u30FC\u30BF\u306F\u307E\u3060\u8AAD\u307F\u8FBC\u307E\u308C\u3066\u3044\u307E\u305B\u3093\u3002",headerInfoUnsupported:"\u3053\u306E\u5F62\u5F0F\u306E\u30D8\u30C3\u30C0\u30FC\u89E3\u6790\u306F\u307E\u3060\u30B5\u30DD\u30FC\u30C8\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002",headerInfoOffset:"\u30AA\u30D5\u30BB\u30C3\u30C8",headerInfoByteOffset:"\u30D0\u30A4\u30C8\u30AA\u30D5\u30BB\u30C3\u30C8",headerInfoSize:"\u9577\u3055",headerInfoBits:"\u30D3\u30C3\u30C8\u7BC4\u56F2",headerInfoField:"\u30D5\u30A3\u30FC\u30EB\u30C9",headerInfoValue:"\u5024",headerInfoDescription:"\u8AAC\u660E",headerInfoWavMissingData:"data chunk \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093",headerInfoWavCannotDetermine:"WAV \u30D8\u30C3\u30C0\u30FC\u9577\u3092\u5224\u5B9A\u3067\u304D\u307E\u305B\u3093\u3002",headerInfoWavHeaderLength:"WAV \u30D8\u30C3\u30C0\u30FC\u9577 {size} B",headerInfoWavStandardPcm:"\u6A19\u6E96\u306E 44 \u30D0\u30A4\u30C8 PCM \u30D8\u30C3\u30C0\u30FC\u3067\u3059\u3002",headerInfoWavNonStandardPrefix:"44 \u30D0\u30A4\u30C8\u3067\u306F\u306A\u3044 PCM \u30D8\u30C3\u30C0\u30FC",headerInfoWavFmtExtended:"fmt \u30C1\u30E3\u30F3\u30AF\u306F {size} B \u3067\u3001\u62E1\u5F35\u5F62\u5F0F\u30D5\u30A3\u30FC\u30EB\u30C9\u3092\u542B\u307F\u307E\u3059",headerInfoWavFormat:"\u97F3\u58F0\u5F62\u5F0F\u306F {format} ({name}) \u3067\u3059",headerInfoWavExtraChunks:"data \u306E\u524D\u306B\u8FFD\u52A0\u30C1\u30E3\u30F3\u30AF\u304C\u3042\u308A\u307E\u3059: {chunks}",headerInfoWavDataOffsetNon44:"data \u306E\u958B\u59CB\u30AA\u30D5\u30BB\u30C3\u30C8\u304C 44 B \u3067\u306F\u3042\u308A\u307E\u305B\u3093",headerInfoReasonSeparator:"\uFF1B",arkOffsetLabel:"ARK \u30AA\u30D5\u30BB\u30C3\u30C8",settings:"\u8A2D\u5B9A",playPause:"\u518D\u751F / \u4E00\u6642\u505C\u6B62",playbackPosition:"\u518D\u751F\u4F4D\u7F6E",closeSettings:"\u8A2D\u5B9A\u3092\u9589\u3058\u308B",spectrogramDisplay:"\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u8868\u793A",algorithmFrequency:"\u5468\u6CE2\u6570",windowSize:"\u7A93\u30B5\u30A4\u30BA",windowType:"\u7A93\u30BF\u30A4\u30D7",windowRectangular:"\u77E9\u5F62",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"\u30BC\u30ED\u57CB\u3081\u4FC2\u6570",frequencyScale:"\u5468\u6CE2\u6570\u30B9\u30B1\u30FC\u30EB",frequencyRange:"\u5468\u6CE2\u6570\u7BC4\u56F2\uFF08\u8868\u793A\u306E\u307F\uFF09",minFrequencyHz:"\u6700\u5C0F\u5468\u6CE2\u6570 (Hz)",maxFrequencyHz:"\u6700\u5927\u5468\u6CE2\u6570 (Hz)",maxFrequencyNyquist:"\u6700\u5927\u5024\u3092 Nyquist \u306B\u5408\u308F\u305B\u308B",spectrogramAppearance:"\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u306E\u8868\u793A",palette:"\u30D1\u30EC\u30C3\u30C8",paletteRose:"\u30AB\u30E9\u30FC (\u30ED\u30FC\u30BA)",paletteClassic:"\u30AB\u30E9\u30FC (\u30AF\u30E9\u30B7\u30C3\u30AF)",paletteGrayscale:"\u30B0\u30EC\u30FC\u30B9\u30B1\u30FC\u30EB",paletteInverseGrayscale:"\u53CD\u8EE2\u30B0\u30EC\u30FC",minDb:"\u6700\u5C0F dB (\u660E\u308B\u3055)",maxDb:"\u6700\u5927 dB (\u660E\u308B\u3055)",autoBrightness:"\u81EA\u52D5\u660E\u308B\u3055",amplitudeRange:"\u632F\u5E45\u7BC4\u56F2\uFF08\u6CE2\u5F62\uFF09",minAmplitude:"\u6700\u5C0F\u632F\u5E45",maxAmplitude:"\u6700\u5927\u632F\u5E45",amplitudeAuto:"\u81EA\u52D5\uFF08\u5404\u30C1\u30E3\u30F3\u30CD\u30EB\u306B\u5408\u308F\u305B\u308B\uFF09",channel:"\u30C1\u30E3\u30F3\u30CD\u30EB",timeZoom:"\u6642\u9593\u30BA\u30FC\u30E0",timePosition:"\u6642\u9593\u4F4D\u7F6E",mouseWheel:"\u30DE\u30A6\u30B9\u30DB\u30A4\u30FC\u30EB",refreshSpectrogram:"\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u3092\u66F4\u65B0",resetView:"\u8868\u793A\u3092\u30EA\u30BB\u30C3\u30C8",pcmReadAs:"PCM \u3068\u3057\u3066\u8AAD\u307F\u8FBC\u3080",pcmParams:"PCM \u30D5\u30A1\u30A4\u30EB\u30D1\u30E9\u30E1\u30FC\u30BF",editPcmParams:"\u30D1\u30E9\u30E1\u30FC\u30BF\u3092\u7DE8\u96C6",wavPcmRead:"WAV \u3092 PCM \u3068\u3057\u3066\u8AAD\u307F\u8FBC\u3080",currentFileOnly:"\u73FE\u5728\u306E\u30D5\u30A1\u30A4\u30EB\u306E\u307F",sampleRate:"\u30B5\u30F3\u30D7\u30EB\u30EC\u30FC\u30C8",channels:"\u30C1\u30E3\u30F3\u30CD\u30EB\u6570",startOffsetBytes:"\u30AA\u30D5\u30BB\u30C3\u30C8(B)",bitDepth:"\u30A8\u30F3\u30B3\u30FC\u30C9",sampleFormat:"\u5F62\u5F0F",endianness:"\u30D0\u30A4\u30C8\u9806",read:"\u8AAD\u307F\u8FBC\u307F",saveDefault:"\u65E2\u5B9A\u5024\u3092\u4FDD\u5B58",cancel:"\u30AD\u30E3\u30F3\u30BB\u30EB",defaultView:"\u65E2\u5B9A\u30D3\u30E5\u30FC",view:"\u30D3\u30E5\u30FC",viewBoth:"\u30DE\u30EB\u30C1\u30D3\u30E5\u30FC",mute:"\u30DF\u30E5\u30FC\u30C8",solo:"\u30BD\u30ED",timeLabel:"\u6642\u9593",helpTimeZoom:"\u6642\u9593\u30BA\u30FC\u30E0",helpTimePan:"\u6642\u9593\u79FB\u52D5",helpAmplitudeZoom:"\u632F\u5E45\u30BA\u30FC\u30E0",helpRightClick:"\u53F3\u30AF\u30EA\u30C3\u30AF",helpPinch:"\u30D4\u30F3\u30C1",helpHorizontalSwipe:"\u6A2A\u30B9\u30EF\u30A4\u30D7",helpDoubleClick:"\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF",helpPlaybackGroup:"\u518D\u751F\u3068\u9078\u629E\u7BC4\u56F2",helpViewGroup:"\u8868\u793A\u64CD\u4F5C",helpMouseGroup:"\u30DE\u30A6\u30B9\u3068\u30C8\u30E9\u30C3\u30AF\u30D1\u30C3\u30C9",helpGainGroup:"\u30B2\u30A4\u30F3\u3068\u30D1\u30F3",helpPlayPause:"\u518D\u751F / \u4E00\u6642\u505C\u6B62",helpClearSelection:"\u30E1\u30CB\u30E5\u30FC\u3092\u9589\u3058\u308B\u3001\u9078\u629E\u7BC4\u56F2\u3092\u89E3\u9664\u3001\u307E\u305F\u306F\u518D\u751F\u30AB\u30FC\u30BD\u30EB\u3092\u30EA\u30BB\u30C3\u30C8",helpResetTimeZoom:"\u6642\u9593\u30BA\u30FC\u30E0\u3092\u30EA\u30BB\u30C3\u30C8",helpTrackpadZoom:"\u30C8\u30E9\u30C3\u30AF\u30D1\u30C3\u30C9\u306E\u30D4\u30F3\u30C1\u3067\u6642\u9593\u3092\u30BA\u30FC\u30E0",helpTrackpadPan:"\u30C8\u30E9\u30C3\u30AF\u30D1\u30C3\u30C9\u306E\u6A2A\u30B9\u30EF\u30A4\u30D7\u3067\u6642\u9593\u3092\u79FB\u52D5",helpGainReset:"\u30C1\u30E3\u30F3\u30CD\u30EB\u306E\u30B2\u30A4\u30F3/\u30D1\u30F3\u30B9\u30E9\u30A4\u30C0\u30FC\u3092\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF\u3059\u308B\u3068\u30EA\u30BB\u30C3\u30C8\u3055\u308C\u307E\u3059",helpSelectionPlayback:"\u6CE2\u5F62\u307E\u305F\u306F\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u3092\u30C9\u30E9\u30C3\u30B0\u3057\u3066\u7BC4\u56F2\u3092\u9078\u629E\u3057\u307E\u3059\u3002\u9078\u629E\u7BC4\u56F2\u304C\u3042\u308B\u5834\u5408\u3001\u518D\u751F\u306F\u305D\u306E\u7BC4\u56F2\u3060\u3051\u306B\u306A\u308A\u307E\u3059\u3002",selectionAnalysis:"\u9078\u629E\u7BC4\u56F2\u5206\u6790",selectionAnalysisHelp:`\u9078\u629E\u7BC4\u56F2\u5206\u6790:
\u9078\u629E\u3057\u305F\u6642\u9593\u7BC4\u56F2\u3092\u3059\u3070\u3084\u304F\u96C6\u8A08\u3057\u3001\u9332\u97F3\u30EC\u30D9\u30EB\u3001\u30C0\u30A4\u30CA\u30DF\u30C3\u30AF\u30EC\u30F3\u30B8\u3001\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0\u30EA\u30B9\u30AF\u3001\u30CE\u30A4\u30BA\u30D5\u30ED\u30A2\u3001\u5468\u6CE2\u6570\u5206\u5E03\u3092\u78BA\u8A8D\u3057\u307E\u3059\u3002

\u5BFE\u8C61:
\u7D50\u679C\u306F\u73FE\u5728\u30A2\u30AF\u30C6\u30A3\u30D6\u306A\u30C1\u30E3\u30F3\u30CD\u30EB\u3060\u3051\u3067\u8A08\u7B97\u3057\u307E\u3059\u3002\u8907\u6570\u30C1\u30E3\u30F3\u30CD\u30EB\u3092\u6DF7\u5408\u3057\u307E\u305B\u3093\u3002

\u5207\u308A\u66FF\u3048:
\u30C8\u30E9\u30C3\u30AF\u3092\u30AF\u30EA\u30C3\u30AF\u3059\u308B\u3068\u3001\u305D\u306E\u30C8\u30E9\u30C3\u30AF\u304C\u30A2\u30AF\u30C6\u30A3\u30D6\u30C1\u30E3\u30F3\u30CD\u30EB\u306B\u306A\u308A\u307E\u3059\u3002\u4EE5\u5F8C\u306E RMS\u3001Peak\u3001Dominant\u3001\u5468\u6CE2\u6570\u5206\u6790\u306F\u305D\u306E\u30C1\u30E3\u30F3\u30CD\u30EB\u3092\u4F7F\u3044\u307E\u3059\u3002`,basicMetrics:"\u57FA\u672C\u6307\u6A19",selectionStart:"\u958B\u59CB",selectionEnd:"\u7D42\u4E86",selectionDuration:"\u9577\u3055",rmsLevel:"RMS\u30EC\u30D9\u30EB",peakLevel:"\u30D4\u30FC\u30AF\u30EC\u30D9\u30EB",dominant:"\u4E3B\u5468\u6CE2\u6570",crestFactor:"\u30AF\u30EC\u30B9\u30C8",clippingRatio:"\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0",noiseFloor:"\u30CE\u30A4\u30BA\u30D5\u30ED\u30A2",spectralCentroid:"\u91CD\u5FC3",zeroCrossingRate:"ZCR",rmsLevelHelp:`RMS\u30EC\u30D9\u30EB:
\u8A08\u7B97:
rms = sqrt(mean(sample\xB2))
rmsDb = 20 \xD7 log10(rms)

\u7528\u9014:
\u9078\u629E\u7BC4\u56F2\u306E\u5E73\u5747\u7684\u306A\u30A8\u30CD\u30EB\u30AE\u30FC\u3084\u97F3\u91CF\u50BE\u5411\u3092\u793A\u3057\u307E\u3059\u3002\u30D4\u30FC\u30AF\u3088\u308A\u5B89\u5B9A\u3057\u3066\u304A\u308A\u3001\u97F3\u58F0\u304C\u5C0F\u3055\u3059\u304E\u308B\u3001\u307E\u305F\u306F\u5927\u304D\u3059\u304E\u308B\u304B\u3092\u78BA\u8A8D\u3057\u3084\u3059\u3044\u6307\u6A19\u3067\u3059\u3002

\u5236\u9650:
RMS \u306F LUFS \u3067\u306F\u306A\u304F\u3001\u8074\u611F\u91CD\u307F\u4ED8\u3051\u3084\u30B2\u30FC\u30C6\u30A3\u30F3\u30B0\u306F\u3042\u308A\u307E\u305B\u3093\u3002\u9577\u3044\u9078\u629E\u7BC4\u56F2\u3067\u306F UI \u5FDC\u7B54\u6027\u3092\u4FDD\u3064\u305F\u3081\u5747\u7B49\u30B5\u30F3\u30D7\u30EA\u30F3\u30B0\u3057\u307E\u3059\u3002

\u53C2\u8003:
MathWorks rms; librosa.feature.rms; Audacity Measure RMS.`,peakLevelHelp:`\u30D4\u30FC\u30AF\u30EC\u30D9\u30EB:
\u8A08\u7B97:
peak = max(abs(sample))
peakDb = 20 \xD7 log10(peak)

\u7528\u9014:
\u9078\u629E\u7BC4\u56F2\u5185\u306E\u6700\u5927\u77AC\u6642\u30EC\u30D9\u30EB\u3092\u793A\u3057\u307E\u3059\u30020 dBFS \u3078\u306E\u8FD1\u3055\u3084\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0\u30EA\u30B9\u30AF\u78BA\u8A8D\u306B\u6709\u7528\u3067\u3059\u3002

\u5236\u9650:
\u30D4\u30FC\u30AF\u306F\u6700\u5927\u77AC\u9593\u3060\u3051\u3092\u8868\u3057\u3001\u5168\u4F53\u306E\u5927\u304D\u3055\u306F\u8868\u3057\u307E\u305B\u3093\u3002\u9577\u3044\u9078\u629E\u7BC4\u56F2\u3067\u306F UI \u5FDC\u7B54\u6027\u3092\u4FDD\u3064\u305F\u3081\u5747\u7B49\u30B5\u30F3\u30D7\u30EA\u30F3\u30B0\u3057\u307E\u3059\u3002

\u53C2\u8003:
Adobe Audition Amplitude Statistics; Audacity Amplify; AES17 0 dBFS.`,dominantHelp:`\u4E3B\u5468\u6CE2\u6570:
\u9078\u629E\u7BC4\u56F2\u5168\u4F53\u3067\u7D2F\u7A4D\u30D1\u30EF\u30FC\u304C\u6700\u5927\u306E FFT \u5468\u6CE2\u6570\u30D3\u30F3\u3067\u3059\u3002

\u30D3\u30F3\u5BFE\u5FDC:
\u30D3\u30F3 k \u306E\u5468\u6CE2\u6570:
freq = k \xD7 sampleRate / FFT size

\u30D1\u30EF\u30FC:
\u5404\u30D5\u30EC\u30FC\u30E0\u3067:
power = re\xB2 + im\xB2

\u9078\u629E\u7BC4\u56F2\u3067\u306E\u7D2F\u7A4D:
binPower[k] += power

\u7D50\u679C:
dominantHz = k \xD7 sampleRate / FFT size\u3002k \u306F binPower \u304C\u6700\u5927\u306E\u30D3\u30F3\u3067\u3059\u3002

\u610F\u5473:
\u5FC5\u305A\u3057\u3082\u57FA\u672C\u5468\u6CE2\u6570\u3084\u77E5\u899A\u4E0A\u306E\u30D4\u30C3\u30C1\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002\u5468\u6CE2\u6570\u5206\u89E3\u80FD\u306F sampleRate / FFT size \u3067\u3059\u3002

\u53C2\u8003:
NumPy fftfreq; librosa spectral features.`,crestFactorHelp:`\u30AF\u30EC\u30B9\u30C8\u30D5\u30A1\u30AF\u30BF\u30FC:
\u30D4\u30FC\u30AF\u3068 RMS \u306E\u6BD4\u3067\u3059\u3002

\u8A08\u7B97:
crest = peak / rms
crestDb = peakDb - rmsDb

\u7528\u9014:
\u30C0\u30A4\u30CA\u30DF\u30C3\u30AF\u30EC\u30F3\u30B8\u3084\u904E\u6E21\u6210\u5206\u306E\u5F37\u3055\u3092\u793A\u3057\u307E\u3059\u3002\u5024\u304C\u5927\u304D\u3044\u307B\u3069\u5E73\u5747\u30A8\u30CD\u30EB\u30AE\u30FC\u306B\u5BFE\u3057\u3066\u30D4\u30FC\u30AF\u304C\u76EE\u7ACB\u3061\u307E\u3059\u3002

\u5236\u9650:
\u7121\u97F3\u3084\u975E\u5E38\u306B\u5C0F\u3055\u3044\u97F3\u3067\u306F\u4E0D\u5B89\u5B9A\u3067\u3059\u3002\u30C0\u30A4\u30CA\u30DF\u30AF\u30B9\u3092\u793A\u3059\u6307\u6A19\u3067\u3042\u308A\u3001\u54C1\u8CEA\u3092\u76F4\u63A5\u5224\u5B9A\u3059\u308B\u3082\u306E\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002

\u53C2\u8003:
MathWorks peak2rms; Signal Processing Toolbox descriptive statistics.`,clippingRatioHelp:`\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0\u7387:
\u30D5\u30EB\u30B9\u30B1\u30FC\u30EB\u306B\u8FD1\u3044\u30B5\u30F3\u30D7\u30EB\u306E\u5272\u5408\u3067\u3059\u3002

\u8A08\u7B97:
clippingRatio = count(abs(sample) >= 0.999) / measuredSamples \xD7 100%

\u7528\u9014:
\u30C7\u30B8\u30BF\u30EB\u30D5\u30EB\u30B9\u30B1\u30FC\u30EB\u3001\u9332\u97F3\u904E\u5927\u3001\u30CF\u30FC\u30C9\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0\u306E\u30EA\u30B9\u30AF\u3092\u7D20\u65E9\u304F\u691C\u51FA\u3057\u307E\u3059\u3002

\u5236\u9650:
AudioLens \u306B\u5165\u308B\u524D\u306B\u30EA\u30DF\u30C3\u30BF\u30FC\u3084\u6B6A\u307F\u304C\u304B\u304B\u3063\u3066\u3044\u308B\u5834\u5408\u3001\u30D5\u30EB\u30B9\u30B1\u30FC\u30EB\u30B5\u30F3\u30D7\u30EB\u304C\u306A\u304F\u3066\u3082\u6B6A\u3093\u3067\u805E\u3053\u3048\u308B\u3053\u3068\u304C\u3042\u308A\u307E\u3059\u3002

\u53C2\u8003:
Audacity Find Clipping; Adobe Audition Amplitude Statistics; Netflix AudioClippingInspector.`,noiseFloorHelp:`\u30CE\u30A4\u30BA\u30D5\u30ED\u30A2:
\u9078\u629E\u7BC4\u56F2\u5185\u306E\u9759\u304B\u306A\u90E8\u5206\u306B\u304A\u3051\u308B\u77ED\u6642\u9593 RMS \u306E\u4F4E\u30D1\u30FC\u30BB\u30F3\u30BF\u30A4\u30EB\u304B\u3089\u63A8\u5B9A\u3057\u307E\u3059\u3002

\u8A08\u7B97:
1. \u9078\u629E\u7BC4\u56F2\u3092\u7D04 20 ms\u300150% \u30AA\u30FC\u30D0\u30FC\u30E9\u30C3\u30D7\u306E\u7A93\u306B\u5206\u5272\u3057\u307E\u3059\u3002
2. \u5404\u7A93\u306E RMS \u3092\u8A08\u7B97\u3057\u307E\u3059\u3002
3. RMS \u306E 10 \u30D1\u30FC\u30BB\u30F3\u30BF\u30A4\u30EB\u3092 dBFS \u306B\u5909\u63DB\u3057\u307E\u3059\u3002

\u7528\u9014:
\u80CC\u666F\u30CE\u30A4\u30BA\u3001\u7121\u97F3\u90E8\u5206\u306E\u304D\u308C\u3044\u3055\u3001\u9332\u97F3\u74B0\u5883\u306E\u30CE\u30A4\u30BA\u3092\u63A8\u5B9A\u3057\u307E\u3059\u3002

\u5236\u9650:
\u6559\u5E2B\u306A\u3057\u63A8\u5B9A\u3067\u3059\u3002\u9078\u629E\u7BC4\u56F2\u306E\u5927\u534A\u304C\u97F3\u58F0\u3084\u97F3\u697D\u306E\u5834\u5408\u3001\u771F\u306E\u30CE\u30A4\u30BA\u30D5\u30ED\u30A2\u3068\u306F\u4E00\u81F4\u3057\u306A\u3044\u3053\u3068\u304C\u3042\u308A\u307E\u3059\u3002

\u53C2\u8003:
Adobe Audition Minimum RMS; librosa.feature.rms; Audacity Noise Reduction.`,spectralCentroidHelp:`\u30B9\u30DA\u30AF\u30C8\u30EB\u91CD\u5FC3:
\u30B9\u30DA\u30AF\u30C8\u30EB\u30A8\u30CD\u30EB\u30AE\u30FC\u306E\u91CD\u5FC3\u3092 Hz \u3067\u8868\u3057\u307E\u3059\u3002

\u8A08\u7B97:
centroid = sum(freq[k] \xD7 power[k]) / sum(power[k])

\u7528\u9014:
\u97F3\u304C\u660E\u308B\u3044\u304B\u6697\u3044\u304B\u306E\u50BE\u5411\u3092\u793A\u3057\u307E\u3059\u3002\u9AD8\u57DF\u6210\u5206\u306E\u591A\u3044\u97F3\u58F0\u306F\u4E00\u822C\u306B\u91CD\u5FC3\u304C\u9AD8\u304F\u306A\u308A\u307E\u3059\u3002

\u5236\u9650:
\u30CE\u30A4\u30BA\u3001\u6B6F\u64E6\u97F3\u3001\u5E2F\u57DF\u5E45\u306E\u5F71\u97FF\u3092\u53D7\u3051\u307E\u3059\u3002\u30D4\u30C3\u30C1\u3067\u306F\u306A\u304F\u3001\u5358\u72EC\u3067\u660E\u77AD\u5EA6\u3092\u5224\u65AD\u3059\u308B\u3082\u306E\u3067\u3082\u3042\u308A\u307E\u305B\u3093\u3002

\u53C2\u8003:
librosa.feature.spectral_centroid; MathWorks spectralCentroid.`,zeroCrossingRateHelp:`\u30BC\u30ED\u4EA4\u5DEE\u7387:
\u4FE1\u53F7\u306E\u7B26\u53F7\u304C\u5909\u308F\u308B\u983B\u5EA6\u3067\u3059\u3002

\u8A08\u7B97:
zeroCrossingRate = zeroCrossings / durationSeconds

\u7528\u9014:
\u9AD8\u5468\u6CE2\u30CE\u30A4\u30BA\u3001\u7121\u58F0\u97F3\u3001\u6469\u64E6\u97F3\u306A\u3069\u3092\u5927\u307E\u304B\u306B\u898B\u308B\u6642\u9593\u9818\u57DF\u7279\u5FB4\u91CF\u3067\u3059\u3002

\u5236\u9650:
\u30CE\u30A4\u30BA\u3084 DC \u30AA\u30D5\u30BB\u30C3\u30C8\u306B\u654F\u611F\u3067\u3059\u3002\u5468\u6CE2\u6570\u3084\u30D4\u30C3\u30C1\u305D\u306E\u3082\u306E\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002

\u53C2\u8003:
librosa.feature.zero_crossing_rate; librosa.zero_crossings.`,frequencyAnalysis:"\u5468\u6CE2\u6570\u5206\u6790",frequencyAnalysisHelp:`\u610F\u5473:
\u5468\u6CE2\u6570\u5E2F\u57DF\u3054\u3068\u306E\u7DDA\u5F62\u30A8\u30CD\u30EB\u30AE\u30FC\u5272\u5408\u3067\u3059\u3002RMS \u30EC\u30D9\u30EB\u3067\u3082 dB \u3067\u3082\u3042\u308A\u307E\u305B\u3093\u3002

\u8A08\u7B97:
1. \u9078\u629E\u7BC4\u56F2\u5185\u306E\u30A2\u30AF\u30C6\u30A3\u30D6\u30C1\u30E3\u30F3\u30CD\u30EB\u3092\u30B5\u30F3\u30D7\u30EA\u30F3\u30B0\u3057\u307E\u3059\u3002
2. \u73FE\u5728\u306E\u7A93\u95A2\u6570\u3068 FFT \u30B5\u30A4\u30BA\u3092\u4F7F\u3044\u3001\u9078\u629E\u7BC4\u56F2\u5168\u4F53\u3092 50% \u30AA\u30FC\u30D0\u30FC\u30E9\u30C3\u30D7\u306E\u30D5\u30EC\u30FC\u30E0\u306B\u5206\u5272\u3057\u307E\u3059\u3002
3. \u5404\u30D3\u30F3\u306E\u30D1\u30EF\u30FC\u306F re\xB2 + im\xB2 \u3067\u3059\u3002
4. \u5168\u30D5\u30EC\u30FC\u30E0\u3067\u30D3\u30F3\u306E\u30D1\u30EF\u30FC\u3092\u7D2F\u7A4D\u3057\u3001\u5468\u6CE2\u6570\u5E2F\u57DF\u3078\u5272\u308A\u5F53\u3066\u307E\u3059\u3002
5. bandPower / totalPower \xD7 100% \u3092\u8868\u793A\u3057\u307E\u3059\u3002

\u6CE8:
\u3053\u308C\u306F\u9078\u629E\u7BC4\u56F2\u5168\u4F53\u306E\u8907\u6570\u30D5\u30EC\u30FC\u30E0\u306B\u3088\u308B\u30B9\u30DA\u30AF\u30C8\u30EB\u30A8\u30CD\u30EB\u30AE\u30FC\u5206\u5E03\u3067\u3042\u308A\u3001dB/RMS \u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002`,selectionAnalysisCalculating:"\u8A08\u7B97\u4E2D...",bands:"\u5E2F\u57DF",waveform:"\u6CE2\u5F62",spectrogram:"\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0",adjustWaveformHeight:"\u6CE2\u5F62\u306E\u9AD8\u3055\u3092\u8ABF\u6574",adjustSpectrogramHeight:"\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u306E\u9AD8\u3055\u3092\u8ABF\u6574",ready:"\u6E96\u5099\u5B8C\u4E86",workspaceNotTrusted:"\u4FE1\u983C\u3055\u308C\u3066\u3044\u306A\u3044\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u306E\u305F\u3081\u3001\u97F3\u58F0\u5185\u5BB9\u306F\u8EE2\u9001\u3055\u308C\u307E\u305B\u3093",fileTooLarge:"\u30D5\u30A1\u30A4\u30EB\u304C\u4E0A\u9650\u3092\u8D85\u3048\u3066\u3044\u307E\u3059",readingAudio:"\u97F3\u58F0\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D",readingAudioProgress:"\u97F3\u58F0\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D",decodingAudio:"\u97F3\u58F0\u3092\u30C7\u30B3\u30FC\u30C9\u4E2D",transcodingAudio:"FFmpeg \u3067\u97F3\u58F0\u3092\u5909\u63DB\u4E2D",encodedPlaybackOnly:"\u97F3\u58F0\u306E\u30C7\u30B3\u30FC\u30C9\u306B\u5931\u6557\u3057\u307E\u3057\u305F\u3002",emptyWavNoAudio:"WAV \u30D5\u30A1\u30A4\u30EB\u306B\u97F3\u58F0\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093\u3002",waitingPcmParams:"PCM \u30D1\u30E9\u30E1\u30FC\u30BF\u5F85\u6A5F\u4E2D",pcmUsedDefaultParams:"\u65E2\u5B9A\u306E PCM \u30D1\u30E9\u30E1\u30FC\u30BF\u3067\u8AAD\u307F\u8FBC\u307F\u307E\u3057\u305F\u3002",pcmFillParams:"PCM \u30D1\u30E9\u30E1\u30FC\u30BF\u3092\u5165\u529B\u3057\u3066\u304B\u3089\u3001\u8AAD\u307F\u8FBC\u307F\u3092\u30AF\u30EA\u30C3\u30AF\u3057\u3066\u304F\u3060\u3055\u3044\u3002",wavPcmFillParams:"\u30D1\u30E9\u30E1\u30FC\u30BF\u3092\u5165\u529B\u3057\u3066\u304B\u3089\u8AAD\u307F\u8FBC\u307F\u3092\u30AF\u30EA\u30C3\u30AF\u3057\u3001\u73FE\u5728\u306E WAV \u3092 PCM \u3068\u3057\u3066\u89E3\u6790\u3057\u307E\u3059\u3002",currentPcmFormat:"\u73FE\u5728",savedDefaultPcmFormat:"\u4FDD\u5B58\u6E08\u307F\u65E2\u5B9A\u5024",audioLoaded:"\u97F3\u58F0\u3092\u8AAD\u307F\u8FBC\u307F\u307E\u3057\u305F",audioNotReady:"\u97F3\u58F0\u306E\u6E96\u5099\u304C\u3067\u304D\u3066\u3044\u307E\u305B\u3093",audioCannotPlay:"\u3053\u306E\u97F3\u58F0\u306F Webview \u3067\u518D\u751F\u3067\u304D\u307E\u305B\u3093",playbackFailed:"\u518D\u751F\u306B\u5931\u6557\u3057\u307E\u3057\u305F",analyzingSpectrogram:"\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u89E3\u6790\u4E2D",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens \u306E\u521D\u671F\u5316\u306B\u5931\u6557\u3057\u307E\u3057\u305F",trackGain:"\u30B2\u30A4\u30F3",trackPan:"\u30D1\u30F3",panLeft:"L",panRight:"R",panCenter:"C",doubleClickReset:"\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF\u3067\u30EA\u30BB\u30C3\u30C8",freqScaleMenuTitle:"\u30C1\u30E3\u30F3\u30CD\u30EB\u5468\u6CE2\u6570\u30B9\u30B1\u30FC\u30EB",restoreChannelDefault:"\u30C1\u30E3\u30F3\u30CD\u30EB\u65E2\u5B9A\u306B\u623B\u3059",helpAxisGroup:"\u7E26\u8EF8",helpAxisZoom:"\u8EF8\u4E0A\u3067 Ctrl+\u30DB\u30A4\u30FC\u30EB / \u30D4\u30F3\u30C1\uFF1A\u305D\u306E\u8EF8\u3092\u30BA\u30FC\u30E0\uFF08\u30C1\u30E3\u30F3\u30CD\u30EB\u3054\u3068\uFF09",helpAxisPan:"\u8EF8\u4E0A\u3067 Shift+\u30DB\u30A4\u30FC\u30EB / \u6A2A\u30B9\u30EF\u30A4\u30D7\uFF1A\u305D\u306E\u8EF8\u3092\u30D1\u30F3\uFF08\u30C1\u30E3\u30F3\u30CD\u30EB\u3054\u3068\uFF09",helpAxisAlt:"\u6CE2\u5F62\u4E0A\u3067 Alt+\u30DB\u30A4\u30FC\u30EB\uFF1A\u305D\u306E\u30C1\u30E3\u30F3\u30CD\u30EB\u306E\u632F\u5E45\u3092\u30BA\u30FC\u30E0",helpAxisScaleMenu:"\u5468\u6CE2\u6570\u8EF8\u3092\u53F3\u30AF\u30EA\u30C3\u30AF\uFF1A\u3053\u306E\u30C1\u30E3\u30F3\u30CD\u30EB\u306E\u30B9\u30B1\u30FC\u30EB\u3092\u8A2D\u5B9A",helpAxisReset:"\u8EF8\u3092\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF\uFF1A\u3053\u306E\u30C1\u30E3\u30F3\u30CD\u30EB\u3092\u65E2\u5B9A\u306B\u623B\u3059"};var _e={waitingAudioFile:"\uC624\uB514\uC624 \uD30C\uC77C \uB300\uAE30 \uC911",initializing:"\uCD08\uAE30\uD654 \uC911",spectrogramSettings:"Spectrogram \uC124\uC815",playPause:"\uC7AC\uC0DD / \uC77C\uC2DC\uC815\uC9C0",playbackPosition:"\uC7AC\uC0DD \uC704\uCE58",closeSettings:"\uC124\uC815 \uB2EB\uAE30",spectrogramDisplay:"Spectrogram \uD45C\uC2DC",algorithmFrequency:"\uC8FC\uD30C\uC218",windowSize:"\uC708\uB3C4\uC6B0 \uD06C\uAE30",windowType:"\uC708\uB3C4\uC6B0 \uC720\uD615",windowRectangular:"Rectangular",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"\uC81C\uB85C \uD328\uB529 \uACC4\uC218",frequencyScale:"\uC8FC\uD30C\uC218 \uC2A4\uCF00\uC77C",frequencyRange:"\uC8FC\uD30C\uC218 \uBC94\uC704 (\uD45C\uC2DC \uC804\uC6A9)",minFrequencyHz:"\uCD5C\uC18C \uC8FC\uD30C\uC218 (Hz)",maxFrequencyHz:"\uCD5C\uB300 \uC8FC\uD30C\uC218 (Hz)",maxFrequencyNyquist:"\uCD5C\uB300\uAC12\uC744 Nyquist\uC5D0 \uB9DE\uCDA4",spectrogramAppearance:"\uC2A4\uD399\uD2B8\uB85C\uADF8\uB7A8 \uD45C\uC2DC",palette:"\uD314\uB808\uD2B8",paletteRose:"\uC0C9\uC0C1 (rose)",paletteClassic:"\uC0C9\uC0C1 (classic)",paletteGrayscale:"\uADF8\uB808\uC774\uC2A4\uCF00\uC77C",paletteInverseGrayscale:"\uBC18\uC804 \uADF8\uB808\uC774\uC2A4\uCF00\uC77C",minDb:"\uCD5C\uC18C dB (\uBC1D\uAE30)",maxDb:"\uCD5C\uB300 dB (\uBC1D\uAE30)",autoBrightness:"\uC790\uB3D9 \uBC1D\uAE30",amplitudeRange:"\uC9C4\uD3ED \uBC94\uC704(\uD30C\uD615)",minAmplitude:"\uCD5C\uC18C \uC9C4\uD3ED",maxAmplitude:"\uCD5C\uB300 \uC9C4\uD3ED",amplitudeAuto:"\uC790\uB3D9(\uCC44\uB110\uBCC4 \uB9DE\uCDA4)",channel:"\uCC44\uB110",timeZoom:"\uC2DC\uAC04 \uD655\uB300",timePosition:"\uC2DC\uAC04 \uC704\uCE58",mouseWheel:"\uB9C8\uC6B0\uC2A4 \uD720",help:"\uB3C4\uC6C0\uB9D0",downloadAudio:"\uC624\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC",downloadSelection:"\uC120\uD0DD \uC601\uC5ED \uB2E4\uC6B4\uB85C\uB4DC",downloadSelectionWav:"\uC120\uD0DD \uC601\uC5ED\uC744 WAV\uB85C \uB2E4\uC6B4\uB85C\uB4DC",clearSelection:"\uC120\uD0DD \uC601\uC5ED \uC9C0\uC6B0\uAE30",noSelectionToDownload:"\uB2E4\uC6B4\uB85C\uB4DC\uD560 \uC624\uB514\uC624 \uC120\uD0DD \uC601\uC5ED\uC774 \uC5C6\uC2B5\uB2C8\uB2E4",headerInfo:"\uD5E4\uB354 \uC815\uBCF4",headerInfoTitle:"\uD5E4\uB354 \uC815\uBCF4",headerInfoAudioUnread:"\uC624\uB514\uC624 \uB370\uC774\uD130\uB97C \uC544\uC9C1 \uC77D\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.",headerInfoUnsupported:"\uC774 \uD615\uC2DD\uC758 \uD5E4\uB354 \uD30C\uC2F1\uC740 \uC544\uC9C1 \uC9C0\uC6D0\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.",headerInfoOffset:"\uC624\uD504\uC14B",headerInfoByteOffset:"\uBC14\uC774\uD2B8 \uC624\uD504\uC14B",headerInfoSize:"\uAE38\uC774",headerInfoBits:"\uBE44\uD2B8 \uBC94\uC704",headerInfoField:"\uD544\uB4DC",headerInfoValue:"\uAC12",headerInfoDescription:"\uC124\uBA85",headerInfoWavMissingData:"data chunk\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4",headerInfoWavCannotDetermine:"WAV \uD5E4\uB354 \uAE38\uC774\uB97C \uD310\uB2E8\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",headerInfoWavHeaderLength:"WAV \uD5E4\uB354 \uAE38\uC774 {size} B",headerInfoWavStandardPcm:"\uD45C\uC900 44\uBC14\uC774\uD2B8 PCM \uD5E4\uB354\uC785\uB2C8\uB2E4.",headerInfoWavNonStandardPrefix:"44\uBC14\uC774\uD2B8\uAC00 \uC544\uB2CC PCM \uD5E4\uB354",headerInfoWavFmtExtended:"fmt \uCCAD\uD06C\uAC00 {size} B\uC774\uBA70 \uD655\uC7A5 \uD615\uC2DD \uD544\uB4DC\uB97C \uD3EC\uD568\uD569\uB2C8\uB2E4",headerInfoWavFormat:"\uC624\uB514\uC624 \uD615\uC2DD\uC740 {format} ({name})\uC785\uB2C8\uB2E4",headerInfoWavExtraChunks:"data \uC55E\uC5D0 \uCD94\uAC00 \uCCAD\uD06C\uAC00 \uC788\uC2B5\uB2C8\uB2E4: {chunks}",headerInfoWavDataOffsetNon44:"data \uC2DC\uC791 \uC624\uD504\uC14B\uC774 44 B\uAC00 \uC544\uB2D9\uB2C8\uB2E4",headerInfoReasonSeparator:"; ",arkOffsetLabel:"ARK \uC624\uD504\uC14B",settings:"\uC124\uC815",pcmReadAs:"PCM\uC73C\uB85C \uC77D\uAE30",pcmParams:"PCM \uD30C\uC77C \uB9E4\uAC1C\uBCC0\uC218",editPcmParams:"\uB9E4\uAC1C\uBCC0\uC218 \uC218\uC815",wavPcmRead:"WAV\uB97C PCM\uC73C\uB85C \uC77D\uAE30",currentFileOnly:"\uD604\uC7AC \uD30C\uC77C\uB9CC",sampleRate:"\uC0D8\uD50C\uB808\uC774\uD2B8",channels:"\uCC44\uB110 \uC218",startOffsetBytes:"\uC624\uD504\uC14B(B)",bitDepth:"\uC778\uCF54\uB529",sampleFormat:"\uD615\uC2DD",endianness:"\uBC14\uC774\uD2B8 \uC21C\uC11C",read:"\uC77D\uAE30",saveDefault:"\uAE30\uBCF8\uAC12 \uC800\uC7A5",cancel:"\uCDE8\uC18C",defaultView:"\uAE30\uBCF8 \uBCF4\uAE30",view:"\uBCF4\uAE30",viewBoth:"\uBA40\uD2F0\uBDF0",mute:"\uC74C\uC18C\uAC70",solo:"\uC194\uB85C",timeLabel:"\uC2DC\uAC04",helpTimeZoom:"\uC2DC\uAC04 \uD655\uB300",helpTimePan:"\uC2DC\uAC04 \uC774\uB3D9",helpAmplitudeZoom:"\uC9C4\uD3ED \uD655\uB300",helpRightClick:"\uC624\uB978\uCABD \uD074\uB9AD",helpPinch:"\uD540\uCE58",helpHorizontalSwipe:"\uAC00\uB85C \uC2A4\uC640\uC774\uD504",helpDoubleClick:"\uB354\uBE14 \uD074\uB9AD",helpPlaybackGroup:"\uC7AC\uC0DD \uBC0F \uC120\uD0DD",helpViewGroup:"\uBCF4\uAE30 \uD0D0\uC0C9",helpMouseGroup:"\uB9C8\uC6B0\uC2A4 \uBC0F \uD2B8\uB799\uD328\uB4DC",helpGainGroup:"\uAC8C\uC778 \uBC0F \uD32C",helpPlayPause:"\uC7AC\uC0DD / \uC77C\uC2DC\uC815\uC9C0",helpClearSelection:"\uBA54\uB274 \uB2EB\uAE30, \uC120\uD0DD \uD574\uC81C \uB610\uB294 \uC7AC\uC0DD \uCEE4\uC11C \uCD08\uAE30\uD654",helpResetTimeZoom:"\uC2DC\uAC04 \uD655\uB300 \uCD08\uAE30\uD654",helpTrackpadZoom:"\uD2B8\uB799\uD328\uB4DC \uD540\uCE58\uB85C \uC2DC\uAC04 \uD655\uB300/\uCD95\uC18C",helpTrackpadPan:"\uD2B8\uB799\uD328\uB4DC \uAC00\uB85C \uC2A4\uC640\uC774\uD504\uB85C \uC2DC\uAC04 \uC774\uB3D9",helpGainReset:"\uCC44\uB110\uC758 \uAC8C\uC778/\uD32C \uC2AC\uB77C\uC774\uB354\uB97C \uB354\uBE14 \uD074\uB9AD\uD558\uBA74 \uCD08\uAE30\uD654\uB429\uB2C8\uB2E4",helpSelectionPlayback:"\uD30C\uD615 \uB610\uB294 \uC2A4\uD399\uD2B8\uB85C\uADF8\uB7A8\uC744 \uB4DC\uB798\uADF8\uD558\uC5EC \uAD6C\uAC04\uC744 \uC120\uD0DD\uD569\uB2C8\uB2E4. \uC120\uD0DD \uAD6C\uAC04\uC774 \uC788\uC73C\uBA74 \uD574\uB2F9 \uBC94\uC704\uB9CC \uC7AC\uC0DD\uD569\uB2C8\uB2E4.",refreshSpectrogram:"Spectrogram \uC0C8\uB85C\uACE0\uCE68",resetView:"\uBCF4\uAE30 \uCD08\uAE30\uD654",selectionAnalysis:"\uC120\uD0DD \uBD84\uC11D",selectionStart:"\uC2DC\uC791",selectionEnd:"\uB05D",selectionDuration:"\uAE38\uC774",rmsLevel:"RMS \uB808\uBCA8",peakLevel:"\uD53C\uD06C \uB808\uBCA8",dominant:"\uC8FC\uC694",crestFactor:"\uD06C\uB808\uC2A4\uD2B8",clippingRatio:"\uD074\uB9AC\uD551",noiseFloor:"\uB178\uC774\uC988 \uD50C\uB85C\uC5B4",spectralCentroid:"\uC911\uC2EC",zeroCrossingRate:"ZCR",basicMetrics:"\uAE30\uBCF8 \uC9C0\uD45C",selectionAnalysisHelp:`\uC120\uD0DD \uBD84\uC11D:
\uC120\uD0DD\uD55C \uC2DC\uAC04 \uBC94\uC704\uC758 \uB808\uBCA8, \uB2E4\uC774\uB0B4\uBBF9 \uB808\uC778\uC9C0, \uD074\uB9AC\uD551 \uC704\uD5D8, \uB178\uC774\uC988 \uD50C\uB85C\uC5B4, \uC8FC\uD30C\uC218 \uBD84\uD3EC\uB97C \uBE60\uB974\uAC8C \uD655\uC778\uD569\uB2C8\uB2E4.

\uBC94\uC704:
\uACB0\uACFC\uB294 \uD65C\uC131 \uCC44\uB110\uB9CC \uACC4\uC0B0\uD558\uBA70 \uC5EC\uB7EC \uCC44\uB110\uC744 \uBBF9\uC2A4\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.

\uCC44\uB110 \uC804\uD658:
\uD2B8\uB799\uC744 \uD074\uB9AD\uD558\uBA74 \uD574\uB2F9 \uD2B8\uB799\uC774 \uD65C\uC131 \uCC44\uB110\uC774 \uB429\uB2C8\uB2E4.`,rmsLevelHelp:`RMS \uB808\uBCA8:
\uC120\uD0DD \uAD6C\uAC04\uC758 \uD3C9\uADE0 \uC5D0\uB108\uC9C0\uB97C \uB098\uD0C0\uB0C5\uB2C8\uB2E4. peak\uBCF4\uB2E4 \uC548\uC815\uC801\uC774\uBA70 \uC74C\uC131\uC774 \uB108\uBB34 \uC791\uAC70\uB098 \uD070\uC9C0 \uD655\uC778\uD560 \uB54C \uC720\uC6A9\uD569\uB2C8\uB2E4.`,peakLevelHelp:`\uD53C\uD06C \uB808\uBCA8:
\uC120\uD0DD \uAD6C\uAC04\uC5D0\uC11C \uAC00\uC7A5 \uD070 \uC21C\uAC04 \uB808\uBCA8\uC785\uB2C8\uB2E4. 0 dBFS \uB610\uB294 \uD074\uB9AC\uD551 \uC704\uD5D8\uC5D0 \uAC00\uAE4C\uC6B4\uC9C0 \uD655\uC778\uD560 \uB54C \uC720\uC6A9\uD569\uB2C8\uB2E4.`,dominantHelp:`\uC8FC\uC694 \uC8FC\uD30C\uC218:
\uC120\uD0DD \uAD6C\uAC04\uC5D0\uC11C \uB204\uC801 \uD30C\uC6CC\uAC00 \uAC00\uC7A5 \uD070 FFT bin\uC758 \uC8FC\uD30C\uC218\uC785\uB2C8\uB2E4. \uBC18\uB4DC\uC2DC \uAE30\uBCF8 \uC8FC\uD30C\uC218\uB098 \uC9C0\uAC01\uB418\uB294 pitch\uB294 \uC544\uB2D9\uB2C8\uB2E4.`,crestFactorHelp:`\uD06C\uB808\uC2A4\uD2B8 \uD329\uD130:
peak\uC640 RMS\uC758 \uBE44\uC728\uC785\uB2C8\uB2E4. \uD070 \uAC12\uC740 \uD3C9\uADE0 \uC5D0\uB108\uC9C0\uBCF4\uB2E4 \uD53C\uD06C\uAC00 \uB354 \uB450\uB4DC\uB7EC\uC9D0\uC744 \uC758\uBBF8\uD569\uB2C8\uB2E4.`,clippingRatioHelp:`\uD074\uB9AC\uD551 \uBE44\uC728:
\uD480\uC2A4\uCF00\uC77C\uC5D0 \uAC00\uAE4C\uC6B4 \uC0D8\uD50C\uC758 \uBE44\uC728\uC785\uB2C8\uB2E4. \uB179\uC74C \uACFC\uBD80\uD558\uB098 \uB514\uC9C0\uD138 \uD074\uB9AC\uD551 \uC704\uD5D8\uC744 \uBE60\uB974\uAC8C \uD655\uC778\uD569\uB2C8\uB2E4.`,noiseFloorHelp:`\uB178\uC774\uC988 \uD50C\uB85C\uC5B4:
\uC9E7\uC740 RMS \uCC3D\uC758 \uB0AE\uC740 \uD37C\uC13C\uD0C0\uC77C\uB85C \uBC30\uACBD \uB178\uC774\uC988\uB97C \uCD94\uC815\uD569\uB2C8\uB2E4. \uC120\uD0DD \uAD6C\uAC04\uC774 \uB300\uBD80\uBD84 \uC74C\uC131\uC774\uB098 \uC74C\uC545\uC774\uBA74 \uC2E4\uC81C \uB178\uC774\uC988 \uD50C\uB85C\uC5B4\uC640 \uB2E4\uB97C \uC218 \uC788\uC2B5\uB2C8\uB2E4.`,spectralCentroidHelp:`\uC2A4\uD399\uD2B8\uB7FC \uC911\uC2EC:
\uC2A4\uD399\uD2B8\uB7FC \uC5D0\uB108\uC9C0\uC758 \uC911\uC2EC\uC744 Hz\uB85C \uB098\uD0C0\uB0C5\uB2C8\uB2E4. \uC18C\uB9AC\uAC00 \uBC1D\uC740\uC9C0 \uC5B4\uB450\uC6B4\uC9C0 \uBCF4\uB294 \uB370 \uC720\uC6A9\uD569\uB2C8\uB2E4.`,zeroCrossingRateHelp:`\uC601\uAD50\uCC28\uC728:
\uC2E0\uD638 \uBD80\uD638\uAC00 \uBC14\uB00C\uB294 \uBE44\uC728\uC785\uB2C8\uB2E4. \uACE0\uC8FC\uD30C \uB178\uC774\uC988, \uBB34\uC131\uC74C, \uB9C8\uCC30\uC74C \uD655\uC778\uC5D0 \uC720\uC6A9\uD55C \uC2DC\uAC04 \uC601\uC5ED \uD2B9\uC9D5\uC785\uB2C8\uB2E4.`,frequencyAnalysis:"\uC8FC\uD30C\uC218 \uBD84\uC11D",frequencyAnalysisHelp:`\uC758\uBBF8:
\uC8FC\uD30C\uC218 \uB300\uC5ED\uBCC4 \uC120\uD615 \uC5D0\uB108\uC9C0 \uBE44\uC728\uC785\uB2C8\uB2E4. RMS \uB808\uBCA8\uC774\uB098 dB\uAC00 \uC544\uB2D9\uB2C8\uB2E4.

\uACC4\uC0B0:
\uC120\uD0DD \uAD6C\uAC04 \uC804\uCCB4\uB97C 50% overlap frame\uC73C\uB85C \uB098\uB204\uACE0, \uAC01 FFT bin\uC758 power\uB97C \uB204\uC801\uD55C \uB4A4 \uB300\uC5ED\uBCC4 \uBE44\uC728\uC744 \uD45C\uC2DC\uD569\uB2C8\uB2E4.`,selectionAnalysisCalculating:"\uACC4\uC0B0 \uC911...",bands:"\uB300\uC5ED",waveform:"\uD30C\uD615",spectrogram:"Spectrogram",adjustWaveformHeight:"\uD30C\uD615 \uB192\uC774 \uC870\uC815",adjustSpectrogramHeight:"Spectrogram \uB192\uC774 \uC870\uC815",ready:"\uC900\uBE44\uB428",workspaceNotTrusted:"\uC2E0\uB8B0\uB418\uC9C0 \uC54A\uC740 \uC791\uC5C5 \uC601\uC5ED",fileTooLarge:"\uD30C\uC77C \uD55C\uB3C4 \uCD08\uACFC",readingAudio:"\uC624\uB514\uC624 \uC77D\uB294 \uC911",readingAudioProgress:"\uC624\uB514\uC624 \uC77D\uB294 \uC911",decodingAudio:"\uC624\uB514\uC624 \uB514\uCF54\uB529 \uC911",transcodingAudio:"FFmpeg\uB85C \uC624\uB514\uC624 \uBCC0\uD658 \uC911",encodedPlaybackOnly:"\uC624\uB514\uC624 \uB514\uCF54\uB529\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"PCM \uB9E4\uAC1C\uBCC0\uC218 \uB300\uAE30 \uC911",pcmUsedDefaultParams:"\uAE30\uBCF8 PCM \uB9E4\uAC1C\uBCC0\uC218\uB85C \uB85C\uB4DC\uD588\uC2B5\uB2C8\uB2E4.",pcmFillParams:"PCM \uB9E4\uAC1C\uBCC0\uC218\uB97C \uC785\uB825\uD55C \uB4A4 \uC77D\uAE30\uB97C \uD074\uB9AD\uD558\uC138\uC694.",wavPcmFillParams:"\uB9E4\uAC1C\uBCC0\uC218\uB97C \uC785\uB825\uD55C \uB4A4 \uC77D\uAE30\uB97C \uD074\uB9AD\uD558\uC5EC \uD604\uC7AC WAV\uB97C PCM\uC73C\uB85C \uD574\uC11D\uD558\uC138\uC694.",currentPcmFormat:"\uD604\uC7AC",savedDefaultPcmFormat:"\uC800\uC7A5\uB41C \uAE30\uBCF8\uAC12",audioLoaded:"\uC624\uB514\uC624 \uB85C\uB4DC\uB428",audioNotReady:"\uC624\uB514\uC624\uAC00 \uC900\uBE44\uB418\uC9C0 \uC54A\uC74C",audioCannotPlay:"\uC774 \uC624\uB514\uC624\uB294 Webview\uC5D0\uC11C \uC7AC\uC0DD\uD560 \uC218 \uC5C6\uC74C",playbackFailed:"\uC7AC\uC0DD \uC2E4\uD328",analyzingSpectrogram:"Spectrogram \uBD84\uC11D \uC911",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens \uCD08\uAE30\uD654 \uC2E4\uD328",trackGain:"\uAC8C\uC778",trackPan:"\uD32C",panLeft:"L",panRight:"R",panCenter:"C",doubleClickReset:"\uB354\uBE14 \uD074\uB9AD\uD558\uC5EC \uCD08\uAE30\uD654",freqScaleMenuTitle:"\uCC44\uB110 \uC8FC\uD30C\uC218 \uC2A4\uCF00\uC77C",restoreChannelDefault:"\uCC44\uB110 \uAE30\uBCF8\uAC12 \uBCF5\uC6D0",helpAxisGroup:"\uC138\uB85C\uCD95",helpAxisZoom:"\uCD95\uC5D0\uC11C Ctrl+\uD720 / \uD540\uCE58: \uD574\uB2F9 \uCD95 \uD655\uB300(\uCC44\uB110\uBCC4)",helpAxisPan:"\uCD95\uC5D0\uC11C Shift+\uD720 / \uAC00\uB85C \uC2A4\uC640\uC774\uD504: \uD574\uB2F9 \uCD95 \uC774\uB3D9(\uCC44\uB110\uBCC4)",helpAxisAlt:"\uD30C\uD615\uC5D0\uC11C Alt+\uD720: \uD574\uB2F9 \uCC44\uB110 \uC9C4\uD3ED \uD655\uB300",helpAxisScaleMenu:"\uC8FC\uD30C\uC218 \uCD95 \uC6B0\uD074\uB9AD: \uC774 \uCC44\uB110\uC758 \uC2A4\uCF00\uC77C \uC124\uC815",helpAxisReset:"\uCD95 \uB354\uBE14\uD074\uB9AD: \uC774 \uCC44\uB110 \uAE30\uBCF8\uAC12 \uBCF5\uC6D0"};var $e={waitingAudioFile:"Wacht op audiobestand",initializing:"Initialiseren",spectrogramSettings:"Spectrograminstellingen",playPause:"Afspelen / pauze",playbackPosition:"Afspeelpositie",closeSettings:"Instellingen sluiten",spectrogramDisplay:"Spectrogramweergave",algorithmFrequency:"Frequentie",windowSize:"Venstergrootte",windowType:"Venstertype",windowRectangular:"Rechthoekig",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"Zero-paddingfactor",frequencyScale:"Frequentieschaal",frequencyRange:"Frequentiebereik (alleen weergave)",minFrequencyHz:"Min. frequentie (Hz)",maxFrequencyHz:"Max. frequentie (Hz)",maxFrequencyNyquist:"Max volgt Nyquist",spectrogramAppearance:"Spectrogramweergave",palette:"Palet",paletteRose:"Roos",paletteClassic:"Klassiek",paletteGrayscale:"Grijswaarden",paletteInverseGrayscale:"Omgekeerde grijswaarden",minDb:"Min dB (helderheid)",maxDb:"Max dB (helderheid)",autoBrightness:"Auto-helderheid",amplitudeRange:"Amplitudebereik (golf)",minAmplitude:"Min amplitude",maxAmplitude:"Max amplitude",amplitudeAuto:"Auto (per kanaal)",channel:"Kanaal",timeZoom:"Tijdzoom",timePosition:"Tijdpositie",mouseWheel:"Muiswiel",help:"Help",downloadAudio:"Audio downloaden",downloadSelection:"Selectie downloaden",downloadSelectionWav:"Selectie als WAV downloaden",clearSelection:"Selectie wissen",noSelectionToDownload:"Geen audioselectie om te downloaden",headerInfo:"Headerinformatie",headerInfoTitle:"Headerinformatie",headerInfoAudioUnread:"Audiogegevens zijn nog niet gelezen.",headerInfoUnsupported:"Headeranalyse wordt voor dit formaat nog niet ondersteund.",headerInfoOffset:"Offset",headerInfoByteOffset:"Byte-offset",headerInfoSize:"Lengte",headerInfoBits:"Bits",headerInfoField:"Veld",headerInfoValue:"Waarde",headerInfoDescription:"Beschrijving",headerInfoWavMissingData:"data-chunk niet gevonden",headerInfoWavCannotDetermine:"Kan WAV-headerlengte niet bepalen.",headerInfoWavHeaderLength:"WAV-headerlengte {size} B",headerInfoWavStandardPcm:"Standaard PCM-header van 44 bytes.",headerInfoWavNonStandardPrefix:"Niet-standaard PCM-header van 44 bytes",headerInfoWavFmtExtended:"fmt-chunk is {size} B en bevat uitgebreide formaatvelden",headerInfoWavFormat:"audioformaat is {format} ({name})",headerInfoWavExtraChunks:"extra chunk(s) v\xF3\xF3r data: {chunks}",headerInfoWavDataOffsetNon44:"data begint op een andere offset dan 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"ARK-offset",settings:"Instellingen",pcmReadAs:"Als PCM lezen",pcmParams:"PCM-bestandsparameters",editPcmParams:"Parameters bewerken",wavPcmRead:"WAV als PCM lezen",currentFileOnly:"Alleen huidig bestand",sampleRate:"Samplefrequentie",channels:"Kanalen",startOffsetBytes:"Offset (B)",bitDepth:"Codering",sampleFormat:"Formaat",endianness:"Byte order",read:"Lezen",saveDefault:"Standaard opslaan",cancel:"Annuleren",defaultView:"Standaardweergave",view:"Weergave",viewBoth:"Multi-weergave",mute:"Dempen",solo:"Solo",timeLabel:"Tijd",helpTimeZoom:"Tijdzoom",helpTimePan:"Tijd verschuiven",helpAmplitudeZoom:"Amplitudezoom",helpRightClick:"Rechtsklik",helpPinch:"Knijpen",helpHorizontalSwipe:"Horizontaal vegen",helpDoubleClick:"Dubbelklik",helpPlaybackGroup:"Afspelen en selectie",helpViewGroup:"Weergavenavigatie",helpMouseGroup:"Muis en trackpad",helpGainGroup:"Gain & panning",helpPlayPause:"Afspelen / pauze",helpClearSelection:"Menu sluiten, selectie wissen of afspeelcursor resetten",helpResetTimeZoom:"Tijdzoom resetten",helpTrackpadZoom:"Knijp op trackpad om tijd te zoomen",helpTrackpadPan:"Horizontale trackpad-swipe verschuift tijd",helpGainReset:"Dubbelklik een gain- of panningschuif om te resetten",helpSelectionPlayback:"Sleep over golfvorm of spectrogram om een segment te selecteren. Met actieve selectie wordt alleen dat bereik afgespeeld.",refreshSpectrogram:"Spectrogram verversen",resetView:"Weergave resetten",selectionAnalysis:"Selectieanalyse",selectionStart:"Start",selectionEnd:"Einde",selectionDuration:"Duur",rmsLevel:"RMS-niveau",peakLevel:"Peak-niveau",dominant:"Dominant",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"Ruisvloer",spectralCentroid:"Centroid",zeroCrossingRate:"ZCR",basicMetrics:"Basismetingen",selectionAnalysisHelp:`Selectieanalyse:
Analyseert snel het geselecteerde tijdsbereik voor niveau, dynamiek, clippingrisico, ruisvloer en frequentieverdeling.

Bereik:
Resultaten worden alleen voor het actieve kanaal berekend; kanalen worden niet gemixt.

Kanaal wisselen:
Klik op een spoor om het actief te maken.`,rmsLevelHelp:`RMS-niveau:
Toont gemiddelde energie in de selectie. Stabieler dan peak en nuttig voor te zachte of te luide spraak.`,peakLevelHelp:`Peak-niveau:
Toont het hoogste momentane niveau in de selectie. Nuttig voor nabijheid van 0 dBFS en clippingrisico.`,dominantHelp:`Dominante frequentie:
FFT-bin met de hoogste opgetelde power in de selectie. Dit is niet noodzakelijk de grondtoon of waargenomen toonhoogte.`,crestFactorHelp:`Crest factor:
Verhouding tussen peak en RMS. Hogere waarden betekenen sterkere pieken ten opzichte van gemiddelde energie.`,clippingRatioHelp:`Clippingratio:
Percentage samples dicht bij full scale. Helpt overbelasting of digitale clipping snel te detecteren.`,noiseFloorHelp:`Ruisvloer:
Geschat uit een laag percentiel van korte RMS-vensters. Bij vooral spraak of muziek kan dit afwijken van de echte ruisvloer.`,spectralCentroidHelp:`Spectrale centroid:
Zwaartepunt van spectrale energie in Hz. Geeft aan of geluid helderder of donkerder is.`,zeroCrossingRateHelp:`Zero-crossing-rate:
Hoe vaak het signaal van teken wisselt. Nuttig voor hoogfrequente ruis, stemloze spraak en fricatieven.`,frequencyAnalysis:"Frequentieanalyse",frequencyAnalysisHelp:`Betekenis:
Lineair energiepercentage per frequentieband. Het is geen RMS-niveau en geen dB.

Berekening:
De selectie wordt in frames met 50% overlap verdeeld. FFT-bin-power wordt opgeteld en aan frequentiebanden toegewezen.`,selectionAnalysisCalculating:"Berekenen...",bands:"Banden",waveform:"Golfvorm",spectrogram:"Spectrogram",adjustWaveformHeight:"Golfvormhoogte aanpassen",adjustSpectrogramHeight:"Spectrogramhoogte aanpassen",ready:"Klaar",workspaceNotTrusted:"Werkruimte niet vertrouwd; audio-inhoud wordt niet overgedragen",fileTooLarge:"Bestand overschrijdt limiet",readingAudio:"Audio lezen",readingAudioProgress:"Audio lezen",decodingAudio:"Audio decoderen",transcodingAudio:"Audio transcoderen met FFmpeg",encodedPlaybackOnly:"Audiodecodering mislukt.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"Wachten op PCM-parameters",pcmUsedDefaultParams:"Geladen met standaard PCM-parameters.",pcmFillParams:"Vul PCM-parameters in en klik op Lezen.",wavPcmFillParams:"Vul parameters in en klik op Lezen om de huidige WAV als PCM te parsen.",currentPcmFormat:"Huidig",savedDefaultPcmFormat:"Opgeslagen standaard",audioLoaded:"Audio geladen",audioNotReady:"Audio is niet klaar",audioCannotPlay:"Deze audio kan niet in de webview worden afgespeeld",playbackFailed:"Afspelen mislukt",analyzingSpectrogram:"Spectrogram analyseren",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens-initialisatie mislukt",trackGain:"Gain",trackPan:"Panning",panLeft:"L",panRight:"R",panCenter:"M",doubleClickReset:"Dubbelklik om te resetten",freqScaleMenuTitle:"Kanaal-frequentieschaal",restoreChannelDefault:"Kanaalstandaard herstellen",helpAxisGroup:"Verticale as",helpAxisZoom:"Ctrl + wiel / pinch op een as: die as zoomen (per kanaal)",helpAxisPan:"Shift + wiel / horizontaal vegen op een as: die as pannen (per kanaal)",helpAxisAlt:"Alt + wiel op een golfvorm: amplitude van het kanaal zoomen",helpAxisScaleMenu:"Rechtsklik op de frequentie-as: schaal van dit kanaal instellen",helpAxisReset:"Dubbelklik op een as: kanaalstandaard herstellen"};var Xe={waitingAudioFile:"Venter p\xE5 lydfil",initializing:"Initialiserer",spectrogramSettings:"Spectrogram-innstillinger",playPause:"Spill av / pause",playbackPosition:"Avspillingsposisjon",closeSettings:"Lukk innstillinger",spectrogramDisplay:"Spectrogram-visning",algorithmFrequency:"Frekvens",windowSize:"Vindust\xF8rrelse",windowType:"Vindustype",windowRectangular:"Rektangul\xE6r",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"Nullutfyllingsfaktor",frequencyScale:"Frekvensskala",frequencyRange:"Frekvensomr\xE5de (kun visning)",minFrequencyHz:"Min. frekvens (Hz)",maxFrequencyHz:"Maks. frekvens (Hz)",maxFrequencyNyquist:"Maks f\xF8lger Nyquist",spectrogramAppearance:"Spectrogram-utseende",palette:"Palett",paletteRose:"Rose",paletteClassic:"Klassisk",paletteGrayscale:"Gr\xE5toner",paletteInverseGrayscale:"Inverterte gr\xE5toner",minDb:"Min dB (lysstyrke)",maxDb:"Maks dB (lysstyrke)",autoBrightness:"Auto-lysstyrke",amplitudeRange:"Amplitudeomr\xE5de (b\xF8lge)",minAmplitude:"Min amplitude",maxAmplitude:"Maks amplitude",amplitudeAuto:"Auto (per kanal)",channel:"Kanal",timeZoom:"Tidszoom",timePosition:"Tidsposisjon",mouseWheel:"Musehjul",help:"Hjelp",downloadAudio:"Last ned lyd",downloadSelection:"Last ned utvalg",downloadSelectionWav:"Last ned utvalg som WAV",clearSelection:"Fjern utvalg",noSelectionToDownload:"Ingen lydutvalg \xE5 laste ned",headerInfo:"Headerinfo",headerInfoTitle:"Headerinfo",headerInfoAudioUnread:"Lyddata er ikke lest enn\xE5.",headerInfoUnsupported:"Headeranalyse st\xF8ttes ikke for dette formatet enn\xE5.",headerInfoOffset:"Offset",headerInfoByteOffset:"Byte-offset",headerInfoSize:"Lengde",headerInfoBits:"Bits",headerInfoField:"Felt",headerInfoValue:"Verdi",headerInfoDescription:"Beskrivelse",headerInfoWavMissingData:"data-chunk ikke funnet",headerInfoWavCannotDetermine:"Kan ikke bestemme WAV-headerlengde.",headerInfoWavHeaderLength:"WAV-headerlengde {size} B",headerInfoWavStandardPcm:"Standard 44-byte PCM-header.",headerInfoWavNonStandardPrefix:"Ikke-standard PCM-header som ikke er 44 byte",headerInfoWavFmtExtended:"fmt-chunk er {size} B og inneholder utvidede formatfelt",headerInfoWavFormat:"lydformatet er {format} ({name})",headerInfoWavExtraChunks:"ekstra chunk(er) f\xF8r data: {chunks}",headerInfoWavDataOffsetNon44:"data starter p\xE5 en annen offset enn 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"ARK-offset",settings:"Innstillinger",pcmReadAs:"Les som PCM",pcmParams:"PCM-filparametere",editPcmParams:"Rediger parametere",wavPcmRead:"Les WAV som PCM",currentFileOnly:"Bare gjeldende fil",sampleRate:"Samplingsrate",channels:"Kanaler",startOffsetBytes:"Offset (B)",bitDepth:"Koding",sampleFormat:"Format",endianness:"Byte order",read:"Les",saveDefault:"Lagre standard",cancel:"Avbryt",defaultView:"Standardvisning",view:"Visning",viewBoth:"Flervisning",mute:"Demp",solo:"Solo",timeLabel:"Tid",helpTimeZoom:"Tidszoom",helpTimePan:"Tidspanorering",helpAmplitudeZoom:"Amplitudezoom",helpRightClick:"H\xF8yreklikk",helpPinch:"Knip",helpHorizontalSwipe:"Horisontal sveip",helpDoubleClick:"Dobbeltklikk",helpPlaybackGroup:"Avspilling og utvalg",helpViewGroup:"Visningsnavigasjon",helpMouseGroup:"Mus og styreflate",helpGainGroup:"Gain og panorering",helpPlayPause:"Spill av / pause",helpClearSelection:"Lukk meny, fjern utvalg eller tilbakestill avspillingsmark\xF8r",helpResetTimeZoom:"Tilbakestill tidszoom",helpTrackpadZoom:"Knip p\xE5 styreflaten for \xE5 zoome tid",helpTrackpadPan:"Horisontal sveip p\xE5 styreflaten flytter tid",helpGainReset:"Dobbeltklikk en gain- eller panoreringsglidebryter for \xE5 tilbakestille den",helpSelectionPlayback:"Dra i b\xF8lgeform eller spectrogram for \xE5 velge et segment. Med aktivt utvalg spilles bare dette omr\xE5det.",refreshSpectrogram:"Oppdater spectrogram",resetView:"Tilbakestill visning",selectionAnalysis:"Utvalgsanalyse",selectionStart:"Start",selectionEnd:"Slutt",selectionDuration:"Varighet",rmsLevel:"RMS-niv\xE5",peakLevel:"Peak-niv\xE5",dominant:"Dominant",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"St\xF8ygulv",spectralCentroid:"Centroid",zeroCrossingRate:"ZCR",basicMetrics:"Grunnm\xE5linger",selectionAnalysisHelp:`Utvalgsanalyse:
Analyserer valgt tidsomr\xE5de for niv\xE5, dynamikk, clipping-risiko, st\xF8ygulv og frekvensfordeling.

Omfang:
Resultater beregnes bare for aktiv kanal; kanaler mikses ikke.

Bytt kanal:
Klikk p\xE5 et spor for \xE5 gj\xF8re det aktivt.`,rmsLevelHelp:`RMS-niv\xE5:
Viser gjennomsnittlig energi i utvalget. Mer stabilt enn peak og nyttig for \xE5 sjekke tale som er for lav eller h\xF8y.`,peakLevelHelp:`Peak-niv\xE5:
Viser h\xF8yeste \xF8yeblikksniv\xE5 i utvalget. Nyttig for \xE5 sjekke n\xE6rhet til 0 dBFS og clipping-risiko.`,dominantHelp:`Dominant frekvens:
FFT-bin med h\xF8yest akkumulert effekt i utvalget. Det er ikke n\xF8dvendigvis grunntone eller oppfattet pitch.`,crestFactorHelp:`Crest factor:
Forholdet mellom peak og RMS. H\xF8yere verdier betyr tydeligere topper mot gjennomsnittsenergien.`,clippingRatioHelp:`Clipping-andel:
Prosentandel samples n\xE6r full skala. Hjelper \xE5 oppdage overstyring og digital clipping.`,noiseFloorHelp:`St\xF8ygulv:
Estimert fra lav persentil av korttids-RMS. Hvis utvalget mest er tale eller musikk, kan verdien avvike fra faktisk st\xF8ygulv.`,spectralCentroidHelp:`Spektral centroid:
Tyngdepunktet til spektral energi i Hz. Indikerer om lyden heller mot lys eller m\xF8rk.`,zeroCrossingRateHelp:`Zero crossing rate:
Hvor ofte signalet skifter fortegn. Nyttig for h\xF8yfrekvent st\xF8y, ustemt tale og frikativer.`,frequencyAnalysis:"Frekvensanalyse",frequencyAnalysisHelp:`Betydning:
Line\xE6r energiprosent per frekvensb\xE5nd. Det er ikke RMS-niv\xE5 og ikke dB.

Beregning:
Utvalget deles i rammer med 50% overlapp. FFT-bin-effekt akkumuleres og fordeles p\xE5 frekvensb\xE5nd.`,selectionAnalysisCalculating:"Beregner...",bands:"B\xE5nd",waveform:"B\xF8lgeform",spectrogram:"Spectrogram",adjustWaveformHeight:"Juster b\xF8lgeformh\xF8yde",adjustSpectrogramHeight:"Juster spectrogram-h\xF8yde",ready:"Klar",workspaceNotTrusted:"Arbeidsomr\xE5det er ikke klarert; lydinnhold overf\xF8res ikke",fileTooLarge:"Filen overskrider grensen",readingAudio:"Leser lyd",readingAudioProgress:"Leser lyd",decodingAudio:"Dekoder lyd",transcodingAudio:"Transkoder lyd med FFmpeg",encodedPlaybackOnly:"Lyddekoding mislyktes.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"Venter p\xE5 PCM-parametere",pcmUsedDefaultParams:"Lastet med standard PCM-parametere.",pcmFillParams:"Fyll inn PCM-parametere og klikk Les.",wavPcmFillParams:"Fyll inn parametere og klikk Les for \xE5 tolke gjeldende WAV som PCM.",currentPcmFormat:"Gjeldende",savedDefaultPcmFormat:"Lagret standard",audioLoaded:"Lyd lastet",audioNotReady:"Lyden er ikke klar",audioCannotPlay:"Denne lyden kan ikke spilles av i webview",playbackFailed:"Avspilling mislyktes",analyzingSpectrogram:"Analyserer spectrogram",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens-initialisering mislyktes",trackGain:"Gain",trackPan:"Panorering",panLeft:"V",panRight:"H",panCenter:"M",doubleClickReset:"Dobbeltklikk for \xE5 tilbakestille",freqScaleMenuTitle:"Kanalens frekvensskala",restoreChannelDefault:"Tilbakestill kanalstandard",helpAxisGroup:"Vertikal akse",helpAxisZoom:"Ctrl + hjul / knip p\xE5 en akse: zoom den aksen (per kanal)",helpAxisPan:"Shift + hjul / horisontal sveip p\xE5 en akse: panorer den aksen (per kanal)",helpAxisAlt:"Alt + hjul p\xE5 en b\xF8lgeform: zoom kanalens amplitude",helpAxisScaleMenu:"H\xF8yreklikk frekvensaksen: sett kanalens skala",helpAxisReset:"Dobbeltklikk en akse: tilbakestill kanalstandard"};var Ye={waitingAudioFile:"Oczekiwanie na plik audio",initializing:"Inicjalizacja",spectrogramSettings:"Ustawienia spektrogramu",playPause:"Odtw\xF3rz / pauza",playbackPosition:"Pozycja odtwarzania",closeSettings:"Zamknij ustawienia",spectrogramDisplay:"Widok spektrogramu",algorithmFrequency:"Cz\u0119stotliwo\u015B\u0107",windowSize:"Rozmiar okna",windowType:"Typ okna",windowRectangular:"Prostok\u0105tne",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussowskie (\u03B1=2.5)",windowGaussian35:"Gaussowskie (\u03B1=3.5)",windowGaussian45:"Gaussowskie (\u03B1=4.5)",zeroPaddingFactor:"Wsp\xF3\u0142czynnik zero padding",frequencyScale:"Skala cz\u0119stotliwo\u015Bci",frequencyRange:"Zakres cz\u0119stotliwo\u015Bci (tylko widok)",minFrequencyHz:"Min. cz\u0119stotliwo\u015B\u0107 (Hz)",maxFrequencyHz:"Maks. cz\u0119stotliwo\u015B\u0107 (Hz)",maxFrequencyNyquist:"Maks. wg Nyquista",spectrogramAppearance:"Wygl\u0105d spektrogramu",palette:"Paleta",paletteRose:"R\xF3\u017C",paletteClassic:"Klasyczna",paletteGrayscale:"Skala szaro\u015Bci",paletteInverseGrayscale:"Odwr\xF3cona szaro\u015B\u0107",minDb:"Min. dB (jasno\u015B\u0107)",maxDb:"Maks. dB (jasno\u015B\u0107)",autoBrightness:"Auto-jasno\u015B\u0107",amplitudeRange:"Zakres amplitudy (fala)",minAmplitude:"Min amplituda",maxAmplitude:"Maks amplituda",amplitudeAuto:"Auto (na kana\u0142)",channel:"Kana\u0142",timeZoom:"Powi\u0119kszenie czasu",timePosition:"Pozycja czasu",mouseWheel:"K\xF3\u0142ko myszy",help:"Pomoc",downloadAudio:"Pobierz audio",downloadSelection:"Pobierz zaznaczenie",downloadSelectionWav:"Pobierz zaznaczenie jako WAV",clearSelection:"Wyczy\u015B\u0107 zaznaczenie",noSelectionToDownload:"Brak zaznaczenia audio do pobrania",headerInfo:"Informacje nag\u0142\xF3wka",headerInfoTitle:"Informacje nag\u0142\xF3wka",headerInfoAudioUnread:"Dane audio nie zosta\u0142y jeszcze odczytane.",headerInfoUnsupported:"Analiza nag\u0142\xF3wka nie jest jeszcze obs\u0142ugiwana dla tego formatu.",headerInfoOffset:"Offset",headerInfoByteOffset:"Offset bajtu",headerInfoSize:"D\u0142ugo\u015B\u0107",headerInfoBits:"Bity",headerInfoField:"Pole",headerInfoValue:"Warto\u015B\u0107",headerInfoDescription:"Opis",headerInfoWavMissingData:"nie znaleziono chunku data",headerInfoWavCannotDetermine:"Nie mo\u017Cna okre\u015Bli\u0107 d\u0142ugo\u015Bci nag\u0142\xF3wka WAV.",headerInfoWavHeaderLength:"D\u0142ugo\u015B\u0107 nag\u0142\xF3wka WAV {size} B",headerInfoWavStandardPcm:"Standardowy 44-bajtowy nag\u0142\xF3wek PCM.",headerInfoWavNonStandardPrefix:"Niestandardowy nag\u0142\xF3wek PCM inny ni\u017C 44 bajty",headerInfoWavFmtExtended:"chunk fmt ma {size} B i zawiera rozszerzone pola formatu",headerInfoWavFormat:"format audio to {format} ({name})",headerInfoWavExtraChunks:"dodatkowe chunki przed data: {chunks}",headerInfoWavDataOffsetNon44:"data zaczyna si\u0119 od offsetu innego ni\u017C 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"Offset ARK",settings:"Ustawienia",pcmReadAs:"Czytaj jako PCM",pcmParams:"Parametry pliku PCM",editPcmParams:"Edytuj parametry",wavPcmRead:"Czytaj WAV jako PCM",currentFileOnly:"Tylko bie\u017C\u0105cy plik",sampleRate:"Cz\u0119stotliwo\u015B\u0107 pr\xF3bkowania",channels:"Kana\u0142y",startOffsetBytes:"Offset (B)",bitDepth:"Kodowanie",sampleFormat:"Format",endianness:"Byte order",read:"Czytaj",saveDefault:"Zapisz domy\u015Blne",cancel:"Anuluj",defaultView:"Widok domy\u015Blny",view:"Widok",viewBoth:"Widok \u0142\u0105czony",mute:"Wycisz",solo:"Solo",timeLabel:"Czas",helpTimeZoom:"Powi\u0119kszenie czasu",helpTimePan:"Przesuwanie czasu",helpAmplitudeZoom:"Powi\u0119kszenie amplitudy",helpRightClick:"Prawy klik",helpPinch:"Gest szczypania",helpHorizontalSwipe:"Przesuni\u0119cie poziome",helpDoubleClick:"Dwuklik",helpPlaybackGroup:"Odtwarzanie i zaznaczenie",helpViewGroup:"Nawigacja widoku",helpMouseGroup:"Mysz i trackpad",helpGainGroup:"Wzmocnienie i panorama",helpPlayPause:"Odtw\xF3rz / pauza",helpClearSelection:"Zamknij menu, wyczy\u015B\u0107 zaznaczenie lub zresetuj kursor",helpResetTimeZoom:"Zresetuj powi\u0119kszenie czasu",helpTrackpadZoom:"Gest szczypania na trackpadzie powi\u0119ksza czas",helpTrackpadPan:"Poziome przesuni\u0119cie trackpada przesuwa czas",helpGainReset:"Dwuklik suwaka wzmocnienia lub panoramy resetuje go",helpSelectionPlayback:"Przeci\u0105gnij po przebiegu lub spektrogramie, aby zaznaczy\u0107 segment. Przy aktywnym zaznaczeniu odtwarzany jest tylko ten zakres.",refreshSpectrogram:"Od\u015Bwie\u017C spektrogram",resetView:"Resetuj widok",selectionAnalysis:"Analiza zaznaczenia",selectionStart:"Start",selectionEnd:"Koniec",selectionDuration:"Czas trwania",rmsLevel:"Poziom RMS",peakLevel:"Poziom Peak",dominant:"Dominuj\u0105ca",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"Poziom szumu",spectralCentroid:"Centroid",zeroCrossingRate:"ZCR",basicMetrics:"Podstawowe metryki",selectionAnalysisHelp:`Analiza zaznaczenia:
Szybko analizuje wybrany zakres czasu pod k\u0105tem poziomu, dynamiki, ryzyka clippingu, poziomu szumu i rozk\u0142adu cz\u0119stotliwo\u015Bci.

Zakres:
Wyniki s\u0105 liczone tylko dla aktywnego kana\u0142u; kana\u0142y nie s\u0105 miksowane.

Zmiana kana\u0142u:
Kliknij \u015Bcie\u017Ck\u0119, aby j\u0105 uaktywni\u0107.`,rmsLevelHelp:`Poziom RMS:
Pokazuje \u015Bredni\u0105 energi\u0119 zaznaczenia. Stabilniejszy ni\u017C peak i przydatny do kontroli zbyt cichej lub g\u0142o\u015Bnej mowy.`,peakLevelHelp:`Poziom peak:
Pokazuje najwy\u017Cszy chwilowy poziom w zaznaczeniu. Przydatny do sprawdzania blisko\u015Bci 0 dBFS i ryzyka clippingu.`,dominantHelp:`Cz\u0119stotliwo\u015B\u0107 dominuj\u0105ca:
Bin FFT o najwi\u0119kszej skumulowanej mocy w zaznaczeniu. Nie musi by\u0107 cz\u0119stotliwo\u015Bci\u0105 podstawow\u0105 ani s\u0142yszan\u0105 wysoko\u015Bci\u0105.`,crestFactorHelp:`Crest factor:
Stosunek peak do RMS. Wi\u0119ksze warto\u015Bci oznaczaj\u0105 mocniejsze piki wzgl\u0119dem \u015Bredniej energii.`,clippingRatioHelp:`Udzia\u0142 clippingu:
Procent pr\xF3bek bliskich pe\u0142nej skali. Pomaga wykrywa\u0107 przesterowanie i clipping cyfrowy.`,noiseFloorHelp:`Poziom szumu:
Estymowany z niskiego percentyla kr\xF3tkookresowego RMS. Przy zaznaczeniu z mow\u0105 lub muzyk\u0105 mo\u017Ce r\xF3\u017Cni\u0107 si\u0119 od rzeczywistego szumu.`,spectralCentroidHelp:`Centroid widmowy:
\u015Arodek masy energii widmowej w Hz. Wskazuje, czy d\u017Awi\u0119k jest ja\u015Bniejszy czy ciemniejszy.`,zeroCrossingRateHelp:`Zero crossing rate:
Cz\u0119sto\u015B\u0107 zmian znaku sygna\u0142u. Przydatne dla szumu wysokocz\u0119stotliwo\u015Bciowego, mowy bezd\u017Awi\u0119cznej i frykatyw.`,frequencyAnalysis:"Analiza cz\u0119stotliwo\u015Bci",frequencyAnalysisHelp:`Znaczenie:
Liniowy procent energii w pasmach cz\u0119stotliwo\u015Bci. To nie jest poziom RMS ani dB.

Obliczanie:
Zaznaczenie dzieli si\u0119 na ramki z 50% overlap. Moc bin\xF3w FFT jest sumowana i przypisywana do pasm.`,selectionAnalysisCalculating:"Obliczanie...",bands:"Pasma",waveform:"Przebieg",spectrogram:"Spektrogram",adjustWaveformHeight:"Dostosuj wysoko\u015B\u0107 przebiegu",adjustSpectrogramHeight:"Dostosuj wysoko\u015B\u0107 spektrogramu",ready:"Gotowe",workspaceNotTrusted:"Obszar roboczy nie jest zaufany; tre\u015B\u0107 audio nie jest przesy\u0142ana",fileTooLarge:"Plik przekracza limit",readingAudio:"Odczyt audio",readingAudioProgress:"Odczyt audio",decodingAudio:"Dekodowanie audio",transcodingAudio:"Transkodowanie audio przez FFmpeg",encodedPlaybackOnly:"Dekodowanie d\u017Awi\u0119ku nie powiod\u0142o si\u0119.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"Oczekiwanie na parametry PCM",pcmUsedDefaultParams:"Wczytano z domy\u015Blnymi parametrami PCM.",pcmFillParams:"Uzupe\u0142nij parametry PCM, a nast\u0119pnie kliknij Czytaj.",wavPcmFillParams:"Uzupe\u0142nij parametry i kliknij Czytaj, aby sparsowa\u0107 bie\u017C\u0105cy WAV jako PCM.",currentPcmFormat:"Bie\u017C\u0105cy",savedDefaultPcmFormat:"Zapisane domy\u015Blne",audioLoaded:"Audio wczytane",audioNotReady:"Audio nie jest gotowe",audioCannotPlay:"Tego audio nie mo\u017Cna odtworzy\u0107 w webview",playbackFailed:"Odtwarzanie nie powiod\u0142o si\u0119",analyzingSpectrogram:"Analiza spektrogramu",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"Inicjalizacja AudioLens nie powiod\u0142a si\u0119",trackGain:"Wzmocnienie",trackPan:"Panorama",panLeft:"L",panRight:"P",panCenter:"C",doubleClickReset:"Dwuklik resetuje",freqScaleMenuTitle:"Skala cz\u0119stotliwo\u015Bci kana\u0142u",restoreChannelDefault:"Przywr\xF3\u0107 domy\u015Blne kana\u0142u",helpAxisGroup:"O\u015B pionowa",helpAxisZoom:"Ctrl + k\xF3\u0142ko / szczypanie na osi: powi\u0119ksz t\u0119 o\u015B (na kana\u0142)",helpAxisPan:"Shift + k\xF3\u0142ko / poziomy gest na osi: przesu\u0144 t\u0119 o\u015B (na kana\u0142)",helpAxisAlt:"Alt + k\xF3\u0142ko na przebiegu: powi\u0119ksz amplitud\u0119 kana\u0142u",helpAxisScaleMenu:"Prawy klik na osi cz\u0119stotliwo\u015Bci: ustaw skal\u0119 tego kana\u0142u",helpAxisReset:"Dwuklik na osi: przywr\xF3\u0107 domy\u015Blne kana\u0142u"};var Je={waitingAudioFile:"Aguardando \xE1udio",initializing:"Inicializando",spectrogramSettings:"Config. do espectrograma",playPause:"Reproduzir / pausar",playbackPosition:"Posi\xE7\xE3o de reprodu\xE7\xE3o",closeSettings:"Fechar ajustes",spectrogramDisplay:"Exibi\xE7\xE3o do espectrograma",algorithmFrequency:"Frequ\xEAncia",windowSize:"Tamanho da janela",windowType:"Tipo de janela",windowRectangular:"Retangular",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussiana (\u03B1=2.5)",windowGaussian35:"Gaussiana (\u03B1=3.5)",windowGaussian45:"Gaussiana (\u03B1=4.5)",zeroPaddingFactor:"Fator de zero padding",frequencyScale:"Escala de frequ\xEAncia",frequencyRange:"Faixa de frequ\xEAncia (s\xF3 visual)",minFrequencyHz:"Frequ\xEAncia m\xEDn. (Hz)",maxFrequencyHz:"Frequ\xEAncia m\xE1x. (Hz)",maxFrequencyNyquist:"M\xE1x. segue Nyquist",spectrogramAppearance:"Apar\xEAncia do espectrograma",palette:"Paleta",paletteRose:"Rosa",paletteClassic:"Cl\xE1ssica",paletteGrayscale:"Tons de cinza",paletteInverseGrayscale:"Cinza inverso",minDb:"dB m\xEDn. (brilho)",maxDb:"dB m\xE1x. (brilho)",autoBrightness:"Brilho autom\xE1tico",amplitudeRange:"Faixa de amplitude (onda)",minAmplitude:"Amplitude m\xEDn",maxAmplitude:"Amplitude m\xE1x",amplitudeAuto:"Auto (por canal)",channel:"Canal",timeZoom:"Zoom temporal",timePosition:"Posi\xE7\xE3o temporal",mouseWheel:"Roda do mouse",help:"Ajuda",downloadAudio:"Baixar \xE1udio",downloadSelection:"Baixar sele\xE7\xE3o",downloadSelectionWav:"Baixar sele\xE7\xE3o como WAV",clearSelection:"Limpar sele\xE7\xE3o",noSelectionToDownload:"Nenhuma sele\xE7\xE3o de \xE1udio para baixar",headerInfo:"Informa\xE7\xF5es do cabe\xE7alho",headerInfoTitle:"Informa\xE7\xF5es do cabe\xE7alho",headerInfoAudioUnread:"Os dados de \xE1udio ainda n\xE3o foram lidos.",headerInfoUnsupported:"A an\xE1lise do cabe\xE7alho ainda n\xE3o \xE9 compat\xEDvel com este formato.",headerInfoOffset:"Deslocamento",headerInfoByteOffset:"Deslocamento byte",headerInfoSize:"Tamanho",headerInfoBits:"Bits",headerInfoField:"Campo",headerInfoValue:"Valor",headerInfoDescription:"Descri\xE7\xE3o",headerInfoWavMissingData:"chunk data n\xE3o encontrado",headerInfoWavCannotDetermine:"N\xE3o \xE9 poss\xEDvel determinar o tamanho do cabe\xE7alho WAV.",headerInfoWavHeaderLength:"Tamanho do cabe\xE7alho WAV {size} B",headerInfoWavStandardPcm:"Cabe\xE7alho PCM padr\xE3o de 44 bytes.",headerInfoWavNonStandardPrefix:"Cabe\xE7alho PCM n\xE3o padr\xE3o de 44 bytes",headerInfoWavFmtExtended:"o chunk fmt tem {size} B e cont\xE9m campos de formato estendidos",headerInfoWavFormat:"o formato de \xE1udio \xE9 {format} ({name})",headerInfoWavExtraChunks:"chunk(s) extra antes de data: {chunks}",headerInfoWavDataOffsetNon44:"data come\xE7a em um deslocamento diferente de 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"Offset ARK",settings:"Ajustes",pcmReadAs:"Ler como PCM",pcmParams:"Par\xE2metros do arquivo PCM",editPcmParams:"Editar par\xE2metros",wavPcmRead:"Ler WAV como PCM",currentFileOnly:"Somente arquivo atual",sampleRate:"Taxa de amostragem",channels:"Canais",startOffsetBytes:"Offset (B)",bitDepth:"Codifica\xE7\xE3o",sampleFormat:"Formato",endianness:"Byte order",read:"Ler",saveDefault:"Salvar padr\xE3o",cancel:"Cancelar",defaultView:"Vista padr\xE3o",view:"Vista",viewBoth:"Multi-view",mute:"Mudo",solo:"Solo",timeLabel:"Tempo",helpTimeZoom:"Zoom temporal",helpTimePan:"Pan temporal",helpAmplitudeZoom:"Zoom de amplitude",helpRightClick:"Clique direito",helpPinch:"Pin\xE7ar",helpHorizontalSwipe:"Deslize horizontal",helpDoubleClick:"Duplo clique",helpPlaybackGroup:"Reprodu\xE7\xE3o e sele\xE7\xE3o",helpViewGroup:"Navega\xE7\xE3o da vista",helpMouseGroup:"Mouse e trackpad",helpGainGroup:"Ganho e pan",helpPlayPause:"Reproduzir / pausar",helpClearSelection:"Fechar menu, limpar sele\xE7\xE3o ou redefinir cursor",helpResetTimeZoom:"Redefinir zoom temporal",helpTrackpadZoom:"Pin\xE7ar no trackpad para ampliar o tempo",helpTrackpadPan:"Deslize horizontal do trackpad move o tempo",helpGainReset:"Duplo clique em um controle de ganho ou pan para redefini-lo",helpSelectionPlayback:"Arraste a forma de onda ou o espectrograma para selecionar um segmento. Com sele\xE7\xE3o ativa, s\xF3 esse intervalo \xE9 reproduzido.",refreshSpectrogram:"Atualizar espectrograma",resetView:"Redefinir vista",selectionAnalysis:"An\xE1lise da sele\xE7\xE3o",selectionStart:"In\xEDcio",selectionEnd:"Fim",selectionDuration:"Dura\xE7\xE3o",rmsLevel:"N\xEDvel RMS",peakLevel:"N\xEDvel Peak",dominant:"Dominante",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"Piso de ru\xEDdo",spectralCentroid:"Centroide",zeroCrossingRate:"ZCR",basicMetrics:"M\xE9tricas b\xE1sicas",selectionAnalysisHelp:`An\xE1lise da sele\xE7\xE3o:
Analisa rapidamente o intervalo selecionado para inspecionar n\xEDvel, din\xE2mica, risco de clipping, piso de ru\xEDdo e distribui\xE7\xE3o de frequ\xEAncias.

Escopo:
Os resultados usam apenas o canal ativo; os canais n\xE3o s\xE3o mixados.

Trocar canal:
Clique em uma trilha para torn\xE1-la ativa.`,rmsLevelHelp:`N\xEDvel RMS:
Mostra a energia m\xE9dia da sele\xE7\xE3o. \xC9 mais est\xE1vel que o pico e ajuda a verificar fala muito baixa ou alta.`,peakLevelHelp:`N\xEDvel de pico:
Mostra o maior n\xEDvel instant\xE2neo da sele\xE7\xE3o. \xDAtil para verificar proximidade de 0 dBFS e risco de clipping.`,dominantHelp:`Frequ\xEAncia dominante:
Bin FFT com maior pot\xEAncia acumulada na sele\xE7\xE3o. N\xE3o \xE9 necessariamente a fundamental nem o pitch percebido.`,crestFactorHelp:`Fator de crista:
Raz\xE3o entre pico e RMS. Valores maiores indicam picos mais fortes em rela\xE7\xE3o \xE0 energia m\xE9dia.`,clippingRatioHelp:`Propor\xE7\xE3o de clipping:
Percentual de amostras pr\xF3ximas ao fundo de escala. Ajuda a detectar sobrecarga ou clipping digital.`,noiseFloorHelp:`Piso de ru\xEDdo:
Estimado a partir de um percentil baixo de RMS em janelas curtas. Se a sele\xE7\xE3o for principalmente fala ou m\xFAsica, pode n\xE3o corresponder ao ru\xEDdo real.`,spectralCentroidHelp:`Centroide espectral:
Centro de massa da energia espectral em Hz. Indica se o som tende a ser mais brilhante ou escuro.`,zeroCrossingRateHelp:`Taxa de cruzamento por zero:
Frequ\xEAncia com que o sinal muda de sinal. \xDAtil para ru\xEDdo de alta frequ\xEAncia, fala n\xE3o vozeada e fricativas.`,frequencyAnalysis:"An\xE1lise de frequ\xEAncia",frequencyAnalysisHelp:`Significado:
Percentual de energia linear por banda de frequ\xEAncia. N\xE3o \xE9 n\xEDvel RMS nem dB.

C\xE1lculo:
A sele\xE7\xE3o \xE9 dividida em frames com 50% de overlap; a pot\xEAncia dos bins FFT \xE9 acumulada e distribu\xEDda por bandas.`,selectionAnalysisCalculating:"Calculando...",bands:"Bandas",waveform:"Forma de onda",spectrogram:"Espectrograma",adjustWaveformHeight:"Ajustar altura da forma de onda",adjustSpectrogramHeight:"Ajustar altura do espectrograma",ready:"Pronto",workspaceNotTrusted:"Workspace n\xE3o confi\xE1vel; o \xE1udio n\xE3o \xE9 transferido",fileTooLarge:"Arquivo excede o limite",readingAudio:"Lendo \xE1udio",readingAudioProgress:"Lendo \xE1udio",decodingAudio:"Decodificando \xE1udio",transcodingAudio:"Transcodificando \xE1udio com FFmpeg",encodedPlaybackOnly:"Falha ao decodificar o \xE1udio.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"Aguardando par\xE2metros PCM",pcmUsedDefaultParams:"Carregado com par\xE2metros PCM padr\xE3o.",pcmFillParams:"Preencha os par\xE2metros PCM e clique em Ler.",wavPcmFillParams:"Preencha os par\xE2metros e clique em Ler para interpretar o WAV atual como PCM.",currentPcmFormat:"Atual",savedDefaultPcmFormat:"Padr\xE3o salvo",audioLoaded:"\xC1udio carregado",audioNotReady:"\xC1udio n\xE3o est\xE1 pronto",audioCannotPlay:"Este \xE1udio n\xE3o pode ser reproduzido no webview",playbackFailed:"Falha na reprodu\xE7\xE3o",analyzingSpectrogram:"Analisando espectrograma",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"Falha ao inicializar AudioLens",trackGain:"Ganho",trackPan:"Pan",panLeft:"E",panRight:"D",panCenter:"C",doubleClickReset:"Duplo clique para redefinir",freqScaleMenuTitle:"Escala de frequ\xEAncia do canal",restoreChannelDefault:"Restaurar padr\xE3o do canal",helpAxisGroup:"Eixo vertical",helpAxisZoom:"Ctrl + roda / pin\xE7a num eixo: zoom desse eixo (por canal)",helpAxisPan:"Shift + roda / deslize horizontal num eixo: deslocar esse eixo (por canal)",helpAxisAlt:"Alt + roda numa onda: zoom da amplitude do canal",helpAxisScaleMenu:"Clique direito no eixo de frequ\xEAncia: definir a escala do canal",helpAxisReset:"Duplo clique num eixo: restaurar o padr\xE3o do canal"};var Qe={waitingAudioFile:"\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E\u0444\u0430\u0439\u043B\u0430",initializing:"\u0418\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u044F",spectrogramSettings:"\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",playPause:"\u041F\u0443\u0441\u043A / \u043F\u0430\u0443\u0437\u0430",playbackPosition:"\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u044F",closeSettings:"\u0417\u0430\u043A\u0440\u044B\u0442\u044C \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",spectrogramDisplay:"\u041E\u0442\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",algorithmFrequency:"\u0427\u0430\u0441\u0442\u043E\u0442\u0430",windowSize:"\u0420\u0430\u0437\u043C\u0435\u0440 \u043E\u043A\u043D\u0430",windowType:"\u0422\u0438\u043F \u043E\u043A\u043D\u0430",windowRectangular:"\u041F\u0440\u044F\u043C\u043E\u0443\u0433\u043E\u043B\u044C\u043D\u043E\u0435",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"\u041A\u043E\u044D\u0444. zero padding",frequencyScale:"\u0428\u043A\u0430\u043B\u0430 \u0447\u0430\u0441\u0442\u043E\u0442",frequencyRange:"\u0414\u0438\u0430\u043F\u0430\u0437\u043E\u043D \u0447\u0430\u0441\u0442\u043E\u0442 (\u0442\u043E\u043B\u044C\u043A\u043E \u0432\u0438\u0434)",minFrequencyHz:"\u041C\u0438\u043D. \u0447\u0430\u0441\u0442\u043E\u0442\u0430 (Hz)",maxFrequencyHz:"\u041C\u0430\u043A\u0441. \u0447\u0430\u0441\u0442\u043E\u0442\u0430 (Hz)",maxFrequencyNyquist:"\u041C\u0430\u043A\u0441. \u043F\u043E \u041D\u0430\u0439\u043A\u0432\u0438\u0441\u0442\u0443",spectrogramAppearance:"\u0412\u043D\u0435\u0448\u043D\u0438\u0439 \u0432\u0438\u0434 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",palette:"\u041F\u0430\u043B\u0438\u0442\u0440\u0430",paletteRose:"\u0420\u043E\u0437\u0430",paletteClassic:"\u041A\u043B\u0430\u0441\u0441\u0438\u0447\u0435\u0441\u043A\u0430\u044F",paletteGrayscale:"\u0421\u0435\u0440\u0430\u044F \u0448\u043A\u0430\u043B\u0430",paletteInverseGrayscale:"\u0418\u043D\u0432\u0435\u0440\u0442. \u0441\u0435\u0440\u0430\u044F",minDb:"\u041C\u0438\u043D. dB (\u044F\u0440\u043A\u043E\u0441\u0442\u044C)",maxDb:"\u041C\u0430\u043A\u0441. dB (\u044F\u0440\u043A\u043E\u0441\u0442\u044C)",autoBrightness:"\u0410\u0432\u0442\u043E-\u044F\u0440\u043A\u043E\u0441\u0442\u044C",amplitudeRange:"\u0414\u0438\u0430\u043F\u0430\u0437\u043E\u043D \u0430\u043C\u043F\u043B\u0438\u0442\u0443\u0434\u044B (\u0432\u043E\u043B\u043D\u0430)",minAmplitude:"\u041C\u0438\u043D. \u0430\u043C\u043F\u043B\u0438\u0442\u0443\u0434\u0430",maxAmplitude:"\u041C\u0430\u043A\u0441. \u0430\u043C\u043F\u043B\u0438\u0442\u0443\u0434\u0430",amplitudeAuto:"\u0410\u0432\u0442\u043E (\u043F\u043E \u043A\u0430\u043D\u0430\u043B\u0430\u043C)",channel:"\u041A\u0430\u043D\u0430\u043B",timeZoom:"\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",timePosition:"\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u0432\u0440\u0435\u043C\u0435\u043D\u0438",mouseWheel:"\u041A\u043E\u043B\u0435\u0441\u043E \u043C\u044B\u0448\u0438",help:"\u0421\u043F\u0440\u0430\u0432\u043A\u0430",downloadAudio:"\u0421\u043A\u0430\u0447\u0430\u0442\u044C \u0430\u0443\u0434\u0438\u043E",downloadSelection:"\u0421\u043A\u0430\u0447\u0430\u0442\u044C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435",downloadSelectionWav:"\u0421\u043A\u0430\u0447\u0430\u0442\u044C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u043A\u0430\u043A WAV",clearSelection:"\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435",noSelectionToDownload:"\u041D\u0435\u0442 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u043D\u043E\u0433\u043E \u0430\u0443\u0434\u0438\u043E \u0434\u043B\u044F \u0441\u043A\u0430\u0447\u0438\u0432\u0430\u043D\u0438\u044F",headerInfo:"\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430",headerInfoTitle:"\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430",headerInfoAudioUnread:"\u0410\u0443\u0434\u0438\u043E\u0434\u0430\u043D\u043D\u044B\u0435 \u0435\u0449\u0435 \u043D\u0435 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u043D\u044B.",headerInfoUnsupported:"\u0420\u0430\u0437\u0431\u043E\u0440 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430 \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u0444\u043E\u0440\u043C\u0430\u0442\u0430 \u043F\u043E\u043A\u0430 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F.",headerInfoOffset:"\u0421\u043C\u0435\u0449\u0435\u043D\u0438\u0435",headerInfoByteOffset:"\u0411\u0430\u0439\u0442\u043E\u0432\u043E\u0435 \u0441\u043C\u0435\u0449\u0435\u043D\u0438\u0435",headerInfoSize:"\u0414\u043B\u0438\u043D\u0430",headerInfoBits:"\u0411\u0438\u0442\u044B",headerInfoField:"\u041F\u043E\u043B\u0435",headerInfoValue:"\u0417\u043D\u0430\u0447\u0435\u043D\u0438\u0435",headerInfoDescription:"\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435",headerInfoWavMissingData:"chunk data \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D",headerInfoWavCannotDetermine:"\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0434\u043B\u0438\u043D\u0443 WAV-\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430.",headerInfoWavHeaderLength:"\u0414\u043B\u0438\u043D\u0430 WAV-\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430 {size} B",headerInfoWavStandardPcm:"\u0421\u0442\u0430\u043D\u0434\u0430\u0440\u0442\u043D\u044B\u0439 PCM-\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A 44 \u0431\u0430\u0439\u0442\u0430.",headerInfoWavNonStandardPrefix:"\u041D\u0435\u0441\u0442\u0430\u043D\u0434\u0430\u0440\u0442\u043D\u044B\u0439 PCM-\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \u043D\u0435 44 \u0431\u0430\u0439\u0442\u0430",headerInfoWavFmtExtended:"chunk fmt \u0438\u043C\u0435\u0435\u0442 \u0440\u0430\u0437\u043C\u0435\u0440 {size} B \u0438 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 \u0440\u0430\u0441\u0448\u0438\u0440\u0435\u043D\u043D\u044B\u0435 \u043F\u043E\u043B\u044F \u0444\u043E\u0440\u043C\u0430\u0442\u0430",headerInfoWavFormat:"\u0430\u0443\u0434\u0438\u043E\u0444\u043E\u0440\u043C\u0430\u0442: {format} ({name})",headerInfoWavExtraChunks:"\u0434\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 chunk \u043F\u0435\u0440\u0435\u0434 data: {chunks}",headerInfoWavDataOffsetNon44:"data \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u043D\u0435 \u0441\u043E \u0441\u043C\u0435\u0449\u0435\u043D\u0438\u044F 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"\u0421\u043C\u0435\u0449\u0435\u043D\u0438\u0435 ARK",settings:"\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",pcmReadAs:"\u0427\u0438\u0442\u0430\u0442\u044C \u043A\u0430\u043A PCM",pcmParams:"\u041F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B PCM-\u0444\u0430\u0439\u043B\u0430",editPcmParams:"\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B",wavPcmRead:"\u0427\u0438\u0442\u0430\u0442\u044C WAV \u043A\u0430\u043A PCM",currentFileOnly:"\u0422\u043E\u043B\u044C\u043A\u043E \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0444\u0430\u0439\u043B",sampleRate:"\u0427\u0430\u0441\u0442\u043E\u0442\u0430 \u0434\u0438\u0441\u043A\u0440\u0435\u0442\u0438\u0437\u0430\u0446\u0438\u0438",channels:"\u041A\u0430\u043D\u0430\u043B\u044B",startOffsetBytes:"\u0421\u043C\u0435\u0449\u0435\u043D\u0438\u0435 (B)",bitDepth:"\u041A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435",sampleFormat:"\u0424\u043E\u0440\u043C\u0430\u0442",endianness:"\u041F\u043E\u0440\u044F\u0434\u043E\u043A \u0431\u0430\u0439\u0442\u043E\u0432",read:"\u0427\u0438\u0442\u0430\u0442\u044C",saveDefault:"\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",cancel:"\u041E\u0442\u043C\u0435\u043D\u0430",defaultView:"\u0412\u0438\u0434 \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",view:"\u0412\u0438\u0434",viewBoth:"\u041C\u0443\u043B\u044C\u0442\u0438\u0432\u0438\u0434",mute:"\u0411\u0435\u0437 \u0437\u0432\u0443\u043A\u0430",solo:"\u0421\u043E\u043B\u043E",timeLabel:"\u0412\u0440\u0435\u043C\u044F",helpTimeZoom:"\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",helpTimePan:"\u0421\u0434\u0432\u0438\u0433 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",helpAmplitudeZoom:"\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0430\u043C\u043F\u043B\u0438\u0442\u0443\u0434\u044B",helpRightClick:"\u041F\u0440\u0430\u0432\u044B\u0439 \u043A\u043B\u0438\u043A",helpPinch:"\u0429\u0438\u043F\u043E\u043A",helpHorizontalSwipe:"\u0413\u043E\u0440\u0438\u0437\u043E\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0432\u0430\u0439\u043F",helpDoubleClick:"\u0414\u0432\u043E\u0439\u043D\u043E\u0439 \u043A\u043B\u0438\u043A",helpPlaybackGroup:"\u0412\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u0438 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435",helpViewGroup:"\u041D\u0430\u0432\u0438\u0433\u0430\u0446\u0438\u044F \u0432\u0438\u0434\u0430",helpMouseGroup:"\u041C\u044B\u0448\u044C \u0438 \u0442\u0440\u0435\u043A\u043F\u0430\u0434",helpGainGroup:"\u0423\u0441\u0438\u043B\u0435\u043D\u0438\u0435 \u0438 \u043F\u0430\u043D\u043E\u0440\u0430\u043C\u0430",helpPlayPause:"\u041F\u0443\u0441\u043A / \u043F\u0430\u0443\u0437\u0430",helpClearSelection:"\u0417\u0430\u043A\u0440\u044B\u0442\u044C \u043C\u0435\u043D\u044E, \u043E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0438\u043B\u0438 \u0441\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u043A\u0443\u0440\u0441\u043E\u0440",helpResetTimeZoom:"\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u043C\u0430\u0441\u0448\u0442\u0430\u0431 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",helpTrackpadZoom:"\u0429\u0438\u043F\u043E\u043A \u043D\u0430 \u0442\u0440\u0435\u043A\u043F\u0430\u0434\u0435 \u043C\u0430\u0441\u0448\u0442\u0430\u0431\u0438\u0440\u0443\u0435\u0442 \u0432\u0440\u0435\u043C\u044F",helpTrackpadPan:"\u0413\u043E\u0440\u0438\u0437\u043E\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0432\u0430\u0439\u043F \u0442\u0440\u0435\u043A\u043F\u0430\u0434\u0430 \u0441\u0434\u0432\u0438\u0433\u0430\u0435\u0442 \u0432\u0440\u0435\u043C\u044F",helpGainReset:"\u0414\u0432\u043E\u0439\u043D\u043E\u0439 \u043A\u043B\u0438\u043A \u043F\u043E \u043F\u043E\u043B\u0437\u0443\u043D\u043A\u0443 \u0443\u0441\u0438\u043B\u0435\u043D\u0438\u044F \u0438\u043B\u0438 \u043F\u0430\u043D\u043E\u0440\u0430\u043C\u044B \u0441\u0431\u0440\u0430\u0441\u044B\u0432\u0430\u0435\u0442 \u0435\u0433\u043E",helpSelectionPlayback:"\u041F\u043E\u0442\u044F\u043D\u0438\u0442\u0435 \u043F\u043E \u0432\u043E\u043B\u043D\u0435 \u0438\u043B\u0438 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0435, \u0447\u0442\u043E\u0431\u044B \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u0441\u0435\u0433\u043C\u0435\u043D\u0442. \u041F\u0440\u0438 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u043C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0438 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u043E\u0434\u0438\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u044D\u0442\u043E\u0442 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D.",refreshSpectrogram:"\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0443",resetView:"\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u0432\u0438\u0434",selectionAnalysis:"\u0410\u043D\u0430\u043B\u0438\u0437 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u044F",selectionStart:"\u041D\u0430\u0447\u0430\u043B\u043E",selectionEnd:"\u041A\u043E\u043D\u0435\u0446",selectionDuration:"\u0414\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C",rmsLevel:"\u0423\u0440\u043E\u0432\u0435\u043D\u044C RMS",peakLevel:"\u0423\u0440\u043E\u0432\u0435\u043D\u044C Peak",dominant:"\u0414\u043E\u043C\u0438\u043D\u0438\u0440\u0443\u044E\u0449\u0430\u044F",crestFactor:"Crest",clippingRatio:"\u041A\u043B\u0438\u043F\u043F\u0438\u043D\u0433",noiseFloor:"\u0428\u0443\u043C\u043E\u0432\u043E\u0439 \u043F\u043E\u0440\u043E\u0433",spectralCentroid:"\u0426\u0435\u043D\u0442\u0440\u043E\u0438\u0434",zeroCrossingRate:"ZCR",basicMetrics:"\u0411\u0430\u0437\u043E\u0432\u044B\u0435 \u043C\u0435\u0442\u0440\u0438\u043A\u0438",selectionAnalysisHelp:`\u0410\u043D\u0430\u043B\u0438\u0437 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u044F:
\u0411\u044B\u0441\u0442\u0440\u043E \u0430\u043D\u0430\u043B\u0438\u0437\u0438\u0440\u0443\u0435\u0442 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D \u0432\u0440\u0435\u043C\u0435\u043D\u0438: \u0443\u0440\u043E\u0432\u0435\u043D\u044C, \u0434\u0438\u043D\u0430\u043C\u0438\u043A\u0443, \u0440\u0438\u0441\u043A \u043A\u043B\u0438\u043F\u043F\u0438\u043D\u0433\u0430, \u0448\u0443\u043C\u043E\u0432\u043E\u0439 \u043F\u043E\u0440\u043E\u0433 \u0438 \u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0447\u0430\u0441\u0442\u043E\u0442.

\u041E\u0431\u043B\u0430\u0441\u0442\u044C:
\u0420\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u044B \u0441\u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0433\u043E \u043A\u0430\u043D\u0430\u043B\u0430; \u043A\u0430\u043D\u0430\u043B\u044B \u043D\u0435 \u0441\u043C\u0435\u0448\u0438\u0432\u0430\u044E\u0442\u0441\u044F.

\u0421\u043C\u0435\u043D\u0430 \u043A\u0430\u043D\u0430\u043B\u0430:
\u0429\u0435\u043B\u043A\u043D\u0438\u0442\u0435 \u0434\u043E\u0440\u043E\u0436\u043A\u0443, \u0447\u0442\u043E\u0431\u044B \u0441\u0434\u0435\u043B\u0430\u0442\u044C \u0435\u0435 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0439.`,rmsLevelHelp:`\u0423\u0440\u043E\u0432\u0435\u043D\u044C RMS:
\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0441\u0440\u0435\u0434\u043D\u044E\u044E \u044D\u043D\u0435\u0440\u0433\u0438\u044E \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u044F. \u0421\u0442\u0430\u0431\u0438\u043B\u044C\u043D\u0435\u0435 \u043F\u0438\u043A\u043E\u0432\u043E\u0433\u043E \u0443\u0440\u043E\u0432\u043D\u044F \u0438 \u043F\u043E\u043B\u0435\u0437\u0435\u043D \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0442\u0438\u0445\u043E\u0439 \u0438\u043B\u0438 \u0433\u0440\u043E\u043C\u043A\u043E\u0439 \u0440\u0435\u0447\u0438.`,peakLevelHelp:`\u041F\u0438\u043A\u043E\u0432\u044B\u0439 \u0443\u0440\u043E\u0432\u0435\u043D\u044C:
\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u043C\u0433\u043D\u043E\u0432\u0435\u043D\u043D\u044B\u0439 \u0443\u0440\u043E\u0432\u0435\u043D\u044C \u0432 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0438. \u041F\u043E\u043B\u0435\u0437\u0435\u043D \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0431\u043B\u0438\u0437\u043E\u0441\u0442\u0438 \u043A 0 dBFS \u0438 \u0440\u0438\u0441\u043A\u0430 \u043A\u043B\u0438\u043F\u043F\u0438\u043D\u0433\u0430.`,dominantHelp:`\u0414\u043E\u043C\u0438\u043D\u0438\u0440\u0443\u044E\u0449\u0430\u044F \u0447\u0430\u0441\u0442\u043E\u0442\u0430:
FFT-bin \u0441 \u043D\u0430\u0438\u0431\u043E\u043B\u044C\u0448\u0435\u0439 \u043D\u0430\u043A\u043E\u043F\u043B\u0435\u043D\u043D\u043E\u0439 \u043C\u043E\u0449\u043D\u043E\u0441\u0442\u044C\u044E \u0432 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0438. \u042D\u0442\u043E \u043D\u0435 \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E \u0444\u0443\u043D\u0434\u0430\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u0430\u044F \u0447\u0430\u0441\u0442\u043E\u0442\u0430 \u0438\u043B\u0438 \u0432\u043E\u0441\u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u043C\u0430\u044F \u0432\u044B\u0441\u043E\u0442\u0430.`,crestFactorHelp:`Crest factor:
\u041E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0435 peak \u043A RMS. \u0411\u043E\u043B\u044C\u0448\u0438\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F \u043E\u0437\u043D\u0430\u0447\u0430\u044E\u0442 \u0431\u043E\u043B\u0435\u0435 \u0432\u044B\u0440\u0430\u0436\u0435\u043D\u043D\u044B\u0435 \u043F\u0438\u043A\u0438 \u043E\u0442\u043D\u043E\u0441\u0438\u0442\u0435\u043B\u044C\u043D\u043E \u0441\u0440\u0435\u0434\u043D\u0435\u0439 \u044D\u043D\u0435\u0440\u0433\u0438\u0438.`,clippingRatioHelp:`\u0414\u043E\u043B\u044F \u043A\u043B\u0438\u043F\u043F\u0438\u043D\u0433\u0430:
\u041F\u0440\u043E\u0446\u0435\u043D\u0442 samples \u0431\u043B\u0438\u0437\u043A\u043E \u043A full scale. \u041F\u043E\u043C\u043E\u0433\u0430\u0435\u0442 \u0431\u044B\u0441\u0442\u0440\u043E \u043E\u0431\u043D\u0430\u0440\u0443\u0436\u0438\u0442\u044C \u043F\u0435\u0440\u0435\u0433\u0440\u0443\u0437\u043A\u0443 \u0437\u0430\u043F\u0438\u0441\u0438 \u0438\u043B\u0438 \u0446\u0438\u0444\u0440\u043E\u0432\u043E\u0439 \u043A\u043B\u0438\u043F\u043F\u0438\u043D\u0433.`,noiseFloorHelp:`\u0428\u0443\u043C\u043E\u0432\u043E\u0439 \u043F\u043E\u0440\u043E\u0433:
\u041E\u0446\u0435\u043D\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u043F\u043E \u043D\u0438\u0437\u043A\u043E\u043C\u0443 \u043F\u0440\u043E\u0446\u0435\u043D\u0442\u0438\u043B\u044E \u043A\u0440\u0430\u0442\u043A\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E\u0433\u043E RMS. \u0415\u0441\u043B\u0438 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0432 \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u043C \u0440\u0435\u0447\u044C \u0438\u043B\u0438 \u043C\u0443\u0437\u044B\u043A\u0430, \u043E\u0446\u0435\u043D\u043A\u0430 \u043C\u043E\u0436\u0435\u0442 \u043E\u0442\u043B\u0438\u0447\u0430\u0442\u044C\u0441\u044F \u043E\u0442 \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0448\u0443\u043C\u0430.`,spectralCentroidHelp:`\u0421\u043F\u0435\u043A\u0442\u0440\u0430\u043B\u044C\u043D\u044B\u0439 \u0446\u0435\u043D\u0442\u0440\u043E\u0438\u0434:
\u0426\u0435\u043D\u0442\u0440 \u043C\u0430\u0441\u0441 \u0441\u043F\u0435\u043A\u0442\u0440\u0430\u043B\u044C\u043D\u043E\u0439 \u044D\u043D\u0435\u0440\u0433\u0438\u0438 \u0432 Hz. \u041F\u043E\u043C\u043E\u0433\u0430\u0435\u0442 \u043F\u043E\u043D\u044F\u0442\u044C, \u0437\u0432\u0443\u043A \u0431\u043E\u043B\u0435\u0435 \u044F\u0440\u043A\u0438\u0439 \u0438\u043B\u0438 \u0442\u0435\u043C\u043D\u044B\u0439.`,zeroCrossingRateHelp:`Zero crossing rate:
\u0427\u0430\u0441\u0442\u043E\u0442\u0430 \u0441\u043C\u0435\u043D\u044B \u0437\u043D\u0430\u043A\u0430 \u0441\u0438\u0433\u043D\u0430\u043B\u0430. \u041F\u043E\u043B\u0435\u0437\u043D\u043E \u0434\u043B\u044F \u0412\u0427-\u0448\u0443\u043C\u0430, \u0433\u043B\u0443\u0445\u043E\u0439 \u0440\u0435\u0447\u0438 \u0438 \u0444\u0440\u0438\u043A\u0430\u0442\u0438\u0432\u043E\u0432.`,frequencyAnalysis:"\u0410\u043D\u0430\u043B\u0438\u0437 \u0447\u0430\u0441\u0442\u043E\u0442",frequencyAnalysisHelp:`\u0421\u043C\u044B\u0441\u043B:
\u041B\u0438\u043D\u0435\u0439\u043D\u044B\u0439 \u043F\u0440\u043E\u0446\u0435\u043D\u0442 \u044D\u043D\u0435\u0440\u0433\u0438\u0438 \u043F\u043E \u0447\u0430\u0441\u0442\u043E\u0442\u043D\u044B\u043C \u043F\u043E\u043B\u043E\u0441\u0430\u043C. \u042D\u0442\u043E \u043D\u0435 RMS \u0438 \u043D\u0435 dB.

\u0420\u0430\u0441\u0447\u0435\u0442:
\u0412\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0434\u0435\u043B\u0438\u0442\u0441\u044F \u043D\u0430 \u0444\u0440\u0435\u0439\u043C\u044B \u0441 50% overlap. \u041C\u043E\u0449\u043D\u043E\u0441\u0442\u044C FFT-bin \u0441\u0443\u043C\u043C\u0438\u0440\u0443\u0435\u0442\u0441\u044F \u0438 \u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442\u0441\u044F \u043F\u043E \u043F\u043E\u043B\u043E\u0441\u0430\u043C.`,selectionAnalysisCalculating:"\u0412\u044B\u0447\u0438\u0441\u043B\u0435\u043D\u0438\u0435...",bands:"\u041F\u043E\u043B\u043E\u0441\u044B",waveform:"\u0412\u043E\u043B\u043D\u0430",spectrogram:"\u0421\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0430",adjustWaveformHeight:"\u041D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u0432\u044B\u0441\u043E\u0442\u0443 \u0432\u043E\u043B\u043D\u044B",adjustSpectrogramHeight:"\u041D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u0432\u044B\u0441\u043E\u0442\u0443 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",ready:"\u0413\u043E\u0442\u043E\u0432\u043E",workspaceNotTrusted:"\u0420\u0430\u0431\u043E\u0447\u0430\u044F \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u043D\u0435 \u0434\u043E\u0432\u0435\u0440\u0435\u043D\u0430; \u0430\u0443\u0434\u0438\u043E \u043D\u0435 \u043F\u0435\u0440\u0435\u0434\u0430\u0435\u0442\u0441\u044F",fileTooLarge:"\u0424\u0430\u0439\u043B \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 \u043B\u0438\u043C\u0438\u0442",readingAudio:"\u0427\u0442\u0435\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E",readingAudioProgress:"\u0427\u0442\u0435\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E",decodingAudio:"\u0414\u0435\u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E",transcodingAudio:"\u0422\u0440\u0430\u043D\u0441\u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E \u0447\u0435\u0440\u0435\u0437 FFmpeg",encodedPlaybackOnly:"\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0434\u0435\u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0430\u0443\u0434\u0438\u043E.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u043E\u0432 PCM",pcmUsedDefaultParams:"\u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E \u0441 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u0430\u043C\u0438 PCM \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E.",pcmFillParams:"\u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B PCM \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u0427\u0438\u0442\u0430\u0442\u044C.",wavPcmFillParams:"\u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u0427\u0438\u0442\u0430\u0442\u044C, \u0447\u0442\u043E\u0431\u044B \u0440\u0430\u0437\u043E\u0431\u0440\u0430\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0438\u0439 WAV \u043A\u0430\u043A PCM.",currentPcmFormat:"\u0422\u0435\u043A\u0443\u0449\u0438\u0439",savedDefaultPcmFormat:"\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",audioLoaded:"\u0410\u0443\u0434\u0438\u043E \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E",audioNotReady:"\u0410\u0443\u0434\u0438\u043E \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u043E",audioCannotPlay:"\u042D\u0442\u043E \u0430\u0443\u0434\u0438\u043E \u043D\u0435\u043B\u044C\u0437\u044F \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0441\u0442\u0438 \u0432 webview",playbackFailed:"\u0421\u0431\u043E\u0439 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u044F",analyzingSpectrogram:"\u0410\u043D\u0430\u043B\u0438\u0437 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"\u0421\u0431\u043E\u0439 \u0438\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u0438 AudioLens",trackGain:"\u0423\u0441\u0438\u043B\u0435\u043D\u0438\u0435",trackPan:"\u041F\u0430\u043D\u043E\u0440\u0430\u043C\u0430",panLeft:"\u041B",panRight:"\u041F",panCenter:"\u0426",doubleClickReset:"\u0414\u0432\u043E\u0439\u043D\u043E\u0439 \u043A\u043B\u0438\u043A \u0434\u043B\u044F \u0441\u0431\u0440\u043E\u0441\u0430",freqScaleMenuTitle:"\u0427\u0430\u0441\u0442\u043E\u0442\u043D\u0430\u044F \u0448\u043A\u0430\u043B\u0430 \u043A\u0430\u043D\u0430\u043B\u0430",restoreChannelDefault:"\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u043A\u0430\u043D\u0430\u043B \u043A \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",helpAxisGroup:"\u0412\u0435\u0440\u0442\u0438\u043A\u0430\u043B\u044C\u043D\u0430\u044F \u043E\u0441\u044C",helpAxisZoom:"Ctrl + \u043A\u043E\u043B\u0435\u0441\u043E / \u0449\u0438\u043F\u043E\u043A \u043D\u0430 \u043E\u0441\u0438: \u043C\u0430\u0441\u0448\u0442\u0430\u0431 \u044D\u0442\u043E\u0439 \u043E\u0441\u0438 (\u043F\u043E \u043A\u0430\u043D\u0430\u043B\u0430\u043C)",helpAxisPan:"Shift + \u043A\u043E\u043B\u0435\u0441\u043E / \u0433\u043E\u0440\u0438\u0437\u043E\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0432\u0430\u0439\u043F \u043D\u0430 \u043E\u0441\u0438: \u0441\u0434\u0432\u0438\u0433 \u044D\u0442\u043E\u0439 \u043E\u0441\u0438 (\u043F\u043E \u043A\u0430\u043D\u0430\u043B\u0430\u043C)",helpAxisAlt:"Alt + \u043A\u043E\u043B\u0435\u0441\u043E \u043D\u0430 \u0432\u043E\u043B\u043D\u0435: \u043C\u0430\u0441\u0448\u0442\u0430\u0431 \u0430\u043C\u043F\u043B\u0438\u0442\u0443\u0434\u044B \u043A\u0430\u043D\u0430\u043B\u0430",helpAxisScaleMenu:"\u041F\u041A\u041C \u043F\u043E \u043E\u0441\u0438 \u0447\u0430\u0441\u0442\u043E\u0442: \u0437\u0430\u0434\u0430\u0442\u044C \u0448\u043A\u0430\u043B\u0443 \u044D\u0442\u043E\u0433\u043E \u043A\u0430\u043D\u0430\u043B\u0430",helpAxisReset:"\u0414\u0432\u043E\u0439\u043D\u043E\u0439 \u043A\u043B\u0438\u043A \u043F\u043E \u043E\u0441\u0438: \u0441\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u043A\u0430\u043D\u0430\u043B \u043A \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E"};var ea={waitingAudioFile:"Ses dosyasi bekleniyor",initializing:"Baslatiliyor",spectrogramSettings:"Spektrogram ayarlari",playPause:"Oynat / duraklat",playbackPosition:"Oynatma konumu",closeSettings:"Ayarlari kapat",spectrogramDisplay:"Spektrogram gorunumu",algorithmFrequency:"Frekans",windowSize:"Pencere boyutu",windowType:"Pencere tipi",windowRectangular:"Dikdortgen",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gauss (\u03B1=2.5)",windowGaussian35:"Gauss (\u03B1=3.5)",windowGaussian45:"Gauss (\u03B1=4.5)",zeroPaddingFactor:"Zero padding katsayisi",frequencyScale:"Frekans olcegi",frequencyRange:"Frekans araligi (yalnizca gorunum)",minFrequencyHz:"Min frekans (Hz)",maxFrequencyHz:"Maks frekans (Hz)",maxFrequencyNyquist:"Maks Nyquist'i izler",spectrogramAppearance:"Spektrogram gorunumu",palette:"Palet",paletteRose:"Gul",paletteClassic:"Klasik",paletteGrayscale:"Gri tonlama",paletteInverseGrayscale:"Ters gri tonlama",minDb:"Min dB (parlakl\u0131k)",maxDb:"Maks dB (parlakl\u0131k)",autoBrightness:"Otomatik parlakl\u0131k",amplitudeRange:"Genlik aral\u0131\u011F\u0131 (dalga)",minAmplitude:"Min genlik",maxAmplitude:"Maks genlik",amplitudeAuto:"Otomatik (kanala g\xF6re)",channel:"Kanal",timeZoom:"Zaman zumu",timePosition:"Zaman konumu",mouseWheel:"Fare tekeri",help:"Yard\u0131m",downloadAudio:"Sesi indir",downloadSelection:"Secimi indir",downloadSelectionWav:"Secimi WAV olarak indir",clearSelection:"Secimi temizle",noSelectionToDownload:"Indirilecek ses secimi yok",headerInfo:"Ba\u015Fl\u0131k bilgisi",headerInfoTitle:"Ba\u015Fl\u0131k bilgisi",headerInfoAudioUnread:"Ses verisi hen\xFCz okunmad\u0131.",headerInfoUnsupported:"Bu format i\xE7in ba\u015Fl\u0131k ayr\u0131\u015Ft\u0131rma hen\xFCz desteklenmiyor.",headerInfoOffset:"Ofset",headerInfoByteOffset:"Bayt ofseti",headerInfoSize:"Uzunluk",headerInfoBits:"Bitler",headerInfoField:"Alan",headerInfoValue:"De\u011Fer",headerInfoDescription:"A\xE7\u0131klama",headerInfoWavMissingData:"data chunk bulunamad\u0131",headerInfoWavCannotDetermine:"WAV ba\u015Fl\u0131k uzunlu\u011Fu belirlenemiyor.",headerInfoWavHeaderLength:"WAV ba\u015Fl\u0131k uzunlu\u011Fu {size} B",headerInfoWavStandardPcm:"Standart 44 bayt PCM ba\u015Fl\u0131\u011F\u0131.",headerInfoWavNonStandardPrefix:"44 bayt olmayan PCM ba\u015Fl\u0131\u011F\u0131",headerInfoWavFmtExtended:"fmt chunk {size} B ve geni\u015Fletilmi\u015F format alanlar\u0131 i\xE7eriyor",headerInfoWavFormat:"ses format\u0131 {format} ({name})",headerInfoWavExtraChunks:"data \xF6ncesinde ek chunk(lar): {chunks}",headerInfoWavDataOffsetNon44:"data 44 B d\u0131\u015F\u0131nda bir ofsette ba\u015Fl\u0131yor",headerInfoReasonSeparator:"; ",arkOffsetLabel:"ARK offseti",settings:"Ayarlar",pcmReadAs:"PCM olarak oku",pcmParams:"PCM dosya parametreleri",editPcmParams:"Parametreleri d\xFCzenle",wavPcmRead:"WAV'i PCM olarak oku",currentFileOnly:"Yaln\u0131zca ge\xE7erli dosya",sampleRate:"\xD6rnekleme h\u0131z\u0131",channels:"Kanallar",startOffsetBytes:"Offset (B)",bitDepth:"Kodlama",sampleFormat:"Format",endianness:"Byte order",read:"Oku",saveDefault:"Varsay\u0131lan\u0131 kaydet",cancel:"\u0130ptal",defaultView:"Varsay\u0131lan g\xF6r\xFCn\xFCm",view:"G\xF6r\xFCn\xFCm",viewBoth:"\xC7oklu g\xF6r\xFCn\xFCm",mute:"Sessiz",solo:"Solo",timeLabel:"Zaman",helpTimeZoom:"Zaman zumu",helpTimePan:"Zaman kayd\u0131rma",helpAmplitudeZoom:"Genlik zumu",helpRightClick:"Sa\u011F t\u0131k",helpPinch:"S\u0131k\u0131\u015Ft\u0131r",helpHorizontalSwipe:"Yatay kayd\u0131r",helpDoubleClick:"\xC7ift t\u0131k",helpPlaybackGroup:"Oynatma ve se\xE7im",helpViewGroup:"G\xF6r\xFCn\xFCm gezinme",helpMouseGroup:"Fare ve trackpad",helpGainGroup:"Kazan\xE7 ve pan",helpPlayPause:"Oynat / duraklat",helpClearSelection:"Men\xFCy\xFC kapat, se\xE7imi temizle veya oynatma imlecini s\u0131f\u0131rla",helpResetTimeZoom:"Zaman zumunu s\u0131f\u0131rla",helpTrackpadZoom:"Trackpad s\u0131k\u0131\u015Ft\u0131rma zaman zumu yapar",helpTrackpadPan:"Trackpad yatay kayd\u0131rma zaman\u0131 kayd\u0131r\u0131r",helpGainReset:"S\u0131f\u0131rlamak i\xE7in bir kanal\u0131n kazan\xE7 veya pan kayd\u0131r\u0131c\u0131s\u0131na \xE7ift t\u0131klay\u0131n",helpSelectionPlayback:"Bir segment se\xE7mek i\xE7in dalga bi\xE7imi veya spektrogram \xFCzerinde s\xFCr\xFCkle. Se\xE7im aktifken yaln\u0131zca o aral\u0131k oynat\u0131l\u0131r.",refreshSpectrogram:"Spektrogrami yenile",resetView:"Gorunumu sifirla",selectionAnalysis:"Secim analizi",selectionStart:"Baslangic",selectionEnd:"Bitis",selectionDuration:"Sure",rmsLevel:"RMS seviyesi",peakLevel:"Peak seviyesi",dominant:"Baskin",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"G\xFCr\xFClt\xFC taban\u0131",spectralCentroid:"Merkez",zeroCrossingRate:"ZCR",basicMetrics:"Temel metrikler",selectionAnalysisHelp:`Se\xE7im analizi:
Se\xE7ilen zaman aral\u0131\u011F\u0131n\u0131 seviye, dinamik aral\u0131k, clipping riski, g\xFCr\xFClt\xFC taban\u0131 ve frekans da\u011F\u0131l\u0131m\u0131 i\xE7in h\u0131zl\u0131ca analiz eder.

Kapsam:
Sonu\xE7lar yaln\u0131zca aktif kanal i\xE7in hesaplan\u0131r; kanallar kar\u0131\u015Ft\u0131r\u0131lmaz.

Kanal de\u011Fi\u015Ftirme:
Bir izi aktif yapmak i\xE7in \xFCzerine t\u0131kla.`,rmsLevelHelp:`RMS seviyesi:
Se\xE7imin ortalama enerjisini g\xF6sterir. Peak'ten daha stabildir ve \xE7ok d\xFC\u015F\xFCk veya \xE7ok y\xFCksek konu\u015Fmay\u0131 kontrol etmek i\xE7in kullan\u0131\u015Fl\u0131d\u0131r.`,peakLevelHelp:`Peak seviyesi:
Se\xE7imdeki en y\xFCksek anl\u0131k seviyeyi g\xF6sterir. 0 dBFS'e yak\u0131nl\u0131k ve clipping riski i\xE7in kullan\u0131\u015Fl\u0131d\u0131r.`,dominantHelp:`Bask\u0131n frekans:
Se\xE7imde en y\xFCksek birikmi\u015F g\xFCce sahip FFT bin frekans\u0131d\u0131r. Temel frekans veya alg\u0131lanan pitch olmak zorunda de\u011Fildir.`,crestFactorHelp:`Crest factor:
Peak/RMS oran\u0131. Daha b\xFCy\xFCk de\u011Ferler, ortalama enerjiye g\xF6re daha belirgin tepe noktalar\u0131 anlam\u0131na gelir.`,clippingRatioHelp:`Clipping oran\u0131:
Full scale'e yak\u0131n sample y\xFCzdesi. Kay\u0131t a\u015F\u0131r\u0131 y\xFCklenmesi veya dijital clipping riskini h\u0131zl\u0131ca g\xF6sterir.`,noiseFloorHelp:`G\xFCr\xFClt\xFC taban\u0131:
K\u0131sa RMS pencerelerinin d\xFC\u015F\xFCk y\xFCzdeliklerinden tahmin edilir. Se\xE7im \xE7o\u011Funlukla konu\u015Fma veya m\xFCzikse ger\xE7ek g\xFCr\xFClt\xFC taban\u0131ndan farkl\u0131 olabilir.`,spectralCentroidHelp:`Spektral merkez:
Spektral enerjinin Hz cinsinden a\u011F\u0131rl\u0131k merkezi. Sesin daha parlak veya koyu olma e\u011Filimini g\xF6sterir.`,zeroCrossingRateHelp:`Zero crossing rate:
Sinyalin i\u015Faret de\u011Fi\u015Ftirme h\u0131z\u0131. Y\xFCksek frekansl\u0131 g\xFCr\xFClt\xFC, \xF6t\xFCms\xFCz konu\u015Fma ve s\xFCrt\xFCnmeli sesler i\xE7in kullan\u0131\u015Fl\u0131d\u0131r.`,frequencyAnalysis:"Frekans analizi",frequencyAnalysisHelp:`Anlam:
Frekans band\u0131 ba\u015F\u0131na do\u011Frusal enerji y\xFCzdesi. RMS seviyesi veya dB de\u011Fildir.

Hesaplama:
Se\xE7im %50 overlap frame'lere b\xF6l\xFCn\xFCr; FFT bin g\xFCc\xFC toplan\u0131r ve frekans bantlar\u0131na atan\u0131r.`,selectionAnalysisCalculating:"Hesaplan\u0131yor...",bands:"Bantlar",waveform:"Dalga bicimi",spectrogram:"Spektrogram",adjustWaveformHeight:"Dalga bicimi yuksekligini ayarla",adjustSpectrogramHeight:"Spektrogram yuksekligini ayarla",ready:"Hazir",workspaceNotTrusted:"Calisma alani guvenilir degil; ses icerigi aktarilmaz",fileTooLarge:"Dosya siniri asiyor",readingAudio:"Ses okunuyor",readingAudioProgress:"Ses okunuyor",decodingAudio:"Ses cozuluyor",transcodingAudio:"Ses FFmpeg ile d\xF6n\xFC\u015Ft\xFCr\xFCl\xFCyor",encodedPlaybackOnly:"Ses kodu \xE7\xF6z\xFClemedi.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"PCM parametreleri bekleniyor",pcmUsedDefaultParams:"Varsay\u0131lan PCM parametreleriyle y\xFCklendi.",pcmFillParams:"PCM parametrelerini girin, sonra Oku'ya t\u0131klay\u0131n.",wavPcmFillParams:"Parametreleri girin, sonra ge\xE7erli WAV'i PCM olarak ayr\u0131\u015Ft\u0131rmak i\xE7in Oku'ya t\u0131klay\u0131n.",currentPcmFormat:"Ge\xE7erli",savedDefaultPcmFormat:"Kaydedilen varsay\u0131lan",audioLoaded:"Ses yuklendi",audioNotReady:"Ses hazir degil",audioCannotPlay:"Bu ses webview icinde oynatilamiyor",playbackFailed:"Oynatma basarisiz",analyzingSpectrogram:"Spektrogram analiz ediliyor",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens baslatilamadi",trackGain:"Kazan\xE7",trackPan:"Pan",panLeft:"L",panRight:"R",panCenter:"C",doubleClickReset:"S\u0131f\u0131rlamak i\xE7in \xE7ift t\u0131klay\u0131n",freqScaleMenuTitle:"Kanal frekans \xF6l\xE7e\u011Fi",restoreChannelDefault:"Kanal varsay\u0131lan\u0131na d\xF6n",helpAxisGroup:"Dikey eksen",helpAxisZoom:"Eksende Ctrl + tekerlek / k\u0131st\u0131rma: o ekseni yak\u0131nla\u015Ft\u0131r (kanal ba\u015F\u0131na)",helpAxisPan:"Eksende Shift + tekerlek / yatay kayd\u0131rma: o ekseni kayd\u0131r (kanal ba\u015F\u0131na)",helpAxisAlt:"Dalga \xFCzerinde Alt + tekerlek: kanal\u0131n genli\u011Fini yak\u0131nla\u015Ft\u0131r",helpAxisScaleMenu:"Frekans eksenine sa\u011F t\u0131k: bu kanal\u0131n \xF6l\xE7e\u011Fini ayarla",helpAxisReset:"Eksene \xE7ift t\u0131k: bu kanal\u0131n varsay\u0131lan\u0131n\u0131 geri y\xFCkle"};var aa={waitingAudioFile:"\u0110ang ch\u1EDD t\u1EC7p \xE2m thanh",initializing:"\u0110ang kh\u1EDFi t\u1EA1o",spectrogramSettings:"C\xE0i \u0111\u1EB7t spectrogram",playPause:"Ph\xE1t / t\u1EA1m d\u1EEBng",playbackPosition:"V\u1ECB tr\xED ph\xE1t",closeSettings:"\u0110\xF3ng c\xE0i \u0111\u1EB7t",spectrogramDisplay:"Hi\u1EC3n th\u1ECB spectrogram",algorithmFrequency:"T\u1EA7n s\u1ED1",windowSize:"K\xEDch th\u01B0\u1EDBc c\u1EEDa s\u1ED5",windowType:"Lo\u1EA1i c\u1EEDa s\u1ED5",windowRectangular:"Ch\u1EEF nh\u1EADt",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"H\u1EC7 s\u1ED1 zero padding",frequencyScale:"Thang t\u1EA7n s\u1ED1",frequencyRange:"D\u1EA3i t\u1EA7n s\u1ED1 (ch\u1EC9 hi\u1EC3n th\u1ECB)",minFrequencyHz:"T\u1EA7n s\u1ED1 t\u1ED1i thi\u1EC3u (Hz)",maxFrequencyHz:"T\u1EA7n s\u1ED1 t\u1ED1i \u0111a (Hz)",maxFrequencyNyquist:"T\u1ED1i \u0111a theo Nyquist",spectrogramAppearance:"Giao di\u1EC7n spectrogram",palette:"B\u1EA3ng m\xE0u",paletteRose:"Rose",paletteClassic:"C\u1ED5 \u0111i\u1EC3n",paletteGrayscale:"Thang x\xE1m",paletteInverseGrayscale:"Thang x\xE1m \u0111\u1EA3o",minDb:"dB t\u1ED1i thi\u1EC3u (\u0111\u1ED9 s\xE1ng)",maxDb:"dB t\u1ED1i \u0111a (\u0111\u1ED9 s\xE1ng)",autoBrightness:"\u0110\u1ED9 s\xE1ng t\u1EF1 \u0111\u1ED9ng",amplitudeRange:"D\u1EA3i bi\xEAn \u0111\u1ED9 (s\xF3ng)",minAmplitude:"Bi\xEAn \u0111\u1ED9 t\u1ED1i thi\u1EC3u",maxAmplitude:"Bi\xEAn \u0111\u1ED9 t\u1ED1i \u0111a",amplitudeAuto:"T\u1EF1 \u0111\u1ED9ng (theo k\xEAnh)",channel:"K\xEAnh",timeZoom:"Thu ph\xF3ng th\u1EDDi gian",timePosition:"V\u1ECB tr\xED th\u1EDDi gian",mouseWheel:"Con l\u0103n chu\u1ED9t",help:"Tr\u1EE3 gi\xFAp",downloadAudio:"T\u1EA3i \xE2m thanh",downloadSelection:"T\u1EA3i v\xF9ng ch\u1ECDn",downloadSelectionWav:"T\u1EA3i v\xF9ng ch\u1ECDn d\u01B0\u1EDBi d\u1EA1ng WAV",clearSelection:"X\xF3a v\xF9ng ch\u1ECDn",noSelectionToDownload:"Kh\xF4ng c\xF3 v\xF9ng ch\u1ECDn \xE2m thanh \u0111\u1EC3 t\u1EA3i",headerInfo:"Th\xF4ng tin header",headerInfoTitle:"Th\xF4ng tin header",headerInfoAudioUnread:"D\u1EEF li\u1EC7u \xE2m thanh ch\u01B0a \u0111\u01B0\u1EE3c \u0111\u1ECDc.",headerInfoUnsupported:"Ch\u01B0a h\u1ED7 tr\u1EE3 ph\xE2n t\xEDch header cho \u0111\u1ECBnh d\u1EA1ng n\xE0y.",headerInfoOffset:"Offset",headerInfoByteOffset:"Offset byte",headerInfoSize:"\u0110\u1ED9 d\xE0i",headerInfoBits:"Bit",headerInfoField:"Tr\u01B0\u1EDDng",headerInfoValue:"Gi\xE1 tr\u1ECB",headerInfoDescription:"M\xF4 t\u1EA3",headerInfoWavMissingData:"kh\xF4ng t\xECm th\u1EA5y chunk data",headerInfoWavCannotDetermine:"Kh\xF4ng th\u1EC3 x\xE1c \u0111\u1ECBnh \u0111\u1ED9 d\xE0i header WAV.",headerInfoWavHeaderLength:"\u0110\u1ED9 d\xE0i header WAV {size} B",headerInfoWavStandardPcm:"Header PCM chu\u1EA9n 44 byte.",headerInfoWavNonStandardPrefix:"Header PCM kh\xF4ng ph\u1EA3i 44 byte",headerInfoWavFmtExtended:"chunk fmt d\xE0i {size} B v\xE0 ch\u1EE9a c\xE1c tr\u01B0\u1EDDng \u0111\u1ECBnh d\u1EA1ng m\u1EDF r\u1ED9ng",headerInfoWavFormat:"\u0111\u1ECBnh d\u1EA1ng \xE2m thanh l\xE0 {format} ({name})",headerInfoWavExtraChunks:"chunk b\u1ED5 sung tr\u01B0\u1EDBc data: {chunks}",headerInfoWavDataOffsetNon44:"data b\u1EAFt \u0111\u1EA7u \u1EDF offset kh\xE1c 44 B",headerInfoReasonSeparator:"; ",arkOffsetLabel:"Offset ARK",settings:"C\xE0i \u0111\u1EB7t",pcmReadAs:"\u0110\u1ECDc nh\u01B0 PCM",pcmParams:"Tham s\u1ED1 t\u1EC7p PCM",editPcmParams:"S\u1EEDa tham s\u1ED1",wavPcmRead:"\u0110\u1ECDc WAV nh\u01B0 PCM",currentFileOnly:"Ch\u1EC9 t\u1EC7p hi\u1EC7n t\u1EA1i",sampleRate:"T\u1EA7n s\u1ED1 l\u1EA5y m\u1EABu",channels:"S\u1ED1 k\xEAnh",startOffsetBytes:"Offset (B)",bitDepth:"M\xE3 h\xF3a",sampleFormat:"\u0110\u1ECBnh d\u1EA1ng",endianness:"Byte order",read:"\u0110\u1ECDc",saveDefault:"L\u01B0u m\u1EB7c \u0111\u1ECBnh",cancel:"H\u1EE7y",defaultView:"Ch\u1EBF \u0111\u1ED9 xem m\u1EB7c \u0111\u1ECBnh",view:"Ch\u1EBF \u0111\u1ED9 xem",viewBoth:"\u0110a ch\u1EBF \u0111\u1ED9",mute:"T\u1EAFt ti\u1EBFng",solo:"Solo",timeLabel:"Th\u1EDDi gian",helpTimeZoom:"Thu ph\xF3ng th\u1EDDi gian",helpTimePan:"D\u1ECBch chuy\u1EC3n th\u1EDDi gian",helpAmplitudeZoom:"Thu ph\xF3ng bi\xEAn \u0111\u1ED9",helpRightClick:"Nh\u1EA5p ph\u1EA3i",helpPinch:"Ch\u1EE5m",helpHorizontalSwipe:"Vu\u1ED1t ngang",helpDoubleClick:"Nh\u1EA5p \u0111\xFAp",helpPlaybackGroup:"Ph\xE1t v\xE0 v\xF9ng ch\u1ECDn",helpViewGroup:"\u0110i\u1EC1u h\u01B0\u1EDBng ch\u1EBF \u0111\u1ED9 xem",helpMouseGroup:"Chu\u1ED9t v\xE0 trackpad",helpGainGroup:"Gain & pan",helpPlayPause:"Ph\xE1t / t\u1EA1m d\u1EEBng",helpClearSelection:"\u0110\xF3ng menu, x\xF3a v\xF9ng ch\u1ECDn ho\u1EB7c \u0111\u1EB7t l\u1EA1i con tr\u1ECF ph\xE1t",helpResetTimeZoom:"\u0110\u1EB7t l\u1EA1i thu ph\xF3ng th\u1EDDi gian",helpTrackpadZoom:"Ch\u1EE5m tr\xEAn trackpad \u0111\u1EC3 thu ph\xF3ng th\u1EDDi gian",helpTrackpadPan:"Vu\u1ED1t ngang tr\xEAn trackpad \u0111\u1EC3 d\u1ECBch chuy\u1EC3n th\u1EDDi gian",helpGainReset:"Nh\u1EA5p \u0111\xFAp thanh tr\u01B0\u1EE3t gain ho\u1EB7c pan c\u1EE7a k\xEAnh \u0111\u1EC3 \u0111\u1EB7t l\u1EA1i",helpSelectionPlayback:"K\xE9o tr\xEAn d\u1EA1ng s\xF3ng ho\u1EB7c spectrogram \u0111\u1EC3 ch\u1ECDn \u0111o\u1EA1n. Khi c\xF3 v\xF9ng ch\u1ECDn, ch\u1EC9 v\xF9ng \u0111\xF3 \u0111\u01B0\u1EE3c ph\xE1t.",refreshSpectrogram:"L\xE0m m\u1EDBi spectrogram",resetView:"\u0110\u1EB7t l\u1EA1i ch\u1EBF \u0111\u1ED9 xem",selectionAnalysis:"Ph\xE2n t\xEDch v\xF9ng ch\u1ECDn",selectionStart:"B\u1EAFt \u0111\u1EA7u",selectionEnd:"K\u1EBFt th\xFAc",selectionDuration:"Th\u1EDDi l\u01B0\u1EE3ng",rmsLevel:"M\u1EE9c RMS",peakLevel:"M\u1EE9c Peak",dominant:"Chi\u1EBFm \u01B0u th\u1EBF",crestFactor:"Crest",clippingRatio:"Clipping",noiseFloor:"N\u1EC1n nhi\u1EC5u",spectralCentroid:"T\xE2m ph\u1ED5",zeroCrossingRate:"ZCR",basicMetrics:"Ch\u1EC9 s\u1ED1 c\u01A1 b\u1EA3n",selectionAnalysisHelp:`Ph\xE2n t\xEDch v\xF9ng ch\u1ECDn:
Ph\xE2n t\xEDch nhanh kho\u1EA3ng th\u1EDDi gian \u0111\xE3 ch\u1ECDn \u0111\u1EC3 ki\u1EC3m tra m\u1EE9c \xE2m, d\u1EA3i \u0111\u1ED9ng, nguy c\u01A1 clipping, n\u1EC1n nhi\u1EC5u v\xE0 ph\xE2n b\u1ED1 t\u1EA7n s\u1ED1.

Ph\u1EA1m vi:
K\u1EBFt qu\u1EA3 ch\u1EC9 t\xEDnh tr\xEAn k\xEAnh \u0111ang ho\u1EA1t \u0111\u1ED9ng; kh\xF4ng tr\u1ED9n c\xE1c k\xEAnh.

\u0110\u1ED5i k\xEAnh:
Nh\u1EA5p v\xE0o m\u1ED9t track \u0111\u1EC3 \u0111\u1EB7t n\xF3 l\xE0m k\xEAnh ho\u1EA1t \u0111\u1ED9ng.`,rmsLevelHelp:`M\u1EE9c RMS:
Hi\u1EC3n th\u1ECB n\u0103ng l\u01B0\u1EE3ng trung b\xECnh c\u1EE7a v\xF9ng ch\u1ECDn. \u1ED4n \u0111\u1ECBnh h\u01A1n peak v\xE0 h\u1EEFu \xEDch \u0111\u1EC3 ki\u1EC3m tra gi\u1ECDng n\xF3i qu\xE1 nh\u1ECF ho\u1EB7c qu\xE1 l\u1EDBn.`,peakLevelHelp:`M\u1EE9c peak:
Hi\u1EC3n th\u1ECB m\u1EE9c t\u1EE9c th\u1EDDi cao nh\u1EA5t trong v\xF9ng ch\u1ECDn. H\u1EEFu \xEDch \u0111\u1EC3 ki\u1EC3m tra g\u1EA7n 0 dBFS v\xE0 nguy c\u01A1 clipping.`,dominantHelp:`T\u1EA7n s\u1ED1 chi\u1EBFm \u01B0u th\u1EBF:
Bin FFT c\xF3 c\xF4ng su\u1EA5t t\xEDch l\u0169y cao nh\u1EA5t trong v\xF9ng ch\u1ECDn. Kh\xF4ng nh\u1EA5t thi\u1EBFt l\xE0 t\u1EA7n s\u1ED1 c\u01A1 b\u1EA3n ho\u1EB7c pitch c\u1EA3m nh\u1EADn.`,crestFactorHelp:`Crest factor:
T\u1EC9 l\u1EC7 gi\u1EEFa peak v\xE0 RMS. Gi\xE1 tr\u1ECB l\u1EDBn h\u01A1n ngh\u0129a l\xE0 peak n\u1ED5i b\u1EADt h\u01A1n so v\u1EDBi n\u0103ng l\u01B0\u1EE3ng trung b\xECnh.`,clippingRatioHelp:`T\u1EC9 l\u1EC7 clipping:
Ph\u1EA7n tr\u0103m sample g\u1EA7n full scale. Gi\xFAp ph\xE1t hi\u1EC7n qu\xE1 t\u1EA3i ghi \xE2m ho\u1EB7c clipping s\u1ED1.`,noiseFloorHelp:`N\u1EC1n nhi\u1EC5u:
\u01AF\u1EDBc l\u01B0\u1EE3ng t\u1EEB percentile th\u1EA5p c\u1EE7a RMS ng\u1EAFn h\u1EA1n. N\u1EBFu v\xF9ng ch\u1ECDn ch\u1EE7 y\u1EBFu l\xE0 gi\u1ECDng n\xF3i ho\u1EB7c nh\u1EA1c, gi\xE1 tr\u1ECB c\xF3 th\u1EC3 kh\xE1c n\u1EC1n nhi\u1EC5u th\u1EADt.`,spectralCentroidHelp:`T\xE2m ph\u1ED5:
Tr\u1ECDng t\xE2m n\u0103ng l\u01B0\u1EE3ng ph\u1ED5 theo Hz. Cho bi\u1EBFt \xE2m thanh thi\xEAn s\xE1ng hay t\u1ED1i.`,zeroCrossingRateHelp:`Zero crossing rate:
T\u1ED1c \u0111\u1ED9 t\xEDn hi\u1EC7u \u0111\u1ED5i d\u1EA5u. H\u1EEFu \xEDch cho nhi\u1EC5u t\u1EA7n s\u1ED1 cao, \xE2m v\xF4 thanh v\xE0 \xE2m x\xE1t.`,frequencyAnalysis:"Ph\xE2n t\xEDch t\u1EA7n s\u1ED1",frequencyAnalysisHelp:`\xDD ngh\u0129a:
Ph\u1EA7n tr\u0103m n\u0103ng l\u01B0\u1EE3ng tuy\u1EBFn t\xEDnh theo d\u1EA3i t\u1EA7n. \u0110\xE2y kh\xF4ng ph\u1EA3i m\u1EE9c RMS v\xE0 kh\xF4ng ph\u1EA3i dB.

C\xE1ch t\xEDnh:
V\xF9ng ch\u1ECDn \u0111\u01B0\u1EE3c chia th\xE0nh frame overlap 50%; c\xF4ng su\u1EA5t bin FFT \u0111\u01B0\u1EE3c t\xEDch l\u0169y r\u1ED3i ph\xE2n v\xE0o c\xE1c d\u1EA3i t\u1EA7n.`,selectionAnalysisCalculating:"\u0110ang t\xEDnh...",bands:"D\u1EA3i",waveform:"D\u1EA1ng s\xF3ng",spectrogram:"Spectrogram",adjustWaveformHeight:"\u0110i\u1EC1u ch\u1EC9nh chi\u1EC1u cao d\u1EA1ng s\xF3ng",adjustSpectrogramHeight:"\u0110i\u1EC1u ch\u1EC9nh chi\u1EC1u cao spectrogram",ready:"S\u1EB5n s\xE0ng",workspaceNotTrusted:"Workspace kh\xF4ng \u0111\xE1ng tin c\u1EADy; n\u1ED9i dung \xE2m thanh kh\xF4ng \u0111\u01B0\u1EE3c truy\u1EC1n",fileTooLarge:"T\u1EC7p v\u01B0\u1EE3t qu\xE1 gi\u1EDBi h\u1EA1n",readingAudio:"\u0110ang \u0111\u1ECDc \xE2m thanh",readingAudioProgress:"\u0110ang \u0111\u1ECDc \xE2m thanh",decodingAudio:"\u0110ang gi\u1EA3i m\xE3 \xE2m thanh",transcodingAudio:"\u0110ang chuy\u1EC3n m\xE3 \xE2m thanh b\u1EB1ng FFmpeg",encodedPlaybackOnly:"Kh\xF4ng th\u1EC3 gi\u1EA3i m\xE3 \xE2m thanh.",emptyWavNoAudio:"WAV file contains no audio data.",waitingPcmParams:"\u0110ang ch\u1EDD tham s\u1ED1 PCM",pcmUsedDefaultParams:"\u0110\xE3 t\u1EA3i b\u1EB1ng tham s\u1ED1 PCM m\u1EB7c \u0111\u1ECBnh.",pcmFillParams:"\u0110i\u1EC1n tham s\u1ED1 PCM r\u1ED3i nh\u1EA5p \u0110\u1ECDc.",wavPcmFillParams:"\u0110i\u1EC1n tham s\u1ED1 r\u1ED3i nh\u1EA5p \u0110\u1ECDc \u0111\u1EC3 ph\xE2n t\xEDch WAV hi\u1EC7n t\u1EA1i nh\u01B0 PCM.",currentPcmFormat:"Hi\u1EC7n t\u1EA1i",savedDefaultPcmFormat:"M\u1EB7c \u0111\u1ECBnh \u0111\xE3 l\u01B0u",audioLoaded:"\u0110\xE3 t\u1EA3i \xE2m thanh",audioNotReady:"\xC2m thanh ch\u01B0a s\u1EB5n s\xE0ng",audioCannotPlay:"Kh\xF4ng th\u1EC3 ph\xE1t \xE2m thanh n\xE0y trong webview",playbackFailed:"Ph\xE1t th\u1EA5t b\u1EA1i",analyzingSpectrogram:"\u0110ang ph\xE2n t\xEDch spectrogram",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"Kh\u1EDFi t\u1EA1o AudioLens th\u1EA5t b\u1EA1i",trackGain:"Gain",trackPan:"Pan",panLeft:"T",panRight:"P",panCenter:"G",doubleClickReset:"Nh\u1EA5p \u0111\xFAp \u0111\u1EC3 \u0111\u1EB7t l\u1EA1i",freqScaleMenuTitle:"Thang t\u1EA7n s\u1ED1 k\xEAnh",restoreChannelDefault:"Kh\xF4i ph\u1EE5c m\u1EB7c \u0111\u1ECBnh k\xEAnh",helpAxisGroup:"Tr\u1EE5c d\u1ECDc",helpAxisZoom:"Ctrl + cu\u1ED9n / ch\u1EE5m tr\xEAn m\u1ED9t tr\u1EE5c: thu ph\xF3ng tr\u1EE5c \u0111\xF3 (m\u1ED7i k\xEAnh)",helpAxisPan:"Shift + cu\u1ED9n / vu\u1ED1t ngang tr\xEAn m\u1ED9t tr\u1EE5c: d\u1ECBch tr\u1EE5c \u0111\xF3 (m\u1ED7i k\xEAnh)",helpAxisAlt:"Alt + cu\u1ED9n tr\xEAn d\u1EA1ng s\xF3ng: thu ph\xF3ng bi\xEAn \u0111\u1ED9 k\xEAnh",helpAxisScaleMenu:"Chu\u1ED9t ph\u1EA3i tr\u1EE5c t\u1EA7n s\u1ED1: \u0111\u1EB7t thang cho k\xEAnh n\xE0y",helpAxisReset:"Nh\u1EA5p \u0111\xFAp m\u1ED9t tr\u1EE5c: kh\xF4i ph\u1EE5c m\u1EB7c \u0111\u1ECBnh k\xEAnh n\xE0y"};var ta={waitingAudioFile:"\u7B49\u5F85\u97F3\u9891\u6587\u4EF6",initializing:"\u6B63\u5728\u521D\u59CB\u5316",spectrogramSettings:"\u9891\u8C31\u56FE\u8BBE\u7F6E",help:"\u5E2E\u52A9",downloadAudio:"\u4E0B\u8F7D\u97F3\u9891",downloadSelection:"\u4E0B\u8F7D\u9009\u533A",downloadSelectionWav:"\u4E0B\u8F7D\u9009\u533A\u4E3A WAV",clearSelection:"\u6E05\u9664\u9009\u533A",noSelectionToDownload:"\u6CA1\u6709\u53EF\u4E0B\u8F7D\u7684\u97F3\u9891\u9009\u533A",headerInfo:"\u6587\u4EF6\u5934\u4FE1\u606F",headerInfoTitle:"\u6587\u4EF6\u5934\u4FE1\u606F",headerInfoAudioUnread:"\u97F3\u9891\u6570\u636E\u5C1A\u672A\u8BFB\u53D6\u3002",headerInfoUnsupported:"\u5F53\u524D\u683C\u5F0F\u6682\u4E0D\u652F\u6301\u89E3\u6790\u6587\u4EF6\u5934\u4FE1\u606F\u3002",headerInfoOffset:"\u504F\u79FB",headerInfoByteOffset:"\u5B57\u8282\u504F\u79FB",headerInfoSize:"\u957F\u5EA6",headerInfoBits:"\u4F4D\u8303\u56F4",headerInfoField:"\u5B57\u6BB5",headerInfoValue:"\u503C",headerInfoDescription:"\u8BF4\u660E",headerInfoWavMissingData:"\u672A\u627E\u5230 data chunk",headerInfoWavCannotDetermine:"\u65E0\u6CD5\u5224\u65AD WAV \u5934\u957F\u5EA6\u3002",headerInfoWavHeaderLength:"WAV \u5934\u957F\u5EA6 {size} B",headerInfoWavStandardPcm:"\u6807\u51C6 44 \u5B57\u8282 PCM \u5934\u3002",headerInfoWavNonStandardPrefix:"\u975E 44 \u5B57\u8282 PCM \u5934",headerInfoWavFmtExtended:"fmt \u5B50\u5757\u4E3A {size} B\uFF0C\u5305\u542B\u6269\u5C55\u683C\u5F0F\u5B57\u6BB5",headerInfoWavFormat:"\u7F16\u7801\u683C\u5F0F\u4E3A {format} ({name})",headerInfoWavExtraChunks:"data \u524D\u6709\u989D\u5916\u5B50\u5757 {chunks}",headerInfoWavDataOffsetNon44:"data \u8D77\u59CB\u504F\u79FB\u4E0D\u662F 44 B",headerInfoReasonSeparator:"\uFF1B",arkOffsetLabel:"ARK \u504F\u79FB",settings:"\u8BBE\u7F6E",playPause:"\u64AD\u653E / \u6682\u505C",playbackPosition:"\u64AD\u653E\u4F4D\u7F6E",closeSettings:"\u5173\u95ED\u8BBE\u7F6E",spectrogramDisplay:"\u9891\u8C31\u56FE\u663E\u793A",algorithmFrequency:"\u9891\u7387",windowSize:"\u7A97\u53E3\u5927\u5C0F",windowType:"\u7A97\u53E3\u7C7B\u578B",windowRectangular:"\u77E9\u5F62",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"\u96F6\u586B\u5145\u56E0\u5B50",frequencyScale:"\u9891\u7387\u523B\u5EA6",frequencyRange:"\u9891\u7387\u8303\u56F4\uFF08\u4EC5\u663E\u793A\uFF09",minFrequencyHz:"\u6700\u5C0F\u9891\u7387 (Hz)",maxFrequencyHz:"\u6700\u5927\u9891\u7387 (Hz)",maxFrequencyNyquist:"\u6700\u5927\u503C\u8DDF\u968F Nyquist",spectrogramAppearance:"\u9891\u8C31\u56FE\u5916\u89C2",palette:"\u8C03\u8272\u677F",paletteRose:"\u989C\u8272 (\u73AB\u7470)",paletteClassic:"\u989C\u8272 (\u7ECF\u5178)",paletteGrayscale:"\u7070\u5EA6",paletteInverseGrayscale:"\u53CD\u76F8\u7070\u5EA6",minDb:"\u6700\u5C0F dB (\u4EAE\u5EA6)",maxDb:"\u6700\u5927 dB (\u4EAE\u5EA6)",autoBrightness:"\u81EA\u52A8\u4EAE\u5EA6",amplitudeRange:"\u632F\u5E45\u8303\u56F4\uFF08\u6CE2\u5F62\uFF09",minAmplitude:"\u6700\u5C0F\u632F\u5E45",maxAmplitude:"\u6700\u5927\u632F\u5E45",amplitudeAuto:"\u81EA\u9002\u5E94\uFF08\u6BCF\u901A\u9053\u8D34\u5408\uFF09",channel:"\u58F0\u9053",timeZoom:"\u65F6\u95F4\u7F29\u653E",timePosition:"\u65F6\u95F4\u4F4D\u7F6E",mouseWheel:"\u9F20\u6807\u6EDA\u8F6E",refreshSpectrogram:"\u5237\u65B0\u9891\u8C31\u56FE",resetView:"\u91CD\u7F6E\u89C6\u56FE",pcmReadAs:"\u6309 PCM \u8BFB\u53D6",pcmParams:"PCM \u6587\u4EF6\u53C2\u6570",editPcmParams:"\u4FEE\u6539\u53C2\u6570",wavPcmRead:"WAV \u6309 PCM \u8BFB\u53D6",currentFileOnly:"\u4EC5\u5BF9\u5F53\u524D\u6587\u4EF6\u751F\u6548",sampleRate:"\u91C7\u6837\u7387",channels:"\u901A\u9053\u6570",startOffsetBytes:"\u504F\u79FB(B)",bitDepth:"\u7F16\u7801",sampleFormat:"\u683C\u5F0F",endianness:"\u5B57\u8282\u5E8F",read:"\u8BFB\u53D6",saveDefault:"\u4FDD\u5B58\u9ED8\u8BA4",cancel:"\u53D6\u6D88",defaultView:"\u9ED8\u8BA4\u89C6\u56FE",view:"\u89C6\u56FE",viewBoth:"\u591A\u89C6\u56FE",mute:"\u9759\u97F3",solo:"\u72EC\u594F",timeLabel:"\u65F6\u95F4",helpTimeZoom:"\u65F6\u95F4\u7F29\u653E",helpTimePan:"\u65F6\u95F4\u5E73\u79FB",helpAmplitudeZoom:"\u5E45\u503C\u7F29\u653E",helpRightClick:"\u53F3\u952E",helpPinch:"\u53CC\u6307\u634F\u5408",helpHorizontalSwipe:"\u6A2A\u5411\u6ED1\u52A8",helpDoubleClick:"\u53CC\u51FB",helpPlaybackGroup:"\u64AD\u653E\u4E0E\u9009\u533A",helpViewGroup:"\u89C6\u56FE\u5BFC\u822A",helpMouseGroup:"\u9F20\u6807\u4E0E\u89E6\u63A7\u677F",helpGainGroup:"\u589E\u76CA\u4E0E\u58F0\u9053\u5E73\u8861",helpPlayPause:"\u64AD\u653E / \u6682\u505C",helpClearSelection:"\u5173\u95ED\u83DC\u5355\u3001\u6E05\u9664\u9009\u533A\u6216\u91CD\u7F6E\u64AD\u653E\u6E38\u6807",helpResetTimeZoom:"\u91CD\u7F6E\u65F6\u95F4\u7F29\u653E",helpTrackpadZoom:"\u89E6\u63A7\u677F\u53CC\u6307\u634F\u5408\u53EF\u7F29\u653E\u65F6\u95F4",helpTrackpadPan:"\u89E6\u63A7\u677F\u6A2A\u5411\u6ED1\u52A8\u53EF\u5E73\u79FB\u65F6\u95F4",helpGainReset:"\u53CC\u51FB\u901A\u9053\u7684\u589E\u76CA\u6216\u58F0\u9053\u5E73\u8861\u6ED1\u5757\u53EF\u91CD\u7F6E",helpSelectionPlayback:"\u5728\u6CE2\u5F62\u56FE\u6216\u8BED\u8C31\u56FE\u4E0A\u62D6\u62FD\u53EF\u6846\u9009\u7247\u6BB5\uFF1B\u6709\u9009\u533A\u65F6\u64AD\u653E\u53EA\u8BD5\u542C\u8BE5\u8303\u56F4\u3002",selectionAnalysis:"\u9009\u533A\u5206\u6790",selectionAnalysisHelp:`\u9009\u533A\u5206\u6790\uFF1A
\u5BF9\u5F53\u524D\u6846\u9009\u7684\u65F6\u95F4\u8303\u56F4\u8FDB\u884C\u5FEB\u901F\u7EDF\u8BA1\uFF0C\u5E2E\u52A9\u5224\u65AD\u5F55\u97F3\u7535\u5E73\u3001\u52A8\u6001\u8303\u56F4\u3001\u524A\u6CE2\u98CE\u9669\u3001\u566A\u58F0\u5E95\u548C\u9891\u7387\u5206\u5E03\u3002

\u5206\u6790\u5BF9\u8C61\uFF1A
\u5F53\u524D\u7ED3\u679C\u53EA\u9488\u5BF9\u6FC0\u6D3B\u901A\u9053\uFF0C\u4E0D\u4F1A\u628A\u591A\u4E2A\u901A\u9053\u6DF7\u5408\u8BA1\u7B97\u3002

\u5982\u4F55\u5207\u6362\uFF1A
\u70B9\u51FB\u67D0\u4E00\u6761\u97F3\u8F68\u540E\uFF0C\u8BE5\u97F3\u8F68\u4F1A\u6210\u4E3A\u5F53\u524D\u6FC0\u6D3B\u901A\u9053\uFF1B\u4E4B\u540E\u7684 RMS\u3001Peak\u3001Dominant \u548C\u9891\u7387\u5206\u6790\u90FD\u4F1A\u4F7F\u7528\u8FD9\u4E2A\u901A\u9053\u7684\u6570\u636E\u3002`,basicMetrics:"\u57FA\u7840\u6307\u6807",selectionStart:"\u5F00\u59CB",selectionEnd:"\u7ED3\u675F",selectionDuration:"\u65F6\u957F",rmsLevel:"RMS\u7535\u5E73",peakLevel:"\u5CF0\u503C\u7535\u5E73",dominant:"\u4E3B\u9891",crestFactor:"Crest",clippingRatio:"\u524A\u6CE2\u6BD4\u4F8B",noiseFloor:"\u566A\u58F0\u5E95",spectralCentroid:"\u9891\u8C31\u8D28\u5FC3",zeroCrossingRate:"\u8FC7\u96F6\u7387",rmsLevelHelp:`RMS \u7535\u5E73\uFF08RMS Level\uFF09\uFF1A
\u8BA1\u7B97\uFF1A
rms = sqrt(mean(sample\xB2))
rmsDb = 20 \xD7 log10(rms)

\u7528\u9014\uFF1A
\u53CD\u6620\u9009\u533A\u6574\u4F53\u80FD\u91CF/\u5E73\u5747\u54CD\u5EA6\u8D8B\u52BF\uFF0C\u6BD4\u5CF0\u503C\u66F4\u7A33\u5B9A\uFF0C\u9002\u5408\u89C2\u5BDF\u8BED\u97F3\u662F\u5426\u8FC7\u8F7B\u6216\u8FC7\u54CD\u3002

\u9650\u5236\uFF1A
RMS \u4E0D\u662F LUFS\uFF0C\u4E0D\u5305\u542B\u542C\u611F\u52A0\u6743\u548C\u95E8\u9650\u5904\u7406\uFF1B\u8D85\u957F\u9009\u533A\u4F1A\u7B49\u8DDD\u91C7\u6837\u4EE5\u4FDD\u6301\u754C\u9762\u54CD\u5E94\u3002

\u53C2\u8003\uFF1A
MathWorks rms\uFF1Blibrosa.feature.rms\uFF1BAudacity Measure RMS\u3002`,peakLevelHelp:`\u5CF0\u503C\u7535\u5E73\uFF08Peak Level\uFF09\uFF1A
\u8BA1\u7B97\uFF1A
peak = max(abs(sample))
peakDb = 20 \xD7 log10(peak)

\u7528\u9014\uFF1A
\u53CD\u6620\u9009\u533A\u5185\u6700\u9AD8\u77AC\u65F6\u7535\u5E73\uFF0C\u9002\u5408\u68C0\u67E5\u662F\u5426\u63A5\u8FD1 0 dBFS \u6216\u5B58\u5728\u524A\u6CE2\u98CE\u9669\u3002

\u9650\u5236\uFF1A
\u5CF0\u503C\u53EA\u770B\u77AC\u65F6\u6700\u5927\u503C\uFF0C\u4E0D\u4EE3\u8868\u6574\u4F53\u54CD\u5EA6\uFF1B\u8D85\u957F\u9009\u533A\u4F1A\u7B49\u8DDD\u91C7\u6837\u4EE5\u4FDD\u6301\u754C\u9762\u54CD\u5E94\u3002

\u53C2\u8003\uFF1A
Adobe Audition Amplitude Statistics\uFF1BAudacity Amplify\uFF1BAES17 0 dBFS\u3002`,dominantHelp:`\u4E3B\u9891\uFF08Dominant Frequency\uFF09\uFF1A
\u8868\u793A\u6574\u4E2A\u9009\u533A\u5185\u7D2F\u8BA1\u529F\u7387\u6700\u5927\u7684 FFT \u9891\u7387 bin\u3002

Bin \u5212\u5206\uFF1A
\u7B2C k \u4E2A bin \u5BF9\u5E94\u9891\u7387\uFF1A
freq = k \xD7 sampleRate / FFT size

\u529F\u7387\u8BA1\u7B97\uFF1A
\u6BCF\u4E00\u5E27\u4E2D\uFF0C\u6BCF\u4E2A bin \u7684\u529F\u7387\u4E3A\uFF1A
power = re\xB2 + im\xB2

\u9009\u533A\u7D2F\u8BA1\uFF1A
\u5BF9\u6574\u4E2A\u9009\u533A\u505A\u591A\u5E27 FFT\uFF0C\u9010\u5E27\u7D2F\u52A0\u540C\u4E00\u4E2A bin \u7684\u529F\u7387\uFF1A
binPower[k] += power

\u6700\u7EC8\u7ED3\u679C\uFF1A
\u53D6 binPower \u6700\u5927\u7684 k\uFF1A
dominantHz = k \xD7 sampleRate / FFT size

\u542B\u4E49\uFF1A
\u5B83\u4E0D\u7B49\u540C\u4E8E\u57FA\u9891\uFF0C\u4E5F\u4E0D\u4E00\u5B9A\u7B49\u540C\u4E8E\u542C\u611F\u97F3\u9AD8\u3002
\u9891\u7387\u5206\u8FA8\u7387\u7531 sampleRate / FFT size \u51B3\u5B9A\u3002

\u53C2\u8003\uFF1A
NumPy fftfreq\uFF1Blibrosa spectral features\u3002`,crestFactorHelp:`\u5CF0\u5747\u6BD4\uFF08Crest Factor\uFF09\uFF1A
\u5CF0\u5747\u6BD4\uFF0C\u4E5F\u5C31\u662F\u5CF0\u503C\u4E0E RMS \u7684\u6BD4\u503C\u3002

\u8BA1\u7B97\uFF1A
crest = peak / rms
crestDb = peakDb - rmsDb

\u7528\u9014\uFF1A
\u89C2\u5BDF\u52A8\u6001\u8303\u56F4\u548C\u77AC\u6001\u5F3A\u5EA6\u3002\u6570\u503C\u8D8A\u5927\uFF0C\u8868\u793A\u5CF0\u503C\u76F8\u5BF9\u5E73\u5747\u80FD\u91CF\u8D8A\u7A81\u51FA\u3002

\u9650\u5236\uFF1A
\u9759\u97F3\u6216\u6781\u4F4E\u7535\u5E73\u65F6\u4E0D\u7A33\u5B9A\uFF1B\u5B83\u4E0D\u80FD\u76F4\u63A5\u5224\u65AD\u97F3\u8D28\u597D\u574F\uFF0C\u53EA\u80FD\u63D0\u793A\u52A8\u6001\u7279\u5F81\u3002

\u53C2\u8003\uFF1A
MathWorks peak2rms\uFF1BSignal Processing Toolbox descriptive statistics\u3002`,clippingRatioHelp:`\u524A\u6CE2\u6BD4\u4F8B\uFF08Clipping Ratio\uFF09\uFF1A
\u7EDF\u8BA1\u9009\u533A\u4E2D\u63A5\u8FD1\u6EE1\u5E45\u5EA6\u7684\u91C7\u6837\u70B9\u6BD4\u4F8B\u3002

\u8BA1\u7B97\uFF1A
clippingRatio = count(abs(sample) >= 0.999) / measuredSamples \xD7 100%

\u7528\u9014\uFF1A
\u5FEB\u901F\u53D1\u73B0\u6570\u5B57\u6EE1\u5E45\u3001\u5F55\u97F3\u8FC7\u8F7D\u6216\u786C\u524A\u6CE2\u98CE\u9669\u3002

\u9650\u5236\uFF1A
\u6709\u4E9B\u97F3\u9891\u5728\u8FDB\u5165 AudioLens \u524D\u5DF2\u7ECF\u88AB\u9650\u5E45\u6216\u6A21\u62DF\u5931\u771F\uFF0C\u5373\u4F7F\u6CA1\u6709\u6EE1\u5E45\u91C7\u6837\u4E5F\u53EF\u80FD\u542C\u8D77\u6765\u5931\u771F\u3002

\u53C2\u8003\uFF1A
Audacity Find Clipping\uFF1BAdobe Audition Amplitude Statistics\uFF1BNetflix AudioClippingInspector\u3002`,noiseFloorHelp:`\u566A\u58F0\u5E95\uFF08Noise Floor\uFF09\uFF1A
\u7528\u77ED\u65F6 RMS \u7684\u4F4E\u5206\u4F4D\u6570\u4F30\u8BA1\u9009\u533A\u8F83\u5B89\u9759\u90E8\u5206\u7684\u7535\u5E73\u3002

\u8BA1\u7B97\uFF1A
1. \u5C06\u9009\u533A\u5207\u6210\u7EA6 20 ms \u7A97\u53E3\uFF0C50% overlap\u3002
2. \u8BA1\u7B97\u6BCF\u4E2A\u7A97\u53E3 RMS\u3002
3. \u53D6\u7B2C 10 \u767E\u5206\u4F4D RMS\uFF0C\u5E76\u6362\u7B97\u4E3A dBFS\u3002

\u7528\u9014\uFF1A
\u4F30\u8BA1\u5E95\u566A\u3001\u7A7A\u767D\u6BB5\u6D01\u51C0\u5EA6\u548C\u5F55\u97F3\u73AF\u5883\u566A\u58F0\u3002

\u9650\u5236\uFF1A
\u8FD9\u662F\u65E0\u76D1\u7763\u4F30\u8BA1\uFF1B\u5982\u679C\u9009\u533A\u51E0\u4E4E\u5168\u662F\u8BED\u97F3\u6216\u97F3\u4E50\uFF0C\u7ED3\u679C\u4E0D\u4E00\u5B9A\u7B49\u540C\u4E8E\u771F\u5B9E\u566A\u58F0\u5E95\u3002

\u53C2\u8003\uFF1A
Adobe Audition Minimum RMS\uFF1Blibrosa.feature.rms\uFF1BAudacity Noise Reduction\u3002`,spectralCentroidHelp:`\u9891\u8C31\u8D28\u5FC3\uFF08Spectral Centroid\uFF09\uFF1A
\u9891\u8C31\u80FD\u91CF\u7684\u91CD\u5FC3\uFF0C\u5355\u4F4D Hz\u3002

\u8BA1\u7B97\uFF1A
centroid = sum(freq[k] \xD7 power[k]) / sum(power[k])

\u7528\u9014\uFF1A
\u89C2\u5BDF\u58F0\u97F3\u504F\u4EAE\u8FD8\u662F\u504F\u95F7\uFF1B\u8BED\u97F3\u9AD8\u9891\u6210\u5206\u66F4\u591A\u65F6\u901A\u5E38\u4F1A\u66F4\u9AD8\u3002

\u9650\u5236\uFF1A
\u4F1A\u53D7\u566A\u58F0\u3001\u9F7F\u97F3\u548C\u5E26\u5BBD\u5F71\u54CD\uFF1B\u5B83\u4E0D\u662F\u97F3\u9AD8\uFF0C\u4E5F\u4E0D\u80FD\u5355\u72EC\u5224\u65AD\u6E05\u6670\u5EA6\u3002

\u53C2\u8003\uFF1A
librosa.feature.spectral_centroid\uFF1BMathWorks spectralCentroid\u3002`,zeroCrossingRateHelp:`\u8FC7\u96F6\u7387\uFF08Zero Crossing Rate\uFF09\uFF1A
\u7EDF\u8BA1\u4FE1\u53F7\u6B63\u8D1F\u53F7\u53D8\u5316\u7684\u9891\u7387\u3002

\u8BA1\u7B97\uFF1A
zeroCrossingRate = zeroCrossings / durationSeconds

\u7528\u9014\uFF1A
\u7C97\u7565\u89C2\u5BDF\u9AD8\u9891\u566A\u58F0\u3001\u6E05\u97F3\u3001\u6469\u64E6\u97F3\u7B49\u6210\u5206\uFF1B\u8BED\u97F3\u5206\u6790\u4E2D\u5E38\u4F5C\u4E3A\u65F6\u57DF\u7279\u5F81\u3002

\u9650\u5236\uFF1A
\u5BB9\u6613\u53D7\u566A\u58F0\u548C DC offset \u5F71\u54CD\uFF1B\u5B83\u4E0D\u80FD\u76F4\u63A5\u4EE3\u8868\u9891\u7387\u6216\u97F3\u9AD8\u3002

\u53C2\u8003\uFF1A
librosa.feature.zero_crossing_rate\uFF1Blibrosa.zero_crossings\u3002`,frequencyAnalysis:"\u9891\u7387\u5206\u6790",frequencyAnalysisHelp:`\u542B\u4E49\uFF1A
\u9891\u6BB5\u7EBF\u6027\u80FD\u91CF\u5360\u6BD4\uFF0C\u4E0D\u662F RMS level\uFF0C\u4E5F\u4E0D\u662F dB\u3002

\u8BA1\u7B97\uFF1A
1. \u5BF9\u9009\u533A\u5185\u5F53\u524D\u901A\u9053\u53D6\u6837\u3002
2. \u4F7F\u7528\u5F53\u524D\u7A97\u53E3\u51FD\u6570\u548C FFT size\uFF0C\u628A\u6574\u4E2A\u9009\u533A\u6309 50% overlap \u5206\u6210\u591A\u5E27\u3002
3. \u6BCF\u4E2A\u9891\u7387 bin \u7684\u529F\u7387\u4E3A re\xB2 + im\xB2\u3002
4. \u7D2F\u8BA1\u6240\u6709\u5E27\u7684 bin \u529F\u7387\uFF0C\u5E76\u6309\u9891\u7387\u5F52\u5165\u5404\u9891\u6BB5\u3002
5. \u663E\u793A bandPower / totalPower \xD7 100%\u3002

\u6CE8\u610F\uFF1A
\u8FD9\u662F\u6574\u4E2A\u9009\u533A\u7684\u591A\u5E27\u9891\u8C31\u80FD\u91CF\u5206\u5E03\uFF1B\u4ECD\u4E0D\u662F dB/RMS\u3002`,selectionAnalysisCalculating:"\u8BA1\u7B97\u4E2D...",bands:"\u9891\u6BB5",waveform:"\u6CE2\u5F62",spectrogram:"\u9891\u8C31\u56FE",adjustWaveformHeight:"\u8C03\u6574\u6CE2\u5F62\u9AD8\u5EA6",adjustSpectrogramHeight:"\u8C03\u6574\u9891\u8C31\u56FE\u9AD8\u5EA6",ready:"\u5C31\u7EEA",workspaceNotTrusted:"\u5DE5\u4F5C\u533A\u4E0D\u53D7\u4FE1\u4EFB",fileTooLarge:"\u6587\u4EF6\u8D85\u8FC7\u9650\u5236",readingAudio:"\u6B63\u5728\u8BFB\u53D6\u97F3\u9891",readingAudioProgress:"\u6B63\u5728\u8BFB\u53D6\u97F3\u9891",decodingAudio:"\u6B63\u5728\u89E3\u7801\u97F3\u9891",transcodingAudio:"\u6B63\u5728\u4F7F\u7528 FFmpeg \u8F6C\u7801\u97F3\u9891",encodedPlaybackOnly:"\u97F3\u9891\u89E3\u7801\u5931\u8D25\u3002",emptyWavNoAudio:"WAV \u6587\u4EF6\u4E0D\u5305\u542B\u97F3\u9891\u6570\u636E\u3002",waitingPcmParams:"\u7B49\u5F85 PCM \u53C2\u6570",pcmUsedDefaultParams:"\u5DF2\u4F7F\u7528\u9ED8\u8BA4 PCM \u53C2\u6570\u8BFB\u53D6\u3002",pcmFillParams:"\u8BF7\u586B\u5199 PCM \u53C2\u6570\uFF0C\u7136\u540E\u70B9\u51FB\u201C\u8BFB\u53D6\u201D\u3002",wavPcmFillParams:"\u586B\u5199\u53C2\u6570\u540E\u70B9\u51FB\u201C\u8BFB\u53D6\u201D\uFF0C\u5C06\u6309 PCM \u91CD\u65B0\u89E3\u6790\u5F53\u524D WAV\u3002",currentPcmFormat:"\u5F53\u524D",savedDefaultPcmFormat:"\u5DF2\u4FDD\u5B58\u9ED8\u8BA4\u53C2\u6570",audioLoaded:"\u97F3\u9891\u5DF2\u52A0\u8F7D",audioNotReady:"\u97F3\u9891\u5C1A\u672A\u5C31\u7EEA",audioCannotPlay:"\u6B64\u97F3\u9891\u65E0\u6CD5\u5728 Webview \u4E2D\u64AD\u653E",playbackFailed:"\u64AD\u653E\u5931\u8D25",analyzingSpectrogram:"\u6B63\u5728\u5206\u6790\u9891\u8C31\u56FE",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens \u521D\u59CB\u5316\u5931\u8D25",trackGain:"\u589E\u76CA",trackPan:"\u58F0\u9053\u5E73\u8861",panLeft:"\u5DE6",panRight:"\u53F3",panCenter:"\u4E2D",doubleClickReset:"\u53CC\u51FB\u91CD\u7F6E",freqScaleMenuTitle:"\u8BE5\u901A\u9053\u9891\u7387\u523B\u5EA6",restoreChannelDefault:"\u6062\u590D\u8BE5\u901A\u9053\u9ED8\u8BA4",helpAxisGroup:"\u7EB5\u5411\u5750\u6807\u8F74",helpAxisZoom:"\u5750\u6807\u8F74\u4E0A Ctrl+\u6EDA\u8F6E / \u634F\u5408\uFF1A\u7F29\u653E\u8BE5\u8F74\uFF08\u6BCF\u901A\u9053\uFF09",helpAxisPan:"\u5750\u6807\u8F74\u4E0A Shift+\u6EDA\u8F6E / \u6A2A\u5411\u6ED1\u52A8\uFF1A\u5E73\u79FB\u8BE5\u8F74\uFF08\u6BCF\u901A\u9053\uFF09",helpAxisAlt:"\u6CE2\u5F62\u56FE\u4E0A Alt+\u6EDA\u8F6E\uFF1A\u7F29\u653E\u8BE5\u901A\u9053\u632F\u5E45",helpAxisScaleMenu:"\u9891\u7387\u8F74\u53F3\u952E\uFF1A\u8BBE\u7F6E\u8BE5\u901A\u9053\u523B\u5EA6\u7C7B\u578B",helpAxisReset:"\u5750\u6807\u8F74\u53CC\u51FB\uFF1A\u6062\u590D\u8BE5\u901A\u9053\u9ED8\u8BA4"};var na={waitingAudioFile:"\u7B49\u5F85\u97F3\u8A0A\u6A94\u6848",initializing:"\u521D\u59CB\u5316\u4E2D",spectrogramSettings:"\u983B\u8B5C\u5716\u8A2D\u5B9A",playPause:"\u64AD\u653E / \u66AB\u505C",playbackPosition:"\u64AD\u653E\u4F4D\u7F6E",closeSettings:"\u95DC\u9589\u8A2D\u5B9A",spectrogramDisplay:"\u983B\u8B5C\u5716\u986F\u793A",algorithmFrequency:"\u983B\u7387",windowSize:"\u8996\u7A97\u5927\u5C0F",windowType:"\u8996\u7A97\u985E\u578B",windowRectangular:"\u77E9\u5F62",windowBartlett:"Bartlett",windowHamming:"Hamming",windowHann:"Hann",windowBlackman:"Blackman",windowBlackmanHarris:"Blackman-Harris",windowWelch:"Welch",windowGaussian25:"Gaussian (\u03B1=2.5)",windowGaussian35:"Gaussian (\u03B1=3.5)",windowGaussian45:"Gaussian (\u03B1=4.5)",zeroPaddingFactor:"\u96F6\u586B\u5145\u56E0\u5B50",frequencyScale:"\u983B\u7387\u523B\u5EA6",frequencyRange:"\u983B\u7387\u7BC4\u570D\uFF08\u50C5\u986F\u793A\uFF09",minFrequencyHz:"\u6700\u5C0F\u983B\u7387 (Hz)",maxFrequencyHz:"\u6700\u5927\u983B\u7387 (Hz)",maxFrequencyNyquist:"\u6700\u5927\u503C\u8DDF\u96A8 Nyquist",spectrogramAppearance:"\u983B\u8B5C\u5716\u5916\u89C0",palette:"\u8272\u76E4",paletteRose:"\u8272\u5F69 (\u73AB\u7470)",paletteClassic:"\u8272\u5F69 (\u7D93\u5178)",paletteGrayscale:"\u7070\u968E",paletteInverseGrayscale:"\u53CD\u5411\u7070\u968E",minDb:"\u6700\u5C0F dB (\u4EAE\u5EA6)",maxDb:"\u6700\u5927 dB (\u4EAE\u5EA6)",autoBrightness:"\u81EA\u52D5\u4EAE\u5EA6",amplitudeRange:"\u632F\u5E45\u7BC4\u570D\uFF08\u6CE2\u5F62\uFF09",minAmplitude:"\u6700\u5C0F\u632F\u5E45",maxAmplitude:"\u6700\u5927\u632F\u5E45",amplitudeAuto:"\u81EA\u9069\u61C9\uFF08\u6BCF\u901A\u9053\u8CBC\u5408\uFF09",channel:"\u8072\u9053",timeZoom:"\u6642\u9593\u7E2E\u653E",timePosition:"\u6642\u9593\u4F4D\u7F6E",mouseWheel:"\u6ED1\u9F20\u6EFE\u8F2A",help:"\u8AAA\u660E",downloadAudio:"\u4E0B\u8F09\u97F3\u8A0A",downloadSelection:"\u4E0B\u8F09\u9078\u5340",downloadSelectionWav:"\u4E0B\u8F09\u9078\u5340\u70BA WAV",clearSelection:"\u6E05\u9664\u9078\u5340",noSelectionToDownload:"\u6C92\u6709\u53EF\u4E0B\u8F09\u7684\u97F3\u8A0A\u9078\u5340",headerInfo:"\u6A94\u6848\u982D\u8CC7\u8A0A",headerInfoTitle:"\u6A94\u6848\u982D\u8CC7\u8A0A",headerInfoAudioUnread:"\u5C1A\u672A\u8B80\u53D6\u97F3\u8A0A\u8CC7\u6599\u3002",headerInfoUnsupported:"\u76EE\u524D\u683C\u5F0F\u5C1A\u4E0D\u652F\u63F4\u89E3\u6790\u6A94\u6848\u982D\u8CC7\u8A0A\u3002",headerInfoOffset:"\u504F\u79FB",headerInfoByteOffset:"\u4F4D\u5143\u7D44\u504F\u79FB",headerInfoSize:"\u9577\u5EA6",headerInfoBits:"\u4F4D\u5143\u7BC4\u570D",headerInfoField:"\u6B04\u4F4D",headerInfoValue:"\u503C",headerInfoDescription:"\u8AAA\u660E",headerInfoWavMissingData:"\u627E\u4E0D\u5230 data chunk",headerInfoWavCannotDetermine:"\u7121\u6CD5\u5224\u65B7 WAV \u6A94\u6848\u982D\u9577\u5EA6\u3002",headerInfoWavHeaderLength:"WAV \u6A94\u6848\u982D\u9577\u5EA6 {size} B",headerInfoWavStandardPcm:"\u6A19\u6E96 44 \u4F4D\u5143\u7D44 PCM \u6A94\u6848\u982D\u3002",headerInfoWavNonStandardPrefix:"\u975E 44 \u4F4D\u5143\u7D44 PCM \u6A94\u6848\u982D",headerInfoWavFmtExtended:"fmt \u5B50\u5340\u584A\u70BA {size} B\uFF0C\u5305\u542B\u64F4\u5145\u683C\u5F0F\u6B04\u4F4D",headerInfoWavFormat:"\u7DE8\u78BC\u683C\u5F0F\u70BA {format} ({name})",headerInfoWavExtraChunks:"data \u524D\u6709\u984D\u5916\u5B50\u5340\u584A {chunks}",headerInfoWavDataOffsetNon44:"data \u8D77\u59CB\u504F\u79FB\u4E0D\u662F 44 B",headerInfoReasonSeparator:"\uFF1B",arkOffsetLabel:"ARK \u504F\u79FB",settings:"\u8A2D\u5B9A",pcmReadAs:"\u6309 PCM \u8B80\u53D6",pcmParams:"PCM \u6A94\u6848\u53C3\u6578",editPcmParams:"\u4FEE\u6539\u53C3\u6578",wavPcmRead:"WAV \u6309 PCM \u8B80\u53D6",currentFileOnly:"\u50C5\u5C0D\u76EE\u524D\u6A94\u6848\u751F\u6548",sampleRate:"\u53D6\u6A23\u7387",channels:"\u8072\u9053\u6578",startOffsetBytes:"\u504F\u79FB(B)",bitDepth:"\u7DE8\u78BC",sampleFormat:"\u683C\u5F0F",endianness:"\u5B57\u7BC0\u5E8F",read:"\u8B80\u53D6",saveDefault:"\u5132\u5B58\u9810\u8A2D",cancel:"\u53D6\u6D88",defaultView:"\u9810\u8A2D\u8996\u5716",view:"\u8996\u5716",viewBoth:"\u591A\u8996\u5716",mute:"\u975C\u97F3",solo:"\u7368\u594F",timeLabel:"\u6642\u9593",helpTimeZoom:"\u6642\u9593\u7E2E\u653E",helpTimePan:"\u6642\u9593\u5E73\u79FB",helpAmplitudeZoom:"\u632F\u5E45\u7E2E\u653E",helpRightClick:"\u53F3\u9375",helpPinch:"\u96D9\u6307\u634F\u5408",helpHorizontalSwipe:"\u6A6B\u5411\u6ED1\u52D5",helpDoubleClick:"\u96D9\u64CA",helpPlaybackGroup:"\u64AD\u653E\u8207\u9078\u5340",helpViewGroup:"\u8996\u5716\u5C0E\u89BD",helpMouseGroup:"\u6ED1\u9F20\u8207\u89F8\u63A7\u677F",helpGainGroup:"\u589E\u76CA\u8207\u8072\u9053\u5E73\u8861",helpPlayPause:"\u64AD\u653E / \u66AB\u505C",helpClearSelection:"\u95DC\u9589\u9078\u55AE\u3001\u6E05\u9664\u9078\u5340\u6216\u91CD\u8A2D\u64AD\u653E\u6E38\u6A19",helpResetTimeZoom:"\u91CD\u8A2D\u6642\u9593\u7E2E\u653E",helpTrackpadZoom:"\u89F8\u63A7\u677F\u96D9\u6307\u634F\u5408\u53EF\u7E2E\u653E\u6642\u9593",helpTrackpadPan:"\u89F8\u63A7\u677F\u6A6B\u5411\u6ED1\u52D5\u53EF\u5E73\u79FB\u6642\u9593",helpGainReset:"\u96D9\u64CA\u901A\u9053\u7684\u589E\u76CA\u6216\u8072\u9053\u5E73\u8861\u6ED1\u687F\u53EF\u91CD\u8A2D",helpSelectionPlayback:"\u5728\u6CE2\u5F62\u5716\u6216\u983B\u8B5C\u5716\u4E0A\u62D6\u66F3\u53EF\u6846\u9078\u7247\u6BB5\uFF1B\u6709\u9078\u5340\u6642\u64AD\u653E\u53EA\u6703\u8A66\u807D\u8A72\u7BC4\u570D\u3002",refreshSpectrogram:"\u91CD\u65B0\u6574\u7406\u983B\u8B5C\u5716",resetView:"\u91CD\u8A2D\u8996\u5716",selectionAnalysis:"\u9078\u5340\u5206\u6790",selectionStart:"\u958B\u59CB",selectionEnd:"\u7D50\u675F",selectionDuration:"\u6301\u7E8C\u6642\u9593",rmsLevel:"RMS\u96FB\u5E73",peakLevel:"\u5CF0\u503C\u96FB\u5E73",dominant:"\u4E3B\u983B",crestFactor:"Crest",clippingRatio:"\u524A\u6CE2\u6BD4\u4F8B",noiseFloor:"\u566A\u8072\u5E95",spectralCentroid:"\u983B\u8B5C\u8CEA\u5FC3",zeroCrossingRate:"ZCR",basicMetrics:"\u57FA\u790E\u6307\u6A19",selectionAnalysisHelp:`\u9078\u5340\u5206\u6790\uFF1A
\u5C0D\u76EE\u524D\u6846\u9078\u7684\u6642\u9593\u7BC4\u570D\u9032\u884C\u5FEB\u901F\u7D71\u8A08\uFF0C\u5354\u52A9\u5224\u65B7\u9304\u97F3\u96FB\u5E73\u3001\u52D5\u614B\u7BC4\u570D\u3001\u524A\u6CE2\u98A8\u96AA\u3001\u566A\u8072\u5E95\u8207\u983B\u7387\u5206\u4F48\u3002

\u5206\u6790\u5C0D\u8C61\uFF1A
\u7D50\u679C\u53EA\u91DD\u5C0D\u555F\u7528\u4E2D\u7684\u8072\u9053\uFF0C\u4E0D\u6703\u6DF7\u5408\u591A\u500B\u8072\u9053\u3002

\u5982\u4F55\u5207\u63DB\uFF1A
\u9EDE\u64CA\u67D0\u4E00\u689D\u97F3\u8ECC\u5F8C\uFF0C\u8A72\u97F3\u8ECC\u6703\u6210\u70BA\u76EE\u524D\u555F\u7528\u8072\u9053\u3002`,rmsLevelHelp:`RMS \u96FB\u5E73\uFF1A
\u986F\u793A\u9078\u5340\u7684\u5E73\u5747\u80FD\u91CF\uFF0C\u6BD4\u5CF0\u503C\u66F4\u7A69\u5B9A\uFF0C\u9069\u5408\u6AA2\u67E5\u8A9E\u97F3\u662F\u5426\u904E\u5C0F\u6216\u904E\u5927\u3002`,peakLevelHelp:`\u5CF0\u503C\u96FB\u5E73\uFF1A
\u986F\u793A\u9078\u5340\u4E2D\u7684\u6700\u9AD8\u77AC\u6642\u96FB\u5E73\uFF0C\u9069\u5408\u6AA2\u67E5\u662F\u5426\u63A5\u8FD1 0 dBFS \u6216\u6709\u524A\u6CE2\u98A8\u96AA\u3002`,dominantHelp:`\u4E3B\u983B\uFF1A
\u9078\u5340\u5167\u7D2F\u7A4D\u529F\u7387\u6700\u5927\u7684 FFT bin \u5C0D\u61C9\u983B\u7387\u3002\u5B83\u4E0D\u4E00\u5B9A\u662F\u57FA\u983B\u6216\u807D\u611F\u97F3\u9AD8\u3002`,crestFactorHelp:`Crest Factor\uFF1A
\u5CF0\u503C\u8207 RMS \u7684\u6BD4\u503C\u3002\u6578\u503C\u8D8A\u5927\uFF0C\u8868\u793A\u5CF0\u503C\u76F8\u5C0D\u5E73\u5747\u80FD\u91CF\u8D8A\u7A81\u51FA\u3002`,clippingRatioHelp:`\u524A\u6CE2\u6BD4\u4F8B\uFF1A
\u63A5\u8FD1\u6EFF\u523B\u5EA6\u7684 sample \u6BD4\u4F8B\uFF0C\u7528\u65BC\u5FEB\u901F\u5075\u6E2C\u9304\u97F3\u904E\u8F09\u6216\u6578\u4F4D\u524A\u6CE2\u98A8\u96AA\u3002`,noiseFloorHelp:`\u566A\u8072\u5E95\uFF1A
\u7531\u77ED\u6642 RMS \u7684\u4F4E\u767E\u5206\u4F4D\u4F30\u7B97\u80CC\u666F\u566A\u8072\u3002\u82E5\u9078\u5340\u5927\u591A\u662F\u8A9E\u97F3\u6216\u97F3\u6A02\uFF0C\u53EF\u80FD\u4E0D\u7B49\u65BC\u771F\u5BE6\u566A\u8072\u5E95\u3002`,spectralCentroidHelp:`\u983B\u8B5C\u8CEA\u5FC3\uFF1A
\u983B\u8B5C\u80FD\u91CF\u7684\u91CD\u5FC3\uFF0C\u55AE\u4F4D\u70BA Hz\uFF0C\u7528\u65BC\u89C0\u5BDF\u8072\u97F3\u504F\u4EAE\u6216\u504F\u6697\u3002`,zeroCrossingRateHelp:`\u904E\u96F6\u7387\uFF1A
\u8A0A\u865F\u6539\u8B8A\u6B63\u8CA0\u865F\u7684\u983B\u7387\uFF0C\u5E38\u7528\u65BC\u89C0\u5BDF\u9AD8\u983B\u566A\u8072\u3001\u7121\u8072\u5B50\u97F3\u8207\u6469\u64E6\u97F3\u3002`,frequencyAnalysis:"\u983B\u7387\u5206\u6790",frequencyAnalysisHelp:`\u542B\u7FA9\uFF1A
\u5404\u983B\u5E36\u7684\u7DDA\u6027\u80FD\u91CF\u767E\u5206\u6BD4\uFF0C\u4E0D\u662F RMS \u96FB\u5E73\uFF0C\u4E5F\u4E0D\u662F dB\u3002

\u8A08\u7B97\uFF1A
\u5C07\u9078\u5340\u5207\u6210 50% overlap \u7684 FFT frame\uFF0C\u7D2F\u7A4D\u5404 bin \u529F\u7387\u5F8C\u5206\u914D\u5230\u983B\u5E36\u4E26\u986F\u793A\u767E\u5206\u6BD4\u3002`,selectionAnalysisCalculating:"\u8A08\u7B97\u4E2D...",bands:"\u983B\u5E36",waveform:"\u6CE2\u5F62",spectrogram:"\u983B\u8B5C\u5716",adjustWaveformHeight:"\u8ABF\u6574\u6CE2\u5F62\u9AD8\u5EA6",adjustSpectrogramHeight:"\u8ABF\u6574\u983B\u8B5C\u5716\u9AD8\u5EA6",ready:"\u5C31\u7DD2",workspaceNotTrusted:"\u5DE5\u4F5C\u5340\u4E0D\u53D7\u4FE1\u4EFB",fileTooLarge:"\u6A94\u6848\u8D85\u904E\u9650\u5236",readingAudio:"\u8B80\u53D6\u97F3\u8A0A\u4E2D",readingAudioProgress:"\u8B80\u53D6\u97F3\u8A0A\u4E2D",decodingAudio:"\u89E3\u78BC\u97F3\u8A0A\u4E2D",transcodingAudio:"\u6B63\u5728\u4F7F\u7528 FFmpeg \u8F49\u78BC\u97F3\u8A0A",encodedPlaybackOnly:"\u97F3\u8A0A\u89E3\u78BC\u5931\u6557\u3002",emptyWavNoAudio:"WAV \u6A94\u6848\u4E0D\u5305\u542B\u97F3\u8A0A\u8CC7\u6599\u3002",waitingPcmParams:"\u7B49\u5F85 PCM \u53C3\u6578",pcmUsedDefaultParams:"\u5DF2\u4F7F\u7528\u9810\u8A2D PCM \u53C3\u6578\u8F09\u5165\u3002",pcmFillParams:"\u8ACB\u586B\u5BEB PCM \u53C3\u6578\uFF0C\u7136\u5F8C\u9EDE\u64CA\u8B80\u53D6\u3002",wavPcmFillParams:"\u8ACB\u586B\u5BEB\u53C3\u6578\uFF0C\u7136\u5F8C\u9EDE\u64CA\u8B80\u53D6\uFF0C\u5C07\u76EE\u524D WAV \u6309 PCM \u89E3\u6790\u3002",currentPcmFormat:"\u76EE\u524D",savedDefaultPcmFormat:"\u5DF2\u5132\u5B58\u9810\u8A2D",audioLoaded:"\u97F3\u8A0A\u5DF2\u8F09\u5165",audioNotReady:"\u97F3\u8A0A\u5C1A\u672A\u5C31\u7DD2",audioCannotPlay:"\u6B64\u97F3\u8A0A\u7121\u6CD5\u5728 Webview \u64AD\u653E",playbackFailed:"\u64AD\u653E\u5931\u6557",analyzingSpectrogram:"\u5206\u6790\u983B\u8B5C\u5716\u4E2D",frequencyBand0To250:"0-250",frequencyBand250To500:"250-500",frequencyBand500To1k:"0.5-1k",frequencyBand1To2k:"1-2k",frequencyBand2To4k:"2-4k",frequencyBand4To8k:"4-8k",frequencyBand8kPlus:"8k+",pad:"pad",hop:"hop",initializationFailed:"AudioLens \u521D\u59CB\u5316\u5931\u6557",trackGain:"\u589E\u76CA",trackPan:"\u8072\u9053\u5E73\u8861",panLeft:"\u5DE6",panRight:"\u53F3",panCenter:"\u4E2D",doubleClickReset:"\u96D9\u64CA\u91CD\u8A2D",freqScaleMenuTitle:"\u8A72\u901A\u9053\u983B\u7387\u523B\u5EA6",restoreChannelDefault:"\u6062\u5FA9\u8A72\u901A\u9053\u9810\u8A2D",helpAxisGroup:"\u7E31\u5411\u5EA7\u6A19\u8EF8",helpAxisZoom:"\u5EA7\u6A19\u8EF8\u4E0A Ctrl+\u6EFE\u8F2A / \u634F\u5408\uFF1A\u7E2E\u653E\u8A72\u8EF8\uFF08\u6BCF\u901A\u9053\uFF09",helpAxisPan:"\u5EA7\u6A19\u8EF8\u4E0A Shift+\u6EFE\u8F2A / \u6A6B\u5411\u6ED1\u52D5\uFF1A\u5E73\u79FB\u8A72\u8EF8\uFF08\u6BCF\u901A\u9053\uFF09",helpAxisAlt:"\u6CE2\u5F62\u5716\u4E0A Alt+\u6EFE\u8F2A\uFF1A\u7E2E\u653E\u8A72\u901A\u9053\u632F\u5E45",helpAxisScaleMenu:"\u983B\u7387\u8EF8\u53F3\u9375\uFF1A\u8A2D\u5B9A\u8A72\u901A\u9053\u523B\u5EA6\u985E\u578B",helpAxisReset:"\u5EA7\u6A19\u8EF8\u96D9\u64CA\uFF1A\u6062\u5FA9\u8A72\u901A\u9053\u9810\u8A2D"};var at={"zh-CN":ta,"zh-TW":na,en:ce,ja:Ke,ko:_e,fr:je,de:Ge,ru:Qe,es:Oe,it:Ze,pt:Je,id:Ue,no:Xe,nl:$e,pl:Ye,tr:ea,vi:aa};function ue(n){return{...ce,...at[n]??{}}}function tt(n){let e=(n||"en").toLowerCase();return e==="zh-tw"||e==="zh-hk"||e==="zh-hant"||e.startsWith("zh-hant")?"zh-TW":e==="zh-cn"||e==="zh-sg"||e==="zh-hans"||e.startsWith("zh")?"zh-CN":e.startsWith("ja")?"ja":e.startsWith("ko")?"ko":e.startsWith("fr")?"fr":e.startsWith("de")?"de":e.startsWith("ru")?"ru":e.startsWith("es")?"es":e.startsWith("it")?"it":e.startsWith("pt")?"pt":e.startsWith("id")?"id":e.startsWith("no")||e.startsWith("nb")||e.startsWith("nn")?"no":e.startsWith("nl")?"nl":e.startsWith("pl")?"pl":e.startsWith("tr")?"tr":e.startsWith("vi")?"vi":"en"}function ia(n,e){return n&&n!=="auto"?n:tt(e)}function me(n){return n!==void 0&&Number.isFinite(n)&&n>=3e3&&n<=768e3}function V(n){switch(n){case"signed-8":return{bitDepth:8,sampleFormat:"signed-int",endianness:"none"};case"signed-16":return{bitDepth:16,sampleFormat:"signed-int",endianness:"little"};case"signed-24":return{bitDepth:24,sampleFormat:"signed-int",endianness:"little"};case"signed-32":return{bitDepth:32,sampleFormat:"signed-int",endianness:"little"};case"unsigned-8":return{bitDepth:8,sampleFormat:"unsigned-int",endianness:"none"};case"float-64":return{bitDepth:64,sampleFormat:"float",endianness:"little"};default:return{bitDepth:32,sampleFormat:"float",endianness:"little"}}}function G(n){return n.sampleFormat==="float"?n.bitDepth===64?"float-64":"float-32":n.sampleFormat==="unsigned-int"?"unsigned-8":n.bitDepth===8?"signed-8":n.bitDepth===24?"signed-24":n.bitDepth===32?"signed-32":"signed-16"}function pe(n,e){let a=sa(e),t=nt(n,a),i=ge(a),r=ra(a);if(i<=0||r<=0||t.byteLength%r!==0)throw new Error("PCM parameters do not match the file size.");let o=t.byteLength/r,s=Array.from({length:e.channels},()=>new Float32Array(o));for(let l=0;l<o;l+=1){let d=l*r;for(let c=0;c<e.channels;c+=1){let u=d+c*i;s[c][l]=it(t,u,a)}}return{sampleRate:e.sampleRate,channels:s}}function he(n,e){let a=e.channels[0]?.length??0,t=n.createBuffer(e.channels.length,a,e.sampleRate);return e.channels.forEach((i,r)=>t.getChannelData(r).set(i)),t}function fe(n,e){let a=sa(e),t=e.startOffsetBytes??0;if(!me(e.sampleRate))return"PCM sample rate must be between 3000 and 768000 Hz.";if(!Number.isInteger(e.channels)||e.channels<=0||e.channels>32)return"PCM channel count must be between 1 and 32.";if(![8,16,24,32,64].includes(a.bitDepth))return"PCM encoding must be Signed 8/16/24/32-bit PCM, Unsigned 8-bit PCM, 32-bit float, or 64-bit float.";if(a.sampleFormat==="float"&&a.bitDepth!==32&&a.bitDepth!==64)return"Float PCM supports 32-bit or 64-bit only.";if(a.sampleFormat==="unsigned-int"&&a.bitDepth!==8)return"Unsigned PCM currently supports 8-bit only.";if(a.bitDepth>8&&a.endianness==="none")return"Byte order is required for multi-byte PCM encodings.";if(!Number.isInteger(t)||t<0)return"PCM start offset must be a non-negative integer.";if(t>=n.byteLength)return`PCM start offset ${t} bytes exceeds the file size.`;let i=n.byteLength-t,r=ra(a);if(r<=0||i%r!==0)return`Data size after offset (${i} bytes) is not aligned to the current PCM parameters.`}function nt(n,e){return n.subarray(e.startOffsetBytes??0)}function it(n,e,a){let t=new DataView(n.buffer,n.byteOffset+e,ge(a));if(a.sampleFormat==="float"){let i=a.endianness==="little";return st(a.bitDepth===64?t.getFloat64(0,i):t.getFloat32(0,i),-1,1)}if(a.bitDepth===8)return a.sampleFormat==="unsigned-int"?(t.getUint8(0)-128)/128:t.getInt8(0)/128;if(a.bitDepth===16)return t.getInt16(0,a.endianness==="little")/32768;if(a.bitDepth===24){let r=a.endianness==="little"?t.getUint8(0)|t.getUint8(1)<<8|t.getUint8(2)<<16:t.getUint8(2)|t.getUint8(1)<<8|t.getUint8(0)<<16;return rt(r)/8388608}return t.getInt32(0,a.endianness==="little")/2147483648}function rt(n){return n&8388608?n|-16777216:n}function ge(n){return n.bitDepth/8}function ra(n){return ge(n)*n.channels}function st(n,e,a){return Math.max(e,Math.min(a,n))}function sa(n){let e=G(n),a=V(e),t=a.bitDepth===8?"none":n.endianness==="none"?a.endianness:n.endianness;return{...n,...a,endianness:t}}function oa(n){return n.innerHTML=`
    <main class="shell">
      <header class="topbar">
        <div class="identity">
          <strong class="brand">AudioLens</strong>
          <span id="fileMeta" class="muted fileMeta" tabindex="0" data-i18n="waitingAudioFile">Waiting for audio file</span>
          <button id="pcmReveal" class="secondary pcmReveal" data-i18n="pcmReadAs" hidden>Read as PCM</button>
        </div>
        <div id="status" class="status" data-i18n="initializing" hidden>Initializing</div>
        <section id="pcmPanel" class="pcmPanel topPcmPanel" hidden>
          <div class="paneTitle" data-i18n="pcmParams">PCM parameters</div>
          <div class="pcmFields">
            <label>
              <span data-i18n="sampleRate">Sample rate</span>
              <input id="pcmSampleRate" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="16000" />
            </label>
            <label>
              <span data-i18n="channels">Channels</span>
              <input id="pcmChannels" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="1" />
            </label>
            <label>
              <span data-i18n="startOffsetBytes">Offset (B)</span>
              <input id="pcmStartOffset" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="0" />
            </label>
            <label>
              <span data-i18n="bitDepth">Encoding</span>
              <select id="pcmEncoding">
                <option value="signed-8">Signed 8-bit PCM</option>
                <option value="signed-16" selected>Signed 16-bit PCM</option>
                <option value="signed-24">Signed 24-bit PCM</option>
                <option value="signed-32">Signed 32-bit PCM</option>
                <option value="unsigned-8">Unsigned 8-bit PCM</option>
                <option value="float-32">32-bit float</option>
                <option value="float-64">64-bit float</option>
                <option value="u-law" disabled>U-law (soon)</option>
                <option value="a-law" disabled>A-law (soon)</option>
                <option value="gsm-6.10" disabled>GSM 6.10 (soon)</option>
                <option value="dwvw-12" disabled>12-bit DWVW (soon)</option>
                <option value="dwvw-16" disabled>16-bit DWVW (soon)</option>
                <option value="dwvw-24" disabled>24-bit DWVW (soon)</option>
                <option value="vox-adpcm" disabled>VOX ADPCM (soon)</option>
                <option value="nms-adpcm-16" disabled>16kbs NMS ADPCM (soon)</option>
                <option value="nms-adpcm-24" disabled>24kbs NMS ADPCM (soon)</option>
                <option value="nms-adpcm-32" disabled>32kbs NMS ADPCM (soon)</option>
              </select>
            </label>
            <label>
              <span data-i18n="endianness">Endian</span>
              <select id="pcmEndianness">
                <option value="none">None</option>
                <option value="little">LE</option>
                <option value="big">BE</option>
              </select>
            </label>
          </div>
          <div class="pcmActions">
            <button id="pcmApply" class="secondary" data-i18n="read">Read</button>
            <button id="pcmSaveDefault" class="secondary" data-i18n="saveDefault">Save default</button>
          </div>
          <button id="pcmEdit" class="secondary pcmEdit" data-i18n="editPcmParams" hidden>Edit parameters</button>
          <span id="pcmStatus" class="muted"><span id="pcmStatusText"></span></span>
        </section>
        <div class="topbarTools">
          <button id="headerInfo" class="iconButton secondaryIcon headerInfoButton" data-i18n-title="headerInfo" data-i18n-aria="headerInfo" data-i18n-tooltip="headerInfo" title="Header info" aria-label="Header info" data-tooltip="Header info" hidden>
            <svg class="headerInfoIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M6.75 3.5h7.5L19 8.25v12.25H6.75z" />
              <path d="M14.25 3.5v4.75H19" />
              <path d="M9.25 12.25h6.5M9.25 15.25h6.5M9.25 18.25h4.25" />
            </svg>
          </button>
          <button id="downloadAudio" class="iconButton secondaryIcon downloadButton" data-i18n-title="downloadAudio" data-i18n-aria="downloadAudio" data-i18n-tooltip="downloadAudio" title="Download audio" aria-label="Download audio" data-tooltip="Download audio">\u2193</button>
          <details id="helpMenu" class="helpMenu">
            <summary class="iconButton secondaryIcon" data-i18n-title="help" data-i18n-aria="help" data-i18n-tooltip="help" title="Help" aria-label="Help" data-tooltip="Help">?</summary>
            <div class="helpPopover">
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpPlaybackGroup">Playback & selection</div>
                <div class="helpRow"><span><kbd>Space</kbd></span><span data-i18n="helpPlayPause">Play / pause</span></div>
                <div class="helpRow"><span><kbd>Esc</kbd></span><span data-i18n="helpClearSelection">Close menu, clear selection, or reset playback cursor</span></div>
                <div class="helpNote" data-i18n="helpSelectionPlayback">Drag waveform or spectrogram to select a segment. Playing with a selection active only plays that range.</div>
              </section>
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpViewGroup">View navigation</div>
                <div class="helpRow"><span><kbd data-command-modifier>Ctrl</kbd> + <kbd>F</kbd></span><span data-i18n="helpResetTimeZoom">Reset time zoom</span></div>
                <div class="helpRow"><span><kbd data-time-zoom-modifier>Ctrl</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpTimeZoom">Time zoom:</span></div>
                <div class="helpRow"><span><kbd>Shift</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpTimePan">Time pan:</span></div>
                <div class="helpRow"><span><kbd data-amplitude-zoom-modifier>Alt</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpAmplitudeZoom">Amplitude zoom:</span></div>
              </section>
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpMouseGroup">Mouse & trackpad</div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpRightClick">Right click</span></span><span data-i18n="resetView">Reset view</span></div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpPinch">Pinch</span></span><span data-i18n="helpTrackpadZoom">Pinch on trackpad to zoom time</span></div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpHorizontalSwipe">Horizontal swipe</span></span><span data-i18n="helpTrackpadPan">Horizontal trackpad swipe pans time</span></div>
              </section>
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpGainGroup">Gain & pan</div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpDoubleClick">Double click</span></span><span data-i18n="helpGainReset">Double-click a channel's gain or pan slider to reset it</span></div>
              </section>
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpAxisGroup">Vertical axis</div>
                <div class="helpRow"><span><kbd data-command-modifier>Ctrl</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpAxisZoom"></span></div>
                <div class="helpRow"><span><kbd>Shift</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpAxisPan"></span></div>
                <div class="helpRow"><span><kbd data-amplitude-zoom-modifier>Alt</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpAxisAlt"></span></div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpRightClick">Right click</span></span><span data-i18n="helpAxisScaleMenu"></span></div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpDoubleClick">Double click</span></span><span data-i18n="helpAxisReset"></span></div>
              </section>
            </div>
          </details>
          <button id="settingsToggle" class="iconButton secondaryIcon" data-i18n-title="settings" data-i18n-aria="settings" data-i18n-tooltip="settings" title="Settings" aria-label="Settings" data-tooltip="Settings"><span class="settingsGlyph">\u2699</span></button>
        </div>
      </header>

      <section id="wavPcmPanel" class="wavPcmPanel" role="dialog" data-i18n-aria="wavPcmRead" aria-label="Read WAV as PCM" hidden>
        <div class="wavPcmHeader">
          <strong data-i18n="wavPcmRead">Read WAV as PCM</strong>
          <span class="muted" data-i18n="currentFileOnly">Current file only</span>
        </div>
        <div class="wavPcmGrid">
          <label>
            <span data-i18n="sampleRate">Sample rate</span>
            <input id="wavPcmSampleRate" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="16000" />
          </label>
          <label>
            <span data-i18n="channels">Channels</span>
            <input id="wavPcmChannels" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="1" />
          </label>
          <label>
            <span data-i18n="startOffsetBytes">Offset (B)</span>
            <input id="wavPcmStartOffset" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="0" />
          </label>
          <label>
            <span data-i18n="bitDepth">Encoding</span>
            <select id="wavPcmEncoding">
              <option value="signed-8">Signed 8-bit PCM</option>
              <option value="signed-16" selected>Signed 16-bit PCM</option>
              <option value="signed-24">Signed 24-bit PCM</option>
              <option value="signed-32">Signed 32-bit PCM</option>
              <option value="unsigned-8">Unsigned 8-bit PCM</option>
              <option value="float-32">32-bit float</option>
              <option value="float-64">64-bit float</option>
              <option value="u-law" disabled>U-law (soon)</option>
              <option value="a-law" disabled>A-law (soon)</option>
              <option value="gsm-6.10" disabled>GSM 6.10 (soon)</option>
              <option value="dwvw-12" disabled>12-bit DWVW (soon)</option>
              <option value="dwvw-16" disabled>16-bit DWVW (soon)</option>
              <option value="dwvw-24" disabled>24-bit DWVW (soon)</option>
              <option value="vox-adpcm" disabled>VOX ADPCM (soon)</option>
              <option value="nms-adpcm-16" disabled>16kbs NMS ADPCM (soon)</option>
              <option value="nms-adpcm-24" disabled>24kbs NMS ADPCM (soon)</option>
              <option value="nms-adpcm-32" disabled>32kbs NMS ADPCM (soon)</option>
            </select>
          </label>
          <label>
            <span data-i18n="endianness">Endian</span>
            <select id="wavPcmEndianness">
              <option value="none">None</option>
              <option value="little">LE</option>
              <option value="big">BE</option>
            </select>
          </label>
        </div>
        <div class="wavPcmFooter">
          <span id="wavPcmStatus" class="muted"></span>
          <button id="wavPcmCancel" class="secondary" data-i18n="cancel">Cancel</button>
          <button id="wavPcmApply" class="secondary" data-i18n="read">Read</button>
        </div>
      </section>

      <section id="headerInfoPanel" class="headerInfoPanel" role="dialog" aria-label="Audio header info" hidden>
        <div class="headerInfoHeader">
          <strong id="headerInfoTitle">\u6587\u4EF6\u5934\u4FE1\u606F</strong>
          <button id="headerInfoClose" class="iconButton secondaryIcon" title="Close" aria-label="Close">\xD7</button>
        </div>
        <div id="headerInfoBody" class="headerInfoBody"></div>
      </section>

      <section class="player">
        <button id="play" class="iconButton" data-i18n-title="playPause" data-i18n-aria="playPause" title="Play / pause" aria-label="Play / pause">\u25B6</button>
        <span id="clock" class="clock">0:00.000 / 0:00.000</span>
        <input id="seek" class="seek" type="range" min="0" max="1000" value="0" data-i18n-aria="playbackPosition" aria-label="Playback position" />
        <audio id="audio" preload="auto"></audio>
      </section>

      <aside id="settingsPanel" class="settingsPanel" hidden>
        <div class="settingsHeader">
          <strong data-i18n="settings">Settings</strong>
        </div>
        <section class="settingsSection">
          <strong data-i18n="defaultView">Default view</strong>
          <label>
            <span data-i18n="view">View</span>
            <select id="defaultTrackMode">
              <option value="both" data-i18n="viewBoth">Multi-view</option>
              <option value="waveform" data-i18n="waveform">Waveform</option>
              <option value="spectrogram" data-i18n="spectrogram">Spectrogram</option>
            </select>
          </label>
        </section>
        <section class="settingsSection">
          <strong data-i18n="spectrogramDisplay">Spectrogram display</strong>
        <label>
          <span data-i18n="windowSize">Window size</span>
          <select id="fftSize">
            <option value="8">8</option>
            <option value="16">16</option>
            <option value="32">32</option>
            <option value="64">64</option>
            <option value="128">128</option>
            <option value="256">256</option>
            <option value="512">512</option>
            <option value="1024">1024</option>
            <option value="2048">2048</option>
            <option value="4096">4096</option>
            <option value="8192">8192</option>
            <option value="16384">16384</option>
            <option value="32768">32768</option>
          </select>
        </label>
        <label>
          <span data-i18n="windowType">Window type</span>
          <select id="windowFunction">
            <option value="rectangular" data-i18n="windowRectangular">Rectangular</option>
            <option value="bartlett" data-i18n="windowBartlett">Bartlett</option>
            <option value="hamming" data-i18n="windowHamming">Hamming</option>
            <option value="hann" data-i18n="windowHann">Hann</option>
            <option value="blackman" data-i18n="windowBlackman">Blackman</option>
            <option value="blackmanHarris" data-i18n="windowBlackmanHarris">Blackman-Harris</option>
            <option value="welch" data-i18n="windowWelch">Welch</option>
            <option value="gaussian25" data-i18n="windowGaussian25">Gaussian (\u03B1=2.5)</option>
            <option value="gaussian35" data-i18n="windowGaussian35">Gaussian (\u03B1=3.5)</option>
            <option value="gaussian45" data-i18n="windowGaussian45">Gaussian (\u03B1=4.5)</option>
          </select>
        </label>
        <label>
          <span data-i18n="zeroPaddingFactor">Zero padding factor</span>
          <select id="zeroPaddingFactor">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="4">4</option>
            <option value="8">8</option>
            <option value="16">16</option>
            <option value="32">32</option>
            <option value="64">64</option>
            <option value="128">128</option>
          </select>
        </label>
        <label>
          <span data-i18n="frequencyScale">Frequency scale</span>
          <select id="frequencyScale">
            <option value="linear">Linear</option>
            <option value="log">Log</option>
            <option value="mel">Mel</option>
            <option value="bark">Bark</option>
            <option value="erb">ERB</option>
          </select>
        </label>
        <div class="settingsSubsection">
          <strong data-i18n="frequencyRange">Frequency range</strong>
          <label>
            <span data-i18n="minFrequencyHz">Min frequency (Hz)</span>
            <input id="spectrogramMinHz" type="number" min="0" step="1" value="0" />
          </label>
          <label>
            <span data-i18n="maxFrequencyHz">Max frequency (Hz)</span>
            <input id="spectrogramMaxHz" type="number" min="1" step="1" value="8000" />
          </label>
          <label class="checkboxLabel">
            <input id="spectrogramMaxFollowsNyquist" type="checkbox" checked />
            <span data-i18n="maxFrequencyNyquist">Max follows Nyquist</span>
          </label>
        </div>
        <div class="settingsSubsection">
          <strong data-i18n="amplitudeRange">Amplitude range (waveform)</strong>
          <label class="checkboxLabel">
            <input id="amplitudeAuto" type="checkbox" checked />
            <span data-i18n="amplitudeAuto">Auto (fit each channel)</span>
          </label>
          <label>
            <span data-i18n="minAmplitude">Min amplitude</span>
            <input id="amplitudeMinInput" type="number" step="0.1" value="-1" />
          </label>
          <label>
            <span data-i18n="maxAmplitude">Max amplitude</span>
            <input id="amplitudeMaxInput" type="number" step="0.1" value="1" />
          </label>
        </div>
        <div class="settingsSubsection">
          <strong data-i18n="spectrogramAppearance">Spectrogram appearance</strong>
          <label>
            <span data-i18n="palette">Palette</span>
            <select id="palette">
              <option value="rose" data-i18n="paletteRose">Color (rose)</option>
              <option value="classic" data-i18n="paletteClassic">Color (classic)</option>
              <option value="grayscale" data-i18n="paletteGrayscale">Grayscale</option>
              <option value="inverseGrayscale" data-i18n="paletteInverseGrayscale">Inverse grayscale</option>
            </select>
          </label>
          <label class="checkboxLabel">
            <input id="autoBrightness" type="checkbox" checked />
            <span data-i18n="autoBrightness">Auto brightness</span>
          </label>
          <label>
            <span data-i18n="minDb">Min dB (brightness)</span>
            <input id="minDb" type="number" min="-160" max="-1" step="1" value="-96" />
          </label>
          <label>
            <span data-i18n="maxDb">Max dB (brightness)</span>
            <input id="maxDb" type="number" min="-80" max="24" step="1" value="0" />
          </label>
        </div>
        </section>
      </aside>

        <section class="workspace">
        <aside class="controls" hidden>
          <div class="controlInternals" hidden>
          <label>
            <span data-i18n="channel">Channel</span>
            <select id="channel"></select>
          </label>
          <label>
            <span data-i18n="timeZoom">Time zoom</span>
            <input id="timeZoom" type="range" min="1" max="64" step="0.25" value="1" />
            <small class="wheelHint"><kbd data-time-zoom-modifier>Ctrl</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></small>
          </label>
          <label>
            <span data-i18n="timePosition">Time position</span>
            <input id="timeOffset" type="range" min="0" max="1" step="0.001" value="0" />
            <small class="wheelHint"><kbd>Shift</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></small>
          </label>
          <button id="resetView" class="secondary" data-i18n="resetView">Reset view</button>
          <button id="analyze" class="primary" data-i18n="refreshSpectrogram">Refresh spectrogram</button>
          </div>

        </aside>

        <section id="figures" class="figures">
          <div class="figureHeader timelineHeader">
            <span id="viewRange" class="muted timelineRange" data-i18n="timeLabel">Time</span>
            <div class="timelineCanvasWrap">
              <canvas id="timeline" class="timelineCanvas"></canvas>
            </div>
          </div>
          <div id="waveformPane" class="plotPane waveformPane legacyPlot" hidden>
            <canvas id="waveform" class="waveform"></canvas>
          </div>
          <div id="trackList" class="trackList"></div>
          <section class="selectionAnalysisPane" data-i18n-aria="selectionAnalysis" aria-label="Selection analysis" hidden>
            <div class="paneTitleRow">
              <div class="paneTitle" data-i18n="selectionAnalysis">Selection analysis</div>
              <span
                class="analysisHelp"
                tabindex="0"
                data-i18n-aria="selectionAnalysis"
                aria-label="Selection analysis"
                data-i18n-tooltip="selectionAnalysisHelp"
                data-tooltip="Selection analysis help"
              >?</span>
            </div>
            <div class="paneSubtitleRow">
              <div class="paneSubtitle" data-i18n="basicMetrics">Basic metrics</div>
            </div>
            <table class="analysisTable">
              <tbody>
                <tr><th data-i18n="selectionStart">Start</th><td id="analysisStart">--</td></tr>
                <tr><th data-i18n="selectionEnd">End</th><td id="analysisEnd">--</td></tr>
                <tr><th data-i18n="selectionDuration">Duration</th><td id="analysisDuration">--</td></tr>
                <tr>
                  <th>
                    <span data-i18n="rmsLevel">RMS Level</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="rmsLevel"
                      aria-label="RMS Level"
                      data-i18n-tooltip="rmsLevelHelp"
                      data-tooltip="RMS level help"
                    >?</span>
                  </th>
                  <td id="analysisRms">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="peakLevel">Peak Level</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="peakLevel"
                      aria-label="Peak Level"
                      data-i18n-tooltip="peakLevelHelp"
                      data-tooltip="Peak level help"
                    >?</span>
                  </th>
                  <td id="analysisPeak">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="dominant">Dominant</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="dominant"
                      aria-label="Dominant"
                      data-i18n-tooltip="dominantHelp"
                      data-tooltip="Dominant frequency help"
                    >?</span>
                  </th>
                  <td id="analysisDominant">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="crestFactor">Crest</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="crestFactor"
                      aria-label="Crest"
                      data-i18n-tooltip="crestFactorHelp"
                      data-tooltip="Crest factor help"
                    >?</span>
                  </th>
                  <td id="analysisCrest">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="clippingRatio">Clipping</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="clippingRatio"
                      aria-label="Clipping"
                      data-i18n-tooltip="clippingRatioHelp"
                      data-tooltip="Clipping ratio help"
                    >?</span>
                  </th>
                  <td id="analysisClipping">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="noiseFloor">Noise floor</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="noiseFloor"
                      aria-label="Noise floor"
                      data-i18n-tooltip="noiseFloorHelp"
                      data-tooltip="Noise floor help"
                    >?</span>
                  </th>
                  <td id="analysisNoiseFloor">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="spectralCentroid">Centroid</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="spectralCentroid"
                      aria-label="Centroid"
                      data-i18n-tooltip="spectralCentroidHelp"
                      data-tooltip="Spectral centroid help"
                    >?</span>
                  </th>
                  <td id="analysisCentroid">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="zeroCrossingRate">ZCR</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="zeroCrossingRate"
                      aria-label="ZCR"
                      data-i18n-tooltip="zeroCrossingRateHelp"
                      data-tooltip="Zero crossing rate help"
                    >?</span>
                  </th>
                  <td id="analysisZcr">--</td>
                </tr>
              </tbody>
            </table>
            <div class="paneSubtitleRow">
              <div class="paneSubtitle" data-i18n="frequencyAnalysis">Frequency analysis</div>
              <span
                class="analysisHelp"
                tabindex="0"
                data-i18n-aria="frequencyAnalysis"
                aria-label="Frequency analysis"
                data-i18n-tooltip="frequencyAnalysisHelp"
                data-tooltip="Frequency analysis help"
              >?</span>
            </div>
            <table class="analysisTable">
              <tbody id="analysisBands">
                <tr><th data-i18n="bands">Bands</th><td>--</td></tr>
              </tbody>
            </table>
          </section>
          <div id="waveformResize" class="plotResize legacyPlot" role="separator" aria-orientation="horizontal" data-i18n-title="adjustWaveformHeight" title="Adjust waveform height" hidden></div>
          <span id="analysisMeta" class="muted legacyPlot" hidden></span>
          <div id="spectrogramPane" class="plotPane spectrogramPane legacyPlot" hidden>
            <canvas id="spectrogram" class="spectrogram"></canvas>
          </div>
          <div id="spectrogramResize" class="plotResize legacyPlot" role="separator" aria-orientation="horizontal" data-i18n-title="adjustSpectrogramHeight" title="Adjust spectrogram height" hidden></div>
          <div id="selectionBox" class="selectionBox" hidden></div>
          <div id="selectionContextMenu" class="contextMenu" role="menu" hidden>
            <button type="button" role="menuitem" data-action="download-selection" data-i18n="downloadSelectionWav">Download selection as WAV</button>
            <button type="button" role="menuitem" data-action="clear-selection" data-i18n="clearSelection">Clear selection</button>
          </div>
          <div id="freqScaleMenu" class="contextMenu freqScaleMenu" role="menu" hidden></div>
          <div id="floatingTooltip" class="floatingTooltip" hidden></div>
        </section>
      </section>

    </main>
  `,{fileMeta:m("#fileMeta",HTMLSpanElement),status:m("#status",HTMLDivElement),play:m("#play",HTMLButtonElement),clock:m("#clock",HTMLSpanElement),seek:m("#seek",HTMLInputElement),audio:m("#audio",HTMLAudioElement),defaultTrackMode:m("#defaultTrackMode",HTMLSelectElement),zeroPaddingFactor:m("#zeroPaddingFactor",HTMLSelectElement),settingsToggle:m("#settingsToggle",HTMLButtonElement),downloadAudio:m("#downloadAudio",HTMLButtonElement),helpMenu:m("#helpMenu",HTMLElement),settingsPanel:m("#settingsPanel",HTMLElement),windowFunction:m("#windowFunction",HTMLSelectElement),fftSize:m("#fftSize",HTMLSelectElement),channel:m("#channel",HTMLSelectElement),pcmPanel:m("#pcmPanel",HTMLElement),pcmEdit:m("#pcmEdit",HTMLButtonElement),pcmReveal:m("#pcmReveal",HTMLButtonElement),headerInfo:m("#headerInfo",HTMLButtonElement),headerInfoPanel:m("#headerInfoPanel",HTMLElement),headerInfoTitle:m("#headerInfoTitle",HTMLElement),headerInfoBody:m("#headerInfoBody",HTMLElement),headerInfoClose:m("#headerInfoClose",HTMLButtonElement),pcmSampleRate:m("#pcmSampleRate",HTMLInputElement),pcmChannels:m("#pcmChannels",HTMLInputElement),pcmStartOffset:m("#pcmStartOffset",HTMLInputElement),pcmEncoding:m("#pcmEncoding",HTMLSelectElement),pcmEndianness:m("#pcmEndianness",HTMLSelectElement),pcmApply:m("#pcmApply",HTMLButtonElement),pcmSaveDefault:m("#pcmSaveDefault",HTMLButtonElement),pcmStatus:m("#pcmStatus",HTMLSpanElement),pcmStatusText:m("#pcmStatusText",HTMLSpanElement),wavPcmPanel:m("#wavPcmPanel",HTMLElement),wavPcmSampleRate:m("#wavPcmSampleRate",HTMLInputElement),wavPcmChannels:m("#wavPcmChannels",HTMLInputElement),wavPcmStartOffset:m("#wavPcmStartOffset",HTMLInputElement),wavPcmEncoding:m("#wavPcmEncoding",HTMLSelectElement),wavPcmEndianness:m("#wavPcmEndianness",HTMLSelectElement),wavPcmApply:m("#wavPcmApply",HTMLButtonElement),wavPcmCancel:m("#wavPcmCancel",HTMLButtonElement),wavPcmStatus:m("#wavPcmStatus",HTMLSpanElement),timeZoom:m("#timeZoom",HTMLInputElement),timeOffset:m("#timeOffset",HTMLInputElement),minDb:m("#minDb",HTMLInputElement),maxDb:m("#maxDb",HTMLInputElement),spectrogramMinHz:m("#spectrogramMinHz",HTMLInputElement),spectrogramMaxHz:m("#spectrogramMaxHz",HTMLInputElement),spectrogramMaxFollowsNyquist:m("#spectrogramMaxFollowsNyquist",HTMLInputElement),autoBrightness:m("#autoBrightness",HTMLInputElement),amplitudeAuto:m("#amplitudeAuto",HTMLInputElement),amplitudeMinInput:m("#amplitudeMinInput",HTMLInputElement),amplitudeMaxInput:m("#amplitudeMaxInput",HTMLInputElement),frequencyScale:m("#frequencyScale",HTMLSelectElement),palette:m("#palette",HTMLSelectElement),analyze:m("#analyze",HTMLButtonElement),resetView:m("#resetView",HTMLButtonElement),viewRange:m("#viewRange",HTMLSpanElement),timeline:m("#timeline",HTMLCanvasElement),analysisMeta:m("#analysisMeta",HTMLSpanElement),analysisStart:m("#analysisStart",HTMLElement),analysisEnd:m("#analysisEnd",HTMLElement),analysisDuration:m("#analysisDuration",HTMLElement),analysisRms:m("#analysisRms",HTMLElement),analysisPeak:m("#analysisPeak",HTMLElement),analysisDominant:m("#analysisDominant",HTMLElement),analysisCrest:m("#analysisCrest",HTMLElement),analysisClipping:m("#analysisClipping",HTMLElement),analysisNoiseFloor:m("#analysisNoiseFloor",HTMLElement),analysisCentroid:m("#analysisCentroid",HTMLElement),analysisZcr:m("#analysisZcr",HTMLElement),analysisBands:m("#analysisBands",HTMLElement),figures:m("#figures",HTMLElement),trackList:m("#trackList",HTMLElement),waveformPane:m("#waveformPane",HTMLElement),spectrogramPane:m("#spectrogramPane",HTMLElement),waveformResize:m("#waveformResize",HTMLDivElement),spectrogramResize:m("#spectrogramResize",HTMLDivElement),waveform:m("#waveform",HTMLCanvasElement),spectrogram:m("#spectrogram",HTMLCanvasElement),selectionBox:m("#selectionBox",HTMLDivElement),selectionContextMenu:m("#selectionContextMenu",HTMLDivElement),freqScaleMenu:m("#freqScaleMenu",HTMLDivElement),floatingTooltip:m("#floatingTooltip",HTMLDivElement)}}function la(n,e){n.querySelectorAll("[data-i18n]").forEach(a=>{let t=a.dataset.i18n;t&&e[t]&&(a.textContent=e[t])}),n.querySelectorAll("[data-i18n-title]").forEach(a=>{let t=a.dataset.i18nTitle;t&&e[t]&&(a.title=e[t])}),n.querySelectorAll("[data-i18n-tooltip]").forEach(a=>{let t=a.dataset.i18nTooltip;t&&e[t]&&(a.dataset.tooltip=e[t])}),n.querySelectorAll("[data-i18n-aria]").forEach(a=>{let t=a.dataset.i18nAria;t&&e[t]&&a.setAttribute("aria-label",e[t])})}var da=16,lt=3,dt=6,ca=8e3,ct=3e4,be=1024*1024,ut=131072,mt=64*1024*1024,pt=64*1024*1024,ht=256,ft=[8,16,32,64,128,256,512,1024,2048,4096,8192,16384,32768],$={left:78,top:18,right:18,bottom:40},ua=78,gt=13,T={waveformMin:160,waveformMax:520,spectrogramMin:220,spectrogramMax:860},bt=280,yt=132,kt=.38,vt=.62,wa=90,Sa=160,ye=24,ke=wa+Sa+2,wt=80,ve=[{labelKey:"frequencyBand0To250",min:0,max:250},{labelKey:"frequencyBand250To500",min:250,max:500},{labelKey:"frequencyBand500To1k",min:500,max:1e3},{labelKey:"frequencyBand1To2k",min:1e3,max:2e3},{labelKey:"frequencyBand2To4k",min:2e3,max:4e3},{labelKey:"frequencyBand4To8k",min:4e3,max:8e3},{labelKey:"frequencyBand8kPlus",min:8e3,max:Number.POSITIVE_INFINITY}],xe={"\u6587\u4EF6\u5927\u5C0F - 8":"File size - 8","\u5B50\u5757 ID":"Subchunk ID",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Subchunk data length",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Audio data region",\u672A\u5C55\u5F00\u5B50\u5757:"Unexpanded chunk","fmt \u5B50\u5757\u8FC7\u77ED":"fmt chunk is too short",\u7F16\u7801\u683C\u5F0F:"Audio format",\u901A\u9053\u6570:"Channel count",\u91C7\u6837\u7387:"Sample rate",\u5B57\u8282\u7387:"Byte rate",\u6BCF\u5E27\u5B57\u8282\u6570:"Bytes per frame",\u4F4D\u6DF1:"Bit depth",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Extension parameter length",\u6709\u6548\u4F4D\u6DF1:"Valid bit depth",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Channel layout mask","FLAC \u6807\u8BC6":"FLAC marker",\u5143\u6570\u636E\u5757\u5934:"Metadata block header",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Metadata block length",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Metadata block payload",\u6700\u5C0F\u5757\u5927\u5C0F:"Minimum block size",\u6700\u5927\u5757\u5927\u5C0F:"Maximum block size",\u6700\u5C0F\u5E27\u5927\u5C0F:"Minimum frame size",\u6700\u5927\u5E27\u5927\u5C0F:"Maximum frame size",\u603B\u91C7\u6837\u6570:"Total samples","\u539F\u59CB\u97F3\u9891 MD5":"Raw audio MD5","Ogg \u9875\u6807\u8BC6":"Ogg page marker",\u6D41\u7ED3\u6784\u7248\u672C:"Stream structure version",\u9875\u7C7B\u578B\u6807\u5FD7:"Page type flags",\u7EDD\u5BF9\u4F4D\u7F6E:"Absolute position",\u903B\u8F91\u6D41\u5E8F\u53F7:"Logical stream serial number",\u9875\u5E8F\u53F7:"Page sequence number",\u9875\u6821\u9A8C\u548C:"Page checksum","segment \u6570":"Segment count","segment \u957F\u5EA6\u8868":"Segment length table",\u9875\u6570\u636E:"Page payload","Opus \u8BC6\u522B\u5934":"Opus identification header",\u7248\u672C:"Version",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Pre-skip sample count",\u8F93\u5165\u91C7\u6837\u7387:"Input sample rate",\u8F93\u51FA\u589E\u76CA:"Output gain",\u58F0\u9053\u6620\u5C04\u65CF:"Channel mapping family",\u8BC6\u522B\u5934:"Identification header","Vorbis \u6807\u8BC6":"Vorbis marker","box \u5927\u5C0F":"Box size","box \u7C7B\u578B":"Box type",\u4E3B\u54C1\u724C:"Major brand",\u6B21\u7248\u672C:"Minor version",\u517C\u5BB9\u54C1\u724C:"Compatible brands",\u6807\u5FD7:"Flags",\u65F6\u95F4\u523B\u5EA6:"Timescale",\u65F6\u957F\u5355\u4F4D\u6570:"Duration units",\u5904\u7406\u5668\u7C7B\u578B:"Handler type",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"Sample description count",\u6837\u672C\u7C7B\u578B:"Sample type",\u540C\u6B65\u5B57:"Sync word","MPEG \u7248\u672C":"MPEG version",\u5C42:"Layer","CRC \u662F\u5426\u7701\u7565":"Whether CRC is absent",\u91C7\u6837\u7387\u7D22\u5F15:"Sample rate index",\u58F0\u9053\u914D\u7F6E:"Channel configuration","ADTS \u5E27\u957F\u5EA6":"ADTS frame length","\u7F13\u51B2 fullness":"Buffer fullness",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Raw data block count field","ID3v2 \u6807\u8BC6":"ID3v2 marker","ID3 \u7248\u672C":"ID3 version",\u6807\u7B7E\u957F\u5EA6:"Tag length",\u5E27\u540C\u6B65:"Frame sync","MPEG \u97F3\u9891\u7248\u672C":"MPEG audio version","CRC \u6807\u5FD7":"CRC flag",\u7801\u7387\u7D22\u5F15:"Bitrate index",\u58F0\u9053\u6A21\u5F0F:"Channel mode"},St={"\u6587\u4EF6\u5927\u5C0F - 8":"\u6A94\u6848\u5927\u5C0F - 8","\u5B50\u5757 ID":"\u5B50\u5340\u584A ID",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"\u5B50\u5340\u584A\u8CC7\u6599\u9577\u5EA6",\u97F3\u9891\u6570\u636E\u533A\u57DF:"\u97F3\u8A0A\u8CC7\u6599\u5340\u57DF",\u672A\u5C55\u5F00\u5B50\u5757:"\u672A\u5C55\u958B\u5B50\u5340\u584A","fmt \u5B50\u5757\u8FC7\u77ED":"fmt \u5B50\u5340\u584A\u904E\u77ED",\u7F16\u7801\u683C\u5F0F:"\u7DE8\u78BC\u683C\u5F0F",\u901A\u9053\u6570:"\u8072\u9053\u6578",\u91C7\u6837\u7387:"\u53D6\u6A23\u7387",\u5B57\u8282\u7387:"\u4F4D\u5143\u7D44\u7387",\u6BCF\u5E27\u5B57\u8282\u6570:"\u6BCF\u5E40\u4F4D\u5143\u7D44\u6578",\u4F4D\u6DF1:"\u4F4D\u5143\u6DF1\u5EA6",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"\u64F4\u5145\u53C3\u6578\u9577\u5EA6",\u6709\u6548\u4F4D\u6DF1:"\u6709\u6548\u4F4D\u5143\u6DF1\u5EA6",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"\u8072\u9053\u5E03\u5C40\u906E\u7F69","FLAC \u6807\u8BC6":"FLAC \u6A19\u8B58",\u5143\u6570\u636E\u5757\u5934:"\u4E2D\u7E7C\u8CC7\u6599\u5340\u584A\u982D",\u5143\u6570\u636E\u5757\u957F\u5EA6:"\u4E2D\u7E7C\u8CC7\u6599\u5340\u584A\u9577\u5EA6",\u5143\u6570\u636E\u5757\u5185\u5BB9:"\u4E2D\u7E7C\u8CC7\u6599\u5340\u584A\u5167\u5BB9",\u6700\u5C0F\u5757\u5927\u5C0F:"\u6700\u5C0F\u5340\u584A\u5927\u5C0F",\u6700\u5927\u5757\u5927\u5C0F:"\u6700\u5927\u5340\u584A\u5927\u5C0F",\u6700\u5C0F\u5E27\u5927\u5C0F:"\u6700\u5C0F\u5E40\u5927\u5C0F",\u6700\u5927\u5E27\u5927\u5C0F:"\u6700\u5927\u5E40\u5927\u5C0F",\u603B\u91C7\u6837\u6570:"\u7E3D\u53D6\u6A23\u6578","\u539F\u59CB\u97F3\u9891 MD5":"\u539F\u59CB\u97F3\u8A0A MD5","Ogg \u9875\u6807\u8BC6":"Ogg \u9801\u6A19\u8B58",\u6D41\u7ED3\u6784\u7248\u672C:"\u4E32\u6D41\u7D50\u69CB\u7248\u672C",\u9875\u7C7B\u578B\u6807\u5FD7:"\u9801\u985E\u578B\u6A19\u8A8C",\u7EDD\u5BF9\u4F4D\u7F6E:"\u7D55\u5C0D\u4F4D\u7F6E",\u903B\u8F91\u6D41\u5E8F\u53F7:"\u908F\u8F2F\u4E32\u6D41\u5E8F\u865F",\u9875\u5E8F\u53F7:"\u9801\u5E8F\u865F",\u9875\u6821\u9A8C\u548C:"\u9801\u6821\u9A57\u548C","segment \u6570":"segment \u6578","segment \u957F\u5EA6\u8868":"segment \u9577\u5EA6\u8868",\u9875\u6570\u636E:"\u9801\u8CC7\u6599","Opus \u8BC6\u522B\u5934":"Opus \u8B58\u5225\u982D",\u7248\u672C:"\u7248\u672C",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"\u9810\u8DF3\u904E\u53D6\u6A23\u6578",\u8F93\u5165\u91C7\u6837\u7387:"\u8F38\u5165\u53D6\u6A23\u7387",\u8F93\u51FA\u589E\u76CA:"\u8F38\u51FA\u589E\u76CA",\u58F0\u9053\u6620\u5C04\u65CF:"\u8072\u9053\u6620\u5C04\u65CF",\u8BC6\u522B\u5934:"\u8B58\u5225\u982D","Vorbis \u6807\u8BC6":"Vorbis \u6A19\u8B58","box \u5927\u5C0F":"box \u5927\u5C0F","box \u7C7B\u578B":"box \u985E\u578B",\u4E3B\u54C1\u724C:"\u4E3B\u54C1\u724C",\u6B21\u7248\u672C:"\u6B21\u7248\u672C",\u517C\u5BB9\u54C1\u724C:"\u76F8\u5BB9\u54C1\u724C",\u6807\u5FD7:"\u6A19\u8A8C",\u65F6\u95F4\u523B\u5EA6:"\u6642\u9593\u523B\u5EA6",\u65F6\u957F\u5355\u4F4D\u6570:"\u6642\u9577\u55AE\u4F4D\u6578",\u5904\u7406\u5668\u7C7B\u578B:"\u8655\u7406\u5668\u985E\u578B",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"\u6A23\u672C\u63CF\u8FF0\u6578\u91CF",\u6837\u672C\u7C7B\u578B:"\u6A23\u672C\u985E\u578B",\u540C\u6B65\u5B57:"\u540C\u6B65\u5B57","MPEG \u7248\u672C":"MPEG \u7248\u672C",\u5C42:"\u5C64","CRC \u662F\u5426\u7701\u7565":"CRC \u662F\u5426\u7701\u7565",\u91C7\u6837\u7387\u7D22\u5F15:"\u53D6\u6A23\u7387\u7D22\u5F15",\u58F0\u9053\u914D\u7F6E:"\u8072\u9053\u914D\u7F6E","ADTS \u5E27\u957F\u5EA6":"ADTS \u5E40\u9577\u5EA6","\u7F13\u51B2 fullness":"\u7DE9\u885D fullness",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"\u539F\u59CB\u8CC7\u6599\u5340\u584A\u6578\u91CF\u6B04\u4F4D","ID3v2 \u6807\u8BC6":"ID3v2 \u6A19\u8B58","ID3 \u7248\u672C":"ID3 \u7248\u672C",\u6807\u7B7E\u957F\u5EA6:"\u6A19\u7C64\u9577\u5EA6",\u5E27\u540C\u6B65:"\u5E40\u540C\u6B65","MPEG \u97F3\u9891\u7248\u672C":"MPEG \u97F3\u8A0A\u7248\u672C","CRC \u6807\u5FD7":"CRC \u6A19\u8A8C",\u7801\u7387\u7D22\u5F15:"\u78BC\u7387\u7D22\u5F15",\u58F0\u9053\u6A21\u5F0F:"\u8072\u9053\u6A21\u5F0F"},Pt={"\u6587\u4EF6\u5927\u5C0F - 8":"\u30D5\u30A1\u30A4\u30EB\u30B5\u30A4\u30BA - 8","\u5B50\u5757 ID":"\u30B5\u30D6\u30C1\u30E3\u30F3\u30AF ID",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"\u30B5\u30D6\u30C1\u30E3\u30F3\u30AF\u30C7\u30FC\u30BF\u9577",\u97F3\u9891\u6570\u636E\u533A\u57DF:"\u97F3\u58F0\u30C7\u30FC\u30BF\u9818\u57DF",\u672A\u5C55\u5F00\u5B50\u5757:"\u672A\u5C55\u958B\u306E\u30B5\u30D6\u30C1\u30E3\u30F3\u30AF","fmt \u5B50\u5757\u8FC7\u77ED":"fmt \u30B5\u30D6\u30C1\u30E3\u30F3\u30AF\u304C\u77ED\u3059\u304E\u307E\u3059",\u7F16\u7801\u683C\u5F0F:"\u30A8\u30F3\u30B3\u30FC\u30C9\u5F62\u5F0F",\u901A\u9053\u6570:"\u30C1\u30E3\u30F3\u30CD\u30EB\u6570",\u91C7\u6837\u7387:"\u30B5\u30F3\u30D7\u30EB\u30EC\u30FC\u30C8",\u5B57\u8282\u7387:"\u30D0\u30A4\u30C8\u30EC\u30FC\u30C8",\u6BCF\u5E27\u5B57\u8282\u6570:"\u30D5\u30EC\u30FC\u30E0\u3042\u305F\u308A\u306E\u30D0\u30A4\u30C8\u6570",\u4F4D\u6DF1:"\u30D3\u30C3\u30C8\u6DF1\u5EA6",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"\u62E1\u5F35\u30D1\u30E9\u30E1\u30FC\u30BF\u9577",\u6709\u6548\u4F4D\u6DF1:"\u6709\u52B9\u30D3\u30C3\u30C8\u6DF1\u5EA6",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"\u30C1\u30E3\u30F3\u30CD\u30EB\u914D\u7F6E\u30DE\u30B9\u30AF","FLAC \u6807\u8BC6":"FLAC \u30DE\u30FC\u30AB\u30FC",\u5143\u6570\u636E\u5757\u5934:"\u30E1\u30BF\u30C7\u30FC\u30BF\u30D6\u30ED\u30C3\u30AF\u30D8\u30C3\u30C0\u30FC",\u5143\u6570\u636E\u5757\u957F\u5EA6:"\u30E1\u30BF\u30C7\u30FC\u30BF\u30D6\u30ED\u30C3\u30AF\u9577",\u5143\u6570\u636E\u5757\u5185\u5BB9:"\u30E1\u30BF\u30C7\u30FC\u30BF\u30D6\u30ED\u30C3\u30AF\u5185\u5BB9",\u6700\u5C0F\u5757\u5927\u5C0F:"\u6700\u5C0F\u30D6\u30ED\u30C3\u30AF\u30B5\u30A4\u30BA",\u6700\u5927\u5757\u5927\u5C0F:"\u6700\u5927\u30D6\u30ED\u30C3\u30AF\u30B5\u30A4\u30BA",\u6700\u5C0F\u5E27\u5927\u5C0F:"\u6700\u5C0F\u30D5\u30EC\u30FC\u30E0\u30B5\u30A4\u30BA",\u6700\u5927\u5E27\u5927\u5C0F:"\u6700\u5927\u30D5\u30EC\u30FC\u30E0\u30B5\u30A4\u30BA",\u603B\u91C7\u6837\u6570:"\u7DCF\u30B5\u30F3\u30D7\u30EB\u6570","\u539F\u59CB\u97F3\u9891 MD5":"\u539F\u97F3\u58F0 MD5","Ogg \u9875\u6807\u8BC6":"Ogg \u30DA\u30FC\u30B8\u30DE\u30FC\u30AB\u30FC",\u6D41\u7ED3\u6784\u7248\u672C:"\u30B9\u30C8\u30EA\u30FC\u30E0\u69CB\u9020\u30D0\u30FC\u30B8\u30E7\u30F3",\u9875\u7C7B\u578B\u6807\u5FD7:"\u30DA\u30FC\u30B8\u30BF\u30A4\u30D7\u30D5\u30E9\u30B0",\u7EDD\u5BF9\u4F4D\u7F6E:"\u7D76\u5BFE\u4F4D\u7F6E",\u903B\u8F91\u6D41\u5E8F\u53F7:"\u8AD6\u7406\u30B9\u30C8\u30EA\u30FC\u30E0\u30B7\u30EA\u30A2\u30EB\u756A\u53F7",\u9875\u5E8F\u53F7:"\u30DA\u30FC\u30B8\u30B7\u30FC\u30B1\u30F3\u30B9\u756A\u53F7",\u9875\u6821\u9A8C\u548C:"\u30DA\u30FC\u30B8\u30C1\u30A7\u30C3\u30AF\u30B5\u30E0","segment \u6570":"segment \u6570","segment \u957F\u5EA6\u8868":"segment \u9577\u30C6\u30FC\u30D6\u30EB",\u9875\u6570\u636E:"\u30DA\u30FC\u30B8\u30DA\u30A4\u30ED\u30FC\u30C9","Opus \u8BC6\u522B\u5934":"Opus \u8B58\u5225\u30D8\u30C3\u30C0\u30FC",\u7248\u672C:"\u30D0\u30FC\u30B8\u30E7\u30F3",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"\u30D7\u30EA\u30B9\u30AD\u30C3\u30D7\u30B5\u30F3\u30D7\u30EB\u6570",\u8F93\u5165\u91C7\u6837\u7387:"\u5165\u529B\u30B5\u30F3\u30D7\u30EB\u30EC\u30FC\u30C8",\u8F93\u51FA\u589E\u76CA:"\u51FA\u529B\u30B2\u30A4\u30F3",\u58F0\u9053\u6620\u5C04\u65CF:"\u30C1\u30E3\u30F3\u30CD\u30EB\u30DE\u30C3\u30D4\u30F3\u30B0\u30D5\u30A1\u30DF\u30EA\u30FC",\u8BC6\u522B\u5934:"\u8B58\u5225\u30D8\u30C3\u30C0\u30FC","Vorbis \u6807\u8BC6":"Vorbis \u30DE\u30FC\u30AB\u30FC","box \u5927\u5C0F":"box \u30B5\u30A4\u30BA","box \u7C7B\u578B":"box \u30BF\u30A4\u30D7",\u4E3B\u54C1\u724C:"\u30E1\u30B8\u30E3\u30FC\u30D6\u30E9\u30F3\u30C9",\u6B21\u7248\u672C:"\u30DE\u30A4\u30CA\u30FC\u30D0\u30FC\u30B8\u30E7\u30F3",\u517C\u5BB9\u54C1\u724C:"\u4E92\u63DB\u30D6\u30E9\u30F3\u30C9",\u6807\u5FD7:"\u30D5\u30E9\u30B0",\u65F6\u95F4\u523B\u5EA6:"\u30BF\u30A4\u30E0\u30B9\u30B1\u30FC\u30EB",\u65F6\u957F\u5355\u4F4D\u6570:"\u7D99\u7D9A\u6642\u9593\u5358\u4F4D\u6570",\u5904\u7406\u5668\u7C7B\u578B:"\u30CF\u30F3\u30C9\u30E9\u30FC\u30BF\u30A4\u30D7",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"\u30B5\u30F3\u30D7\u30EB\u8A18\u8FF0\u6570",\u6837\u672C\u7C7B\u578B:"\u30B5\u30F3\u30D7\u30EB\u30BF\u30A4\u30D7",\u540C\u6B65\u5B57:"\u540C\u671F\u30EF\u30FC\u30C9","MPEG \u7248\u672C":"MPEG \u30D0\u30FC\u30B8\u30E7\u30F3",\u5C42:"\u30EC\u30A4\u30E4\u30FC","CRC \u662F\u5426\u7701\u7565":"CRC \u304C\u7701\u7565\u3055\u308C\u3066\u3044\u308B\u304B",\u91C7\u6837\u7387\u7D22\u5F15:"\u30B5\u30F3\u30D7\u30EB\u30EC\u30FC\u30C8\u30A4\u30F3\u30C7\u30C3\u30AF\u30B9",\u58F0\u9053\u914D\u7F6E:"\u30C1\u30E3\u30F3\u30CD\u30EB\u69CB\u6210","ADTS \u5E27\u957F\u5EA6":"ADTS \u30D5\u30EC\u30FC\u30E0\u9577","\u7F13\u51B2 fullness":"\u30D0\u30C3\u30D5\u30A1 fullness",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"\u751F\u30C7\u30FC\u30BF\u30D6\u30ED\u30C3\u30AF\u6570\u30D5\u30A3\u30FC\u30EB\u30C9","ID3v2 \u6807\u8BC6":"ID3v2 \u30DE\u30FC\u30AB\u30FC","ID3 \u7248\u672C":"ID3 \u30D0\u30FC\u30B8\u30E7\u30F3",\u6807\u7B7E\u957F\u5EA6:"\u30BF\u30B0\u9577",\u5E27\u540C\u6B65:"\u30D5\u30EC\u30FC\u30E0\u540C\u671F","MPEG \u97F3\u9891\u7248\u672C":"MPEG \u97F3\u58F0\u30D0\u30FC\u30B8\u30E7\u30F3","CRC \u6807\u5FD7":"CRC \u30D5\u30E9\u30B0",\u7801\u7387\u7D22\u5F15:"\u30D3\u30C3\u30C8\u30EC\u30FC\u30C8\u30A4\u30F3\u30C7\u30C3\u30AF\u30B9",\u58F0\u9053\u6A21\u5F0F:"\u30C1\u30E3\u30F3\u30CD\u30EB\u30E2\u30FC\u30C9"},Mt={"\u6587\u4EF6\u5927\u5C0F - 8":"\uD30C\uC77C \uD06C\uAE30 - 8","\u5B50\u5757 ID":"\uC11C\uBE0C\uCCAD\uD06C ID",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"\uC11C\uBE0C\uCCAD\uD06C \uB370\uC774\uD130 \uAE38\uC774",\u97F3\u9891\u6570\u636E\u533A\u57DF:"\uC624\uB514\uC624 \uB370\uC774\uD130 \uC601\uC5ED",\u672A\u5C55\u5F00\u5B50\u5757:"\uD3BC\uCE58\uC9C0 \uC54A\uC740 \uC11C\uBE0C\uCCAD\uD06C","fmt \u5B50\u5757\u8FC7\u77ED":"fmt \uC11C\uBE0C\uCCAD\uD06C\uAC00 \uB108\uBB34 \uC9E7\uC74C",\u7F16\u7801\u683C\u5F0F:"\uC778\uCF54\uB529 \uD615\uC2DD",\u901A\u9053\u6570:"\uCC44\uB110 \uC218",\u91C7\u6837\u7387:"\uC0D8\uD50C\uB808\uC774\uD2B8",\u5B57\u8282\u7387:"\uBC14\uC774\uD2B8 \uB808\uC774\uD2B8",\u6BCF\u5E27\u5B57\u8282\u6570:"\uD504\uB808\uC784\uB2F9 \uBC14\uC774\uD2B8 \uC218",\u4F4D\u6DF1:"\uBE44\uD2B8 \uAE4A\uC774",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"\uD655\uC7A5 \uB9E4\uAC1C\uBCC0\uC218 \uAE38\uC774",\u6709\u6548\u4F4D\u6DF1:"\uC720\uD6A8 \uBE44\uD2B8 \uAE4A\uC774",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"\uCC44\uB110 \uB808\uC774\uC544\uC6C3 \uB9C8\uC2A4\uD06C","FLAC \u6807\u8BC6":"FLAC \uB9C8\uCEE4",\u5143\u6570\u636E\u5757\u5934:"\uBA54\uD0C0\uB370\uC774\uD130 \uBE14\uB85D \uD5E4\uB354",\u5143\u6570\u636E\u5757\u957F\u5EA6:"\uBA54\uD0C0\uB370\uC774\uD130 \uBE14\uB85D \uAE38\uC774",\u5143\u6570\u636E\u5757\u5185\u5BB9:"\uBA54\uD0C0\uB370\uC774\uD130 \uBE14\uB85D \uD398\uC774\uB85C\uB4DC",\u6700\u5C0F\u5757\u5927\u5C0F:"\uCD5C\uC18C \uBE14\uB85D \uD06C\uAE30",\u6700\u5927\u5757\u5927\u5C0F:"\uCD5C\uB300 \uBE14\uB85D \uD06C\uAE30",\u6700\u5C0F\u5E27\u5927\u5C0F:"\uCD5C\uC18C \uD504\uB808\uC784 \uD06C\uAE30",\u6700\u5927\u5E27\u5927\u5C0F:"\uCD5C\uB300 \uD504\uB808\uC784 \uD06C\uAE30",\u603B\u91C7\u6837\u6570:"\uCD1D \uC0D8\uD50C \uC218","\u539F\u59CB\u97F3\u9891 MD5":"\uC6D0\uBCF8 \uC624\uB514\uC624 MD5","Ogg \u9875\u6807\u8BC6":"Ogg \uD398\uC774\uC9C0 \uB9C8\uCEE4",\u6D41\u7ED3\u6784\u7248\u672C:"\uC2A4\uD2B8\uB9BC \uAD6C\uC870 \uBC84\uC804",\u9875\u7C7B\u578B\u6807\u5FD7:"\uD398\uC774\uC9C0 \uC720\uD615 \uD50C\uB798\uADF8",\u7EDD\u5BF9\u4F4D\u7F6E:"\uC808\uB300 \uC704\uCE58",\u903B\u8F91\u6D41\u5E8F\u53F7:"\uB17C\uB9AC \uC2A4\uD2B8\uB9BC \uC77C\uB828\uBC88\uD638",\u9875\u5E8F\u53F7:"\uD398\uC774\uC9C0 \uC2DC\uD000\uC2A4 \uBC88\uD638",\u9875\u6821\u9A8C\u548C:"\uD398\uC774\uC9C0 \uCCB4\uD06C\uC12C","segment \u6570":"segment \uC218","segment \u957F\u5EA6\u8868":"segment \uAE38\uC774 \uD14C\uC774\uBE14",\u9875\u6570\u636E:"\uD398\uC774\uC9C0 \uD398\uC774\uB85C\uB4DC","Opus \u8BC6\u522B\u5934":"Opus \uC2DD\uBCC4 \uD5E4\uB354",\u7248\u672C:"\uBC84\uC804",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"\uD504\uB9AC\uC2A4\uD0B5 \uC0D8\uD50C \uC218",\u8F93\u5165\u91C7\u6837\u7387:"\uC785\uB825 \uC0D8\uD50C\uB808\uC774\uD2B8",\u8F93\u51FA\u589E\u76CA:"\uCD9C\uB825 \uAC8C\uC778",\u58F0\u9053\u6620\u5C04\u65CF:"\uCC44\uB110 \uB9E4\uD551 \uD328\uBC00\uB9AC",\u8BC6\u522B\u5934:"\uC2DD\uBCC4 \uD5E4\uB354","Vorbis \u6807\u8BC6":"Vorbis \uB9C8\uCEE4","box \u5927\u5C0F":"box \uD06C\uAE30","box \u7C7B\u578B":"box \uC720\uD615",\u4E3B\u54C1\u724C:"\uC8FC \uBE0C\uB79C\uB4DC",\u6B21\u7248\u672C:"\uB9C8\uC774\uB108 \uBC84\uC804",\u517C\u5BB9\u54C1\u724C:"\uD638\uD658 \uBE0C\uB79C\uB4DC",\u6807\u5FD7:"\uD50C\uB798\uADF8",\u65F6\u95F4\u523B\u5EA6:"\uD0C0\uC784\uC2A4\uCF00\uC77C",\u65F6\u957F\u5355\u4F4D\u6570:"\uC9C0\uC18D \uC2DC\uAC04 \uB2E8\uC704 \uC218",\u5904\u7406\u5668\u7C7B\u578B:"\uD578\uB4E4\uB7EC \uC720\uD615",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"\uC0D8\uD50C \uC124\uBA85 \uC218",\u6837\u672C\u7C7B\u578B:"\uC0D8\uD50C \uC720\uD615",\u540C\u6B65\u5B57:"\uB3D9\uAE30 \uC6CC\uB4DC","MPEG \u7248\u672C":"MPEG \uBC84\uC804",\u5C42:"\uB808\uC774\uC5B4","CRC \u662F\u5426\u7701\u7565":"CRC \uC0DD\uB7B5 \uC5EC\uBD80",\u91C7\u6837\u7387\u7D22\u5F15:"\uC0D8\uD50C\uB808\uC774\uD2B8 \uC778\uB371\uC2A4",\u58F0\u9053\u914D\u7F6E:"\uCC44\uB110 \uAD6C\uC131","ADTS \u5E27\u957F\u5EA6":"ADTS \uD504\uB808\uC784 \uAE38\uC774","\u7F13\u51B2 fullness":"\uBC84\uD37C fullness",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"\uC6D0\uC2DC \uB370\uC774\uD130 \uBE14\uB85D \uC218 \uD544\uB4DC","ID3v2 \u6807\u8BC6":"ID3v2 \uB9C8\uCEE4","ID3 \u7248\u672C":"ID3 \uBC84\uC804",\u6807\u7B7E\u957F\u5EA6:"\uD0DC\uADF8 \uAE38\uC774",\u5E27\u540C\u6B65:"\uD504\uB808\uC784 \uB3D9\uAE30","MPEG \u97F3\u9891\u7248\u672C":"MPEG \uC624\uB514\uC624 \uBC84\uC804","CRC \u6807\u5FD7":"CRC \uD50C\uB798\uADF8",\u7801\u7387\u7D22\u5F15:"\uBE44\uD2B8\uB808\uC774\uD2B8 \uC778\uB371\uC2A4",\u58F0\u9053\u6A21\u5F0F:"\uCC44\uB110 \uBAA8\uB4DC"},xt={"\u6587\u4EF6\u5927\u5C0F - 8":"Taille du fichier - 8","\u5B50\u5757 ID":"ID de sous-chunk",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Longueur des donn\xE9es du sous-chunk",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Zone de donn\xE9es audio",\u672A\u5C55\u5F00\u5B50\u5757:"Sous-chunk non d\xE9velopp\xE9","fmt \u5B50\u5757\u8FC7\u77ED":"Sous-chunk fmt trop court",\u7F16\u7801\u683C\u5F0F:"Format d'encodage",\u901A\u9053\u6570:"Nombre de canaux",\u91C7\u6837\u7387:"Fr\xE9quence d'\xE9chantillonnage",\u5B57\u8282\u7387:"D\xE9bit en octets",\u6BCF\u5E27\u5B57\u8282\u6570:"Octets par trame",\u4F4D\u6DF1:"Profondeur de bits",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Longueur des param\xE8tres \xE9tendus",\u6709\u6548\u4F4D\u6DF1:"Profondeur de bits valide",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Masque de disposition des canaux","FLAC \u6807\u8BC6":"Marqueur FLAC",\u5143\u6570\u636E\u5757\u5934:"En-t\xEAte du bloc de m\xE9tadonn\xE9es",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Longueur du bloc de m\xE9tadonn\xE9es",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Contenu du bloc de m\xE9tadonn\xE9es",\u6700\u5C0F\u5757\u5927\u5C0F:"Taille minimale de bloc",\u6700\u5927\u5757\u5927\u5C0F:"Taille maximale de bloc",\u6700\u5C0F\u5E27\u5927\u5C0F:"Taille minimale de trame",\u6700\u5927\u5E27\u5927\u5C0F:"Taille maximale de trame",\u603B\u91C7\u6837\u6570:"Nombre total d'\xE9chantillons","\u539F\u59CB\u97F3\u9891 MD5":"MD5 de l'audio brut","Ogg \u9875\u6807\u8BC6":"Marqueur de page Ogg",\u6D41\u7ED3\u6784\u7248\u672C:"Version de structure du flux",\u9875\u7C7B\u578B\u6807\u5FD7:"Drapeaux de type de page",\u7EDD\u5BF9\u4F4D\u7F6E:"Position absolue",\u903B\u8F91\u6D41\u5E8F\u53F7:"Num\xE9ro de s\xE9rie du flux logique",\u9875\u5E8F\u53F7:"Num\xE9ro de s\xE9quence de page",\u9875\u6821\u9A8C\u548C:"Somme de contr\xF4le de page","segment \u6570":"Nombre de segments","segment \u957F\u5EA6\u8868":"Table des longueurs de segments",\u9875\u6570\u636E:"Donn\xE9es de page","Opus \u8BC6\u522B\u5934":"En-t\xEAte d'identification Opus",\u7248\u672C:"Version",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Nombre d'\xE9chantillons pr\xE9-saut\xE9s",\u8F93\u5165\u91C7\u6837\u7387:"Fr\xE9quence d'\xE9chantillonnage d'entr\xE9e",\u8F93\u51FA\u589E\u76CA:"Gain de sortie",\u58F0\u9053\u6620\u5C04\u65CF:"Famille de mappage des canaux",\u8BC6\u522B\u5934:"En-t\xEAte d'identification","Vorbis \u6807\u8BC6":"Marqueur Vorbis","box \u5927\u5C0F":"Taille de box","box \u7C7B\u578B":"Type de box",\u4E3B\u54C1\u724C:"Marque principale",\u6B21\u7248\u672C:"Version mineure",\u517C\u5BB9\u54C1\u724C:"Marques compatibles",\u6807\u5FD7:"Drapeaux",\u65F6\u95F4\u523B\u5EA6:"\xC9chelle temporelle",\u65F6\u957F\u5355\u4F4D\u6570:"Unit\xE9s de dur\xE9e",\u5904\u7406\u5668\u7C7B\u578B:"Type de gestionnaire",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"Nombre de descriptions d'\xE9chantillon",\u6837\u672C\u7C7B\u578B:"Type d'\xE9chantillon",\u540C\u6B65\u5B57:"Mot de synchronisation","MPEG \u7248\u672C":"Version MPEG",\u5C42:"Couche","CRC \u662F\u5426\u7701\u7565":"CRC absent ou non",\u91C7\u6837\u7387\u7D22\u5F15:"Indice de fr\xE9quence d'\xE9chantillonnage",\u58F0\u9053\u914D\u7F6E:"Configuration des canaux","ADTS \u5E27\u957F\u5EA6":"Longueur de trame ADTS","\u7F13\u51B2 fullness":"Remplissage du tampon",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Champ du nombre de blocs de donn\xE9es brutes","ID3v2 \u6807\u8BC6":"Marqueur ID3v2","ID3 \u7248\u672C":"Version ID3",\u6807\u7B7E\u957F\u5EA6:"Longueur de balise",\u5E27\u540C\u6B65:"Synchronisation de trame","MPEG \u97F3\u9891\u7248\u672C":"Version audio MPEG","CRC \u6807\u5FD7":"Drapeau CRC",\u7801\u7387\u7D22\u5F15:"Indice de d\xE9bit",\u58F0\u9053\u6A21\u5F0F:"Mode de canaux"},zt={"\u6587\u4EF6\u5927\u5C0F - 8":"Dateigr\xF6\xDFe - 8","\u5B50\u5757 ID":"Subchunk-ID",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Subchunk-Datenl\xE4nge",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Audiodatenbereich",\u672A\u5C55\u5F00\u5B50\u5757:"Nicht erweiterter Subchunk","fmt \u5B50\u5757\u8FC7\u77ED":"fmt-Subchunk ist zu kurz",\u7F16\u7801\u683C\u5F0F:"Kodierungsformat",\u901A\u9053\u6570:"Kanalanzahl",\u91C7\u6837\u7387:"Abtastrate",\u5B57\u8282\u7387:"Byte-Rate",\u6BCF\u5E27\u5B57\u8282\u6570:"Bytes pro Frame",\u4F4D\u6DF1:"Bittiefe",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"L\xE4nge der Erweiterungsparameter",\u6709\u6548\u4F4D\u6DF1:"G\xFCltige Bittiefe",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Kanallayout-Maske","FLAC \u6807\u8BC6":"FLAC-Marker",\u5143\u6570\u636E\u5757\u5934:"Metadatenblock-Header",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Metadatenblock-L\xE4nge",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Metadatenblock-Inhalt",\u6700\u5C0F\u5757\u5927\u5C0F:"Minimale Blockgr\xF6\xDFe",\u6700\u5927\u5757\u5927\u5C0F:"Maximale Blockgr\xF6\xDFe",\u6700\u5C0F\u5E27\u5927\u5C0F:"Minimale Framegr\xF6\xDFe",\u6700\u5927\u5E27\u5927\u5C0F:"Maximale Framegr\xF6\xDFe",\u603B\u91C7\u6837\u6570:"Gesamtzahl der Samples","\u539F\u59CB\u97F3\u9891 MD5":"MD5 der Roh-Audiodaten","Ogg \u9875\u6807\u8BC6":"Ogg-Seitenmarker",\u6D41\u7ED3\u6784\u7248\u672C:"Streamstruktur-Version",\u9875\u7C7B\u578B\u6807\u5FD7:"Seitentyp-Flags",\u7EDD\u5BF9\u4F4D\u7F6E:"Absolute Position",\u903B\u8F91\u6D41\u5E8F\u53F7:"Seriennummer des logischen Streams",\u9875\u5E8F\u53F7:"Seitensequenznummer",\u9875\u6821\u9A8C\u548C:"Seitenpr\xFCfsumme","segment \u6570":"Segmentanzahl","segment \u957F\u5EA6\u8868":"Segmentl\xE4ngentabelle",\u9875\u6570\u636E:"Seitendaten","Opus \u8BC6\u522B\u5934":"Opus-Identifikationsheader",\u7248\u672C:"Version",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Pre-skip-Sampleanzahl",\u8F93\u5165\u91C7\u6837\u7387:"Eingabe-Abtastrate",\u8F93\u51FA\u589E\u76CA:"Ausgabeverst\xE4rkung",\u58F0\u9053\u6620\u5C04\u65CF:"Kanalmapping-Familie",\u8BC6\u522B\u5934:"Identifikationsheader","Vorbis \u6807\u8BC6":"Vorbis-Marker","box \u5927\u5C0F":"Box-Gr\xF6\xDFe","box \u7C7B\u578B":"Box-Typ",\u4E3B\u54C1\u724C:"Hauptmarke",\u6B21\u7248\u672C:"Nebenversion",\u517C\u5BB9\u54C1\u724C:"Kompatible Marken",\u6807\u5FD7:"Flags",\u65F6\u95F4\u523B\u5EA6:"Zeitskala",\u65F6\u957F\u5355\u4F4D\u6570:"Dauereinheiten",\u5904\u7406\u5668\u7C7B\u578B:"Handler-Typ",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"Anzahl der Sample-Beschreibungen",\u6837\u672C\u7C7B\u578B:"Sample-Typ",\u540C\u6B65\u5B57:"Syncwort","MPEG \u7248\u672C":"MPEG-Version",\u5C42:"Layer","CRC \u662F\u5426\u7701\u7565":"Ob CRC fehlt",\u91C7\u6837\u7387\u7D22\u5F15:"Abtastratenindex",\u58F0\u9053\u914D\u7F6E:"Kanalkonfiguration","ADTS \u5E27\u957F\u5EA6":"ADTS-Frame-L\xE4nge","\u7F13\u51B2 fullness":"Pufferf\xFCllstand",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Feld f\xFCr Anzahl der Rohdatenbl\xF6cke","ID3v2 \u6807\u8BC6":"ID3v2-Marker","ID3 \u7248\u672C":"ID3-Version",\u6807\u7B7E\u957F\u5EA6:"Tag-L\xE4nge",\u5E27\u540C\u6B65:"Frame-Synchronisation","MPEG \u97F3\u9891\u7248\u672C":"MPEG-Audioversion","CRC \u6807\u5FD7":"CRC-Flag",\u7801\u7387\u7D22\u5F15:"Bitratenindex",\u58F0\u9053\u6A21\u5F0F:"Kanalmodus"},Ct={"\u6587\u4EF6\u5927\u5C0F - 8":"Tama\xF1o del archivo - 8","\u5B50\u5757 ID":"ID de subchunk",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Longitud de datos del subchunk",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Regi\xF3n de datos de audio",\u672A\u5C55\u5F00\u5B50\u5757:"Subchunk no expandido","fmt \u5B50\u5757\u8FC7\u77ED":"El subchunk fmt es demasiado corto",\u7F16\u7801\u683C\u5F0F:"Formato de codificaci\xF3n",\u901A\u9053\u6570:"N\xFAmero de canales",\u91C7\u6837\u7387:"Frecuencia de muestreo",\u5B57\u8282\u7387:"Tasa de bytes",\u6BCF\u5E27\u5B57\u8282\u6570:"Bytes por trama",\u4F4D\u6DF1:"Profundidad de bits",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Longitud de par\xE1metros extendidos",\u6709\u6548\u4F4D\u6DF1:"Profundidad de bits v\xE1lida",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"M\xE1scara de disposici\xF3n de canales","FLAC \u6807\u8BC6":"Marcador FLAC",\u5143\u6570\u636E\u5757\u5934:"Cabecera del bloque de metadatos",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Longitud del bloque de metadatos",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Contenido del bloque de metadatos",\u6700\u5C0F\u5757\u5927\u5C0F:"Tama\xF1o m\xEDnimo de bloque",\u6700\u5927\u5757\u5927\u5C0F:"Tama\xF1o m\xE1ximo de bloque",\u6700\u5C0F\u5E27\u5927\u5C0F:"Tama\xF1o m\xEDnimo de trama",\u6700\u5927\u5E27\u5927\u5C0F:"Tama\xF1o m\xE1ximo de trama",\u603B\u91C7\u6837\u6570:"Total de muestras","\u539F\u59CB\u97F3\u9891 MD5":"MD5 del audio sin procesar","Ogg \u9875\u6807\u8BC6":"Marcador de p\xE1gina Ogg",\u6D41\u7ED3\u6784\u7248\u672C:"Versi\xF3n de estructura del flujo",\u9875\u7C7B\u578B\u6807\u5FD7:"Banderas de tipo de p\xE1gina",\u7EDD\u5BF9\u4F4D\u7F6E:"Posici\xF3n absoluta",\u903B\u8F91\u6D41\u5E8F\u53F7:"N\xFAmero de serie del flujo l\xF3gico",\u9875\u5E8F\u53F7:"N\xFAmero de secuencia de p\xE1gina",\u9875\u6821\u9A8C\u548C:"Suma de comprobaci\xF3n de p\xE1gina","segment \u6570":"N\xFAmero de segmentos","segment \u957F\u5EA6\u8868":"Tabla de longitudes de segmentos",\u9875\u6570\u636E:"Datos de p\xE1gina","Opus \u8BC6\u522B\u5934":"Cabecera de identificaci\xF3n Opus",\u7248\u672C:"Versi\xF3n",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"N\xFAmero de muestras pre-skip",\u8F93\u5165\u91C7\u6837\u7387:"Frecuencia de muestreo de entrada",\u8F93\u51FA\u589E\u76CA:"Ganancia de salida",\u58F0\u9053\u6620\u5C04\u65CF:"Familia de mapeo de canales",\u8BC6\u522B\u5934:"Cabecera de identificaci\xF3n","Vorbis \u6807\u8BC6":"Marcador Vorbis","box \u5927\u5C0F":"Tama\xF1o de box","box \u7C7B\u578B":"Tipo de box",\u4E3B\u54C1\u724C:"Marca principal",\u6B21\u7248\u672C:"Versi\xF3n menor",\u517C\u5BB9\u54C1\u724C:"Marcas compatibles",\u6807\u5FD7:"Banderas",\u65F6\u95F4\u523B\u5EA6:"Escala de tiempo",\u65F6\u957F\u5355\u4F4D\u6570:"Unidades de duraci\xF3n",\u5904\u7406\u5668\u7C7B\u578B:"Tipo de manejador",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"N\xFAmero de descripciones de muestra",\u6837\u672C\u7C7B\u578B:"Tipo de muestra",\u540C\u6B65\u5B57:"Palabra de sincronizaci\xF3n","MPEG \u7248\u672C":"Versi\xF3n MPEG",\u5C42:"Capa","CRC \u662F\u5426\u7701\u7565":"Si CRC est\xE1 ausente",\u91C7\u6837\u7387\u7D22\u5F15:"\xCDndice de frecuencia de muestreo",\u58F0\u9053\u914D\u7F6E:"Configuraci\xF3n de canales","ADTS \u5E27\u957F\u5EA6":"Longitud de trama ADTS","\u7F13\u51B2 fullness":"Llenado del b\xFAfer",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Campo de n\xFAmero de bloques de datos sin procesar","ID3v2 \u6807\u8BC6":"Marcador ID3v2","ID3 \u7248\u672C":"Versi\xF3n ID3",\u6807\u7B7E\u957F\u5EA6:"Longitud de etiqueta",\u5E27\u540C\u6B65:"Sincronizaci\xF3n de trama","MPEG \u97F3\u9891\u7248\u672C":"Versi\xF3n de audio MPEG","CRC \u6807\u5FD7":"Bandera CRC",\u7801\u7387\u7D22\u5F15:"\xCDndice de bitrate",\u58F0\u9053\u6A21\u5F0F:"Modo de canales"},At={"\u6587\u4EF6\u5927\u5C0F - 8":"Dimensione file - 8","\u5B50\u5757 ID":"ID sotto-blocco",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Lunghezza dati del sotto-blocco",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Area dati audio",\u672A\u5C55\u5F00\u5B50\u5757:"Sotto-blocco non espanso","fmt \u5B50\u5757\u8FC7\u77ED":"Sotto-blocco fmt troppo corto",\u7F16\u7801\u683C\u5F0F:"Formato di codifica",\u901A\u9053\u6570:"Numero di canali",\u91C7\u6837\u7387:"Frequenza di campionamento",\u5B57\u8282\u7387:"Byte rate",\u6BCF\u5E27\u5B57\u8282\u6570:"Byte per frame",\u4F4D\u6DF1:"Profondit\xE0 in bit",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Lunghezza parametri estesi",\u6709\u6548\u4F4D\u6DF1:"Profondit\xE0 valida in bit",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Maschera layout canali","FLAC \u6807\u8BC6":"Marcatore FLAC",\u5143\u6570\u636E\u5757\u5934:"Header blocco metadati",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Lunghezza blocco metadati",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Contenuto blocco metadati",\u6700\u5C0F\u5757\u5927\u5C0F:"Dimensione minima blocco",\u6700\u5927\u5757\u5927\u5C0F:"Dimensione massima blocco",\u6700\u5C0F\u5E27\u5927\u5C0F:"Dimensione minima frame",\u6700\u5927\u5E27\u5927\u5C0F:"Dimensione massima frame",\u603B\u91C7\u6837\u6570:"Campioni totali","\u539F\u59CB\u97F3\u9891 MD5":"MD5 audio grezzo","Ogg \u9875\u6807\u8BC6":"Marcatore pagina Ogg",\u6D41\u7ED3\u6784\u7248\u672C:"Versione struttura stream",\u9875\u7C7B\u578B\u6807\u5FD7:"Flag tipo pagina",\u7EDD\u5BF9\u4F4D\u7F6E:"Posizione assoluta",\u903B\u8F91\u6D41\u5E8F\u53F7:"Numero seriale stream logico",\u9875\u5E8F\u53F7:"Numero sequenza pagina",\u9875\u6821\u9A8C\u548C:"Checksum pagina","segment \u6570":"Numero segmenti","segment \u957F\u5EA6\u8868":"Tabella lunghezze segmenti",\u9875\u6570\u636E:"Payload pagina","Opus \u8BC6\u522B\u5934":"Header identificazione Opus",\u7248\u672C:"Versione",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Numero campioni pre-skip",\u8F93\u5165\u91C7\u6837\u7387:"Frequenza di campionamento in ingresso",\u8F93\u51FA\u589E\u76CA:"Guadagno in uscita",\u58F0\u9053\u6620\u5C04\u65CF:"Famiglia mappatura canali",\u8BC6\u522B\u5934:"Header identificazione","Vorbis \u6807\u8BC6":"Marcatore Vorbis","box \u5927\u5C0F":"Dimensione box","box \u7C7B\u578B":"Tipo box",\u4E3B\u54C1\u724C:"Brand principale",\u6B21\u7248\u672C:"Versione minore",\u517C\u5BB9\u54C1\u724C:"Brand compatibili",\u6807\u5FD7:"Flag",\u65F6\u95F4\u523B\u5EA6:"Scala temporale",\u65F6\u957F\u5355\u4F4D\u6570:"Unit\xE0 di durata",\u5904\u7406\u5668\u7C7B\u578B:"Tipo handler",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"Numero descrizioni campione",\u6837\u672C\u7C7B\u578B:"Tipo campione",\u540C\u6B65\u5B57:"Parola di sync","MPEG \u7248\u672C":"Versione MPEG",\u5C42:"Layer","CRC \u662F\u5426\u7701\u7565":"Se CRC \xE8 assente",\u91C7\u6837\u7387\u7D22\u5F15:"Indice frequenza di campionamento",\u58F0\u9053\u914D\u7F6E:"Configurazione canali","ADTS \u5E27\u957F\u5EA6":"Lunghezza frame ADTS","\u7F13\u51B2 fullness":"Pienezza buffer",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Campo numero blocchi dati grezzi","ID3v2 \u6807\u8BC6":"Marcatore ID3v2","ID3 \u7248\u672C":"Versione ID3",\u6807\u7B7E\u957F\u5EA6:"Lunghezza tag",\u5E27\u540C\u6B65:"Sync frame","MPEG \u97F3\u9891\u7248\u672C":"Versione audio MPEG","CRC \u6807\u5FD7":"Flag CRC",\u7801\u7387\u7D22\u5F15:"Indice bitrate",\u58F0\u9053\u6A21\u5F0F:"Modalit\xE0 canali"},Tt={"\u6587\u4EF6\u5927\u5C0F - 8":"Tamanho do arquivo - 8","\u5B50\u5757 ID":"ID do subchunk",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Comprimento dos dados do subchunk",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Regi\xE3o de dados de \xE1udio",\u672A\u5C55\u5F00\u5B50\u5757:"Subchunk n\xE3o expandido","fmt \u5B50\u5757\u8FC7\u77ED":"Subchunk fmt curto demais",\u7F16\u7801\u683C\u5F0F:"Formato de codifica\xE7\xE3o",\u901A\u9053\u6570:"N\xFAmero de canais",\u91C7\u6837\u7387:"Taxa de amostragem",\u5B57\u8282\u7387:"Taxa de bytes",\u6BCF\u5E27\u5B57\u8282\u6570:"Bytes por quadro",\u4F4D\u6DF1:"Profundidade de bits",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Comprimento dos par\xE2metros estendidos",\u6709\u6548\u4F4D\u6DF1:"Profundidade de bits v\xE1lida",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"M\xE1scara de layout de canais","FLAC \u6807\u8BC6":"Marcador FLAC",\u5143\u6570\u636E\u5757\u5934:"Cabe\xE7alho do bloco de metadados",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Comprimento do bloco de metadados",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Conte\xFAdo do bloco de metadados",\u6700\u5C0F\u5757\u5927\u5C0F:"Tamanho m\xEDnimo de bloco",\u6700\u5927\u5757\u5927\u5C0F:"Tamanho m\xE1ximo de bloco",\u6700\u5C0F\u5E27\u5927\u5C0F:"Tamanho m\xEDnimo de quadro",\u6700\u5927\u5E27\u5927\u5C0F:"Tamanho m\xE1ximo de quadro",\u603B\u91C7\u6837\u6570:"Total de amostras","\u539F\u59CB\u97F3\u9891 MD5":"MD5 do \xE1udio bruto","Ogg \u9875\u6807\u8BC6":"Marcador de p\xE1gina Ogg",\u6D41\u7ED3\u6784\u7248\u672C:"Vers\xE3o da estrutura do fluxo",\u9875\u7C7B\u578B\u6807\u5FD7:"Flags de tipo de p\xE1gina",\u7EDD\u5BF9\u4F4D\u7F6E:"Posi\xE7\xE3o absoluta",\u903B\u8F91\u6D41\u5E8F\u53F7:"N\xFAmero serial do fluxo l\xF3gico",\u9875\u5E8F\u53F7:"N\xFAmero de sequ\xEAncia da p\xE1gina",\u9875\u6821\u9A8C\u548C:"Checksum da p\xE1gina","segment \u6570":"N\xFAmero de segmentos","segment \u957F\u5EA6\u8868":"Tabela de comprimentos dos segmentos",\u9875\u6570\u636E:"Payload da p\xE1gina","Opus \u8BC6\u522B\u5934":"Cabe\xE7alho de identifica\xE7\xE3o Opus",\u7248\u672C:"Vers\xE3o",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"N\xFAmero de amostras pre-skip",\u8F93\u5165\u91C7\u6837\u7387:"Taxa de amostragem de entrada",\u8F93\u51FA\u589E\u76CA:"Ganho de sa\xEDda",\u58F0\u9053\u6620\u5C04\u65CF:"Fam\xEDlia de mapeamento de canais",\u8BC6\u522B\u5934:"Cabe\xE7alho de identifica\xE7\xE3o","Vorbis \u6807\u8BC6":"Marcador Vorbis","box \u5927\u5C0F":"Tamanho da box","box \u7C7B\u578B":"Tipo da box",\u4E3B\u54C1\u724C:"Marca principal",\u6B21\u7248\u672C:"Vers\xE3o menor",\u517C\u5BB9\u54C1\u724C:"Marcas compat\xEDveis",\u6807\u5FD7:"Flags",\u65F6\u95F4\u523B\u5EA6:"Escala de tempo",\u65F6\u957F\u5355\u4F4D\u6570:"Unidades de dura\xE7\xE3o",\u5904\u7406\u5668\u7C7B\u578B:"Tipo de handler",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"N\xFAmero de descri\xE7\xF5es de amostra",\u6837\u672C\u7C7B\u578B:"Tipo de amostra",\u540C\u6B65\u5B57:"Palavra de sincroniza\xE7\xE3o","MPEG \u7248\u672C":"Vers\xE3o MPEG",\u5C42:"Camada","CRC \u662F\u5426\u7701\u7565":"Se o CRC est\xE1 ausente",\u91C7\u6837\u7387\u7D22\u5F15:"\xCDndice da taxa de amostragem",\u58F0\u9053\u914D\u7F6E:"Configura\xE7\xE3o de canais","ADTS \u5E27\u957F\u5EA6":"Comprimento do quadro ADTS","\u7F13\u51B2 fullness":"Preenchimento do buffer",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Campo de n\xFAmero de blocos de dados brutos","ID3v2 \u6807\u8BC6":"Marcador ID3v2","ID3 \u7248\u672C":"Vers\xE3o ID3",\u6807\u7B7E\u957F\u5EA6:"Comprimento da tag",\u5E27\u540C\u6B65:"Sincroniza\xE7\xE3o de quadro","MPEG \u97F3\u9891\u7248\u672C":"Vers\xE3o de \xE1udio MPEG","CRC \u6807\u5FD7":"Flag CRC",\u7801\u7387\u7D22\u5F15:"\xCDndice de bitrate",\u58F0\u9053\u6A21\u5F0F:"Modo de canais"},Ft={"\u6587\u4EF6\u5927\u5C0F - 8":"\u0420\u0430\u0437\u043C\u0435\u0440 \u0444\u0430\u0439\u043B\u0430 - 8","\u5B50\u5757 ID":"ID \u043F\u043E\u0434\u0431\u043B\u043E\u043A\u0430",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"\u0414\u043B\u0438\u043D\u0430 \u0434\u0430\u043D\u043D\u044B\u0445 \u043F\u043E\u0434\u0431\u043B\u043E\u043A\u0430",\u97F3\u9891\u6570\u636E\u533A\u57DF:"\u041E\u0431\u043B\u0430\u0441\u0442\u044C \u0430\u0443\u0434\u0438\u043E\u0434\u0430\u043D\u043D\u044B\u0445",\u672A\u5C55\u5F00\u5B50\u5757:"\u041D\u0435\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0443\u0442\u044B\u0439 \u043F\u043E\u0434\u0431\u043B\u043E\u043A","fmt \u5B50\u5757\u8FC7\u77ED":"\u041F\u043E\u0434\u0431\u043B\u043E\u043A fmt \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439",\u7F16\u7801\u683C\u5F0F:"\u0424\u043E\u0440\u043C\u0430\u0442 \u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u044F",\u901A\u9053\u6570:"\u0427\u0438\u0441\u043B\u043E \u043A\u0430\u043D\u0430\u043B\u043E\u0432",\u91C7\u6837\u7387:"\u0427\u0430\u0441\u0442\u043E\u0442\u0430 \u0434\u0438\u0441\u043A\u0440\u0435\u0442\u0438\u0437\u0430\u0446\u0438\u0438",\u5B57\u8282\u7387:"\u0411\u0430\u0439\u0442\u043E\u0432\u0430\u044F \u0441\u043A\u043E\u0440\u043E\u0441\u0442\u044C",\u6BCF\u5E27\u5B57\u8282\u6570:"\u0411\u0430\u0439\u0442 \u043D\u0430 \u043A\u0430\u0434\u0440",\u4F4D\u6DF1:"\u0411\u0438\u0442\u043E\u0432\u0430\u044F \u0433\u043B\u0443\u0431\u0438\u043D\u0430",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"\u0414\u043B\u0438\u043D\u0430 \u0440\u0430\u0441\u0448\u0438\u0440\u0435\u043D\u043D\u044B\u0445 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u043E\u0432",\u6709\u6548\u4F4D\u6DF1:"\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0431\u0438\u0442\u043E\u0432\u0430\u044F \u0433\u043B\u0443\u0431\u0438\u043D\u0430",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"\u041C\u0430\u0441\u043A\u0430 \u0440\u0430\u0441\u043A\u043B\u0430\u0434\u043A\u0438 \u043A\u0430\u043D\u0430\u043B\u043E\u0432","FLAC \u6807\u8BC6":"\u041C\u0430\u0440\u043A\u0435\u0440 FLAC",\u5143\u6570\u636E\u5757\u5934:"\u0417\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \u0431\u043B\u043E\u043A\u0430 \u043C\u0435\u0442\u0430\u0434\u0430\u043D\u043D\u044B\u0445",\u5143\u6570\u636E\u5757\u957F\u5EA6:"\u0414\u043B\u0438\u043D\u0430 \u0431\u043B\u043E\u043A\u0430 \u043C\u0435\u0442\u0430\u0434\u0430\u043D\u043D\u044B\u0445",\u5143\u6570\u636E\u5757\u5185\u5BB9:"\u0421\u043E\u0434\u0435\u0440\u0436\u0438\u043C\u043E\u0435 \u0431\u043B\u043E\u043A\u0430 \u043C\u0435\u0442\u0430\u0434\u0430\u043D\u043D\u044B\u0445",\u6700\u5C0F\u5757\u5927\u5C0F:"\u041C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0430\u0437\u043C\u0435\u0440 \u0431\u043B\u043E\u043A\u0430",\u6700\u5927\u5757\u5927\u5C0F:"\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0430\u0437\u043C\u0435\u0440 \u0431\u043B\u043E\u043A\u0430",\u6700\u5C0F\u5E27\u5927\u5C0F:"\u041C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0430\u0437\u043C\u0435\u0440 \u043A\u0430\u0434\u0440\u0430",\u6700\u5927\u5E27\u5927\u5C0F:"\u041C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0430\u0437\u043C\u0435\u0440 \u043A\u0430\u0434\u0440\u0430",\u603B\u91C7\u6837\u6570:"\u0412\u0441\u0435\u0433\u043E \u0441\u044D\u043C\u043F\u043B\u043E\u0432","\u539F\u59CB\u97F3\u9891 MD5":"MD5 \u0438\u0441\u0445\u043E\u0434\u043D\u043E\u0433\u043E \u0430\u0443\u0434\u0438\u043E","Ogg \u9875\u6807\u8BC6":"\u041C\u0430\u0440\u043A\u0435\u0440 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B Ogg",\u6D41\u7ED3\u6784\u7248\u672C:"\u0412\u0435\u0440\u0441\u0438\u044F \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u044B \u043F\u043E\u0442\u043E\u043A\u0430",\u9875\u7C7B\u578B\u6807\u5FD7:"\u0424\u043B\u0430\u0433\u0438 \u0442\u0438\u043F\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B",\u7EDD\u5BF9\u4F4D\u7F6E:"\u0410\u0431\u0441\u043E\u043B\u044E\u0442\u043D\u0430\u044F \u043F\u043E\u0437\u0438\u0446\u0438\u044F",\u903B\u8F91\u6D41\u5E8F\u53F7:"\u0421\u0435\u0440\u0438\u0439\u043D\u044B\u0439 \u043D\u043E\u043C\u0435\u0440 \u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u043E\u0433\u043E \u043F\u043E\u0442\u043E\u043A\u0430",\u9875\u5E8F\u53F7:"\u041F\u043E\u0440\u044F\u0434\u043A\u043E\u0432\u044B\u0439 \u043D\u043E\u043C\u0435\u0440 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B",\u9875\u6821\u9A8C\u548C:"\u041A\u043E\u043D\u0442\u0440\u043E\u043B\u044C\u043D\u0430\u044F \u0441\u0443\u043C\u043C\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B","segment \u6570":"\u0427\u0438\u0441\u043B\u043E \u0441\u0435\u0433\u043C\u0435\u043D\u0442\u043E\u0432","segment \u957F\u5EA6\u8868":"\u0422\u0430\u0431\u043B\u0438\u0446\u0430 \u0434\u043B\u0438\u043D \u0441\u0435\u0433\u043C\u0435\u043D\u0442\u043E\u0432",\u9875\u6570\u636E:"\u0414\u0430\u043D\u043D\u044B\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B","Opus \u8BC6\u522B\u5934":"\u0418\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u043E\u043D\u043D\u044B\u0439 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A Opus",\u7248\u672C:"\u0412\u0435\u0440\u0441\u0438\u044F",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"\u0427\u0438\u0441\u043B\u043E pre-skip \u0441\u044D\u043C\u043F\u043B\u043E\u0432",\u8F93\u5165\u91C7\u6837\u7387:"\u0412\u0445\u043E\u0434\u043D\u0430\u044F \u0447\u0430\u0441\u0442\u043E\u0442\u0430 \u0434\u0438\u0441\u043A\u0440\u0435\u0442\u0438\u0437\u0430\u0446\u0438\u0438",\u8F93\u51FA\u589E\u76CA:"\u0412\u044B\u0445\u043E\u0434\u043D\u043E\u0435 \u0443\u0441\u0438\u043B\u0435\u043D\u0438\u0435",\u58F0\u9053\u6620\u5C04\u65CF:"\u0421\u0435\u043C\u0435\u0439\u0441\u0442\u0432\u043E \u043E\u0442\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F \u043A\u0430\u043D\u0430\u043B\u043E\u0432",\u8BC6\u522B\u5934:"\u0418\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u043E\u043D\u043D\u044B\u0439 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A","Vorbis \u6807\u8BC6":"\u041C\u0430\u0440\u043A\u0435\u0440 Vorbis","box \u5927\u5C0F":"\u0420\u0430\u0437\u043C\u0435\u0440 box","box \u7C7B\u578B":"\u0422\u0438\u043F box",\u4E3B\u54C1\u724C:"\u041E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 \u0431\u0440\u0435\u043D\u0434",\u6B21\u7248\u672C:"\u041C\u043B\u0430\u0434\u0448\u0430\u044F \u0432\u0435\u0440\u0441\u0438\u044F",\u517C\u5BB9\u54C1\u724C:"\u0421\u043E\u0432\u043C\u0435\u0441\u0442\u0438\u043C\u044B\u0435 \u0431\u0440\u0435\u043D\u0434\u044B",\u6807\u5FD7:"\u0424\u043B\u0430\u0433\u0438",\u65F6\u95F4\u523B\u5EA6:"\u0428\u043A\u0430\u043B\u0430 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",\u65F6\u957F\u5355\u4F4D\u6570:"\u0415\u0434\u0438\u043D\u0438\u0446\u044B \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u0438",\u5904\u7406\u5668\u7C7B\u578B:"\u0422\u0438\u043F \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0447\u0438\u043A\u0430",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"\u0427\u0438\u0441\u043B\u043E \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0439 \u0441\u044D\u043C\u043F\u043B\u043E\u0432",\u6837\u672C\u7C7B\u578B:"\u0422\u0438\u043F \u0441\u044D\u043C\u043F\u043B\u0430",\u540C\u6B65\u5B57:"\u0421\u0438\u043D\u0445\u0440\u043E\u0441\u043B\u043E\u0432\u043E","MPEG \u7248\u672C":"\u0412\u0435\u0440\u0441\u0438\u044F MPEG",\u5C42:"\u0421\u043B\u043E\u0439","CRC \u662F\u5426\u7701\u7565":"\u041E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u0435\u0442 \u043B\u0438 CRC",\u91C7\u6837\u7387\u7D22\u5F15:"\u0418\u043D\u0434\u0435\u043A\u0441 \u0447\u0430\u0441\u0442\u043E\u0442\u044B \u0434\u0438\u0441\u043A\u0440\u0435\u0442\u0438\u0437\u0430\u0446\u0438\u0438",\u58F0\u9053\u914D\u7F6E:"\u041A\u043E\u043D\u0444\u0438\u0433\u0443\u0440\u0430\u0446\u0438\u044F \u043A\u0430\u043D\u0430\u043B\u043E\u0432","ADTS \u5E27\u957F\u5EA6":"\u0414\u043B\u0438\u043D\u0430 \u043A\u0430\u0434\u0440\u0430 ADTS","\u7F13\u51B2 fullness":"\u0417\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u043E\u0441\u0442\u044C \u0431\u0443\u0444\u0435\u0440\u0430",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"\u041F\u043E\u043B\u0435 \u0447\u0438\u0441\u043B\u0430 \u0431\u043B\u043E\u043A\u043E\u0432 \u0441\u044B\u0440\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445","ID3v2 \u6807\u8BC6":"\u041C\u0430\u0440\u043A\u0435\u0440 ID3v2","ID3 \u7248\u672C":"\u0412\u0435\u0440\u0441\u0438\u044F ID3",\u6807\u7B7E\u957F\u5EA6:"\u0414\u043B\u0438\u043D\u0430 \u0442\u0435\u0433\u0430",\u5E27\u540C\u6B65:"\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F \u043A\u0430\u0434\u0440\u0430","MPEG \u97F3\u9891\u7248\u672C":"\u0412\u0435\u0440\u0441\u0438\u044F \u0430\u0443\u0434\u0438\u043E MPEG","CRC \u6807\u5FD7":"\u0424\u043B\u0430\u0433 CRC",\u7801\u7387\u7D22\u5F15:"\u0418\u043D\u0434\u0435\u043A\u0441 \u0431\u0438\u0442\u0440\u0435\u0439\u0442\u0430",\u58F0\u9053\u6A21\u5F0F:"\u0420\u0435\u0436\u0438\u043C \u043A\u0430\u043D\u0430\u043B\u043E\u0432"},Rt={"\u6587\u4EF6\u5927\u5C0F - 8":"Bestandsgrootte - 8","\u5B50\u5757 ID":"Subchunk-ID",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Gegevenslengte van subchunk",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Audiogegevensgebied",\u672A\u5C55\u5F00\u5B50\u5757:"Niet-uitgevouwen subchunk","fmt \u5B50\u5757\u8FC7\u77ED":"fmt-subchunk is te kort",\u7F16\u7801\u683C\u5F0F:"Coderingsformaat",\u901A\u9053\u6570:"Aantal kanalen",\u91C7\u6837\u7387:"Samplefrequentie",\u5B57\u8282\u7387:"Bytefrequentie",\u6BCF\u5E27\u5B57\u8282\u6570:"Bytes per frame",\u4F4D\u6DF1:"Bitdiepte",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Lengte van uitbreidingsparameters",\u6709\u6548\u4F4D\u6DF1:"Geldige bitdiepte",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Kanaalindelingsmasker","FLAC \u6807\u8BC6":"FLAC-markering",\u5143\u6570\u636E\u5757\u5934:"Header van metadatablok",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Lengte van metadatablok",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Inhoud van metadatablok",\u6700\u5C0F\u5757\u5927\u5C0F:"Minimale blokgrootte",\u6700\u5927\u5757\u5927\u5C0F:"Maximale blokgrootte",\u6700\u5C0F\u5E27\u5927\u5C0F:"Minimale framegrootte",\u6700\u5927\u5E27\u5927\u5C0F:"Maximale framegrootte",\u603B\u91C7\u6837\u6570:"Totaal aantal samples","\u539F\u59CB\u97F3\u9891 MD5":"MD5 van ruwe audio","Ogg \u9875\u6807\u8BC6":"Ogg-paginamarkering",\u6D41\u7ED3\u6784\u7248\u672C:"Versie van streamstructuur",\u9875\u7C7B\u578B\u6807\u5FD7:"Paginatypevlaggen",\u7EDD\u5BF9\u4F4D\u7F6E:"Absolute positie",\u903B\u8F91\u6D41\u5E8F\u53F7:"Serienummer van logische stream",\u9875\u5E8F\u53F7:"Paginavolgnummer",\u9875\u6821\u9A8C\u548C:"Paginacontrolesom","segment \u6570":"Aantal segmenten","segment \u957F\u5EA6\u8868":"Segmentlengtetabel",\u9875\u6570\u636E:"Paginagegevens","Opus \u8BC6\u522B\u5934":"Opus-identificatieheader",\u7248\u672C:"Versie",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Aantal pre-skip samples",\u8F93\u5165\u91C7\u6837\u7387:"Invoersamplefrequentie",\u8F93\u51FA\u589E\u76CA:"Uitvoerversterking",\u58F0\u9053\u6620\u5C04\u65CF:"Kanaaltoewijzingsfamilie",\u8BC6\u522B\u5934:"Identificatieheader","Vorbis \u6807\u8BC6":"Vorbis-markering","box \u5927\u5C0F":"Boxgrootte","box \u7C7B\u578B":"Boxtype",\u4E3B\u54C1\u724C:"Hoofdmerk",\u6B21\u7248\u672C:"Minorversie",\u517C\u5BB9\u54C1\u724C:"Compatibele merken",\u6807\u5FD7:"Vlaggen",\u65F6\u95F4\u523B\u5EA6:"Tijdschaal",\u65F6\u957F\u5355\u4F4D\u6570:"Duur-eenheden",\u5904\u7406\u5668\u7C7B\u578B:"Handlertype",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"Aantal samplebeschrijvingen",\u6837\u672C\u7C7B\u578B:"Sampletype",\u540C\u6B65\u5B57:"Synchronisatiewoord","MPEG \u7248\u672C":"MPEG-versie",\u5C42:"Laag","CRC \u662F\u5426\u7701\u7565":"Of CRC ontbreekt",\u91C7\u6837\u7387\u7D22\u5F15:"Samplefrequentie-index",\u58F0\u9053\u914D\u7F6E:"Kanaalconfiguratie","ADTS \u5E27\u957F\u5EA6":"ADTS-framelengte","\u7F13\u51B2 fullness":"Buffervulling",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Veld voor aantal ruwe datablokken","ID3v2 \u6807\u8BC6":"ID3v2-markering","ID3 \u7248\u672C":"ID3-versie",\u6807\u7B7E\u957F\u5EA6:"Taglengte",\u5E27\u540C\u6B65:"Framesynchronisatie","MPEG \u97F3\u9891\u7248\u672C":"MPEG-audioversie","CRC \u6807\u5FD7":"CRC-vlag",\u7801\u7387\u7D22\u5F15:"Bitrate-index",\u58F0\u9053\u6A21\u5F0F:"Kanaalmodus"},Ht={"\u6587\u4EF6\u5927\u5C0F - 8":"Rozmiar pliku - 8","\u5B50\u5757 ID":"ID podbloku",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"D\u0142ugo\u015B\u0107 danych podbloku",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Obszar danych audio",\u672A\u5C55\u5F00\u5B50\u5757:"Nierozwini\u0119ty podblok","fmt \u5B50\u5757\u8FC7\u77ED":"Podblok fmt jest zbyt kr\xF3tki",\u7F16\u7801\u683C\u5F0F:"Format kodowania",\u901A\u9053\u6570:"Liczba kana\u0142\xF3w",\u91C7\u6837\u7387:"Cz\u0119stotliwo\u015B\u0107 pr\xF3bkowania",\u5B57\u8282\u7387:"Szybko\u015B\u0107 bajtowa",\u6BCF\u5E27\u5B57\u8282\u6570:"Bajt\xF3w na ramk\u0119",\u4F4D\u6DF1:"G\u0142\u0119bia bitowa",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"D\u0142ugo\u015B\u0107 parametr\xF3w rozszerzenia",\u6709\u6548\u4F4D\u6DF1:"Prawid\u0142owa g\u0142\u0119bia bitowa",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Maska uk\u0142adu kana\u0142\xF3w","FLAC \u6807\u8BC6":"Znacznik FLAC",\u5143\u6570\u636E\u5757\u5934:"Nag\u0142\xF3wek bloku metadanych",\u5143\u6570\u636E\u5757\u957F\u5EA6:"D\u0142ugo\u015B\u0107 bloku metadanych",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Zawarto\u015B\u0107 bloku metadanych",\u6700\u5C0F\u5757\u5927\u5C0F:"Minimalny rozmiar bloku",\u6700\u5927\u5757\u5927\u5C0F:"Maksymalny rozmiar bloku",\u6700\u5C0F\u5E27\u5927\u5C0F:"Minimalny rozmiar ramki",\u6700\u5927\u5E27\u5927\u5C0F:"Maksymalny rozmiar ramki",\u603B\u91C7\u6837\u6570:"\u0141\u0105czna liczba pr\xF3bek","\u539F\u59CB\u97F3\u9891 MD5":"MD5 surowego audio","Ogg \u9875\u6807\u8BC6":"Znacznik strony Ogg",\u6D41\u7ED3\u6784\u7248\u672C:"Wersja struktury strumienia",\u9875\u7C7B\u578B\u6807\u5FD7:"Flagi typu strony",\u7EDD\u5BF9\u4F4D\u7F6E:"Pozycja bezwzgl\u0119dna",\u903B\u8F91\u6D41\u5E8F\u53F7:"Numer seryjny strumienia logicznego",\u9875\u5E8F\u53F7:"Numer sekwencji strony",\u9875\u6821\u9A8C\u548C:"Suma kontrolna strony","segment \u6570":"Liczba segment\xF3w","segment \u957F\u5EA6\u8868":"Tabela d\u0142ugo\u015Bci segment\xF3w",\u9875\u6570\u636E:"Dane strony","Opus \u8BC6\u522B\u5934":"Nag\u0142\xF3wek identyfikacyjny Opus",\u7248\u672C:"Wersja",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Liczba pr\xF3bek pre-skip",\u8F93\u5165\u91C7\u6837\u7387:"Wej\u015Bciowa cz\u0119stotliwo\u015B\u0107 pr\xF3bkowania",\u8F93\u51FA\u589E\u76CA:"Wzmocnienie wyj\u015Bciowe",\u58F0\u9053\u6620\u5C04\u65CF:"Rodzina mapowania kana\u0142\xF3w",\u8BC6\u522B\u5934:"Nag\u0142\xF3wek identyfikacyjny","Vorbis \u6807\u8BC6":"Znacznik Vorbis","box \u5927\u5C0F":"Rozmiar box","box \u7C7B\u578B":"Typ box",\u4E3B\u54C1\u724C:"G\u0142\xF3wna marka",\u6B21\u7248\u672C:"Wersja podrz\u0119dna",\u517C\u5BB9\u54C1\u724C:"Zgodne marki",\u6807\u5FD7:"Flagi",\u65F6\u95F4\u523B\u5EA6:"Skala czasu",\u65F6\u957F\u5355\u4F4D\u6570:"Jednostki czasu trwania",\u5904\u7406\u5668\u7C7B\u578B:"Typ handlera",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"Liczba opis\xF3w pr\xF3bek",\u6837\u672C\u7C7B\u578B:"Typ pr\xF3bki",\u540C\u6B65\u5B57:"S\u0142owo synchronizacji","MPEG \u7248\u672C":"Wersja MPEG",\u5C42:"Warstwa","CRC \u662F\u5426\u7701\u7565":"Czy CRC jest pomini\u0119te",\u91C7\u6837\u7387\u7D22\u5F15:"Indeks cz\u0119stotliwo\u015Bci pr\xF3bkowania",\u58F0\u9053\u914D\u7F6E:"Konfiguracja kana\u0142\xF3w","ADTS \u5E27\u957F\u5EA6":"D\u0142ugo\u015B\u0107 ramki ADTS","\u7F13\u51B2 fullness":"Wype\u0142nienie bufora",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Pole liczby blok\xF3w surowych danych","ID3v2 \u6807\u8BC6":"Znacznik ID3v2","ID3 \u7248\u672C":"Wersja ID3",\u6807\u7B7E\u957F\u5EA6:"D\u0142ugo\u015B\u0107 tagu",\u5E27\u540C\u6B65:"Synchronizacja ramki","MPEG \u97F3\u9891\u7248\u672C":"Wersja audio MPEG","CRC \u6807\u5FD7":"Flaga CRC",\u7801\u7387\u7D22\u5F15:"Indeks bitrate",\u58F0\u9053\u6A21\u5F0F:"Tryb kana\u0142\xF3w"},Bt={"\u6587\u4EF6\u5927\u5C0F - 8":"Dosya boyutu - 8","\u5B50\u5757 ID":"Alt par\xE7a ID",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Alt par\xE7a veri uzunlu\u011Fu",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Ses veri b\xF6lgesi",\u672A\u5C55\u5F00\u5B50\u5757:"Geni\u015Fletilmemi\u015F alt par\xE7a","fmt \u5B50\u5757\u8FC7\u77ED":"fmt alt par\xE7as\u0131 \xE7ok k\u0131sa",\u7F16\u7801\u683C\u5F0F:"Kodlama format\u0131",\u901A\u9053\u6570:"Kanal say\u0131s\u0131",\u91C7\u6837\u7387:"\xD6rnekleme h\u0131z\u0131",\u5B57\u8282\u7387:"Bayt h\u0131z\u0131",\u6BCF\u5E27\u5B57\u8282\u6570:"Kare ba\u015F\u0131na bayt",\u4F4D\u6DF1:"Bit derinli\u011Fi",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Geni\u015Fletme parametresi uzunlu\u011Fu",\u6709\u6548\u4F4D\u6DF1:"Ge\xE7erli bit derinli\u011Fi",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Kanal d\xFCzeni maskesi","FLAC \u6807\u8BC6":"FLAC i\u015Fareti",\u5143\u6570\u636E\u5757\u5934:"Meta veri blok ba\u015Fl\u0131\u011F\u0131",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Meta veri blok uzunlu\u011Fu",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Meta veri blok i\xE7eri\u011Fi",\u6700\u5C0F\u5757\u5927\u5C0F:"En k\xFC\xE7\xFCk blok boyutu",\u6700\u5927\u5757\u5927\u5C0F:"En b\xFCy\xFCk blok boyutu",\u6700\u5C0F\u5E27\u5927\u5C0F:"En k\xFC\xE7\xFCk kare boyutu",\u6700\u5927\u5E27\u5927\u5C0F:"En b\xFCy\xFCk kare boyutu",\u603B\u91C7\u6837\u6570:"Toplam \xF6rnek say\u0131s\u0131","\u539F\u59CB\u97F3\u9891 MD5":"Ham ses MD5","Ogg \u9875\u6807\u8BC6":"Ogg sayfa i\u015Fareti",\u6D41\u7ED3\u6784\u7248\u672C:"Ak\u0131\u015F yap\u0131s\u0131 s\xFCr\xFCm\xFC",\u9875\u7C7B\u578B\u6807\u5FD7:"Sayfa t\xFCr\xFC bayraklar\u0131",\u7EDD\u5BF9\u4F4D\u7F6E:"Mutlak konum",\u903B\u8F91\u6D41\u5E8F\u53F7:"Mant\u0131ksal ak\u0131\u015F seri numaras\u0131",\u9875\u5E8F\u53F7:"Sayfa s\u0131ra numaras\u0131",\u9875\u6821\u9A8C\u548C:"Sayfa sa\u011Flama toplam\u0131","segment \u6570":"Segment say\u0131s\u0131","segment \u957F\u5EA6\u8868":"Segment uzunluk tablosu",\u9875\u6570\u636E:"Sayfa verisi","Opus \u8BC6\u522B\u5934":"Opus tan\u0131mlama ba\u015Fl\u0131\u011F\u0131",\u7248\u672C:"S\xFCr\xFCm",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Pre-skip \xF6rnek say\u0131s\u0131",\u8F93\u5165\u91C7\u6837\u7387:"Giri\u015F \xF6rnekleme h\u0131z\u0131",\u8F93\u51FA\u589E\u76CA:"\xC7\u0131k\u0131\u015F kazanc\u0131",\u58F0\u9053\u6620\u5C04\u65CF:"Kanal e\u015Fleme ailesi",\u8BC6\u522B\u5934:"Tan\u0131mlama ba\u015Fl\u0131\u011F\u0131","Vorbis \u6807\u8BC6":"Vorbis i\u015Fareti","box \u5927\u5C0F":"Box boyutu","box \u7C7B\u578B":"Box t\xFCr\xFC",\u4E3B\u54C1\u724C:"Ana marka",\u6B21\u7248\u672C:"Alt s\xFCr\xFCm",\u517C\u5BB9\u54C1\u724C:"Uyumlu markalar",\u6807\u5FD7:"Bayraklar",\u65F6\u95F4\u523B\u5EA6:"Zaman \xF6l\xE7e\u011Fi",\u65F6\u957F\u5355\u4F4D\u6570:"S\xFCre birimleri",\u5904\u7406\u5668\u7C7B\u578B:"Handler t\xFCr\xFC",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"\xD6rnek a\xE7\u0131klamas\u0131 say\u0131s\u0131",\u6837\u672C\u7C7B\u578B:"\xD6rnek t\xFCr\xFC",\u540C\u6B65\u5B57:"Senkronizasyon s\xF6zc\xFC\u011F\xFC","MPEG \u7248\u672C":"MPEG s\xFCr\xFCm\xFC",\u5C42:"Katman","CRC \u662F\u5426\u7701\u7565":"CRC yok mu",\u91C7\u6837\u7387\u7D22\u5F15:"\xD6rnekleme h\u0131z\u0131 indeksi",\u58F0\u9053\u914D\u7F6E:"Kanal yap\u0131land\u0131rmas\u0131","ADTS \u5E27\u957F\u5EA6":"ADTS kare uzunlu\u011Fu","\u7F13\u51B2 fullness":"Tampon dolulu\u011Fu",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Ham veri blo\u011Fu say\u0131s\u0131 alan\u0131","ID3v2 \u6807\u8BC6":"ID3v2 i\u015Fareti","ID3 \u7248\u672C":"ID3 s\xFCr\xFCm\xFC",\u6807\u7B7E\u957F\u5EA6:"Etiket uzunlu\u011Fu",\u5E27\u540C\u6B65:"Kare senkronizasyonu","MPEG \u97F3\u9891\u7248\u672C":"MPEG ses s\xFCr\xFCm\xFC","CRC \u6807\u5FD7":"CRC bayra\u011F\u0131",\u7801\u7387\u7D22\u5F15:"Bitrate indeksi",\u58F0\u9053\u6A21\u5F0F:"Kanal modu"},Lt={"\u6587\u4EF6\u5927\u5C0F - 8":"Ukuran file - 8","\u5B50\u5757 ID":"ID subchunk",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Panjang data subchunk",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Area data audio",\u672A\u5C55\u5F00\u5B50\u5757:"Subchunk yang belum dibuka","fmt \u5B50\u5757\u8FC7\u77ED":"Subchunk fmt terlalu pendek",\u7F16\u7801\u683C\u5F0F:"Format pengodean",\u901A\u9053\u6570:"Jumlah kanal",\u91C7\u6837\u7387:"Laju sampel",\u5B57\u8282\u7387:"Laju byte",\u6BCF\u5E27\u5B57\u8282\u6570:"Byte per frame",\u4F4D\u6DF1:"Kedalaman bit",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Panjang parameter ekstensi",\u6709\u6548\u4F4D\u6DF1:"Kedalaman bit valid",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Mask layout kanal","FLAC \u6807\u8BC6":"Penanda FLAC",\u5143\u6570\u636E\u5757\u5934:"Header blok metadata",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Panjang blok metadata",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Isi blok metadata",\u6700\u5C0F\u5757\u5927\u5C0F:"Ukuran blok minimum",\u6700\u5927\u5757\u5927\u5C0F:"Ukuran blok maksimum",\u6700\u5C0F\u5E27\u5927\u5C0F:"Ukuran frame minimum",\u6700\u5927\u5E27\u5927\u5C0F:"Ukuran frame maksimum",\u603B\u91C7\u6837\u6570:"Total sampel","\u539F\u59CB\u97F3\u9891 MD5":"MD5 audio mentah","Ogg \u9875\u6807\u8BC6":"Penanda halaman Ogg",\u6D41\u7ED3\u6784\u7248\u672C:"Versi struktur stream",\u9875\u7C7B\u578B\u6807\u5FD7:"Flag tipe halaman",\u7EDD\u5BF9\u4F4D\u7F6E:"Posisi absolut",\u903B\u8F91\u6D41\u5E8F\u53F7:"Nomor seri stream logis",\u9875\u5E8F\u53F7:"Nomor urut halaman",\u9875\u6821\u9A8C\u548C:"Checksum halaman","segment \u6570":"Jumlah segment","segment \u957F\u5EA6\u8868":"Tabel panjang segment",\u9875\u6570\u636E:"Payload halaman","Opus \u8BC6\u522B\u5934":"Header identifikasi Opus",\u7248\u672C:"Versi",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Jumlah sampel pre-skip",\u8F93\u5165\u91C7\u6837\u7387:"Laju sampel input",\u8F93\u51FA\u589E\u76CA:"Gain output",\u58F0\u9053\u6620\u5C04\u65CF:"Keluarga pemetaan kanal",\u8BC6\u522B\u5934:"Header identifikasi","Vorbis \u6807\u8BC6":"Penanda Vorbis","box \u5927\u5C0F":"Ukuran box","box \u7C7B\u578B":"Tipe box",\u4E3B\u54C1\u724C:"Brand utama",\u6B21\u7248\u672C:"Versi minor",\u517C\u5BB9\u54C1\u724C:"Brand kompatibel",\u6807\u5FD7:"Flag",\u65F6\u95F4\u523B\u5EA6:"Skala waktu",\u65F6\u957F\u5355\u4F4D\u6570:"Unit durasi",\u5904\u7406\u5668\u7C7B\u578B:"Tipe handler",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"Jumlah deskripsi sampel",\u6837\u672C\u7C7B\u578B:"Tipe sampel",\u540C\u6B65\u5B57:"Kata sinkronisasi","MPEG \u7248\u672C":"Versi MPEG",\u5C42:"Layer","CRC \u662F\u5426\u7701\u7565":"Apakah CRC tidak ada",\u91C7\u6837\u7387\u7D22\u5F15:"Indeks laju sampel",\u58F0\u9053\u914D\u7F6E:"Konfigurasi kanal","ADTS \u5E27\u957F\u5EA6":"Panjang frame ADTS","\u7F13\u51B2 fullness":"Kepenuhan buffer",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Kolom jumlah blok data mentah","ID3v2 \u6807\u8BC6":"Penanda ID3v2","ID3 \u7248\u672C":"Versi ID3",\u6807\u7B7E\u957F\u5EA6:"Panjang tag",\u5E27\u540C\u6B65:"Sinkronisasi frame","MPEG \u97F3\u9891\u7248\u672C":"Versi audio MPEG","CRC \u6807\u5FD7":"Flag CRC",\u7801\u7387\u7D22\u5F15:"Indeks bitrate",\u58F0\u9053\u6A21\u5F0F:"Mode kanal"},Et={"\u6587\u4EF6\u5927\u5C0F - 8":"Filst\xF8rrelse - 8","\u5B50\u5757 ID":"Subchunk-ID",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"Datalengde for subchunk",\u97F3\u9891\u6570\u636E\u533A\u57DF:"Lyddataomr\xE5de",\u672A\u5C55\u5F00\u5B50\u5757:"Ikke-utvidet subchunk","fmt \u5B50\u5757\u8FC7\u77ED":"fmt-subchunk er for kort",\u7F16\u7801\u683C\u5F0F:"Kodingsformat",\u901A\u9053\u6570:"Antall kanaler",\u91C7\u6837\u7387:"Samplingsrate",\u5B57\u8282\u7387:"Byterate",\u6BCF\u5E27\u5B57\u8282\u6570:"Byte per frame",\u4F4D\u6DF1:"Bitdybde",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"Lengde p\xE5 utvidelsesparametere",\u6709\u6548\u4F4D\u6DF1:"Gyldig bitdybde",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"Kanallayoutmaske","FLAC \u6807\u8BC6":"FLAC-mark\xF8r",\u5143\u6570\u636E\u5757\u5934:"Metadata-blokkhode",\u5143\u6570\u636E\u5757\u957F\u5EA6:"Metadata-blokklengde",\u5143\u6570\u636E\u5757\u5185\u5BB9:"Metadata-blokkinnhold",\u6700\u5C0F\u5757\u5927\u5C0F:"Minste blokkst\xF8rrelse",\u6700\u5927\u5757\u5927\u5C0F:"St\xF8rste blokkst\xF8rrelse",\u6700\u5C0F\u5E27\u5927\u5C0F:"Minste framest\xF8rrelse",\u6700\u5927\u5E27\u5927\u5C0F:"St\xF8rste framest\xF8rrelse",\u603B\u91C7\u6837\u6570:"Totalt antall samples","\u539F\u59CB\u97F3\u9891 MD5":"MD5 for r\xE5 lyd","Ogg \u9875\u6807\u8BC6":"Ogg-sidemark\xF8r",\u6D41\u7ED3\u6784\u7248\u672C:"Streamstrukturversjon",\u9875\u7C7B\u578B\u6807\u5FD7:"Sidetypeflagg",\u7EDD\u5BF9\u4F4D\u7F6E:"Absolutt posisjon",\u903B\u8F91\u6D41\u5E8F\u53F7:"Serienummer for logisk stream",\u9875\u5E8F\u53F7:"Sidesekvensnummer",\u9875\u6821\u9A8C\u548C:"Sidekontrollsum","segment \u6570":"Antall segmenter","segment \u957F\u5EA6\u8868":"Segmentlengdetabell",\u9875\u6570\u636E:"Sidedata","Opus \u8BC6\u522B\u5934":"Opus-identifikasjonshode",\u7248\u672C:"Versjon",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"Antall pre-skip samples",\u8F93\u5165\u91C7\u6837\u7387:"Inngangssamplingsrate",\u8F93\u51FA\u589E\u76CA:"Utgangsforsterkning",\u58F0\u9053\u6620\u5C04\u65CF:"Kanaltilordningsfamilie",\u8BC6\u522B\u5934:"Identifikasjonshode","Vorbis \u6807\u8BC6":"Vorbis-mark\xF8r","box \u5927\u5C0F":"Box-st\xF8rrelse","box \u7C7B\u578B":"Box-type",\u4E3B\u54C1\u724C:"Hovedmerke",\u6B21\u7248\u672C:"Underversjon",\u517C\u5BB9\u54C1\u724C:"Kompatible merker",\u6807\u5FD7:"Flagg",\u65F6\u95F4\u523B\u5EA6:"Tidsskala",\u65F6\u957F\u5355\u4F4D\u6570:"Varighetsenheter",\u5904\u7406\u5668\u7C7B\u578B:"Handlertype",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"Antall samplebeskrivelser",\u6837\u672C\u7C7B\u578B:"Sampletype",\u540C\u6B65\u5B57:"Synkroniseringsord","MPEG \u7248\u672C":"MPEG-versjon",\u5C42:"Lag","CRC \u662F\u5426\u7701\u7565":"Om CRC mangler",\u91C7\u6837\u7387\u7D22\u5F15:"Samplingsrateindeks",\u58F0\u9053\u914D\u7F6E:"Kanalkonfigurasjon","ADTS \u5E27\u957F\u5EA6":"ADTS-framelengde","\u7F13\u51B2 fullness":"Bufferfylling",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Felt for antall r\xE5datablokker","ID3v2 \u6807\u8BC6":"ID3v2-mark\xF8r","ID3 \u7248\u672C":"ID3-versjon",\u6807\u7B7E\u957F\u5EA6:"Tagglengde",\u5E27\u540C\u6B65:"Framesynkronisering","MPEG \u97F3\u9891\u7248\u672C":"MPEG-lydversjon","CRC \u6807\u5FD7":"CRC-flagg",\u7801\u7387\u7D22\u5F15:"Bitrateindeks",\u58F0\u9053\u6A21\u5F0F:"Kanalmodus"},It={"\u6587\u4EF6\u5927\u5C0F - 8":"K\xEDch th\u01B0\u1EDBc t\u1EC7p - 8","\u5B50\u5757 ID":"ID subchunk",\u5B50\u5757\u6570\u636E\u957F\u5EA6:"\u0110\u1ED9 d\xE0i d\u1EEF li\u1EC7u subchunk",\u97F3\u9891\u6570\u636E\u533A\u57DF:"V\xF9ng d\u1EEF li\u1EC7u \xE2m thanh",\u672A\u5C55\u5F00\u5B50\u5757:"Subchunk ch\u01B0a m\u1EDF r\u1ED9ng","fmt \u5B50\u5757\u8FC7\u77ED":"Subchunk fmt qu\xE1 ng\u1EAFn",\u7F16\u7801\u683C\u5F0F:"\u0110\u1ECBnh d\u1EA1ng m\xE3 h\xF3a",\u901A\u9053\u6570:"S\u1ED1 k\xEAnh",\u91C7\u6837\u7387:"T\u1EA7n s\u1ED1 l\u1EA5y m\u1EABu",\u5B57\u8282\u7387:"T\u1ED1c \u0111\u1ED9 byte",\u6BCF\u5E27\u5B57\u8282\u6570:"Byte m\u1ED7i frame",\u4F4D\u6DF1:"\u0110\u1ED9 s\xE2u bit",\u6269\u5C55\u53C2\u6570\u957F\u5EA6:"\u0110\u1ED9 d\xE0i tham s\u1ED1 m\u1EDF r\u1ED9ng",\u6709\u6548\u4F4D\u6DF1:"\u0110\u1ED9 s\xE2u bit h\u1EE3p l\u1EC7",\u58F0\u9053\u5E03\u5C40\u63A9\u7801:"M\u1EB7t n\u1EA1 b\u1ED1 c\u1EE5c k\xEAnh","FLAC \u6807\u8BC6":"D\u1EA5u FLAC",\u5143\u6570\u636E\u5757\u5934:"Header kh\u1ED1i metadata",\u5143\u6570\u636E\u5757\u957F\u5EA6:"\u0110\u1ED9 d\xE0i kh\u1ED1i metadata",\u5143\u6570\u636E\u5757\u5185\u5BB9:"N\u1ED9i dung kh\u1ED1i metadata",\u6700\u5C0F\u5757\u5927\u5C0F:"K\xEDch th\u01B0\u1EDBc kh\u1ED1i nh\u1ECF nh\u1EA5t",\u6700\u5927\u5757\u5927\u5C0F:"K\xEDch th\u01B0\u1EDBc kh\u1ED1i l\u1EDBn nh\u1EA5t",\u6700\u5C0F\u5E27\u5927\u5C0F:"K\xEDch th\u01B0\u1EDBc frame nh\u1ECF nh\u1EA5t",\u6700\u5927\u5E27\u5927\u5C0F:"K\xEDch th\u01B0\u1EDBc frame l\u1EDBn nh\u1EA5t",\u603B\u91C7\u6837\u6570:"T\u1ED5ng s\u1ED1 m\u1EABu","\u539F\u59CB\u97F3\u9891 MD5":"MD5 \xE2m thanh th\xF4","Ogg \u9875\u6807\u8BC6":"D\u1EA5u trang Ogg",\u6D41\u7ED3\u6784\u7248\u672C:"Phi\xEAn b\u1EA3n c\u1EA5u tr\xFAc stream",\u9875\u7C7B\u578B\u6807\u5FD7:"C\u1EDD lo\u1EA1i trang",\u7EDD\u5BF9\u4F4D\u7F6E:"V\u1ECB tr\xED tuy\u1EC7t \u0111\u1ED1i",\u903B\u8F91\u6D41\u5E8F\u53F7:"S\u1ED1 s\xEA-ri stream logic",\u9875\u5E8F\u53F7:"S\u1ED1 th\u1EE9 t\u1EF1 trang",\u9875\u6821\u9A8C\u548C:"Checksum trang","segment \u6570":"S\u1ED1 segment","segment \u957F\u5EA6\u8868":"B\u1EA3ng \u0111\u1ED9 d\xE0i segment",\u9875\u6570\u636E:"Payload trang","Opus \u8BC6\u522B\u5934":"Header nh\u1EADn d\u1EA1ng Opus",\u7248\u672C:"Phi\xEAn b\u1EA3n",\u9884\u8DF3\u8FC7\u91C7\u6837\u6570:"S\u1ED1 m\u1EABu pre-skip",\u8F93\u5165\u91C7\u6837\u7387:"T\u1EA7n s\u1ED1 l\u1EA5y m\u1EABu \u0111\u1EA7u v\xE0o",\u8F93\u51FA\u589E\u76CA:"Gain \u0111\u1EA7u ra",\u58F0\u9053\u6620\u5C04\u65CF:"H\u1ECD \xE1nh x\u1EA1 k\xEAnh",\u8BC6\u522B\u5934:"Header nh\u1EADn d\u1EA1ng","Vorbis \u6807\u8BC6":"D\u1EA5u Vorbis","box \u5927\u5C0F":"K\xEDch th\u01B0\u1EDBc box","box \u7C7B\u578B":"Lo\u1EA1i box",\u4E3B\u54C1\u724C:"Brand ch\xEDnh",\u6B21\u7248\u672C:"Phi\xEAn b\u1EA3n ph\u1EE5",\u517C\u5BB9\u54C1\u724C:"Brand t\u01B0\u01A1ng th\xEDch",\u6807\u5FD7:"C\u1EDD",\u65F6\u95F4\u523B\u5EA6:"Thang th\u1EDDi gian",\u65F6\u957F\u5355\u4F4D\u6570:"\u0110\u01A1n v\u1ECB th\u1EDDi l\u01B0\u1EE3ng",\u5904\u7406\u5668\u7C7B\u578B:"Lo\u1EA1i handler",\u6837\u672C\u63CF\u8FF0\u6570\u91CF:"S\u1ED1 m\xF4 t\u1EA3 m\u1EABu",\u6837\u672C\u7C7B\u578B:"Lo\u1EA1i m\u1EABu",\u540C\u6B65\u5B57:"T\u1EEB \u0111\u1ED3ng b\u1ED9","MPEG \u7248\u672C":"Phi\xEAn b\u1EA3n MPEG",\u5C42:"L\u1EDBp","CRC \u662F\u5426\u7701\u7565":"CRC c\xF3 b\u1ECB thi\u1EBFu kh\xF4ng",\u91C7\u6837\u7387\u7D22\u5F15:"Ch\u1EC9 m\u1EE5c t\u1EA7n s\u1ED1 l\u1EA5y m\u1EABu",\u58F0\u9053\u914D\u7F6E:"C\u1EA5u h\xECnh k\xEAnh","ADTS \u5E27\u957F\u5EA6":"\u0110\u1ED9 d\xE0i frame ADTS","\u7F13\u51B2 fullness":"\u0110\u1ED9 \u0111\u1EA7y buffer",\u539F\u59CB\u6570\u636E\u5757\u6570\u91CF\u5B57\u6BB5:"Tr\u01B0\u1EDDng s\u1ED1 kh\u1ED1i d\u1EEF li\u1EC7u th\xF4","ID3v2 \u6807\u8BC6":"D\u1EA5u ID3v2","ID3 \u7248\u672C":"Phi\xEAn b\u1EA3n ID3",\u6807\u7B7E\u957F\u5EA6:"\u0110\u1ED9 d\xE0i tag",\u5E27\u540C\u6B65:"\u0110\u1ED3ng b\u1ED9 frame","MPEG \u97F3\u9891\u7248\u672C":"Phi\xEAn b\u1EA3n \xE2m thanh MPEG","CRC \u6807\u5FD7":"C\u1EDD CRC",\u7801\u7387\u7D22\u5F15:"Ch\u1EC9 m\u1EE5c bitrate",\u58F0\u9053\u6A21\u5F0F:"Ch\u1EBF \u0111\u1ED9 k\xEAnh"},Dt={"zh-TW":St,en:xe,ja:Pt,ko:Mt,fr:xt,de:zt,es:Ct,it:At,pt:Tt,ru:Ft,nl:Rt,pl:Ht,tr:Bt,id:Lt,no:Et,vi:It},ee=class{constructor(e,a){this.vscode=e;this.elements=a;this.syncPlatformShortcuts(),this.bindUi(),this.bindAnalysisWorker(),this.bindSelectionWorker(),this.updateSelectionAnalysis()}vscode;elements;config;audioBuffer;audioBytes;trackViews=[];defaultPcmFormat;currentFileName="";currentSourceLabel="";requestSeq=1;pendingAnalysisKeys=new Set;analysisGeneration=0;workerLoadedChannels=new Set;lastAnalyzeAt=0;prefetchTimer;playheadTime;dragPlayheadTime;sourceSampleRate;selection;selectionPlaybackEnd;isDraggingSelection=!1;playbackFrameId;preferencesSaveTimer;analysisTimer;playbackAudioContext;playbackSourceNode;playbackMediaSourceNode;playbackBufferSourceNode;bufferPlaybackPaused=!0;bufferPlaybackOffset=0;bufferPlaybackStartedAt=0;playbackSplitterNode;playbackMergerNode;playbackChannelGains=[];pendingChunks=new Map;pendingTranscodes=new Map;pendingAnalysisTargets=new Map;pendingAnalysisProfiles=new Map;spectrogramCache=new Map;spectrogramBitmapCache=new Map;spectrogramRangeCache=new Map;lastSpectrogramByChannel=new Map;waveformCache=new Map;waveformCacheBytes=0;channelPeakCache=new Map;pcmStatusStates=new WeakMap;worker=N();selectionWorker=N();selectionSpectrumTimer;selectionSpectrumRequestSeq=0;currentSelectionSpectrumRequestId;selectionSpectrumRunning=!1;selectionWavDownloadRequestSeq=0;pendingSelectionWavDownloads=new Map;loadQueue=Promise.resolve();currentLocale="en";messages=ue("en");settings={defaultTrackMode:"both",windowFunction:"hamming",fftSize:512,zeroPaddingFactor:2,channel:0,minDb:-96,maxDb:0,spectrogramMinHz:0,spectrogramMaxHz:8e3,spectrogramMaxFollowsNyquist:!0,autoBrightness:!0,amplitudeAuto:!0,amplitudeMin:-1,amplitudeMax:1,timeZoom:1,timeOffset:0,frequencyScale:"linear",palette:"rose",defaultTrackRowHeight:bt,defaultTrackWaveFr:kt,defaultTrackSpecFr:vt};async handleMessage(e){switch(e.type){case"bootstrap":this.config=e.config,this.applyLanguage(e.config),this.settings.windowFunction=e.config.analysis.windowFunction,this.settings.fftSize=we(e.config.analysis.fftSize),this.settings.zeroPaddingFactor=L(this.settings.fftSize,e.config.analysis.zeroPaddingFactor),this.applyPreferences(e.preferences),this.syncControls(),await this.enqueueLoad(e.metadata);break;case"configChanged":this.config=e.config,this.settings.windowFunction=e.config.analysis.windowFunction,this.settings.fftSize=we(e.config.analysis.fftSize),this.settings.zeroPaddingFactor=L(this.settings.fftSize,e.config.analysis.zeroPaddingFactor),this.applyLanguage(e.config),this.syncControls(),this.updateSelectionAnalysis(),this.redrawVisuals();break;case"fileChanged":await this.enqueueLoad(e.metadata);break;case"chunk":this.resolveChunk(e);break;case"chunkError":this.rejectChunk(e);break;case"transcodedAudio":this.resolveTranscode(e);break;case"transcodeError":this.rejectTranscode(e);break;case"selectionWavSaveReady":this.writePendingSelectionWav(e.requestId);break;case"selectionWavSaveCanceled":this.pendingSelectionWavDownloads.delete(e.requestId);break;case"error":this.setStatus(e.message,"warning");break}}bindAnalysisWorker(){this.worker.addEventListener("message",e=>{e.data.type==="spectrogram"&&this.drawSpectrogramResult(e.data)}),this.worker.addEventListener("error",e=>{e.preventDefault(),this.recoverAnalysisWorker(e.message||"Analysis Worker failed.")}),this.worker.addEventListener("messageerror",()=>{this.recoverAnalysisWorker("Analysis Worker returned an invalid message.")})}bindSelectionWorker(){this.selectionWorker.addEventListener("message",e=>{e.data.type==="selectionSpectrum"&&this.applySelectionSpectrumResult(e.data)}),this.selectionWorker.addEventListener("error",e=>{e.preventDefault(),this.selectionSpectrumRunning=!1,this.resetSelectionWorker(),this.setStatus(e.message||"Selection analysis failed.","error")},{once:!0})}enqueueLoad(e){let a=this.loadQueue.then(()=>this.load(e));return this.loadQueue=a.catch(t=>{let i=t instanceof Error?t.message:String(t);this.setStatus(i,"error")}),this.loadQueue}recoverAnalysisWorker(e){this.worker.terminate(),this.worker=N(),this.bindAnalysisWorker(),this.workerLoadedChannels.clear(),this.pendingAnalysisKeys.clear(),this.pendingAnalysisTargets.clear(),this.pendingAnalysisProfiles.clear(),this.setStatus(e,"error")}syncPlatformShortcuts(){let e=Q()?"\u2318":"Ctrl",a=Q()?"\u2325":"Alt",t=Q()?"\u2318":"Ctrl";document.querySelectorAll("[data-time-zoom-modifier]").forEach(i=>{i.textContent=e}),document.querySelectorAll("[data-amplitude-zoom-modifier]").forEach(i=>{i.textContent=a}),document.querySelectorAll("[data-command-modifier]").forEach(i=>{i.textContent=t})}applyLanguage(e){let a=ia(e.language,e.vscodeLanguage);this.currentLocale=a,this.messages=ue(a),la(document,this.messages),this.elements.headerInfoPanel.hidden||(this.renderHeaderInfo(),this.positionHeaderInfoPanel()),this.refreshPcmStatusTexts(),this.updateResetViewButtonState(),this.updateTrackLabels(),this.redrawVisuals()}resetWorkerSampleStore(){this.workerLoadedChannels.clear(),this.worker.postMessage({type:"clearSamples"})}resetSelectionWorker(){this.selectionWorker.terminate(),this.selectionWorker=N(),this.bindSelectionWorker()}cancelSelectionSpectrumAnalysis(){this.selectionSpectrumTimer!==void 0&&(window.clearTimeout(this.selectionSpectrumTimer),this.selectionSpectrumTimer=void 0),this.selectionSpectrumRequestSeq+=1,this.currentSelectionSpectrumRequestId=void 0,this.selectionSpectrumRunning&&(this.selectionSpectrumRunning=!1,this.resetSelectionWorker())}clearDecodedAudio(){this.cancelSelectionSpectrumAnalysis(),this.pendingSelectionWavDownloads.clear(),this.audioBuffer=void 0,this.sourceSampleRate=void 0,this.clearAudioElement(),this.spectrogramCache.clear(),this.spectrogramBitmapCache.clear(),this.spectrogramRangeCache.clear(),this.lastSpectrogramByChannel.clear(),this.clearWaveformCache(),this.channelPeakCache.clear(),this.pendingAnalysisKeys.clear(),this.pendingAnalysisTargets.clear(),this.resetWorkerSampleStore(),this.trackViews=[],this.elements.trackList.replaceChildren(),this.elements.figures.classList.remove("isFirstTrackSelectedAtTop"),this.elements.seek.value="0",this.updateClock()}clearAudioElement(){this.stopBufferSource(),this.stopPlaybackTicker(),this.bufferPlaybackPaused=!0,this.bufferPlaybackOffset=0,this.bufferPlaybackStartedAt=0,this.elements.audio.pause(),this.elements.audio.removeAttribute("src"),this.elements.audio.load(),this.elements.play.textContent="\u25B6"}async load(e){this.currentFileName=e.fileName,this.currentSourceLabel=e.sourceKind==="ark"&&e.sourceOffset!==void 0?` \xB7 ${this.messages.arkOffsetLabel} ${e.sourceOffset}`:"";let a=`${e.fileName} \xB7 ${de(e.size)}${this.currentSourceLabel}`;if(this.elements.fileMeta.textContent=a,this.elements.fileMeta.title=a,this.audioBytes=void 0,this.stopPlaybackTicker(),this.clearDecodedAudio(),this.elements.play.textContent="\u25B6",!e.trusted){this.setStatus(this.messages.workspaceNotTrusted);return}if(!this.config)return;let t=this.config.maxFileSizeMB*1024*1024;if(e.size>t){this.setStatus(`${this.messages.fileTooLarge}: ${de(e.size)} / ${this.config.maxFileSizeMB} MB`);return}if(this.setStatus(this.messages.readingAudio),this.audioBytes=await this.readAll(e.size),rn(this.audioBytes)){this.clearDecodedAudio(),this.setStatus(`${this.messages.encodedPlaybackOnly} ${this.messages.emptyWavNoAudio}`,"error");return}if(this.setStatus(e.kind==="pcm"?this.messages.waitingPcmParams:this.messages.decodingAudio),this.elements.pcmReveal.hidden=e.kind==="pcm"||e.extension!=="wav"||e.sourceKind==="ark",this.elements.headerInfo.hidden=!this.audioHasHeaderInfo(e),this.elements.headerInfoPanel.hidden=!0,this.elements.wavPcmPanel.hidden=!0,e.kind==="pcm"){if(!await this.loadPcm(e))return}else if(await this.loadEncoded(e.fileName),!this.audioBuffer){this.settings.channel=0,this.selection=void 0,this.playheadTime=void 0,this.dragPlayheadTime=void 0,this.selectionPlaybackEnd=void 0,this.updateSelectionAnalysis(),this.redrawVisuals();return}this.settings.channel=0,this.spectrogramCache.clear(),this.spectrogramBitmapCache.clear(),this.spectrogramRangeCache.clear(),this.lastSpectrogramByChannel.clear(),this.clearWaveformCache(),this.selection=void 0,this.playheadTime=void 0,this.dragPlayheadTime=void 0,this.selectionPlaybackEnd=void 0,this.updateSelectionAnalysis(),this.populateChannels(),this.renderTrackList(),this.applyAutoBrightness(),this.redrawVisuals(),this.focusDefaultPlot(),this.config.autoAnalyze&&this.scheduleAnalyze(0),this.setStatus(this.messages.ready)}async loadEncoded(e){if(!this.audioBytes)return;let a=Ee(this.audioBytes,e);if(this.elements.pcmPanel.hidden=!0,this.elements.wavPcmPanel.hidden=!0,e.toLowerCase().endsWith(".wav")&&await this.tryLoadWavePcmDirectly(e))return;let t=me(a.sampleRate)?new AudioContext({sampleRate:a.sampleRate}):new AudioContext;try{this.audioBuffer=await ma(t,this.audioBytes,ca),this.sourceSampleRate=a.sampleRate??this.audioBuffer.sampleRate,this.installAudioElementFromBuffer(e)}catch(i){if(console.warn("AudioLens encoded decode fallback:",i),await t.close().catch(()=>{}),await this.tryLoadWavePcmDirectly(e))return;await this.loadEncodedViaFfmpeg(e);return}finally{await t.close().catch(()=>{})}}async loadEncodedViaFfmpeg(e){this.setStatus(this.messages.transcodingAudio);try{let a=await this.requestTranscodedAudio(),t=new AudioContext;try{try{this.audioBuffer=await ma(t,a,ca),this.sourceSampleRate=this.audioBuffer.sampleRate}catch(i){if(console.warn("AudioLens FFmpeg WAV decode fallback:",i),!this.loadWavePcmBytes(a,t))throw i}}finally{await t.close().catch(()=>{})}this.installAudioElementFromBuffer(`${e}.wav`)}catch(a){console.warn("AudioLens FFmpeg fallback failed:",a),this.clearDecodedAudio();let t=a instanceof Error?a.message:String(a);this.setStatus(`${this.messages.encodedPlaybackOnly} ${t}`)}}async tryLoadWavePcmDirectly(e){if(!this.audioBytes)return!1;try{let a=new AudioContext;try{if(!this.loadWavePcmBytes(this.audioBytes,a))return!1}finally{await a.close().catch(()=>{})}return this.installAudioElementFromBuffer(e),!0}catch(a){return console.warn("AudioLens direct WAV PCM decode failed:",a),this.clearDecodedAudio(),!1}}loadWavePcmBytes(e,a){let t=nn(e);if(!t||t.bytes.byteLength===0)return!1;let i=pe(t.bytes,t.format);return this.audioBuffer=he(a,i),this.sourceSampleRate=i.sampleRate,!0}async loadPcm(e){return this.audioBytes?(this.elements.pcmPanel.hidden=!1,this.elements.pcmReveal.hidden=!0,this.elements.wavPcmPanel.hidden=!0,this.clearDecodedAudio(),this.setPcmPanelCollapsed(!1),this.defaultPcmFormat?(this.writePcmControls(this.defaultPcmFormat),this.setPcmStatus(this.elements.pcmStatus,this.messages.pcmUsedDefaultParams),await this.applyPcmFormat(this.defaultPcmFormat),!0):(this.writePcmControls(this.readPcmControls()),this.setPcmStatus(this.elements.pcmStatus,this.messages.pcmFillParams),!1)):!1}bindUi(){this.elements.play.addEventListener("click",()=>{this.togglePlayback()}),this.elements.downloadAudio.addEventListener("click",()=>{this.downloadCurrentAudio()}),this.elements.audio.addEventListener("play",()=>{this.elements.play.textContent="\u23F8",this.startPlaybackTicker()}),this.elements.audio.addEventListener("pause",()=>{this.elements.play.textContent="\u25B6",this.stopPlaybackTicker(),this.syncPlaybackState({redraw:!0})}),this.elements.audio.addEventListener("loadedmetadata",()=>{this.updateClock(),this.setStatus(this.messages.audioLoaded)}),this.elements.audio.addEventListener("error",()=>{let a=this.elements.audio.error?.message||this.messages.audioCannotPlay;if(this.audioBuffer){this.setStatus(`${this.messages.playbackFailed}: ${a}`,"error");return}this.reportPlaybackError(a)}),this.elements.audio.addEventListener("timeupdate",()=>{this.syncPlaybackState({redraw:this.playbackFrameId===void 0})}),this.elements.seek.addEventListener("input",()=>{let a=this.audioBuffer?.duration??this.elements.audio.duration;Number.isNaN(a)||(this.selectionPlaybackEnd=void 0,this.setPlaybackPosition(Number(this.elements.seek.value)/1e3*a),this.updateClock(),this.redrawVisuals())}),this.elements.settingsToggle.addEventListener("click",()=>{this.elements.settingsPanel.hidden=!this.elements.settingsPanel.hidden,this.elements.settingsPanel.hidden||(this.helpMenuElement().open=!1)}),this.elements.helpMenu.addEventListener("toggle",()=>{this.helpMenuElement().open&&(this.elements.settingsPanel.hidden=!0)}),this.elements.pcmReveal.addEventListener("click",()=>{this.showWavPcmPanel()}),this.elements.headerInfo.addEventListener("click",()=>{this.toggleHeaderInfoPanel()}),this.elements.headerInfoClose.addEventListener("click",()=>{this.hideHeaderInfoPanel()}),this.elements.wavPcmApply.addEventListener("click",()=>{this.applyWavPcmFormat()}),this.elements.wavPcmCancel.addEventListener("click",()=>{this.hideWavPcmPanel()}),this.elements.pcmPanel.addEventListener("keydown",a=>{this.handlePcmPanelEnter(a,()=>this.applyPcmFormat(this.readPcmControls()))}),this.elements.pcmEdit.addEventListener("click",()=>{this.setPcmPanelCollapsed(!1)}),this.elements.wavPcmPanel.addEventListener("keydown",a=>{this.handlePcmPanelEnter(a,()=>this.applyWavPcmFormat())}),this.elements.selectionContextMenu.addEventListener("click",a=>{this.handleSelectionContextMenuClick(a)}),document.addEventListener("pointerdown",a=>{this.closeFloatingMenusFromPointer(a)}),this.elements.defaultTrackMode.addEventListener("change",()=>{this.settings.defaultTrackMode=this.elements.defaultTrackMode.value,this.applyDefaultTrackModeToCurrentTracks(),this.savePreferencesSoon()}),this.elements.windowFunction.addEventListener("change",()=>{this.settings.windowFunction=this.elements.windowFunction.value,this.savePreferencesSoon(),this.analyze(),this.updateSelectionAnalysis()}),this.elements.fftSize.addEventListener("change",()=>{this.settings.fftSize=Number(this.elements.fftSize.value),this.settings.zeroPaddingFactor=L(this.settings.fftSize,this.settings.zeroPaddingFactor),this.syncControls(),this.savePreferencesSoon(),this.analyze(),this.updateSelectionAnalysis()}),this.elements.zeroPaddingFactor.addEventListener("change",()=>{this.settings.zeroPaddingFactor=L(this.settings.fftSize,Number(this.elements.zeroPaddingFactor.value)),this.elements.zeroPaddingFactor.value=String(this.settings.zeroPaddingFactor),this.savePreferencesSoon(),this.analyze()}),this.elements.channel.addEventListener("change",()=>{this.settings.channel=Number(this.elements.channel.value),this.clearWaveformCache(),this.analyze(),this.updateSelectionAnalysis(),this.redrawVisuals(),this.renderTrackSelection()}),this.elements.pcmEncoding.addEventListener("change",()=>{this.syncPcmEndiannessControl(this.elements.pcmEncoding,this.elements.pcmEndianness)}),this.elements.wavPcmEncoding.addEventListener("change",()=>{this.syncPcmEndiannessControl(this.elements.wavPcmEncoding,this.elements.wavPcmEndianness)}),this.elements.pcmApply.addEventListener("click",()=>{this.applyPcmFormat(this.readPcmControls())}),this.elements.pcmSaveDefault.addEventListener("click",()=>{this.saveDefaultPcmFormat()}),this.elements.pcmStatus.addEventListener("mouseenter",()=>{this.positionPcmStatusTooltip()}),this.elements.pcmStatus.addEventListener("focusin",()=>{this.positionPcmStatusTooltip()}),this.bindAnalysisTooltips(),this.elements.frequencyScale.addEventListener("change",()=>{this.settings.frequencyScale=this.elements.frequencyScale.value,this.savePreferencesSoon(),this.analyze()}),this.elements.spectrogramMaxFollowsNyquist.addEventListener("change",()=>{this.settings.spectrogramMaxFollowsNyquist=this.elements.spectrogramMaxFollowsNyquist.checked,this.settings.spectrogramMaxFollowsNyquist&&(this.settings.spectrogramMaxHz=Math.round(this.nyquistFrequency()),this.elements.spectrogramMaxHz.value=String(this.settings.spectrogramMaxHz)),this.updateSpectrogramFrequencySettings({syncDisplay:!0})}),this.elements.spectrogramMinHz.addEventListener("input",()=>this.updateSpectrogramFrequencySettings({source:"min"})),this.elements.spectrogramMaxHz.addEventListener("input",()=>this.updateSpectrogramFrequencySettings({source:"max"})),this.elements.spectrogramMinHz.addEventListener("blur",()=>this.syncControls()),this.elements.spectrogramMaxHz.addEventListener("blur",()=>this.syncControls()),this.elements.spectrogramMinHz.addEventListener("dblclick",()=>this.resetSpectrogramFrequencyRange()),this.elements.spectrogramMaxHz.addEventListener("dblclick",()=>this.resetSpectrogramFrequencyRange()),this.elements.palette.addEventListener("change",()=>{this.settings.palette=this.elements.palette.value,this.savePreferencesSoon(),this.analyze()}),this.elements.autoBrightness.addEventListener("change",()=>{this.settings.autoBrightness=this.elements.autoBrightness.checked,this.settings.autoBrightness&&this.applyAutoBrightness(),this.savePreferencesSoon()}),this.elements.amplitudeAuto.addEventListener("change",()=>{this.settings.amplitudeAuto=this.elements.amplitudeAuto.checked,this.savePreferencesSoon(),this.updateResetViewButtonState(),this.redrawVisuals()});let e=()=>{let a=Number(this.elements.amplitudeMinInput.value),t=Number(this.elements.amplitudeMaxInput.value);Number.isFinite(a)&&Number.isFinite(t)&&t>a&&(this.settings.amplitudeMin=a,this.settings.amplitudeMax=t,this.settings.amplitudeAuto=!1,this.elements.amplitudeAuto.checked=!1,this.savePreferencesSoon(),this.updateResetViewButtonState(),this.redrawVisuals())};this.elements.amplitudeMinInput.addEventListener("change",e),this.elements.amplitudeMaxInput.addEventListener("change",e);for(let a of this.analysisInputs())a.addEventListener("input",()=>this.updateAnalysisSettings());this.elements.analyze.addEventListener("click",()=>this.analyze()),this.elements.resetView.addEventListener("click",()=>this.resetView()),this.elements.trackList.addEventListener("scroll",()=>this.updateTimelineBoundaryState()),this.bindFigureInteraction(this.elements.waveform),this.bindFigureInteraction(this.elements.spectrogram),this.bindPlotResizer(this.elements.waveformResize,this.elements.waveformPane,"--waveform-height",T.waveformMin,T.waveformMax),this.bindPlotResizer(this.elements.spectrogramResize,this.elements.spectrogramPane,"--spectrogram-height",T.spectrogramMin,T.spectrogramMax),window.addEventListener("keydown",a=>this.onKeyDown(a)),window.addEventListener("resize",()=>{this.elements.wavPcmPanel.hidden||this.positionWavPcmPanel(),this.elements.headerInfoPanel.hidden||this.positionHeaderInfoPanel(),this.positionPcmStatusTooltip(),this.redrawVisuals(),this.scheduleAnalyze()})}async togglePlayback(){if(this.audioBuffer){await this.toggleBufferPlayback();return}if(!this.elements.audio.src){this.reportPlaybackError(this.messages.audioNotReady);return}try{this.elements.audio.paused?(this.ensurePlaybackGraph(),this.playbackAudioContext?.state==="suspended"&&await this.playbackAudioContext.resume(),await this.elements.audio.play()):(this.selectionPlaybackEnd=void 0,this.elements.audio.pause())}catch(e){let a=e instanceof Error?e.message:String(e);this.reportPlaybackError(a)}}async toggleBufferPlayback(){if(!this.audioBuffer){this.reportPlaybackError(this.messages.audioNotReady);return}try{this.bufferPlaybackPaused?(this.prepareBufferPlaybackStart(),await this.startBufferPlayback()):(this.selectionPlaybackEnd=void 0,this.pauseBufferPlayback())}catch(e){let a=e instanceof Error?e.message:String(e);this.reportPlaybackError(a)}}prepareBufferPlaybackStart(){if(!this.audioBuffer)return;if(this.selection){this.playheadTime=this.selection.start,this.selectionPlaybackEnd=this.selection.end,this.bufferPlaybackOffset=this.selection.start,this.redrawVisuals();return}let e=this.playheadTime===void 0?0:f(this.playheadTime,0,this.audioBuffer.duration),a=Math.max(0,this.audioBuffer.duration-1/this.audioBuffer.sampleRate),t=e>=a?0:e;this.playheadTime=t,this.bufferPlaybackOffset=t,this.redrawVisuals()}async startBufferPlayback(){if(!this.audioBuffer)return;this.playbackAudioContext||(this.playbackAudioContext=new AudioContext),this.playbackAudioContext.state==="suspended"&&await this.playbackAudioContext.resume(),this.stopBufferSource();let e=this.playbackAudioContext.createBufferSource();if(e.buffer=this.audioBuffer,e.onended=()=>{this.playbackBufferSourceNode===e&&this.finishBufferPlayback()},this.playbackBufferSourceNode=e,this.playbackSourceNode=e,this.bufferPlaybackStartedAt=this.playbackAudioContext.currentTime,this.bufferPlaybackPaused=!1,this.ensurePlaybackGraph(),this.selectionPlaybackEnd!==void 0){let a=Math.max(0,this.selectionPlaybackEnd-this.bufferPlaybackOffset);e.start(0,this.bufferPlaybackOffset,a)}else e.start(0,this.bufferPlaybackOffset);this.elements.play.textContent="\u23F8",this.startPlaybackTicker()}pauseBufferPlayback(){let e=this.currentPlaybackTime();this.stopBufferSource(),this.bufferPlaybackPaused=!0,this.bufferPlaybackOffset=e,this.playheadTime=e,this.elements.play.textContent="\u25B6",this.stopPlaybackTicker(),this.syncPlaybackState({redraw:!0})}finishBufferPlayback(){if(!this.audioBuffer)return;let e=this.selectionPlaybackEnd??this.audioBuffer.duration,a=this.selectionPlaybackEnd!==void 0;if(this.playbackBufferSourceNode=void 0,this.playbackSourceNode=void 0,this.bufferPlaybackPaused=!0,this.selectionPlaybackEnd=void 0,this.elements.play.textContent="\u25B6",this.stopPlaybackTicker(),a){this.bufferPlaybackOffset=f(e,0,this.audioBuffer.duration),this.playheadTime=this.bufferPlaybackOffset,this.syncPlaybackState({redraw:!0});return}this.bufferPlaybackOffset=0,this.playheadTime=void 0,this.dragPlayheadTime=void 0,this.elements.seek.value="0",this.updateClock(),this.redrawVisuals()}stopBufferSource(){let e=this.playbackBufferSourceNode;if(e){e.onended=null,this.playbackBufferSourceNode=void 0,this.playbackSourceNode===e&&(this.playbackSourceNode=void 0);try{e.stop()}catch{}e.disconnect()}}startPlaybackTicker(){if(this.playbackFrameId!==void 0)return;let e=()=>{this.syncPlaybackState({redraw:!0}),this.isPlaybackPaused()?this.playbackFrameId=void 0:this.playbackFrameId=requestAnimationFrame(e)};this.playbackFrameId=requestAnimationFrame(e)}stopPlaybackTicker(){this.playbackFrameId!==void 0&&(cancelAnimationFrame(this.playbackFrameId),this.playbackFrameId=void 0)}syncPlaybackState(e){let a=this.elements.audio,t=this.currentPlaybackTime(),i=this.audioBuffer?.duration??a.duration;if(this.selectionPlaybackEnd!==void 0&&t>=this.selectionPlaybackEnd){let r=this.selectionPlaybackEnd;this.selectionPlaybackEnd=void 0,this.audioBuffer?(this.stopBufferSource(),this.bufferPlaybackPaused=!0,this.bufferPlaybackOffset=r,this.elements.play.textContent="\u25B6"):(a.pause(),a.currentTime=r),this.playheadTime=r}else this.playheadTime=t;this.updateClock(),!Number.isNaN(i)&&i>0&&(this.elements.seek.value=String(this.currentPlaybackTime()/i*1e3)),this.followPlayheadDuringPlayback(),e.redraw&&this.redrawVisuals()}followPlayheadDuringPlayback(){if(!this.audioBuffer||this.playheadTime===void 0||this.isPlaybackPaused())return;let e=this.visibleRange(),a=this.audioBuffer.duration,t=e.endTime-e.startTime;if(t<=0||t>=a)return;let i=t*.12;if(this.selectionPlaybackEnd!==void 0&&this.playheadTime>=e.startTime&&this.playheadTime<=e.endTime){let s=this.selectionPlaybackEnd<=e.endTime,l=this.playheadTime<e.endTime-i;if(s||l)return}if(this.playheadTime<=e.endTime-i&&this.playheadTime>=e.startTime+i)return;let r=Math.max(0,a-t),o=f(this.playheadTime-t*.78,0,r);this.settings.timeOffset=r===0?0:o/r,this.syncControls(),this.scheduleAnalyze(0)}onKeyDown(e){if(!(en(e.target)&&!this.isTrackSidebarControl(e.target))){if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==="f"){e.preventDefault(),this.resetTimeZoom();return}e.code==="Space"&&(e.preventDefault(),this.togglePlayback()),e.code==="Escape"&&(e.preventDefault(),this.handleEscape())}}isTrackSidebarControl(e){return e instanceof HTMLElement&&e.closest(".trackSidebar")!==null}handleEscape(){if(!this.elements.freqScaleMenu.hidden){this.hideFreqScaleMenu();return}if(!this.elements.selectionContextMenu.hidden){this.hideSelectionContextMenu();return}if(!this.elements.settingsPanel.hidden){this.elements.settingsPanel.hidden=!0,this.elements.settingsToggle.focus();return}if(!this.elements.headerInfoPanel.hidden){this.hideHeaderInfoPanel(),this.elements.headerInfo.focus();return}if(this.helpMenuElement().open){this.helpMenuElement().open=!1,this.elements.helpMenu.querySelector("summary")?.focus();return}if(this.selection){this.selection=void 0,this.selectionPlaybackEnd=void 0,this.updateSelectionAnalysis(),this.redrawVisuals();return}this.audioBuffer?this.pauseBufferPlayback():(this.elements.audio.pause(),this.elements.audio.currentTime=0),this.playheadTime=void 0,this.bufferPlaybackOffset=0,this.dragPlayheadTime=void 0,this.selectionPlaybackEnd=void 0,this.elements.seek.value="0",this.updateClock(),this.redrawVisuals()}handlePcmPanelEnter(e,a){if(e.key!=="Enter"||e.metaKey||e.ctrlKey||e.altKey||e.shiftKey)return;let t=e.target;(t instanceof HTMLInputElement||t instanceof HTMLSelectElement)&&(e.preventDefault(),a())}closeFloatingMenusFromPointer(e){let a=e.target;a instanceof Node&&(!this.elements.settingsPanel.hidden&&!this.elements.settingsPanel.contains(a)&&!this.elements.settingsToggle.contains(a)&&(this.elements.settingsPanel.hidden=!0),this.helpMenuElement().open&&!this.elements.helpMenu.contains(a)&&(this.helpMenuElement().open=!1),!this.elements.selectionContextMenu.hidden&&!this.elements.selectionContextMenu.contains(a)&&this.hideSelectionContextMenu(),!this.elements.freqScaleMenu.hidden&&!this.elements.freqScaleMenu.contains(a)&&this.hideFreqScaleMenu(),!this.elements.headerInfoPanel.hidden&&!this.elements.headerInfoPanel.contains(a)&&!this.elements.headerInfo.contains(a)&&this.hideHeaderInfoPanel(),this.hideFloatingTooltip(),!this.elements.wavPcmPanel.hidden&&!this.elements.wavPcmPanel.contains(a)&&!this.elements.pcmReveal.contains(a)&&this.hideWavPcmPanel())}helpMenuElement(){return this.elements.helpMenu}toggleHeaderInfoPanel(){if(this.elements.headerInfo.hidden){this.hideHeaderInfoPanel();return}if(this.elements.headerInfoPanel.hidden){this.showHeaderInfoPanel();return}this.hideHeaderInfoPanel()}audioHasHeaderInfo(e){let a=e.extension.toLowerCase();return e.kind!=="pcm"&&a!=="pcm"&&a!=="raw"}showHeaderInfoPanel(){this.elements.settingsPanel.hidden=!0,this.helpMenuElement().open=!1,this.elements.wavPcmPanel.hidden=!0,this.renderHeaderInfo(),this.elements.headerInfoPanel.hidden=!1,this.positionHeaderInfoPanel()}hideHeaderInfoPanel(){this.elements.headerInfoPanel.hidden=!0}renderHeaderInfo(){if(this.elements.headerInfoTitle.textContent=`${this.messages.headerInfoTitle} \xB7 ${this.currentFileName||"--"}`,this.elements.headerInfoBody.replaceChildren(),!this.audioBytes){this.elements.headerInfoBody.append(this.createHeaderInfoEmpty(this.messages.headerInfoAudioUnread));return}let e=Ie(this.audioBytes,this.currentFileName);if(!e){this.elements.headerInfoBody.append(this.createHeaderInfoEmpty(this.messages.headerInfoUnsupported));return}this.elements.headerInfoTitle.textContent=`${this.messages.headerInfoTitle} \xB7 ${e.format}`,e.summary&&this.elements.headerInfoBody.append(this.createHeaderInfoSummary(e.summary)),this.elements.headerInfoBody.append(this.createHeaderInfoTable(e))}createHeaderInfoEmpty(e){let a=document.createElement("div");return a.className="headerInfoEmpty",a.textContent=e,a}createHeaderInfoSummary(e){let a=document.createElement("div");a.className=`headerInfoSummary is-${e.tone}`;let t=document.createElement("strong"),i=this.localizeHeaderSummary(e);if(t.textContent=i.text,a.append(t),i.detail){let r=document.createElement("span");r.textContent=i.detail,a.append(r)}return a}localizeHeaderSummary(e){if(e.kind!=="wavHeader")return{text:e.text,detail:e.detail};if(e.missingData)return{text:this.messages.headerInfoWavMissingData,detail:this.messages.headerInfoWavCannotDetermine};let a=e.headerSize??0,t=this.messages.headerInfoWavHeaderLength.replace("{size}",String(a));if(e.standard)return{text:t,detail:this.messages.headerInfoWavStandardPcm};let i=e.reasons?.map(o=>{switch(o.type){case"fmtExtended":return this.messages.headerInfoWavFmtExtended.replace("{size}",String(o.size));case"format":return this.messages.headerInfoWavFormat.replace("{format}",String(o.format)).replace("{name}",o.name);case"extraChunks":return this.messages.headerInfoWavExtraChunks.replace("{chunks}",o.chunks.join(", "));case"dataOffset":return this.messages.headerInfoWavDataOffsetNon44}})??[],r=i.length>0?`${this.messages.headerInfoWavNonStandardPrefix}: ${i.join(this.messages.headerInfoReasonSeparator)}`:`${this.messages.headerInfoWavNonStandardPrefix}: ${this.messages.headerInfoWavDataOffsetNon44}`;return{text:t,detail:r}}createHeaderInfoTable(e){let a=e.rows.some(l=>l.bits),t=document.createElement("table");t.className="headerInfoTable";let i=document.createElement("thead"),r=document.createElement("tr"),o=a?[[this.messages.headerInfoByteOffset,"offsetColumn"],[this.messages.headerInfoBits,"bitsColumn"],[this.messages.headerInfoField,"fieldColumn"],[this.messages.headerInfoValue,"valueColumn"],[this.messages.headerInfoDescription,"noteColumn"]]:[[this.messages.headerInfoOffset,"offsetColumn"],[this.messages.headerInfoSize,"sizeColumn"],[this.messages.headerInfoField,"fieldColumn"],[this.messages.headerInfoValue,"valueColumn"],[this.messages.headerInfoDescription,"noteColumn"]];for(let[l,d]of o){let c=document.createElement("th");c.className=d,c.textContent=l,r.append(c)}i.append(r),t.append(i);let s=document.createElement("tbody");for(let l of e.rows){let d=document.createElement("tr");l.kind&&(d.dataset.kind=l.kind);let c=a?[`0x${l.offset.toString(16).toUpperCase().padStart(8,"0")}`,l.bits??`${l.size*8} bit`,`${l.treePrefix?`${l.treePrefix} `:""}${l.field}`,l.value,this.localizeHeaderNote(l.note??"")]:[`0x${l.offset.toString(16).toUpperCase().padStart(8,"0")}`,`${l.size} B`,`${l.treePrefix?`${l.treePrefix} `:""}${l.field}`,l.value,this.localizeHeaderNote(l.note??"")];for(let p of c){let g=document.createElement("td");g.textContent=p,d.append(g)}let u=d.children[2];u&&l.depth!==void 0&&u.style.setProperty("--header-field-depth",String(l.depth)),s.append(d)}return t.append(s),t}localizeHeaderNote(e){return e?this.currentLocale==="zh-CN"?e:(Dt[this.currentLocale]??xe)[e]??xe[e]??e:""}positionHeaderInfoPanel(){let e=this.elements.headerInfo.getBoundingClientRect(),a=this.elements.headerInfoPanel,t=12,i=Math.min(680,window.innerWidth-t*2),r=f(e.right-i,t,Math.max(t,window.innerWidth-i-t));a.style.width=`${i}px`,a.style.left=`${r}px`,a.style.top=`${e.bottom+8}px`}bindAnalysisTooltips(){document.querySelectorAll(".analysisHelp, .metricHelp").forEach(e=>{e.addEventListener("mouseenter",()=>this.showFloatingTooltip(e)),e.addEventListener("focusin",()=>this.showFloatingTooltip(e)),e.addEventListener("mouseleave",()=>this.hideFloatingTooltip()),e.addEventListener("focusout",()=>this.hideFloatingTooltip())})}showFloatingTooltip(e){let a=e.dataset.tooltip;if(!a)return;let t=this.elements.floatingTooltip;t.textContent=a,t.hidden=!1,t.style.width="";let i=12,r=e.getBoundingClientRect(),o=t.getBoundingClientRect(),s=Math.min(o.width||380,window.innerWidth-i*2),l=f(r.left-s-10,i,Math.max(i,window.innerWidth-s-i)),d=r.top+r.height*.45-o.height*.45,c=f(d,i,Math.max(i,window.innerHeight-o.height-i));t.style.width=`${s}px`,t.style.left=`${l}px`,t.style.top=`${c}px`}hideFloatingTooltip(){this.elements.floatingTooltip.hidden=!0}reportPlaybackError(e){let a=`${this.messages.playbackFailed}: ${e}`;this.setStatus(a,"error"),this.vscode.postMessage({type:"showError",message:a})}downloadCurrentAudio(){if(!this.currentFileName){this.reportPlaybackError(this.messages.audioNotReady);return}this.vscode.postMessage({type:"downloadAudio"})}downloadSelectionAsWav(){if(!this.audioBuffer||!this.selection){this.reportPlaybackError(this.messages.noSelectionToDownload);return}let e=this.audioBuffer,a=f(Math.floor(this.selection.start*e.sampleRate),0,e.length),t=f(Math.ceil(this.selection.end*e.sampleRate),a,e.length);if(t<=a){this.reportPlaybackError(this.messages.noSelectionToDownload);return}let i=this.selectionWavFileName(this.selection.start,this.selection.end),r=this.selectionWavDownloadRequestSeq+1;this.selectionWavDownloadRequestSeq=r,this.pendingSelectionWavDownloads.set(r,{audioBuffer:e,startFrame:a,endFrame:t,fileName:i}),this.vscode.postMessage({type:"requestSelectionWavSave",requestId:r,fileName:i,saveLabel:this.messages.downloadSelection,title:this.messages.downloadSelectionWav})}writePendingSelectionWav(e){this.pendingSelectionWavDownloads.get(e)&&window.setTimeout(()=>{let t=this.pendingSelectionWavDownloads.get(e);t&&(this.pendingSelectionWavDownloads.delete(e),this.encodeAndWriteSelectionWav(e,t))},0)}async encodeAndWriteSelectionWav(e,a){let t=await Nt(a.audioBuffer,a.startFrame,a.endFrame),i=new Uint8Array(t),r=Math.max(1,Math.ceil(i.byteLength/be));for(let o=0;o<r;o+=1){let s=o*be,l=i.subarray(s,Math.min(i.byteLength,s+be));this.vscode.postMessage({type:"writeSelectionWavChunk",requestId:e,fileName:a.fileName,chunkIndex:o,bytesBase64:await Gt(l),isLast:o===r-1}),await ze()}}selectionWavFileName(e,a){return`${Vt(this.currentFileName||"audio")}_selection_${pa(e)}s-${pa(a)}s.wav`}clearSelection(){this.selection=void 0,this.selectionPlaybackEnd=void 0,this.updateSelectionAnalysis(),this.redrawVisuals()}syncControls(){this.elements.defaultTrackMode.value=this.settings.defaultTrackMode,this.elements.windowFunction.value=this.settings.windowFunction,this.elements.fftSize.value=String(this.settings.fftSize),this.elements.zeroPaddingFactor.value=String(this.settings.zeroPaddingFactor),this.elements.timeZoom.value=String(this.settings.timeZoom),this.elements.timeOffset.value=String(this.settings.timeOffset),this.elements.minDb.value=String(this.settings.minDb),this.elements.maxDb.value=String(this.settings.maxDb);let e=this.spectrogramFrequencyRange();this.elements.spectrogramMinHz.value=String(Math.round(e.minHz)),this.elements.spectrogramMaxHz.value=String(Math.round(e.maxHz)),this.elements.spectrogramMaxFollowsNyquist.checked=this.settings.spectrogramMaxFollowsNyquist,this.elements.autoBrightness.checked=this.settings.autoBrightness,this.elements.amplitudeAuto.checked=this.settings.amplitudeAuto,this.elements.amplitudeMinInput.value=String(this.settings.amplitudeMin),this.elements.amplitudeMaxInput.value=String(this.settings.amplitudeMax),this.elements.frequencyScale.value=this.settings.frequencyScale,this.elements.palette.value=this.settings.palette,this.updateResetViewButtonState()}analysisInputs(){return[this.elements.timeZoom,this.elements.timeOffset,this.elements.minDb,this.elements.maxDb]}updateAnalysisSettings(){this.settings.timeZoom=f(Number(this.elements.timeZoom.value),1,64),this.settings.timeOffset=f(Number(this.elements.timeOffset.value),0,1);let e=this.elements.minDb.value,a=this.elements.maxDb.value;if(!e||!a)return;let t=Number(e),i=Number(a);if(!Number.isFinite(t)||!Number.isFinite(i))return;let r=W(t,i);this.settings.minDb=r.minDb,this.settings.maxDb=r.maxDb,this.settings.autoBrightness=!1,this.elements.autoBrightness.checked=!1,this.updateSpectrogramFrequencySettings()}updateSpectrogramFrequencySettings(e={}){e.source==="max"&&(this.settings.spectrogramMaxFollowsNyquist=!1,this.elements.spectrogramMaxFollowsNyquist.checked=!1);let a=this.nyquistFrequency(),t=this.elements.spectrogramMinHz.value.trim(),i=this.elements.spectrogramMaxHz.value.trim(),r=Number(t),o=Number(i),s=this.spectrogramFrequencyRange(),l=t!==""&&Number.isFinite(r)?r:s.minHz,d=i!==""&&Number.isFinite(o)?o:s.maxHz,c=va(l,d,this.settings.spectrogramMaxFollowsNyquist,a);this.settings.spectrogramMinHz=c.minHz,this.settings.spectrogramMaxHz=c.storedMaxHz,this.savePreferencesSoon(),e.syncDisplay?this.syncControls():this.elements.spectrogramMaxFollowsNyquist.checked=this.settings.spectrogramMaxFollowsNyquist,this.redrawVisuals(),this.analyze()}resetSpectrogramFrequencyRange(){this.settings.spectrogramMinHz=0,this.settings.spectrogramMaxHz=Math.round(this.nyquistFrequency()),this.settings.spectrogramMaxFollowsNyquist=!0,this.savePreferencesSoon(),this.syncControls(),this.redrawVisuals(),this.analyze()}applyPreferences(e){if(e.defaultTrackMode&&(this.settings.defaultTrackMode=e.defaultTrackMode),e.windowFunction&&(this.settings.windowFunction=e.windowFunction),e.fftSize&&(this.settings.fftSize=we(e.fftSize)),e.zeroPaddingFactor&&(this.settings.zeroPaddingFactor=L(this.settings.fftSize,e.zeroPaddingFactor)),e.frequencyScale&&(this.settings.frequencyScale=e.frequencyScale),e.palette&&(this.settings.palette=e.palette),e.minDb!==void 0&&e.maxDb!==void 0){let a=W(e.minDb,e.maxDb);this.settings.minDb=a.minDb,this.settings.maxDb=a.maxDb}e.spectrogramMaxFollowsNyquist!==void 0&&(this.settings.spectrogramMaxFollowsNyquist=e.spectrogramMaxFollowsNyquist),e.spectrogramMinHz!==void 0&&(this.settings.spectrogramMinHz=e.spectrogramMinHz),e.spectrogramMaxHz!==void 0&&(this.settings.spectrogramMaxHz=e.spectrogramMaxHz),e.autoBrightness!==void 0&&(this.settings.autoBrightness=e.autoBrightness),e.amplitudeAuto!==void 0&&(this.settings.amplitudeAuto=e.amplitudeAuto),e.amplitudeMin!==void 0&&(this.settings.amplitudeMin=e.amplitudeMin),e.amplitudeMax!==void 0&&(this.settings.amplitudeMax=e.amplitudeMax),e.waveformHeight!==void 0&&this.setPlotHeight("--waveform-height",e.waveformHeight,T.waveformMin,T.waveformMax),e.spectrogramHeight!==void 0&&this.setPlotHeight("--spectrogram-height",e.spectrogramHeight,T.spectrogramMin,T.spectrogramMax),e.defaultTrackRowHeight!==void 0&&(this.settings.defaultTrackRowHeight=e.defaultTrackRowHeight),e.defaultTrackWaveFr!==void 0&&(this.settings.defaultTrackWaveFr=e.defaultTrackWaveFr),e.defaultTrackSpecFr!==void 0&&(this.settings.defaultTrackSpecFr=e.defaultTrackSpecFr),e.defaultPcmFormat&&(this.defaultPcmFormat=e.defaultPcmFormat),this.settings.zeroPaddingFactor=L(this.settings.fftSize,this.settings.zeroPaddingFactor)}savePreferencesSoon(){this.preferencesSaveTimer!==void 0&&window.clearTimeout(this.preferencesSaveTimer),this.preferencesSaveTimer=window.setTimeout(()=>{this.preferencesSaveTimer=void 0,this.vscode.postMessage({type:"updatePreferences",preferences:this.collectPreferences()})},180)}collectPreferences(){return{defaultTrackMode:this.settings.defaultTrackMode,windowFunction:this.settings.windowFunction,fftSize:this.settings.fftSize,zeroPaddingFactor:this.settings.zeroPaddingFactor,frequencyScale:this.settings.frequencyScale,palette:this.settings.palette,minDb:this.settings.minDb,maxDb:this.settings.maxDb,spectrogramMinHz:this.settings.spectrogramMinHz,spectrogramMaxHz:this.settings.spectrogramMaxHz,spectrogramMaxFollowsNyquist:this.settings.spectrogramMaxFollowsNyquist,autoBrightness:this.settings.autoBrightness,amplitudeAuto:this.settings.amplitudeAuto,amplitudeMin:this.settings.amplitudeMin,amplitudeMax:this.settings.amplitudeMax,defaultTrackRowHeight:this.settings.defaultTrackRowHeight,defaultTrackWaveFr:this.settings.defaultTrackWaveFr,defaultTrackSpecFr:this.settings.defaultTrackSpecFr,waveformHeight:this.getPlotHeight(this.elements.waveformPane),spectrogramHeight:this.getPlotHeight(this.elements.spectrogramPane),defaultPcmFormat:this.defaultPcmFormat}}applyAutoBrightness(){if(!this.settings.autoBrightness||!this.audioBuffer)return;let{minDb:e,maxDb:a}=this.computeAutoDbRange(),t=W(e,a);this.settings.minDb=Math.round(t.minDb*100)/100,this.settings.maxDb=Math.round(t.maxDb*100)/100,this.syncControls(),this.analyze()}computeAutoDbRange(){if(!this.audioBuffer)return{minDb:-96,maxDb:0};let e=Math.max(1,Math.ceil(this.audioBuffer.length/2e6)),a=0,t=0,i=0;for(let s=0;s<this.audioBuffer.numberOfChannels;s+=1){let l=this.audioBuffer.getChannelData(s),d=0,c=0,u=0;for(let g=0;g<l.length;g+=e){let h=l[g]??0;d+=h*h,c=Math.max(c,Math.abs(h)),u+=1}Math.sqrt(d/Math.max(1,u))<1e-8&&c<1e-8||(a+=d,t=Math.max(t,c),i+=u)}if(i===0)return{minDb:-96,maxDb:0};let r=C(Math.sqrt(a/Math.max(1,i))),o=C(t);return W(r-72,o-27)}resetView(){this.settings.timeZoom=1,this.settings.timeOffset=0,this.settings.amplitudeAuto=!0;for(let e of this.trackViews)e.ampRangeOverride=void 0;this.selection=void 0,this.selectionPlaybackEnd=void 0,this.hideSelectionBox(),this.syncControls(),this.savePreferencesSoon(),this.updateSelectionAnalysis(),this.redrawVisuals(),this.analyze()}resetTimeZoom(){this.settings.timeZoom=1,this.settings.timeOffset=0,this.syncControls(),this.savePreferencesSoon(),this.redrawVisuals(),this.analyze()}resolveChunk(e){let a=this.pendingChunks.get(e.requestId);a&&(this.pendingChunks.delete(e.requestId),window.clearTimeout(a.timeoutId),a.resolve(e))}rejectChunk(e){let a=this.pendingChunks.get(e.requestId);a&&(this.pendingChunks.delete(e.requestId),window.clearTimeout(a.timeoutId),a.reject(new Error(e.message)))}resolveTranscode(e){let a=this.pendingTranscodes.get(e.requestId);a&&(this.pendingTranscodes.delete(e.requestId),a.resolve(e))}rejectTranscode(e){let a=this.pendingTranscodes.get(e.requestId);a&&(this.pendingTranscodes.delete(e.requestId),a.reject(new Error(e.message)))}async readAll(e){let a=new Uint8Array(e),t=0;for(;t<e;){let i=Math.min(4194304,e-t),r=this.requestSeq;this.requestSeq+=1;let o=await new Promise((l,d)=>{let c=window.setTimeout(()=>{this.pendingChunks.delete(r),d(new Error(`Audio chunk request timed out at offset ${t}.`))},ct);this.pendingChunks.set(r,{resolve:l,reject:d,timeoutId:c}),this.vscode.postMessage({type:"readChunk",requestId:r,offset:t,length:i})}),s=new Uint8Array(o.bytes);if(o.offset!==t||o.total!==e)throw new Error("Audio file changed while it was being read.");if(s.byteLength===0||s.byteLength>i||t+s.byteLength>e)throw new Error(`Invalid audio chunk length at offset ${t}.`);a.set(s,t),t+=s.byteLength,this.setStatus(`${this.messages.readingAudioProgress} ${Math.round(t/e*100)}%`)}return a}async requestTranscodedAudio(){let e=this.requestSeq;this.requestSeq+=1;let a=await new Promise((t,i)=>{this.pendingTranscodes.set(e,{resolve:t,reject:i}),this.vscode.postMessage({type:"transcodeAudio",requestId:e})});return new Uint8Array(a.bytes)}installAudioElementFromBuffer(e){if(!this.audioBuffer)return;this.stopBufferSource(),this.bufferPlaybackPaused=!0,this.bufferPlaybackOffset=0,this.elements.audio.removeAttribute("src"),this.elements.audio.load(),this.elements.play.textContent="\u25B6",this.elements.seek.value="0",this.updateClock();let a=`${e} \xB7 ${this.audioBuffer.numberOfChannels}ch \xB7 ${this.audioBuffer.sampleRate} Hz${this.currentSourceLabel}`;this.elements.fileMeta.textContent=a,this.elements.fileMeta.title=a,this.setStatus(this.messages.audioLoaded)}async applyPcmFormat(e,a=this.elements.pcmStatus){if(!this.audioBytes)return!1;let t=fe(this.audioBytes,e);if(t)return this.setPcmStatus(a,t),a===this.elements.pcmStatus&&this.setPcmPanelCollapsed(!1),this.setStatus(t),!1;this.writePcmControls(e);let i=pe(this.audioBytes,e),r=new AudioContext({sampleRate:i.sampleRate});return this.audioBuffer=he(r,i),this.sourceSampleRate=i.sampleRate,await r.close(),this.settings.channel=0,this.spectrogramCache.clear(),this.spectrogramBitmapCache.clear(),this.spectrogramRangeCache.clear(),this.lastSpectrogramByChannel.clear(),this.clearWaveformCache(),this.channelPeakCache.clear(),this.resetWorkerSampleStore(),this.selection=void 0,this.selectionPlaybackEnd=void 0,this.playheadTime=void 0,this.installAudioElementFromBuffer(this.currentFileName),this.populateChannels(),this.renderTrackList(),this.applyAutoBrightness(),this.redrawVisuals(),this.config?.autoAnalyze&&this.scheduleAnalyze(0),this.setPcmStatus(a,this.formatPcmStatus({kind:"current",format:e}),{kind:"current",format:e}),a===this.elements.pcmStatus&&this.setPcmPanelCollapsed(!0),this.setStatus(this.messages.ready),!0}showWavPcmPanel(){this.audioBytes&&(this.elements.wavPcmPanel.hidden=!1,this.elements.pcmReveal.hidden=!0,this.writeWavPcmControls(this.suggestPcmFormatForCurrentFile()),this.setPcmStatus(this.elements.wavPcmStatus,this.messages.wavPcmFillParams),this.positionWavPcmPanel())}async applyWavPcmFormat(){await this.applyPcmFormat(this.readWavPcmControls(),this.elements.wavPcmStatus)&&this.hideWavPcmPanel()}hideWavPcmPanel(){this.elements.wavPcmPanel.hidden=!0,this.elements.pcmReveal.hidden=!1}positionWavPcmPanel(){let e=this.elements.pcmReveal.getBoundingClientRect(),a=this.elements.wavPcmPanel,t=12,i=Math.min(520,window.innerWidth-t*2),r=f(e.left,t,Math.max(t,window.innerWidth-i-t));a.style.width=`${i}px`,a.style.left=`${r}px`,a.style.top=`${e.bottom+8}px`}suggestPcmFormatForCurrentFile(){let e=this.readPcmControls();return{sampleRate:Math.max(1,Math.floor(this.audioBuffer?.sampleRate??e.sampleRate)),channels:Math.max(1,Math.floor(this.audioBuffer?.numberOfChannels??e.channels)),bitDepth:e.bitDepth,sampleFormat:e.sampleFormat,endianness:e.endianness,startOffsetBytes:this.findWaveDataOffset()??e.startOffsetBytes??0}}findWaveDataOffset(){let e=this.audioBytes;if(!e||e.byteLength<12||A(e,0,4)!=="RIFF"||A(e,8,4)!=="WAVE")return;let a=12;for(;a+8<=e.byteLength;){let t=A(e,a,4),i=ae(e,a+4),r=a+8;if(t==="data")return r;a=r+i+i%2}}saveDefaultPcmFormat(){let e=this.readPcmControls();if(this.audioBytes){let a=fe(this.audioBytes,e);if(a){this.setPcmStatus(this.elements.pcmStatus,a),this.setStatus(a);return}}this.defaultPcmFormat=e,this.vscode.postMessage({type:"updatePreferences",preferences:this.collectPreferences()}),this.setPcmStatus(this.elements.pcmStatus,this.formatPcmStatus({kind:"savedDefault",format:e}),{kind:"savedDefault",format:e}),this.setPcmPanelCollapsed(!0)}setPcmStatus(e,a,t){t?this.pcmStatusStates.set(e,t):this.pcmStatusStates.delete(e),e===this.elements.pcmStatus?(this.elements.pcmStatusText.textContent=a,this.positionPcmStatusTooltip()):e.textContent=a,e.dataset.tooltip=a}setPcmPanelCollapsed(e){e&&!this.pcmStatusStates.get(this.elements.pcmStatus)&&(e=!1),this.elements.pcmPanel.dataset.collapsed=String(e),this.elements.pcmEdit.hidden=!e}refreshPcmStatusTexts(){for(let e of[this.elements.pcmStatus,this.elements.wavPcmStatus]){let a=this.pcmStatusStates.get(e);a&&this.setPcmStatus(e,this.formatPcmStatus(a),a)}}formatPcmStatus(e){return`${e.kind==="current"?this.messages.currentPcmFormat:this.messages.savedDefaultPcmFormat}: ${tn(e.format)}`}positionPcmStatusTooltip(){let e=this.elements.pcmStatus.getBoundingClientRect();if(e.width<=0||e.height<=0)return;let a=12,t=Math.min(520,window.innerWidth-a*2),i=f(e.left,a,Math.max(a,window.innerWidth-t-a));this.elements.pcmStatus.style.setProperty("--pcm-status-tooltip-left",`${i}px`),this.elements.pcmStatus.style.setProperty("--pcm-status-tooltip-top",`${e.bottom+8}px`)}readPcmControls(){let e=this.elements.pcmEncoding.value,a=V(e),t=a.bitDepth===8?"none":this.elements.pcmEndianness.value==="none"?"little":this.elements.pcmEndianness.value;return{sampleRate:Math.max(1,Math.floor(Number(this.elements.pcmSampleRate.value)||16e3)),channels:Math.max(1,Math.floor(Number(this.elements.pcmChannels.value)||1)),...a,endianness:t,startOffsetBytes:Math.max(0,Math.floor(Number(this.elements.pcmStartOffset.value)||0))}}writePcmControls(e){this.elements.pcmSampleRate.value=String(e.sampleRate),this.elements.pcmChannels.value=String(e.channels),this.elements.pcmStartOffset.value=String(e.startOffsetBytes??0),this.elements.pcmEncoding.value=G(e),this.elements.pcmEndianness.value=e.endianness,this.syncPcmEndiannessControl(this.elements.pcmEncoding,this.elements.pcmEndianness)}readWavPcmControls(){let e=this.elements.wavPcmEncoding.value,a=V(e),t=a.bitDepth===8?"none":this.elements.wavPcmEndianness.value==="none"?"little":this.elements.wavPcmEndianness.value;return{sampleRate:Math.max(1,Math.floor(Number(this.elements.wavPcmSampleRate.value)||16e3)),channels:Math.max(1,Math.floor(Number(this.elements.wavPcmChannels.value)||1)),...a,endianness:t,startOffsetBytes:Math.max(0,Math.floor(Number(this.elements.wavPcmStartOffset.value)||0))}}writeWavPcmControls(e){this.elements.wavPcmSampleRate.value=String(e.sampleRate),this.elements.wavPcmChannels.value=String(e.channels),this.elements.wavPcmStartOffset.value=String(e.startOffsetBytes??0),this.elements.wavPcmEncoding.value=G(e),this.elements.wavPcmEndianness.value=e.endianness,this.syncPcmEndiannessControl(this.elements.wavPcmEncoding,this.elements.wavPcmEndianness)}syncPcmEndiannessControl(e,a){if(V(e.value).bitDepth===8){a.value="none",a.disabled=!0;return}a.disabled=!1,a.value==="none"&&(a.value="little")}populateChannels(){if(this.audioBuffer){this.elements.channel.replaceChildren();for(let e=0;e<this.audioBuffer.numberOfChannels;e+=1){let a=document.createElement("option");a.value=String(e),a.textContent=`CH ${e+1}`,this.elements.channel.appendChild(a)}this.settings.channel=Math.min(this.settings.channel,this.audioBuffer.numberOfChannels-1),this.elements.channel.value=String(this.settings.channel)}}renderTrackList(){if(this.elements.trackList.replaceChildren(),this.trackViews=[],!this.audioBuffer){this.elements.trackList.hidden=!0;return}this.elements.trackList.hidden=!1;for(let e=0;e<this.audioBuffer.numberOfChannels;e+=1)this.addTrackRow(e);this.renderTrackSelection()}addTrackRow(e){let a=document.createElement("div");a.className="trackRow",a.dataset.channel=String(e);let t=document.createElement("div");t.className="trackSidebar";let i=document.createElement("div");i.className="trackTitle",i.textContent=`CH ${e+1}`;let r=document.createElement("button");r.type="button",r.className="trackToggle trackMute",r.textContent=this.messages.mute;let o=document.createElement("button");o.type="button",o.className="trackToggle trackSolo",o.textContent=this.messages.solo;let s=document.createElement("select");s.className="trackMode",this.populateTrackModeOptions(s),s.value=this.settings.defaultTrackMode;let l=this.createTrackSlider("gain"),d=this.createTrackSlider("pan");t.append(i,r,o,s,l.control,d.control);let c=document.createElement("div");c.className="trackBody";let u=document.createElement("div");u.className="trackCanvasWrap trackWaveformWrap";let p=document.createElement("canvas");p.className="trackWaveform",p.dataset.channel=String(e),p.tabIndex=0,u.append(p);let g=document.createElement("div");g.className="trackCanvasWrap trackSpectrogramWrap";let h=document.createElement("canvas");h.className="trackSpectrogram",h.dataset.channel=String(e),h.tabIndex=0;let b=document.createElement("div");b.className="trackSplitHandle",g.append(h,b),c.append(u,g);let y=document.createElement("div");y.className="trackRowHandle",a.append(t,c,y);let k={channel:e,row:a,waveform:p,spectrogram:h,mode:this.settings.defaultTrackMode,muted:!1,solo:!1,gainDb:0,pan:0,gainSlider:l.input,panSlider:d.input,rowHeight:this.settings.defaultTrackRowHeight,waveFr:this.settings.defaultTrackWaveFr,specFr:this.settings.defaultTrackSpecFr},w=()=>this.selectChannel(e);p.addEventListener("click",w),h.addEventListener("click",w),r.addEventListener("click",()=>{this.toggleMute(k)}),o.addEventListener("click",()=>{this.toggleSolo(k)}),s.addEventListener("change",()=>{k.mode=s.value,this.applyTrackMode(k),this.redrawVisuals(),this.analyze()}),this.bindTrackSlider(k,l,{read:()=>f(Number(l.input.value),-ye,ye),apply:v=>{k.gainDb=v}}),this.bindTrackSlider(k,d,{read:()=>f(Number(d.input.value),-100,100)/100,apply:v=>{k.pan=v}}),this.syncTrackSliderHints(k),this.bindFigureInteraction(p),this.bindFigureInteraction(h),this.elements.trackList.append(a),this.trackViews.push(k),this.applyTrackMode(k),this.applyTrackLayout(k),this.bindTrackRowHandle(y,k),this.bindTrackSplitHandle(b,k)}applyTrackLayout(e){let{row:a}=e;a.style.setProperty("--track-row-h",`${e.rowHeight}px`),a.style.setProperty("--track-wave-fr",`${e.waveFr}fr`),a.style.setProperty("--track-spec-fr",`${e.specFr}fr`)}bindTrackRowHandle(e,a){let t=0,i=0,r,o=()=>{r=void 0,this.redrawVisuals()};e.addEventListener("pointerdown",s=>{s.button===0&&(s.preventDefault(),t=s.clientY,i=a.rowHeight,e.setPointerCapture(s.pointerId),document.body.classList.add("is-resizing"))}),e.addEventListener("pointermove",s=>{if(!e.hasPointerCapture(s.pointerId))return;let l=a.mode==="both"?ke:yt,d=Math.max(l,i+s.clientY-t);d!==a.rowHeight&&(a.rowHeight=d,this.applyTrackLayout(a),r===void 0&&(r=requestAnimationFrame(o)))}),e.addEventListener("pointerup",s=>{e.hasPointerCapture(s.pointerId)&&e.releasePointerCapture(s.pointerId),document.body.classList.remove("is-resizing"),r!==void 0&&(cancelAnimationFrame(r),r=void 0),this.redrawVisuals(),this.analyze()}),e.addEventListener("dblclick",()=>this.resetTrackLayout(a))}bindTrackSplitHandle(e,a){let t=0,i=0,r,o=()=>{r=void 0,this.redrawVisuals()};e.addEventListener("pointerdown",s=>{if(s.button!==0)return;s.preventDefault();let l=a.row.querySelector(".trackBody");if(!l)return;let d=l.getBoundingClientRect();t=d.top,i=d.height,e.setPointerCapture(s.pointerId),document.body.classList.add("is-resizing")}),e.addEventListener("pointermove",s=>{if(!e.hasPointerCapture(s.pointerId)||i<=0)return;let d=Math.min(Math.max(wa,s.clientY-t),i-Sa)/i,c=1-d;d!==a.waveFr&&(a.waveFr=d,a.specFr=c,this.applyTrackLayout(a),r===void 0&&(r=requestAnimationFrame(o)))}),e.addEventListener("pointerup",s=>{e.hasPointerCapture(s.pointerId)&&e.releasePointerCapture(s.pointerId),document.body.classList.remove("is-resizing"),r!==void 0&&(cancelAnimationFrame(r),r=void 0),this.redrawVisuals(),this.analyze()}),e.addEventListener("dblclick",()=>this.resetTrackLayout(a))}resetTrackLayout(e){e.rowHeight=this.settings.defaultTrackRowHeight,e.waveFr=this.settings.defaultTrackWaveFr,e.specFr=this.settings.defaultTrackSpecFr,this.applyTrackLayout(e),this.redrawVisuals(),this.analyze()}toggleSolo(e){let a=!e.solo;for(let t of this.trackViews)t.solo=a&&t===e;this.syncAllTrackToggleButtons(),this.updatePlaybackChannelGains()}toggleMute(e){e.muted=!e.muted;for(let a of this.trackViews)a.solo=!1;this.syncAllTrackToggleButtons(),this.updatePlaybackChannelGains()}syncAllTrackToggleButtons(){for(let e of this.trackViews)this.syncTrackToggleButtons(e)}updateTrackLabels(){for(let e of this.trackViews){e.row.querySelector(".trackMute")?.replaceChildren(document.createTextNode(this.messages.mute)),e.row.querySelector(".trackSolo")?.replaceChildren(document.createTextNode(this.messages.solo));let a=e.row.querySelector(".trackMode");if(a){let t=a.value;this.populateTrackModeOptions(a),a.value=t}this.syncTrackSliderHints(e)}}populateTrackModeOptions(e){let a=[["both",this.messages.viewBoth],["waveform",this.messages.waveform],["spectrogram",this.messages.spectrogram]];e.replaceChildren();for(let[t,i]of a){let r=document.createElement("option");r.value=t,r.textContent=i,e.appendChild(r)}}syncTrackToggleButtons(e){let t=this.trackViews.some(i=>i.solo)?!e.solo:e.muted;e.row.querySelector(".trackSolo")?.classList.toggle("isActive",e.solo),e.row.querySelector(".trackMute")?.classList.toggle("isActive",t)}createTrackSlider(e){let a=document.createElement("div");a.className=`trackSliderControl ${e==="gain"?"trackGainControl":"trackPanControl"}`;let t=document.createElement("span");t.className="trackSliderEnd trackSliderEndMin";let i=document.createElement("span");i.className="trackSliderEnd trackSliderEndMax";let r=document.createElement("span");r.className="trackSliderTrack";let o=document.createElement("span");o.className="trackSliderTicks";let s=document.createElement("input");s.type="range",s.className="trackSlider";let l=e==="gain"?ye:100;return s.min=String(-l),s.max=String(l),s.step="1",s.value="0",e==="gain"&&(t.textContent="\u2212",i.textContent="+"),r.append(o,s),a.append(t,r,i),{control:a,input:s}}bindTrackSlider(e,a,t){let{control:i,input:r}=a,o=()=>this.showTrackSliderTip(i);r.addEventListener("input",()=>{t.apply(t.read()),this.syncTrackSliderHints(e),this.updatePlaybackChannelGains(),o()}),r.addEventListener("dblclick",()=>{r.value="0",t.apply(0),this.syncTrackSliderHints(e),this.updatePlaybackChannelGains(),o()}),r.addEventListener("pointerenter",o),r.addEventListener("pointerleave",()=>{r.matches(":active")||this.hideFloatingTooltip()}),r.addEventListener("pointerup",()=>{i.matches(":hover")||this.hideFloatingTooltip()}),r.addEventListener("pointercancel",()=>this.hideFloatingTooltip()),r.addEventListener("blur",()=>this.hideFloatingTooltip())}syncTrackSliderHints(e){this.applyTrackSliderHint(e.gainSlider,this.messages.trackGain,this.formatTrackGain(e.gainDb)),this.applyTrackSliderHint(e.panSlider,this.messages.trackPan,this.formatTrackPan(e.pan));let a=e.panSlider.closest(".trackSliderControl");if(a){let t=a.querySelector(".trackSliderEndMin"),i=a.querySelector(".trackSliderEndMax");t&&(t.textContent=this.messages.panLeft),i&&(i.textContent=this.messages.panRight)}}applyTrackSliderHint(e,a,t){let i=e.closest(".trackSliderControl");i&&(i.dataset.tooltip=`${a} ${t}`),e.setAttribute("aria-label",a),e.setAttribute("aria-valuetext",t)}formatTrackGain(e){return`${e>0?"+":""}${e} dB`}formatTrackPan(e){return e===0?this.messages.panCenter:e<0?`${this.messages.panLeft} ${Math.round(-e*100)}%`:`${this.messages.panRight} ${Math.round(e*100)}%`}showTrackSliderTip(e){let a=e.dataset.tooltip;if(!a)return;let t=this.elements.floatingTooltip,i=document.createElement("span");i.className="sliderTipValue",i.textContent=a;let r=document.createElement("span");r.className="sliderTipHint",r.textContent=this.messages.doubleClickReset,t.replaceChildren(i,r),t.hidden=!1,t.style.width="max-content";let o=8,s=e.getBoundingClientRect(),l=t.getBoundingClientRect(),d=f(s.left+s.width/2-l.width/2,o,Math.max(o,window.innerWidth-l.width-o)),c=Math.max(o,s.top-l.height-8);t.style.left=`${d}px`,t.style.top=`${c}px`}selectChannel(e){this.settings.channel=f(e,0,Math.max(0,(this.audioBuffer?.numberOfChannels??1)-1)),this.elements.channel.value=String(this.settings.channel),this.renderTrackSelection(),this.updateSelectionAnalysis(),this.redrawVisuals(),this.analyze()}renderTrackSelection(){this.trackViews.forEach(e=>{e.row.classList.toggle("isSelected",e.channel===this.settings.channel)}),this.updateTimelineBoundaryState()}updateTimelineBoundaryState(){let e=this.settings.channel===0&&this.elements.trackList.scrollTop<=.5;this.elements.figures.classList.toggle("isFirstTrackSelectedAtTop",e)}applyTrackMode(e){e.row.dataset.mode=e.mode,e.mode==="both"&&e.rowHeight<ke&&(e.rowHeight=ke,this.applyTrackLayout(e))}applyDefaultTrackModeToCurrentTracks(){for(let e of this.trackViews){e.mode=this.settings.defaultTrackMode;let a=e.row.querySelector(".trackMode");a&&(a.value=e.mode),this.applyTrackMode(e)}this.redrawVisuals(),this.analyze()}focusDefaultPlot(){let e=this.trackViews.find(t=>t.channel===this.settings.channel)??this.trackViews[0];if(!e)return;let a=e.mode==="waveform"?e.waveform:e.spectrogram;requestAnimationFrame(()=>{a.focus({preventScroll:!0})})}samplesForActiveTrack(){return this.samplesForChannel(this.settings.channel)}samplesForChannel(e){if(this.audioBuffer)return this.audioBuffer.getChannelData(f(e,0,this.audioBuffer.numberOfChannels-1))}redrawVisuals(){this.updateResetViewButtonState(),this.syncTimelineScrollbarGutter();let e=this.visibleRange();this.elements.viewRange.textContent=this.messages.timeLabel,this.elements.viewRange.title=`${e.startTime.toFixed(3)}s - ${e.endTime.toFixed(3)}s`,this.drawTimeline(),this.drawTrackVisuals(),this.updatePersistentSelectionBox()}syncTimelineScrollbarGutter(){let e=Math.max(0,this.elements.trackList.offsetWidth-this.elements.trackList.clientWidth);this.elements.figures.style.setProperty("--timeline-scrollbar-gutter",`${e}px`)}drawTimeline(){let e=this.elements.timeline,a=B(e),t=this.visibleRange();if(a.clearRect(0,0,e.width,e.height),a.fillStyle=Y(),a.fillRect(0,0,e.width,e.height),!this.audioBuffer)return;let i=window.devicePixelRatio||1,r=this.getTimelinePlotRect(e);a.save(),a.fillStyle=J(),a.font=Se(),a.textBaseline="middle";let o=3*i,s=7*i,l=5*i,d=12*i,c=Math.max(1,e.height-o*2),u=Math.min(c,d+l+s),p=o+Math.max(0,(c-u)/2),g=p+d/2,h=p+d+l+s,b=Math.max(.001,t.endTime-t.startTime),y=Zt(b,r.width/i,92),k=Kt(y);a.strokeStyle=ga(),a.lineWidth=F(),a.beginPath(),a.moveTo(r.left,h),a.lineTo(r.right,h),a.stroke();let w=Math.ceil(t.startTime/k)*k;for(let v=w;v<=t.endTime+k*.5;v+=k){let M=this.timeToX(v,r,t),P=$t(v,y);a.strokeStyle=P?ga():jt(),a.lineWidth=P?F():Math.max(1,F()*.75),a.beginPath(),a.moveTo(M,h-(P?s:4*i)),a.lineTo(M,h),a.stroke(),P&&(a.fillStyle=J(),a.textAlign=r.right-M<40*i?"right":"center",a.fillText(Xt(v,y),M,g))}this.drawTimelinePlayhead(a,r,t),a.restore()}drawTimelinePlayhead(e,a,t){let i=this.dragPlayheadTime??this.playheadTime;if(i===void 0||i<t.startTime||i>t.endTime)return;let r=this.timeToX(i,a,t);e.strokeStyle="#ffcc66",e.fillStyle="#ffcc66",e.lineWidth=2*F(),e.beginPath(),e.moveTo(r,a.top),e.lineTo(r,a.bottom),e.stroke()}drawTrackVisuals(){if(this.audioBuffer)for(let e of this.trackViews)e.mode!=="spectrogram"&&this.drawChannelWaveform(e.waveform,e.channel),e.mode!=="waveform"&&this.drawSpectrogramForView(e)}drawSpectrogramForView(e){let a=this.spectrogramCache.get(this.createSpectrogramCacheKey(e.channel,e.spectrogram));if(a)return this.drawSpectrogramCanvas(e.spectrogram,a);let t=this.compatibleSpectrogramLayers(e.channel);if(t.length>0)return this.drawSpectrogramCanvas(e.spectrogram,t[t.length-1],t.slice(0,-1));let i=this.lastSpectrogramByChannel.get(e.channel);if(i)return this.drawSpectrogramCanvas(e.spectrogram,i);this.drawEmptySpectrogram(e.spectrogram)}compatibleSpectrogramLayers(e){let a=this.visibleRange(),t=this.effectiveFrequencyScale(e),i=[];for(let[r,o]of this.spectrogramCache){let s=this.spectrogramRangeCache.get(r);!s||s.channel!==e||s.palette!==this.settings.palette||s.minDb!==this.settings.minDb||s.maxDb!==this.settings.maxDb||s.frequencyScale===t&&(s.endSample<=a.startSample||s.startSample>=a.endSample||i.push({result:o,hop:s.hopSize}))}return i.sort((r,o)=>o.hop-r.hop),i.map(r=>r.result)}drawChannelWaveform(e,a){if(!this.audioBuffer||!this.samplesForChannel(a))return;let i=B(e),r=this.visibleRange(),o=this.getPlotRect(e);i.clearRect(0,0,e.width,e.height),i.fillStyle=Y(),i.fillRect(0,0,e.width,e.height),this.drawPlotFrame(i,o),this.drawWaveformAxis(i,o,a);let s=this.getWaveformPeaks(a,r.startSample,r.endSample,Math.max(1,Math.floor(o.width))),l=this.effectiveAmplitudeRange(a),d=Math.max(1e-6,l.max-l.min),c=u=>f(o.bottom-(u-l.min)/d*o.height,o.top,o.bottom);i.fillStyle="#8cc8ff",i.strokeStyle="#8cc8ff",i.lineWidth=F(),i.beginPath(),i.moveTo(o.left,c(s.max[0]??0));for(let u=1;u<s.min.length;u+=1)i.lineTo(o.left+u,c(s.max[u]??0));for(let u=s.min.length-1;u>=0;u-=1)i.lineTo(o.left+u,c(s.min[u]??0));i.closePath(),i.fill(),i.stroke(),this.drawSelectionOverlay(i,o,r),this.drawPlayheadOverlay(i,o,r)}drawEmptySpectrogram(e){let a=B(e),t=this.getPlotRect(e);a.clearRect(0,0,e.width,e.height),a.fillStyle=Y(),a.fillRect(0,0,e.width,e.height),this.drawPlotFrame(a,t),this.drawFrequencyAxis(a,t,Number(e.dataset.channel??0))}scheduleAnalyze(e=40){if(this.analysisTimer!==void 0)return;let a=Math.max(0,e-(performance.now()-this.lastAnalyzeAt));if(a===0){this.analyze();return}this.analysisTimer=window.setTimeout(()=>{this.analysisTimer=void 0,this.analyze()},a)}analyze(){if(!this.audioBuffer)return;this.analysisTimer!==void 0&&(window.clearTimeout(this.analysisTimer),this.analysisTimer=void 0),this.lastAnalyzeAt=performance.now(),this.prefetchTimer!==void 0&&(window.clearTimeout(this.prefetchTimer),this.prefetchTimer=void 0);let e=this.trackViews.filter(a=>a.mode!=="waveform");if(e.length!==0){for(let a of e)this.analyzeChannel(a);this.pendingAnalysisKeys.size===0&&this.schedulePrefetch()}}spectrogramRequestPlan(e,a){B(e);let t=this.getPlotRect(e),i=window.devicePixelRatio||1,r=Math.max(360,Math.min(1800,Math.floor(t.width/i))),o=Wt(this.settings.fftSize*this.settings.zeroPaddingFactor),s=Math.max(1,o/2),l=Math.max(1,Math.floor(mt/(s*Float32Array.BYTES_PER_ELEMENT*2))),d=Math.min(r,l),c=Math.max(192,Math.min(900,Math.floor(t.height/i))),{startSample:u,endSample:p}=a??this.visibleRange(),g=this.audioBuffer?.length??0,h=Math.max(1,p-u),b=1;for(;b<h;)b*=2;let y=Math.max(1,Math.floor(b/4)),k=Math.floor(u/y)*y-y,w=Math.max(0,k),v=Math.max(w,Math.min(g,k+b+3*y)),M=Math.max(1,(b+3*y)/d),P=1;for(;P*2<=M;)P*=2;return{startSample:w,endSample:v,hopSize:P,outputBins:c,targetFrames:d}}ensureWorkerSamples(e,a){if(this.workerLoadedChannels.has(e))return;let t=a.slice();this.worker.postMessage({type:"loadSamples",channel:e,samples:t.buffer},[t.buffer]),this.workerLoadedChannels.add(e)}analyzeChannel(e){let a=this.spectrogramRequestPlan(e.spectrogram),t=this.createSpectrogramCacheKey(e.channel,e.spectrogram,a),i=this.spectrogramCache.get(t);if(i){this.touchSpectrogramCacheKey(t),this.drawSpectrogramCanvas(e.spectrogram,i);return}if(!this.pendingAnalysisKeys.has(t)){this.analysisGeneration+=1;for(let[r,o]of Array.from(this.pendingAnalysisTargets))o===e.channel&&(this.pendingAnalysisKeys.delete(r),this.pendingAnalysisTargets.delete(r),this.pendingAnalysisProfiles.delete(r));this.postSpectrogramRequest(e,a,t,!1)&&(this.setStatus(this.messages.analyzingSpectrogram),this.elements.analysisMeta.textContent=`${this.messages.algorithmFrequency} \xB7 ${an(this.settings.windowFunction,this.messages)} \xB7 ${this.settings.fftSize} \xB7 ${this.messages.pad} ${this.settings.zeroPaddingFactor} \xB7 ${this.settings.frequencyScale} \xB7 ${this.messages.hop} ${a.hopSize}`)}}postSpectrogramRequest(e,a,t,i){let r=this.samplesForChannel(e.channel);if(!r)return!1;this.ensureWorkerSamples(e.channel,r),this.pendingAnalysisKeys.add(t),this.pendingAnalysisTargets.set(t,e.channel),!i&&this.shouldProfileSpectrogram()&&this.pendingAnalysisProfiles.set(t,{channel:e.channel,startedAt:performance.now(),startSample:a.startSample,endSample:a.endSample,targetFrames:a.targetFrames,outputBins:a.outputBins});let o=this.effectiveFrequencyRange(e.channel),s=this.effectiveFrequencyScale(e.channel);return this.spectrogramRangeCache.set(t,{startSample:a.startSample,endSample:a.endSample,channel:e.channel,hopSize:a.hopSize,minHz:o.minHz,maxHz:o.maxHz,frequencyScale:s,palette:this.settings.palette,minDb:this.settings.minDb,maxDb:this.settings.maxDb}),this.worker.postMessage({type:"analyze",requestId:t,generation:this.analysisGeneration,channel:e.channel,prefetch:i,startSample:a.startSample,endSample:a.endSample,sampleRate:this.analysisSampleRate(),settings:{windowFunction:this.settings.windowFunction,fftSize:this.settings.fftSize,zeroPaddingFactor:this.settings.zeroPaddingFactor,outputBins:a.outputBins,hopSize:a.hopSize,minDb:this.settings.minDb,maxDb:this.settings.maxDb,minFrequencyHz:o.minHz,maxFrequencyHz:o.maxHz,frequencyScale:s,palette:this.settings.palette,profile:!i&&this.shouldProfileSpectrogram()}}),!0}schedulePrefetch(){this.prefetchTimer!==void 0&&window.clearTimeout(this.prefetchTimer),this.prefetchTimer=window.setTimeout(()=>{this.prefetchTimer=void 0,this.prefetchSpectrogramNeighbors()},160)}prefetchSpectrogramNeighbors(){if(!this.audioBuffer)return;let e=this.trackViews.filter(l=>l.mode!=="waveform");if(e.length===0||e.length>lt)return;let a=this.visibleRange(),t=Math.max(1,a.endSample-a.startSample),i=this.audioBuffer.length,r=Math.round(t*.5),o=Math.round(t*.25),s=[{startSample:a.startSample-r,endSample:a.endSample-r},{startSample:a.startSample+r,endSample:a.endSample+r},{startSample:a.startSample+o,endSample:a.endSample-o},{startSample:a.startSample-r,endSample:a.endSample+r}];for(let l of e)for(let d of s){let c=f(d.startSample,0,i),u=f(d.endSample,0,i);if(u-c<2)continue;let p=this.spectrogramRequestPlan(l.spectrogram,{startSample:c,endSample:u}),g=this.createSpectrogramCacheKey(l.channel,l.spectrogram,p);this.spectrogramCache.has(g)||this.pendingAnalysisKeys.has(g)||this.postSpectrogramRequest(l,p,g,!0)}}createSpectrogramCacheKey(e,a,t){let i=t??this.spectrogramRequestPlan(a),r=this.effectiveFrequencyRange(e);return Re({channel:e,startSample:i.startSample,endSample:i.endSample,fftSize:this.settings.fftSize,windowFunction:this.settings.windowFunction,zeroPaddingFactor:this.settings.zeroPaddingFactor,outputBins:i.outputBins,targetFrames:i.targetFrames,hopSize:i.hopSize,minDb:this.settings.minDb,maxDb:this.settings.maxDb,spectrogramMinHz:r.minHz,spectrogramMaxHz:r.maxHz,frequencyScale:this.effectiveFrequencyScale(e),palette:this.settings.palette})}touchSpectrogramCacheKey(e){let a=this.spectrogramCache.get(e);a&&(this.spectrogramCache.delete(e),this.spectrogramCache.set(e,a));let t=this.spectrogramBitmapCache.get(e);t&&(this.spectrogramBitmapCache.delete(e),this.spectrogramBitmapCache.set(e,t))}pruneSpectrogramCaches(){for(;this.spectrogramCache.size>da;){let e=this.spectrogramCache.keys().next().value;if(e===void 0)break;this.spectrogramCache.delete(e),this.spectrogramBitmapCache.delete(e)}for(;this.spectrogramBitmapCache.size>da;){let e=this.spectrogramBitmapCache.keys().next().value;if(e===void 0)break;this.spectrogramBitmapCache.delete(e)}}drawSpectrogramResult(e){if(!this.pendingAnalysisKeys.has(e.requestId)&&!this.spectrogramCache.has(e.requestId))return;this.spectrogramCache.delete(e.requestId),this.spectrogramCache.set(e.requestId,e),this.pruneSpectrogramCaches(),this.pendingAnalysisKeys.delete(e.requestId);let a=this.pendingAnalysisTargets.get(e.requestId);this.pendingAnalysisTargets.delete(e.requestId);let t=this.pendingAnalysisProfiles.get(e.requestId);this.pendingAnalysisProfiles.delete(e.requestId);for(let i of this.trackViews){let o=this.createSpectrogramCacheKey(i.channel,i.spectrogram)===e.requestId;if(!(e.prefetch&&!o)&&!(!o&&i.channel!==a)&&(this.lastSpectrogramByChannel.set(i.channel,e),i.mode!=="waveform")){let s=o?this.drawSpectrogramCanvas(i.spectrogram,e):this.drawSpectrogramForView(i);this.logSpectrogramProfile(e,s,t)}}this.pendingAnalysisKeys.size===0&&(this.setStatus(this.messages.ready),this.schedulePrefetch())}drawSpectrogramCanvas(e,a,t){let i=this.shouldProfileSpectrogram(),r=i?performance.now():0,o=B(e),s=this.getPlotRect(e),l=i?performance.now():0,d=this.spectrogramBitmapCache.has(a.requestId),c=i?performance.now():0,u=this.spectrogramBitmapForResult(a),p=i?performance.now():0;if(!u)return;let g=Number(e.dataset.channel??0);o.imageSmoothingEnabled=!1,o.clearRect(0,0,e.width,e.height),o.fillStyle=Y(),o.fillRect(0,0,e.width,e.height);let h=i?performance.now():0;for(let w of t??[]){let v=this.spectrogramBitmapForResult(w);v&&this.drawSpectrogramBitmap(o,v,s,w,g)}this.drawSpectrogramBitmap(o,u,s,a,g);let b=i?performance.now():0;this.drawPlotFrame(o,s),this.drawFrequencyAxis(o,s,g);let y=this.visibleRange();if(this.drawSelectionOverlay(o,s,y),this.drawPlayheadOverlay(o,s,y),!i)return;let k=performance.now();return{totalMs:k-r,setupMs:l-r,bitmapMs:p-c,bitmapDrawMs:b-h,overlayMs:k-b,bitmapCached:d}}shouldProfileSpectrogram(){return this.config?.profileSpectrogram===!0}logSpectrogramProfile(e,a,t){if(!this.shouldProfileSpectrogram()||!e.profile&&!a&&!t)return;let i=e.profile,r=t?performance.now()-t.startedAt:void 0;console.groupCollapsed(`[AudioLens] Spectrogram profile${t?` ch ${t.channel+1}`:""} ${e.width}x${e.height}`),console.table({"request round trip":z(r),"worker total":z(i?.totalMs),"worker setup":z(i?.setupMs),"worker fft":z(i?.fftMs),"worker rasterize":z(i?.rasterizeMs),"main draw total":z(a?.totalMs),"main canvas setup":z(a?.setupMs),"main bitmap upload":z(a?.bitmapMs),"main bitmap draw":z(a?.bitmapDrawMs),"main axes/overlays":z(a?.overlayMs),"bitmap cached":a?.bitmapCached??!1,frames:i?.frames??e.width,bins:i?.bins??e.height,"fft size":i?.fftSize??this.settings.fftSize,"window size":i?.windowSize??this.settings.fftSize,"hop size":i?.hopSize??"n/a",samples:i?.sampleCount??(t?t.endSample-t.startSample:"n/a"),"target frames":t?.targetFrames??"n/a","output bins":t?.outputBins??"n/a"}),console.groupEnd()}drawSpectrogramBitmap(e,a,t,i,r){let o=this.spectrogramRangeCache.get(i.requestId),s=this.visibleRange();if(!o){e.drawImage(a,t.left,t.top,t.width,t.height);return}let l=Math.max(1,o.endSample-o.startSample),d=Math.max(1,s.endSample-s.startSample),c=Math.max(o.startSample,s.startSample),u=Math.min(o.endSample,s.endSample);if(u<=c)return;let p=(c-o.startSample)/l*a.width,g=Math.max(1,(u-c)/l*a.width),h=t.left+(c-s.startSample)/d*t.width,b=Math.max(1,(u-c)/d*t.width),y=0,k=a.height,w=t.top,v=t.height,M=this.effectiveFrequencyRange(r),P=this.effectiveFrequencyScale(r);if((o.minHz!==M.minHz||o.maxHz!==M.maxHz)&&o.frequencyScale===P){let Ma=ka(M.maxHz,P,o.minHz,o.maxHz),xa=ka(M.minHz,P,o.minHz,o.maxHz),U=(1-Ma)*a.height,te=(1-xa)*a.height;if(te-U<.001)return;let Te=t.height/(te-U);if(y=f(U,0,a.height),k=f(te,0,a.height)-y,k<=0)return;w=t.top+(y-U)*Te,v=k*Te}e.drawImage(a,p,y,g,k,h,w,b,v)}spectrogramBitmapForResult(e){let a=this.spectrogramBitmapCache.get(e.requestId);if(a)return a;let t=document.createElement("canvas");t.width=e.width,t.height=e.height;let i=t.getContext("2d",{alpha:!1});if(!i)return;let r=new ImageData(new Uint8ClampedArray(e.pixels),e.width,e.height);return i.putImageData(r,0,0),this.spectrogramBitmapCache.set(e.requestId,t),this.pruneSpectrogramCaches(),t}visibleRange(){return this.audioBuffer?Fe({duration:this.audioBuffer.duration,sampleRate:this.audioBuffer.sampleRate,timeZoom:this.settings.timeZoom,timeOffset:this.settings.timeOffset}):{startSample:0,endSample:0,startTime:0,endTime:0}}updateClock(){let e=this.audioBuffer?.duration??this.elements.audio.duration,a=le(this.currentPlaybackTime()),t=le(Number.isFinite(e)?e:0);this.elements.clock.textContent=`${a} / ${t}`}currentPlaybackTime(){return this.audioBuffer?!this.bufferPlaybackPaused&&this.playbackAudioContext?f(this.bufferPlaybackOffset+this.playbackAudioContext.currentTime-this.bufferPlaybackStartedAt,0,this.audioBuffer.duration):f(this.playheadTime??this.bufferPlaybackOffset,0,this.audioBuffer.duration):this.elements.audio.currentTime||0}isPlaybackPaused(){return this.audioBuffer?this.bufferPlaybackPaused:this.elements.audio.paused}setPlaybackPosition(e){if(this.audioBuffer){let a=f(e,0,this.audioBuffer.duration),t=!this.bufferPlaybackPaused;this.stopBufferSource(),this.bufferPlaybackPaused=!t,this.bufferPlaybackOffset=a,this.playheadTime=a,t&&this.startBufferPlayback();return}this.elements.audio.currentTime=e}setStatus(e,a="info"){this.elements.status.textContent=e,this.elements.status.classList.toggle("isWarning",a==="warning"),this.elements.status.classList.toggle("isError",a==="error"),this.elements.status.hidden=!this.shouldShowStatus(e)}shouldShowStatus(e){return!(!e||e===this.messages.initializing||e===this.messages.ready||e===this.messages.audioLoaded)}updateResetViewButtonState(){let e=Math.abs(this.settings.timeZoom-1)>1e-6||Math.abs(this.settings.timeOffset)>1e-6||!this.settings.amplitudeAuto||this.trackViews.some(a=>a.ampRangeOverride)||!!this.selection;this.elements.resetView.classList.toggle("isProminent",e)}ensurePlaybackGraph(){this.playbackAudioContext||(this.playbackAudioContext=new AudioContext),!this.audioBuffer&&!this.playbackMediaSourceNode&&(this.playbackMediaSourceNode=this.playbackAudioContext.createMediaElementSource(this.elements.audio),this.playbackSourceNode=this.playbackMediaSourceNode),this.rebuildPlaybackChannelGraph(),this.updatePlaybackChannelGains(!0)}rebuildPlaybackChannelGraph(){if(!this.playbackAudioContext||!this.playbackSourceNode)return;this.playbackSourceNode.disconnect(),this.playbackSplitterNode?.disconnect(),this.playbackMergerNode?.disconnect();for(let a of this.playbackChannelGains)a.left.disconnect(),a.right.disconnect();if(!this.audioBuffer){this.playbackSourceNode.connect(this.playbackAudioContext.destination),this.playbackChannelGains=[],this.playbackSplitterNode=void 0,this.playbackMergerNode=void 0;return}let e=this.audioBuffer.numberOfChannels;this.playbackSplitterNode=this.playbackAudioContext.createChannelSplitter(e),this.playbackMergerNode=this.playbackAudioContext.createChannelMerger(2),this.playbackChannelGains=Array.from({length:e},()=>({left:this.playbackAudioContext.createGain(),right:this.playbackAudioContext.createGain()})),this.playbackSourceNode.connect(this.playbackSplitterNode),this.playbackChannelGains.forEach((a,t)=>{this.playbackSplitterNode?.connect(a.left,t),this.playbackSplitterNode?.connect(a.right,t),a.left.connect(this.playbackMergerNode,0,0),a.right.connect(this.playbackMergerNode,0,1)}),this.playbackMergerNode.connect(this.playbackAudioContext.destination)}updatePlaybackChannelGains(e=!1){let a=this.trackViews.some(r=>r.solo),t=this.trackViews.length>0?this.trackViews.filter(r=>a?r.solo:!r.muted).length:this.playbackChannelGains.length,i=t>0?1/t:0;this.playbackChannelGains.forEach((r,o)=>{let s=this.trackViews.find(p=>p.channel===o),l=s?a?s.solo:!s.muted:!0,d=s?.gainDb??0,c=s?.pan??0,u=l?i*Math.pow(10,d/20):0;this.setPlaybackGainValue(r.left,u*Math.min(1,1-c),e),this.setPlaybackGainValue(r.right,u*Math.min(1,1+c),e)})}setPlaybackGainValue(e,a,t){let i=this.playbackAudioContext;if(!i){e.gain.value=a;return}e.gain.cancelScheduledValues(i.currentTime),t||this.bufferPlaybackPaused?e.gain.value=a:e.gain.setTargetAtTime(a,i.currentTime,.02)}getWaveformPeaks(e,a,t,i){let r=`ch-${e}:${a}:${t}:${i}`,o=this.waveformCache.get(r);if(o)return this.waveformCache.delete(r),this.waveformCache.set(r,o),o;let s=this.samplesForChannel(e);if(!s||i<=0)return{min:new Float32Array(i),max:new Float32Array(i)};let l=He(s,a,t,i);return this.waveformCache.set(r,l),this.waveformCacheBytes+=l.min.byteLength+l.max.byteLength,this.pruneWaveformCache(),l}clearWaveformCache(){this.waveformCache.clear(),this.waveformCacheBytes=0}pruneWaveformCache(){for(;this.waveformCache.size>0&&(this.waveformCache.size>ht||this.waveformCacheBytes>pt);){let e=this.waveformCache.keys().next().value;if(e===void 0)break;let a=this.waveformCache.get(e);a&&(this.waveformCacheBytes-=a.min.byteLength+a.max.byteLength),this.waveformCache.delete(e)}}bindFigureInteraction(e){let a=0,t=!1,i,r=()=>{window.removeEventListener("pointermove",s),window.removeEventListener("pointerup",l),window.removeEventListener("pointercancel",o),window.removeEventListener("blur",o)},o=()=>{t&&(t=!1,i=void 0,r(),this.isDraggingSelection=!1,this.dragPlayheadTime=void 0,this.hideSelectionBox(),this.redrawVisuals())},s=d=>{!t||d.pointerId!==i||this.updateSelectionBox(e,a,d.clientX)},l=d=>{!t||d.pointerId!==i||(t=!1,i=void 0,r(),e.hasPointerCapture(d.pointerId)&&e.releasePointerCapture(d.pointerId),this.isDraggingSelection=!1,this.hideSelectionBox(),Math.abs(a-d.clientX)<dt?this.setPlayheadFromPointer(e,d.clientX):this.setSelectionFromPointer(e,a,d.clientX),this.dragPlayheadTime=void 0,this.drawTimeline())};e.addEventListener("contextmenu",d=>{let c=this.getPlotRect(e);if(e.classList.contains("trackSpectrogram")&&this.canvasClientX(e,d.clientX)<c.left){d.preventDefault(),this.showFreqScaleMenu(Number(e.dataset.channel??0),d.clientX,d.clientY);return}if(d.preventDefault(),this.selection){this.isPointerInsideSelection(e,d.clientX)?this.showSelectionContextMenu(d.clientX,d.clientY):this.clearSelection();return}this.resetView()}),e.addEventListener("dblclick",d=>{let c=this.getPlotRect(e);if(this.canvasClientX(e,d.clientX)>=c.left)return;let u=Number(e.dataset.channel??0);if(e.classList.contains("trackSpectrogram"))d.preventDefault(),this.resetChannelFreqOverrides(u);else if(e.classList.contains("trackWaveform")){d.preventDefault();let p=this.trackViews.find(g=>g.channel===u);p&&(p.ampRangeOverride=void 0,this.updateResetViewButtonState(),this.redrawVisuals())}}),e.addEventListener("wheel",d=>{this.handleWheel(d,e)},{passive:!1}),e.addEventListener("pointerdown",d=>{d.button===0&&(o(),t=!0,i=d.pointerId,this.isDraggingSelection=!0,this.selectionPlaybackEnd=void 0,a=d.clientX,this.setDragPlayheadFromPointer(e,a),e.setPointerCapture(d.pointerId),this.updateSelectionBox(e,a,d.clientX),window.addEventListener("pointermove",s),window.addEventListener("pointerup",l),window.addEventListener("pointercancel",o),window.addEventListener("blur",o))})}handleWheel(e,a){let t=Yt(e),i=Jt(e),r=Qt(e);if(!this.audioBuffer||!t&&!i&&!e.shiftKey&&!e.altKey&&!r)return;e.preventDefault();let o=this.getPlotRect(a);if(this.canvasClientX(a,e.clientX)<o.left){let s=Number(a.dataset.channel??0),l=this.trackViews.find(p=>p.channel===s),d=a.classList.contains("trackSpectrogram"),c=a.classList.contains("trackWaveform"),u=e.deltaY<0;if(l&&(t||i)){if(d){let p=this.nyquistFrequency(),g=this.axisFrequencyFromClientY(s,a,e.clientY),h=this.effectiveFrequencyRange(s),b=_({min:h.minHz,max:h.maxHz},g,u?.8:1.25,0,p);l.freqRangeOverride={minHz:b.min,maxHz:b.max},this.redrawVisuals(),this.scheduleAnalyze()}else if(c){let p=this.amplitudeBound(s);l.ampRangeOverride=_(this.effectiveAmplitudeRange(s),this.axisAmplitudeFromClientY(s,a,e.clientY),u?.8:1.25,-p,p),this.updateResetViewButtonState(),this.redrawVisuals()}return}if(l&&(e.shiftKey||r)){let p=e.shiftKey?e.deltaY>0?1:-1:j(e.deltaX,e.deltaMode)>0?1:-1;if(d){let g=this.nyquistFrequency(),h=this.effectiveFrequencyRange(s),b=re({min:h.minHz,max:h.maxHz},p*(h.maxHz-h.minHz)*.1,0,g);l.freqRangeOverride={minHz:b.min,maxHz:b.max},this.redrawVisuals(),this.scheduleAnalyze()}else if(c){let g=this.amplitudeBound(s),h=this.effectiveAmplitudeRange(s);l.ampRangeOverride=re(h,p*(h.max-h.min)*.1,-g,g),this.updateResetViewButtonState(),this.redrawVisuals()}return}return}if(t||i){let s=this.canvasXRatio(a,e.clientX),l=this.timeFromCanvasX(a,e.clientX),d=e.deltaY<0?1.25:.8;this.applyTimeZoom(this.settings.timeZoom*d,l,s),this.syncControls(),this.redrawVisuals(),this.scheduleAnalyze();return}if(e.shiftKey){let s=this.visibleRange(),l=this.audioBuffer.duration,d=e.deltaY>0?1:-1,c=s.endTime-s.startTime;this.panTime(d*c*.12,l),this.syncControls(),this.redrawVisuals(),this.scheduleAnalyze();return}if(r){let s=this.visibleRange(),l=s.endTime-s.startTime,d=j(e.deltaX,e.deltaMode);this.panTime(d/100*l*.12,this.audioBuffer.duration),this.syncControls(),this.redrawVisuals(),this.scheduleAnalyze();return}if(e.altKey&&a.classList.contains("trackWaveform")){e.preventDefault();let s=Number(a.dataset.channel??0),l=this.trackViews.find(d=>d.channel===s);if(l){let d=this.amplitudeBound(s),c=e.deltaY<0?.8:1.25;l.ampRangeOverride=_(this.effectiveAmplitudeRange(s),this.axisAmplitudeFromClientY(s,a,e.clientY),c,-d,d),this.redrawVisuals()}}}setPlayheadFromPointer(e,a){if(!this.audioBuffer)return;let t=this.timeFromCanvasX(e,a);this.selection=void 0,this.selectionPlaybackEnd=void 0,this.updateSelectionAnalysis(),this.playheadTime=f(t,0,this.audioBuffer.duration),this.dragPlayheadTime=void 0,this.setPlaybackPosition(this.playheadTime),this.updateClock(),this.redrawVisuals()}setDragPlayheadFromPointer(e,a){if(!this.audioBuffer)return;let t=this.timeFromCanvasX(e,a);this.dragPlayheadTime=f(t,0,this.audioBuffer.duration),this.drawTimeline(),this.isPlaybackPaused()&&this.drawTrackVisuals()}setSelectionFromPointer(e,a,t){if(!this.audioBuffer)return;let i=f(this.timeFromCanvasX(e,a),0,this.audioBuffer.duration),r=f(this.timeFromCanvasX(e,t),0,this.audioBuffer.duration),o={start:Math.min(i,r),end:Math.max(i,r)};o.end-o.start<.001||(this.selection=o,this.hideSelectionContextMenu(),this.playheadTime=o.start,this.dragPlayheadTime=void 0,this.selectionPlaybackEnd=this.isPlaybackPaused()?void 0:o.end,this.setPlaybackPosition(o.start),this.updateClock(),this.updateSelectionAnalysis(),this.redrawVisuals())}showSelectionContextMenu(e,a){let t=this.elements.selectionContextMenu;t.hidden=!1;let i=t.getBoundingClientRect(),r=8,o=f(e,r,Math.max(r,window.innerWidth-i.width-r)),s=f(a,r,Math.max(r,window.innerHeight-i.height-r));t.style.left=`${o}px`,t.style.top=`${s}px`,t.querySelector("button")?.focus()}isPointerInsideSelection(e,a){if(!this.selection||!this.audioBuffer)return!1;let t=f(this.timeFromCanvasX(e,a),0,this.audioBuffer.duration);return t>=this.selection.start&&t<=this.selection.end}hideSelectionContextMenu(){this.elements.selectionContextMenu.hidden=!0}handleSelectionContextMenuClick(e){let a=e.target;if(!(a instanceof HTMLElement))return;let t=a.closest("button[data-action]")?.dataset.action;if(t){if(this.hideSelectionContextMenu(),t==="download-selection"){this.downloadSelectionAsWav();return}t==="clear-selection"&&this.clearSelection()}}updateSelectionBox(e,a,t){let i=e.getBoundingClientRect(),r=this.getCssPlotRect(e),o=this.visibleSelectionPlotRects(),s=f(a-i.left,r.left,r.right),l=f(t-i.left,r.left,r.right),d=o.length>0?Math.min(...o.map(u=>u.top)):i.top+r.top,c=o.length>0?Math.max(...o.map(u=>u.bottom)):i.top+r.bottom;this.elements.selectionBox.hidden=!1,this.elements.selectionBox.classList.add("isDraggingSelection"),this.elements.selectionBox.style.left=`${i.left+Math.min(s,l)}px`,this.elements.selectionBox.style.top=`${d}px`,this.elements.selectionBox.style.width=`${Math.abs(s-l)}px`,this.elements.selectionBox.style.height=`${Math.max(1,c-d)}px`}updatePersistentSelectionBox(){if(this.isDraggingSelection)return;if(!this.selection||!this.audioBuffer){this.hideSelectionBox();return}let e=this.firstVisiblePlotCanvas();if(!e){this.hideSelectionBox();return}let a=e.getBoundingClientRect(),t=this.getCssPlotRect(e),i=this.visibleSelectionPlotRects(),r=this.visibleRange(),o=this.timeToX(this.selection.start,t,r),s=this.timeToX(this.selection.end,t,r),l=f(Math.min(o,s),t.left,t.right),d=f(Math.max(o,s),t.left,t.right);if(d<=t.left||l>=t.right||d-l<1||i.length===0){this.hideSelectionBox();return}let c=Math.min(...i.map(p=>p.top)),u=Math.max(...i.map(p=>p.bottom));this.elements.selectionBox.hidden=!1,this.elements.selectionBox.classList.remove("isDraggingSelection"),this.elements.selectionBox.style.left=`${a.left+l}px`,this.elements.selectionBox.style.top=`${c}px`,this.elements.selectionBox.style.width=`${d-l}px`,this.elements.selectionBox.style.height=`${Math.max(1,u-c)}px`}firstVisiblePlotCanvas(){for(let e of this.trackViews)for(let a of[e.waveform,e.spectrogram])if(a.offsetParent!==null&&a.getBoundingClientRect().width>0)return a}visibleSelectionPlotRects(){let e=[],a=this.elements.trackList.getBoundingClientRect();for(let t of this.trackViews){let i=[t.waveform,t.spectrogram];for(let r of i){if(r.offsetParent===null)continue;let o=r.getBoundingClientRect();if(o.width<=0||o.height<=0)continue;let s=this.getCssPlotRect(r),l=Math.max(o.top+s.top,a.top),d=Math.min(o.top+s.bottom,a.bottom);d>l&&e.push({top:l,bottom:d})}}return e}hideSelectionBox(){this.elements.selectionBox.classList.remove("isDraggingSelection"),this.elements.selectionBox.hidden=!0}bindPlotResizer(e,a,t,i,r){let o=0,s=0,l,d=()=>{l=void 0,this.redrawVisuals()};e.addEventListener("pointerdown",c=>{c.button===0&&(c.preventDefault(),o=c.clientY,s=a.getBoundingClientRect().height,e.setPointerCapture(c.pointerId),document.body.style.userSelect="none")}),e.addEventListener("pointermove",c=>{if(!e.hasPointerCapture(c.pointerId))return;let u=f(s+c.clientY-o,i,r);this.setPlotHeight(t,u,i,r),l===void 0&&(l=requestAnimationFrame(d))}),e.addEventListener("pointerup",c=>{e.hasPointerCapture(c.pointerId)&&e.releasePointerCapture(c.pointerId),document.body.style.userSelect="",l!==void 0&&(cancelAnimationFrame(l),l=void 0),this.redrawVisuals(),this.analyze(),this.savePreferencesSoon()})}setPlotHeight(e,a,t,i){this.elements.figures.style.setProperty(e,`${Math.round(f(a,t,i))}px`)}getPlotHeight(e){return Math.round(e.getBoundingClientRect().height)}updateSelectionAnalysis(){if(!this.audioBuffer||!this.selection){this.cancelSelectionSpectrumAnalysis(),this.elements.analysisStart.closest(".selectionAnalysisPane")?.setAttribute("hidden",""),this.setAnalysisValue(this.elements.analysisStart,"--"),this.setAnalysisValue(this.elements.analysisEnd,"--"),this.setAnalysisValue(this.elements.analysisDuration,"--"),this.setAnalysisValue(this.elements.analysisRms,"--"),this.setAnalysisValue(this.elements.analysisPeak,"--"),this.setAnalysisValue(this.elements.analysisDominant,"--"),this.setAnalysisValue(this.elements.analysisCrest,"--"),this.setAnalysisValue(this.elements.analysisClipping,"--"),this.setAnalysisValue(this.elements.analysisNoiseFloor,"--"),this.setAnalysisValue(this.elements.analysisCentroid,"--"),this.setAnalysisValue(this.elements.analysisZcr,"--"),this.renderFrequencyRows([]);return}this.elements.analysisStart.closest(".selectionAnalysisPane")?.removeAttribute("hidden");let e=this.samplesForActiveTrack();if(!e){this.cancelSelectionSpectrumAnalysis();return}let a=Math.floor(this.selection.start*this.audioBuffer.sampleRate),t=Math.min(e.length,Math.ceil(this.selection.end*this.audioBuffer.sampleRate)),i=cn(e,a,t,this.audioBuffer.sampleRate);this.setAnalysisValue(this.elements.analysisStart,`${this.selection.start.toFixed(3)}s`),this.setAnalysisValue(this.elements.analysisEnd,`${this.selection.end.toFixed(3)}s`),this.setAnalysisValue(this.elements.analysisDuration,`${(this.selection.end-this.selection.start).toFixed(3)}s`),this.setAnalysisValue(this.elements.analysisRms,Pe(C(i.rms))),this.setAnalysisValue(this.elements.analysisPeak,Pe(C(i.peak))),this.setAnalysisValue(this.elements.analysisDominant,this.selectionAnalysisCalculatingText(),!0),this.setAnalysisValue(this.elements.analysisCrest,Number.isFinite(i.crestDb)?`${i.crestDb.toFixed(1)} dB`:"--"),this.setAnalysisValue(this.elements.analysisClipping,`${i.clippingPercent.toFixed(3)}%`),this.setAnalysisValue(this.elements.analysisNoiseFloor,Pe(i.noiseFloorDb)),this.setAnalysisValue(this.elements.analysisCentroid,this.selectionAnalysisCalculatingText(),!0),this.setAnalysisValue(this.elements.analysisZcr,`${i.zeroCrossingRate.toFixed(1)}/s`),this.renderFrequencyRows(ve.map(r=>({label:this.messages[r.labelKey],percent:Number.NaN})),!0),this.scheduleSelectionSpectrumAnalysis(e,a,t)}setAnalysisValue(e,a,t=!1){e.textContent=a,e.classList.toggle("analysisValueLoading",t)}selectionAnalysisCalculatingText(){return this.messages.selectionAnalysisCalculating??this.messages.analyzingSpectrogram}scheduleSelectionSpectrumAnalysis(e,a,t){this.selectionSpectrumTimer!==void 0&&(window.clearTimeout(this.selectionSpectrumTimer),this.selectionSpectrumTimer=void 0),this.selectionSpectrumRunning&&(this.selectionSpectrumRunning=!1,this.resetSelectionWorker()),this.selectionSpectrumRequestSeq+=1;let i=`selection-spectrum-${this.selectionSpectrumRequestSeq}`;this.currentSelectionSpectrumRequestId=i,this.selectionSpectrumTimer=window.setTimeout(()=>{if(this.selectionSpectrumTimer=void 0,!this.selection||this.currentSelectionSpectrumRequestId!==i)return;let r=e.slice(a,t);this.currentSelectionSpectrumRequestId===i&&(this.selectionSpectrumRunning=!0,this.selectionWorker.postMessage({type:"selectionSpectrum",requestId:i,samples:r.buffer,sampleRate:this.analysisSampleRate(),fftSize:this.settings.fftSize,windowFunction:this.settings.windowFunction,bandLimits:ve.map(o=>({min:o.min,max:o.max}))},[r.buffer]))},wt)}applySelectionSpectrumResult(e){!this.selection||this.currentSelectionSpectrumRequestId!==e.requestId||(this.selectionSpectrumRunning=!1,this.currentSelectionSpectrumRequestId=void 0,this.setAnalysisValue(this.elements.analysisDominant,ba(e.dominantHz)),this.setAnalysisValue(this.elements.analysisCentroid,ba(e.centroidHz)),this.renderFrequencyRows(ve.map((a,t)=>({label:this.messages[a.labelKey],percent:e.bandPercents[t]??0}))))}renderFrequencyRows(e,a=!1){this.elements.analysisBands.replaceChildren();let t=e.length>0?e:[{label:this.messages.bands,percent:Number.NaN}];for(let i of t){let r=document.createElement("tr"),o=document.createElement("th"),s=document.createElement("td");o.textContent=i.label,s.textContent=a?this.selectionAnalysisCalculatingText():Number.isFinite(i.percent)?`${i.percent.toFixed(1)}%`:"--",s.classList.toggle("analysisValueLoading",a),r.append(o,s),this.elements.analysisBands.appendChild(r)}}analysisSampleRate(){return this.sourceSampleRate??this.audioBuffer?.sampleRate??1}nyquistFrequency(){return Math.max(1,this.analysisSampleRate()/2)}spectrogramFrequencyRange(){return va(this.settings.spectrogramMinHz,this.settings.spectrogramMaxHz,this.settings.spectrogramMaxFollowsNyquist,this.nyquistFrequency())}effectiveFrequencyScale(e){return this.trackViews.find(t=>t.channel===e)?.freqScaleOverride??this.settings.frequencyScale}effectiveFrequencyRange(e){let a=this.trackViews.find(i=>i.channel===e);if(a?.freqRangeOverride)return a.freqRangeOverride;let t=this.spectrogramFrequencyRange();return{minHz:t.minHz,maxHz:t.maxHz}}channelPeak(e){let a=this.channelPeakCache.get(e);if(a!==void 0)return a;let t=this.samplesForChannel(e),i=0;if(t){let r=Math.max(1,Math.ceil(t.length/1e6));for(let o=0;o<t.length;o+=r){let s=t[o]??0;Number.isFinite(s)&&(i=Math.max(i,Math.abs(s)))}}return this.channelPeakCache.set(e,i),i}autoAmplitudeRange(e){let a=this.channelPeak(e),t=f(a<=1e-6?1:a/.9,.001,1e6);return{min:-t,max:t}}effectiveAmplitudeRange(e){let a=this.trackViews.find(t=>t.channel===e);return a?.ampRangeOverride?a.ampRangeOverride:this.settings.amplitudeAuto?this.autoAmplitudeRange(e):{min:this.settings.amplitudeMin,max:this.settings.amplitudeMax}}amplitudeBound(e){return Math.max(1,this.channelPeak(e)*1.05)}axisAmplitudeFromClientY(e,a,t){let i=this.getPlotRect(a),r=a.getBoundingClientRect(),o=(t-r.top)*(a.height/Math.max(1,r.height)),s=f((i.bottom-o)/Math.max(1,i.height),0,1),{min:l,max:d}=this.effectiveAmplitudeRange(e);return l+s*(d-l)}axisFrequencyFromClientY(e,a,t){let i=this.getPlotRect(a),r=a.getBoundingClientRect(),o=(t-r.top)*(a.height/Math.max(1,r.height)),s=f((i.bottom-o)/Math.max(1,i.height),0,1),l=this.effectiveFrequencyRange(e);return ya(s,this.effectiveFrequencyScale(e),l.minHz,l.maxHz)}canvasClientX(e,a){let t=e.getBoundingClientRect();return(a-t.left)*(e.width/Math.max(1,t.width))}showFreqScaleMenu(e,a,t){let i=this.elements.freqScaleMenu,r=this.effectiveFrequencyScale(e),o=[["linear","Linear"],["log","Log"],["mel","Mel"],["bark","Bark"],["erb","ERB"]];i.replaceChildren();let s=document.createElement("div");s.className="contextMenuTitle",s.textContent=this.messages.freqScaleMenuTitle,i.appendChild(s);for(let[c,u]of o){let p=document.createElement("button");p.type="button",p.setAttribute("role","menuitemradio"),c===r&&p.classList.add("isChecked"),p.textContent=u,p.addEventListener("click",()=>{this.setChannelFreqScale(e,c),this.hideFreqScaleMenu()}),i.appendChild(p)}let l=document.createElement("button");l.type="button",l.setAttribute("role","menuitem"),l.textContent=this.messages.restoreChannelDefault,l.addEventListener("click",()=>{this.resetChannelFreqOverrides(e),this.hideFreqScaleMenu()}),i.appendChild(l),i.hidden=!1;let d=8;i.style.left=`${Math.min(a,window.innerWidth-i.offsetWidth-d)}px`,i.style.top=`${Math.min(t,window.innerHeight-i.offsetHeight-d)}px`}hideFreqScaleMenu(){this.elements.freqScaleMenu.hidden=!0}setChannelFreqScale(e,a){let t=this.trackViews.find(i=>i.channel===e);t&&(t.freqScaleOverride=a,this.redrawVisuals(),this.analyze())}resetChannelFreqOverrides(e){let a=this.trackViews.find(t=>t.channel===e);a&&(a.freqScaleOverride=void 0,a.freqRangeOverride=void 0,this.redrawVisuals(),this.analyze())}getPlotRect(e){if(e.classList.contains("trackWaveform")||e.classList.contains("trackSpectrogram")){let s=window.devicePixelRatio||1,l=ua*s,d=0,c=Math.max(l+1,e.width),u=Math.max(d+1,e.height);return{left:l,top:d,right:c,bottom:u,width:c-l,height:u-d}}let a=window.devicePixelRatio||1,t=$.left*a,i=$.top*a,r=Math.max(t+1,e.width-$.right*a),o=Math.max(i+1,e.height-$.bottom*a);return{left:t,top:i,right:r,bottom:o,width:r-t,height:o-i}}getCssPlotRect(e){let a=window.devicePixelRatio||1,t=this.getPlotRect(e),i=t.left/a,r=t.top/a,o=t.right/a,s=t.bottom/a;return{left:i,top:r,right:o,bottom:s,width:o-i,height:s-r}}drawPlotFrame(e,a){e.strokeStyle=Ut(),e.lineWidth=F(),e.strokeRect(a.left,a.top,a.width,a.height)}drawWaveformAxis(e,a,t){e.save(),e.fillStyle=J(),e.strokeStyle=fa(),e.font=Se(),e.textAlign="right";let{min:i,max:r}=this.effectiveAmplitudeRange(t),o=a.height/(window.devicePixelRatio||1),s=ie(o,{even:!0});for(let l=0;l<=s;l+=1){let d=l/s,c=r-d*(r-i),u=a.top+d*a.height;e.beginPath(),e.moveTo(a.left,u),e.lineTo(a.right,u),e.stroke(),l===0?(e.textBaseline="top",e.fillText(Me(c),a.left-x(6),a.top+x(2))):l===s?(e.textBaseline="bottom",e.fillText(Me(c),a.left-x(6),a.bottom-x(2))):(e.textBaseline="middle",e.fillText(Me(c),a.left-x(6),u))}e.restore()}drawFrequencyAxis(e,a,t){if(!this.audioBuffer)return;e.save(),e.fillStyle=J(),e.strokeStyle=fa(),e.font=Se(),e.textAlign="right";let i=this.effectiveFrequencyRange(t),r=a.height/(window.devicePixelRatio||1),o=ie(r);for(let s=0;s<=o;s+=1){let l=s/o,d=ya(l,this.effectiveFrequencyScale(t),i.minHz,i.maxHz),c=a.bottom-l*a.height;e.beginPath(),e.moveTo(a.left,c),e.lineTo(a.right,c),e.stroke(),s===o?(e.textBaseline="top",e.fillText(K(d),a.left-x(6),a.top+x(2))):s===0?(e.textBaseline="bottom",e.fillText(K(d),a.left-x(6),a.bottom-x(2))):(e.textBaseline="middle",e.fillText(K(d),a.left-x(6),c))}e.restore()}drawSelectionOverlay(e,a,t){if(!this.selection)return;let i=this.timeToX(this.selection.start,a,t),r=this.timeToX(this.selection.end,a,t),o=f(Math.min(i,r),a.left,a.right),s=f(Math.max(i,r),a.left,a.right);s<=a.left||o>=a.right||s-o<1||(e.save(),e.fillStyle="rgba(88, 166, 255, 0.18)",e.fillRect(o,a.top,s-o,a.height),e.restore())}drawPlayheadOverlay(e,a,t){let i=this.dragPlayheadTime??this.playheadTime;if(i===void 0||i<t.startTime||i>t.endTime)return;let r=this.timeToX(i,a,t);e.save(),e.strokeStyle="#ffcc66",e.lineWidth=2*F(),e.beginPath(),e.moveTo(r,a.top),e.lineTo(r,a.bottom),e.stroke(),e.restore()}timeToX(e,a,t){let i=Math.max(.001,t.endTime-t.startTime);return a.left+(e-t.startTime)/i*a.width}timeFromCanvasX(e,a){let t=this.visibleRange(),i=this.canvasXRatio(e,a);return t.startTime+i*(t.endTime-t.startTime)}canvasXRatio(e,a){let t=e.getBoundingClientRect(),i=this.getPlotRect(e),r=(a-t.left)*(e.width/Math.max(1,t.width));return f((r-i.left)/i.width,0,1)}getTimelinePlotRect(e){let a=window.devicePixelRatio||1,t=ua*a,i=0,r=Math.max(t+1,e.width),o=Math.max(i+1,e.height);return{left:t,top:i,right:r,bottom:o,width:r-t,height:o-i}}applyTimeZoom(e,a,t){if(!this.audioBuffer)return;let i=this.audioBuffer.duration;this.settings.timeZoom=f(e,1,64);let r=i/this.settings.timeZoom,o=Math.max(0,i-r),s=f(a-t*r,0,o);this.settings.timeOffset=o===0?0:s/o}panTime(e,a){let t=a/this.settings.timeZoom,i=Math.max(0,a-t),r=i*this.settings.timeOffset,o=f(r+e,0,i);this.settings.timeOffset=i===0?0:o/i}};function qt(n){let e=new ArrayBuffer(n.byteLength);return new Uint8Array(e).set(n),e}function L(n,e){let a=Math.max(8,Math.floor(Number.isFinite(n)?n:512)),t=Math.max(1,Math.floor(Number.isFinite(e)?e:1)),i=Math.max(1,Math.floor(ut/a)),r=1;for(;r*2<=t&&r*2<=i;)r*=2;return r}function we(n){return ft.includes(n)?n:512}function Wt(n){let e=1;for(;e<n;)e*=2;return e}async function ma(n,e,a){let t;try{return await Promise.race([n.decodeAudioData(qt(e)),new Promise((i,r)=>{t=window.setTimeout(()=>{r(new Error(`decodeAudioData timed out after ${a} ms`))},a)})])}finally{t!==void 0&&window.clearTimeout(t)}}async function Nt(n,e=0,a=n.length){let t=n.numberOfChannels,i=n.sampleRate,r=f(Math.floor(e),0,n.length),s=f(Math.ceil(a),r,n.length)-r,l=2,d=t*l,c=s*d,u=new ArrayBuffer(44+c),p=new DataView(u);X(p,0,"RIFF"),p.setUint32(4,36+c,!0),X(p,8,"WAVE"),X(p,12,"fmt "),p.setUint32(16,16,!0),p.setUint16(20,1,!0),p.setUint16(22,t,!0),p.setUint32(24,i,!0),p.setUint32(28,i*d,!0),p.setUint16(32,d,!0),p.setUint16(34,16,!0),X(p,36,"data"),p.setUint32(40,c,!0);let g=Array.from({length:t},(y,k)=>n.getChannelData(k)),h=44,b=262144;for(let y=0;y<s;y+=1){let k=r+y;for(let w=0;w<t;w+=1){let v=f(g[w][k]??0,-1,1);p.setInt16(h,v<0?v*32768:v*32767,!0),h+=l}y>0&&y%b===0&&await ze()}return u}function ze(){return new Promise(n=>window.setTimeout(n,0))}function X(n,e,a){for(let t=0;t<a.length;t+=1)n.setUint8(e+t,a.charCodeAt(t))}function Vt(n){return n.replace(/\.[^/.\\]+$/,"").replace(/[<>:"/\\|?*\x00-\x1f]+/g,"_").replace(/\s+/g,"_").replace(/^_+|_+$/g,"")||"audio"}function pa(n){return Math.max(0,n).toFixed(3)}async function Gt(n){let a="";for(let t=0;t<n.length;t+=32768){let i=n.subarray(t,t+32768);a+=String.fromCharCode(...i),t>0&&t%(32768*128)===0&&await ze()}return btoa(a)}function Se(){return`${Math.round(gt*(window.devicePixelRatio||1))}px system-ui, sans-serif`}function R(n,e){return getComputedStyle(document.body).getPropertyValue(n).trim()||e}function Ot(n,e,a){let t=ha(n),i=ha(e);if(!t||!i)return n;let r=f(a,0,1),o=Math.round(t.red*r+i.red*(1-r)),s=Math.round(t.green*r+i.green*(1-r)),l=Math.round(t.blue*r+i.blue*(1-r));return`rgb(${o} ${s} ${l})`}function ha(n){let e=n.trim(),a=/^#([0-9a-f]{6})$/i.exec(e);if(a){let i=Number.parseInt(a[1],16);return{red:i>>16&255,green:i>>8&255,blue:i&255}}let t=/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(e);if(t)return{red:Number(t[1]),green:Number(t[2]),blue:Number(t[3])}}function Y(){return R("--vscode-editor-background","#1e1e1e")}function J(){return R("--vscode-descriptionForeground","#9aa7b4")}function fa(){return R("--vscode-panel-border","#25303a")}function ga(){return R("--vscode-descriptionForeground","#9aa7b4")}function jt(){return Ot(R("--vscode-descriptionForeground","#9aa7b4"),R("--vscode-editor-background","#1e1e1e"),.58)}function Ut(){return R("--vscode-panel-border","#2d3540")}function F(){return window.devicePixelRatio||1}function x(n){return n*(window.devicePixelRatio||1)}function Zt(n,e,a){let t=Math.max(1,Math.floor(e/a));return _t(n/t)}function Kt(n){let e=Math.floor(Math.log10(n)),t=n/Math.pow(10,e)===2?4:5;return n/t}function _t(n){let e=Math.max(.001,n),a=Math.floor(Math.log10(e)),t=e/Math.pow(10,a);return(t<=1?1:t<=2?2:t<=5?5:10)*Math.pow(10,a)}function $t(n,e){let a=Math.round(n/e)*e;return Math.abs(n-a)<=e*1e-4}function Xt(n,e){return e>=10?`${Math.round(n)}s`:e>=1?`${n.toFixed(1)}s`:e>=.01?`${n.toFixed(2)}s`:`${n.toFixed(3)}s`}function Yt(n){return Q()?n.metaKey:n.ctrlKey}function Jt(n){return n.ctrlKey&&!n.metaKey&&!n.shiftKey&&!n.altKey&&Math.abs(j(n.deltaY,n.deltaMode))>=1}function Qt(n){if(n.metaKey||n.ctrlKey||n.shiftKey||n.altKey)return!1;let e=Math.abs(j(n.deltaX,n.deltaMode)),a=Math.abs(j(n.deltaY,n.deltaMode));return e>=1&&e>a}function j(n,e){return e===WheelEvent.DOM_DELTA_LINE?n*16:e===WheelEvent.DOM_DELTA_PAGE?n*800:n}function Q(){return/Mac|iPhone|iPad|iPod/.test(navigator.platform)||/Mac OS X/.test(navigator.userAgent)}function en(n){return n instanceof HTMLInputElement||n instanceof HTMLSelectElement||n instanceof HTMLTextAreaElement||n instanceof HTMLButtonElement}function C(n){return 20*Math.log10(Math.max(n,1e-12))}function Pe(n){return`${n.toFixed(1)} dBFS`}function an(n,e){return{rectangular:e.windowRectangular,bartlett:e.windowBartlett,hamming:e.windowHamming,hann:e.windowHann,blackman:e.windowBlackman,blackmanHarris:e.windowBlackmanHarris,welch:e.windowWelch,gaussian25:e.windowGaussian25,gaussian35:e.windowGaussian35,gaussian45:e.windowGaussian45}[n]}function ba(n){return n>=1e3?`${(n/1e3).toFixed(n>=1e4?1:2)} kHz`:`${Math.round(n)} Hz`}function Me(n){let e=Math.abs(n);return e===0?"0.0":e>=1?n.toFixed(1):e>=.1?n.toFixed(2):n.toFixed(3)}function tn(n){let e={"signed-8":"Signed 8-bit PCM","signed-16":"Signed 16-bit PCM","signed-24":"Signed 24-bit PCM","signed-32":"Signed 32-bit PCM","unsigned-8":"Unsigned 8-bit PCM","float-32":"32-bit float","float-64":"64-bit float"}[G(n)],a=n.endianness==="none"?"no endian":n.endianness==="little"?"little-endian":"big-endian",t=n.startOffsetBytes?` \xB7 offset ${n.startOffsetBytes}B`:"";return`${n.sampleRate} Hz \xB7 ${n.channels}ch \xB7 ${e} \xB7 ${a}${t}`}function nn(n){if(n.byteLength<44||A(n,0,4)!=="RIFF"||A(n,8,4)!=="WAVE")return;let e=12,a,t=0,i,r=0;for(;e+8<=n.byteLength;){let g=A(n,e,4),h=ae(n,e+4),b=e+8;if(g==="data"){i=b,r=ne(h,n.byteLength-b);break}if(b+h>n.byteLength)return;g==="fmt "&&(a=b,t=h),e=b+h+h%2}if(a===void 0||i===void 0||t<16)return;let o=O(n,a),s=O(n,a+2),l=ae(n,a+4),d=O(n,a+12),c=O(n,a+14);if(o===65534){if(t<40)return;o=O(n,a+24)}let u=sn(o,c);return!u||![8,16,24,32,64].includes(c)||u==="float"&&c!==32&&c!==64||u==="unsigned-int"&&c!==8||s<=0||l<=0||d!==s*(c/8)?void 0:{bytes:n.subarray(i,i+r),format:{sampleRate:l,channels:s,bitDepth:c,sampleFormat:u,endianness:c===8?"none":"little",startOffsetBytes:0}}}function rn(n){if(n.byteLength<44||A(n,0,4)!=="RIFF"||A(n,8,4)!=="WAVE")return!1;let e=12;for(;e+8<=n.byteLength;){let a=A(n,e,4),t=ae(n,e+4),i=e+8;if(a==="data")return ne(t,n.byteLength-i)===0;let r=i+t+t%2;if(r<=e||r>n.byteLength)return!1;e=r}return!1}function sn(n,e){if(n===1)return e===8?"unsigned-int":"signed-int";if(n===3)return"float"}function A(n,e,a){let t="";for(let i=0;i<a;i+=1)t+=String.fromCharCode(n[e+i]??0);return t}function O(n,e){return(n[e]??0)|(n[e+1]??0)<<8}function ae(n,e){return((n[e]??0)|(n[e+1]??0)<<8|(n[e+2]??0)<<16|(n[e+3]??0)<<24)>>>0}function ya(n,e,a,t){let i=f(n,0,1),r=Math.max(0,Math.min(a,t-1)),o=Math.max(r+1,t);if(e==="log"){if(o<=20)return r+i*(o-r);let s=20;if(r<=0&&i<=0)return 0;let l=r<=0?0:Math.log(Math.max(s,r)/s)/Math.log(o/s);return Math.min(o,s*Math.pow(o/s,l+i*(1-l)))}if(e==="mel"){let s=E(r);return on(s+i*(E(o)-s))}if(e==="bark"){let s=I(r);return ln(s+i*(I(o)-s))}if(e==="erb"){let s=D(r);return dn(s+i*(D(o)-s))}return r+i*(o-r)}function ka(n,e,a,t){let i=Math.max(0,Math.min(a,t-1)),r=Math.max(i+1,t);if(e==="log"){if(r<=20)return(n-i)/(r-i);let o=20,s=i<=0?0:Math.log(Math.max(o,i)/o)/Math.log(r/o);return(Math.log(Math.max(n,.001)/o)/Math.log(r/o)-s)/Math.max(1e-9,1-s)}return e==="mel"?(E(n)-E(i))/Math.max(1e-9,E(r)-E(i)):e==="bark"?(I(n)-I(i))/Math.max(1e-9,I(r)-I(i)):e==="erb"?(D(n)-D(i))/Math.max(1e-9,D(r)-D(i)):(n-i)/(r-i)}function va(n,e,a,t){let i=Math.max(1,Math.floor(t)),r=f(Number.isFinite(n)?Math.floor(n):0,0,Math.max(0,i-1)),o=Math.max(1,Math.floor(Number.isFinite(e)?e:i)),s=a?i:f(o,r+1,i);return{minHz:Math.min(r,s-1),maxHz:s,storedMaxHz:o}}function E(n){return 2595*Math.log10(1+n/700)}function on(n){return 700*(Math.pow(10,n/2595)-1)}function I(n){return 6*Math.asinh(n/600)}function ln(n){return 600*Math.sinh(n/6)}function D(n){return 21.4*Math.log10(1+.00437*n)}function dn(n){return(Math.pow(10,n/21.4)-1)/.00437}function cn(n,e,a,t){let i=Math.max(0,a-e);if(i<=0)return{rms:0,peak:0,crestDb:Number.NaN,clippingPercent:0,noiseFloorDb:C(0),zeroCrossingRate:0};let r=Math.max(1,Math.ceil(i/2e6)),o=0,s=0,l=0,d=0,c=0,u=0;for(let y=e;y<a;y+=r){let k=n[y]??0,w=Math.abs(k),v=k>0?1:k<0?-1:u;o+=k*k,s=Math.max(s,w),w>=.999&&(l+=1),u!==0&&v!==0&&v!==u&&(d+=1),v!==0&&(u=v),c+=1}let p=Math.sqrt(o/Math.max(1,c)),g=C(s),h=C(p),b=i/Math.max(1,t);return{rms:p,peak:s,crestDb:p<=0?Number.NaN:g-h,clippingPercent:l/Math.max(1,c)*100,noiseFloorDb:un(n,e,a,t),zeroCrossingRate:d/Math.max(1e-9,b)}}function un(n,e,a,t){let i=Math.max(0,a-e);if(i<=0)return C(0);let r=Math.max(32,Math.floor(t*.02)),o=Math.max(1,Math.floor(r/2));if(i<r){let g=0;for(let h=e;h<a;h+=1){let b=n[h]??0;g+=b*b}return C(Math.sqrt(g/Math.max(1,i)))}let s=i-r,d=Math.max(o,Math.ceil((s+1)/4096)),c=[],u=0;for(;u<=s;){let g=e+u,h=0;for(let b=0;b<r;b+=1){let y=n[g+b]??0;h+=y*y}if(c.push(Math.sqrt(h/r)),u===s)break;u=Math.min(u+d,s)}c.sort((g,h)=>g-h);let p=Math.min(c.length-1,Math.max(0,Math.floor((c.length-1)*.1)));return C(c[p]??0)}function z(n){return n===void 0?"n/a":`${n.toFixed(2)} ms`}function Pa(){let n=document.createElement("style");n.textContent=`
    :root {
      color-scheme: light dark;
    }
    * {
      box-sizing: border-box;
    }
    html,
    body {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    button, input, select {
      font: inherit;
    }
    .shell {
      position: relative;
      height: 100vh;
      min-height: 0;
      display: grid;
      grid-template-rows: auto auto 1fr;
      overflow: hidden;
    }
    .topbar, .player {
      min-height: 44px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, auto) auto;
      grid-auto-rows: auto;
      align-items: center;
    }
    .identity {
      grid-column: 1;
      grid-row: 1;
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex: 1 1 auto;
    }
    .topbarTools {
      grid-column: 3;
      grid-row: 1;
      justify-self: end;
      flex: 0 0 auto;
      min-width: max-content;
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .brand {
      letter-spacing: 0;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #fileMeta {
      display: block;
      flex: 1 1 auto;
      min-width: 0;
      cursor: text;
      user-select: text;
      scrollbar-width: none;
    }
    #fileMeta:hover,
    #fileMeta:focus,
    #fileMeta:active {
      overflow-x: auto;
      text-overflow: clip;
    }
    #fileMeta::-webkit-scrollbar {
      display: none;
    }
    .status {
      grid-column: 2;
      grid-row: 1;
      justify-self: end;
      max-width: min(32vw, 360px);
      color: var(--vscode-notificationsInfoIcon-foreground);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status.isWarning {
      color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-editorWarning-foreground, #cca700));
    }
    .status.isError {
      color: var(--vscode-notificationsErrorIcon-foreground, var(--vscode-errorForeground, #f85149));
    }
    .status[hidden] {
      display: none;
    }
    .player {
      background: var(--vscode-editor-background);
    }
    .iconButton {
      width: 32px;
      height: 32px;
      flex: 0 0 auto;
      display: inline-grid;
      place-items: center;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    [hidden] {
      display: none !important;
    }
    .secondaryIcon {
      position: relative;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .downloadButton {
      font-size: 18px;
      line-height: 1;
    }
    #settingsToggle {
      position: relative;
      width: 32px;
      height: 32px;
      font-size: 20px;
      line-height: 1;
      padding-bottom: 0;
    }
    .settingsGlyph {
      display: block;
      line-height: 1;
      transform: translateY(-1px);
    }
    .iconButton:hover, .primary:hover, .secondary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .secondaryIcon[data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute;
      z-index: 45;
      top: calc(100% + 8px);
      right: 0;
      padding: 5px 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
      backdrop-filter: blur(8px);
      box-shadow: 0 8px 20px rgb(0 0 0 / 24%);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.2;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity 90ms ease, transform 90ms ease;
    }
    .secondaryIcon[data-tooltip]:hover::after,
    .secondaryIcon[data-tooltip]:focus-visible::after {
      opacity: 1;
      transform: translateY(0);
    }
    .clock {
      min-width: 150px;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .seek {
      flex: 1;
      min-width: 140px;
    }
    .workspace {
      min-height: 0;
      display: grid;
      grid-template-columns: 1fr;
      overflow: hidden;
    }
    .controls, .settingsPanel {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
    }
    .controls {
      border-right: 1px solid var(--vscode-panel-border);
      overflow: auto;
      padding: 8px;
    }
    .controls[hidden] {
      display: none;
    }
    .controls label, .settingsPanel label, .pcmPanel label {
      display: grid;
      gap: 5px;
    }
    .controlInternals[hidden] {
      display: none;
    }
    .settingsPanel .checkboxLabel {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .controls label span, .settingsPanel label span, .pcmPanel label span {
      color: var(--vscode-descriptionForeground);
    }
    .controls select,
    .controls input[type="number"],
    .controls input[type="text"],
    .settingsPanel select,
    .settingsPanel input[type="number"],
    .pcmPanel select,
    .pcmPanel input[type="number"],
    .pcmPanel input[type="text"] {
      width: 100%;
      min-height: 28px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 3px 6px;
    }
    .pcmPanel select,
    .wavPcmGrid select {
      min-width: 58px;
      padding-right: 22px;
      text-align: left;
    }
    .numericText {
      direction: ltr;
      text-align: left;
      font-variant-numeric: tabular-nums;
    }
    .settingsPanel {
      position: absolute;
      z-index: 35;
      top: 52px;
      right: 12px;
      width: min(280px, calc(100vw - 24px));
      border: 1px solid var(--vscode-panel-border);
      max-height: calc(100vh - 72px);
      overflow: auto;
      box-shadow: 0 12px 30px rgb(0 0 0 / 24%);
    }
    .settingsPanel[hidden] {
      display: none;
    }
    .settingsHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .settingsSection {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-top: 4px;
    }
    .settingsSection + .settingsSection {
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .settingsSubsection {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 4px;
    }
    .settingsSubsection > strong {
      color: var(--vscode-foreground);
      font-size: 0.95em;
    }
    .primary, .secondary {
      min-height: 32px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      cursor: pointer;
    }
    .primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .secondary.isProminent {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .wheelHint {
      color: var(--vscode-descriptionForeground);
      font-size: 0.88em;
      line-height: 1.35;
      white-space: nowrap;
    }
    .wheelHint kbd {
      display: inline-block;
      min-width: 1.6em;
      padding: 0 4px;
      border: 1px solid var(--vscode-panel-border);
      border-bottom-color: color-mix(in srgb, var(--vscode-panel-border) 65%, #000);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 0.92em;
      line-height: 1.4;
      text-align: center;
    }
    .figures {
      --waveform-height: 220px;
      --spectrogram-height: 360px;
      position: relative;
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 0;
      padding: 0 12px 12px;
      overflow: hidden;
      align-content: start;
      justify-items: stretch;
      background: var(--vscode-editor-background);
      margin-top: -1px;
    }
    .figureHeader {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--vscode-foreground);
    }
    .timelineHeader {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      gap: 0;
      min-height: 34px;
      align-items: stretch;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editor-background);
      box-shadow: 0 1px 0 var(--vscode-editor-background);
      margin-right: var(--timeline-scrollbar-gutter, 0px);
    }
    .figures.isFirstTrackSelectedAtTop .timelineHeader {
      border-bottom-color: var(--vscode-focusBorder);
    }
    .timelineRange {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 8px;
      border-right: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      font-variant-numeric: tabular-nums;
      min-width: 0;
    }
    .timelineCanvasWrap {
      position: relative;
      min-width: 0;
      min-height: 32px;
      background: var(--vscode-editor-background);
    }
    .timelineCanvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    .plotPane {
      position: relative;
      min-width: 0;
      min-height: 96px;
      height: 100%;
      align-self: stretch;
      contain: strict;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .trackList {
      position: relative;
      z-index: 2;
      min-height: 0;
      display: grid;
      gap: 0;
      overflow: auto;
      align-content: start;
      scrollbar-gutter: stable;
      margin-top: -1px;
      background: var(--vscode-editor-background);
    }
    .trackRow {
      position: relative;
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      height: var(--track-row-h, 280px);
      min-height: 132px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: visible;
      background: var(--vscode-editor-background);
    }
    .trackRow:first-child {
      margin-top: 0;
    }
    .trackRow + .trackRow {
      margin-top: -1px;
    }
    .trackRow.isSelected {
      z-index: 4;
      border-color: var(--vscode-focusBorder);
      border-radius: 6px;
    }
    .trackRow:first-child.isSelected::after {
      content: none;
    }
    .trackSidebar {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      padding: 8px;
      overflow: hidden;
      border: 0;
      border-right: 1px solid var(--vscode-panel-border);
      border-radius: 5px 0 0 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
    }
    .trackTitle, .trackToggle, .trackMode {
      font: inherit;
      width: 100%;
      text-align: center;
    }
    .trackToggle {
      min-height: 26px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font-variant-numeric: tabular-nums;
      cursor: pointer;
    }
    .trackTitle {
      min-height: 26px;
      display: grid;
      place-items: center;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: transparent;
      font-weight: 600;
    }
    .trackToggle.isActive {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
      font-weight: 600;
    }
    .trackMute.isActive {
      color: #ffffff;
      text-shadow: 0 1px 1px rgb(0 0 0 / 55%);
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 88%, #00345f);
      border-color: var(--vscode-charts-blue, #3794ff);
      box-shadow: 0 0 0 1px var(--vscode-charts-blue, #3794ff) inset;
    }
    .trackSolo.isActive {
      color: #1f1300;
      text-shadow: 0 1px 0 rgb(255 255 255 / 32%);
      background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 86%, #ffdf9b);
      border-color: var(--vscode-charts-orange, #d18616);
      box-shadow: 0 0 0 1px var(--vscode-charts-orange, #d18616) inset;
    }
    .trackMode {
      min-height: 26px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      text-align-last: center;
    }
    .trackSliderControl {
      display: grid;
      grid-template-columns: 11px minmax(0, 1fr) 11px;
      align-items: center;
      column-gap: 2px;
      min-height: 16px;
    }
    .trackGainControl {
      margin-top: 2px;
    }
    .trackSliderEnd {
      font-size: 10px;
      line-height: 1;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      user-select: none;
      overflow: hidden;
      white-space: nowrap;
    }
    .trackSliderTrack {
      position: relative;
      display: block;
      height: 16px;
      min-width: 0;
    }
    .trackSliderTicks {
      --track-tick: color-mix(in srgb, var(--vscode-descriptionForeground) 50%, transparent);
      --track-tick-strong: color-mix(in srgb, var(--vscode-descriptionForeground) 80%, transparent);
      position: absolute;
      top: 0;
      bottom: 0;
      left: 6px;
      right: 6px;
      pointer-events: none;
      background:
        linear-gradient(var(--track-tick-strong), var(--track-tick-strong)) no-repeat left center / 1px 8px,
        linear-gradient(var(--track-tick), var(--track-tick)) no-repeat 25% center / 1px 5px,
        linear-gradient(var(--track-tick-strong), var(--track-tick-strong)) no-repeat center center / 1px 10px,
        linear-gradient(var(--track-tick), var(--track-tick)) no-repeat 75% center / 1px 5px,
        linear-gradient(var(--track-tick-strong), var(--track-tick-strong)) no-repeat right center / 1px 8px,
        linear-gradient(var(--track-tick), var(--track-tick)) no-repeat center center / 100% 1px;
    }
    .trackSlider {
      -webkit-appearance: none;
      appearance: none;
      position: relative;
      z-index: 1;
      display: block;
      width: 100%;
      height: 16px;
      margin: 0;
      padding: 0;
      background: transparent;
      cursor: pointer;
    }
    .trackSlider::-webkit-slider-runnable-track {
      height: 16px;
      background: transparent;
    }
    .trackSlider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      margin-top: 2px;
      border-radius: 50%;
      border: 1px solid color-mix(in srgb, var(--vscode-button-background) 70%, var(--vscode-foreground));
      background: var(--vscode-button-background);
      box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
      transition: transform 90ms ease, box-shadow 90ms ease;
    }
    .trackSlider:hover::-webkit-slider-thumb {
      transform: scale(1.12);
    }
    .trackSlider:active::-webkit-slider-thumb {
      transform: scale(1.12);
      border-color: var(--vscode-focusBorder);
    }
    .trackSlider:focus,
    .trackSlider:focus-visible {
      outline: none;
    }
    .trackSlider:focus-visible::-webkit-slider-thumb {
      border-color: var(--vscode-focusBorder);
    }
    .trackBody,
    .trackCanvasWrap {
      background: var(--vscode-editor-background);
    }
    .trackBody {
      display: grid;
      grid-template-rows:
        minmax(90px, var(--track-wave-fr, 0.38fr))
        minmax(160px, var(--track-spec-fr, 0.62fr));
      min-width: 0;
      min-height: 0;
      gap: 0;
      overflow: hidden;
      border-radius: 0 5px 5px 0;
    }
    .trackRow[data-mode="waveform"] .trackBody,
    .trackRow[data-mode="spectrogram"] .trackBody {
      grid-template-rows: 1fr;
    }
    .trackRow[data-mode="waveform"] .trackSpectrogramWrap,
    .trackRow[data-mode="spectrogram"] .trackWaveformWrap {
      display: none;
    }
    .trackCanvasWrap {
      position: relative;
      min-width: 0;
      min-height: 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .trackCanvasWrap:last-child {
      border-bottom: 0;
    }
    .trackRowHandle,
    .trackSplitHandle {
      position: absolute;
      left: 0;
      right: 0;
      height: 8px;
      z-index: 6;
      cursor: ns-resize;
      background: transparent;
    }
    .trackRowHandle {
      bottom: 0;
      transform: translateY(50%);
    }
    .trackSplitHandle {
      top: 0;
      transform: translateY(-50%);
    }
    .trackRow[data-mode="waveform"] .trackSplitHandle,
    .trackRow[data-mode="spectrogram"] .trackSplitHandle {
      display: none;
    }
    body.is-resizing {
      user-select: none;
      cursor: ns-resize;
    }
    .trackWaveform:focus,
    .trackSpectrogram:focus {
      outline: none;
    }
    .pcmPanel {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 8px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .pcmReveal {
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .headerInfoButton {
      line-height: 1;
    }
    .headerInfoIcon {
      width: 19px;
      height: 19px;
      display: block;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.7;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .topPcmPanel {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr) max-content;
      grid-template-areas:
        "title fields actions"
        ". status .";
      align-items: center;
      column-gap: 8px;
      row-gap: 5px;
      min-width: min(560px, 100%);
      width: 100%;
      max-width: 100%;
      overflow: visible;
    }
    .topPcmPanel .paneTitle {
      grid-area: title;
      align-self: center;
      justify-self: start;
      white-space: nowrap;
    }
    .topPcmPanel .pcmFields {
      grid-area: fields;
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      justify-content: center;
      gap: 8px;
    }
    .topPcmPanel .pcmActions {
      grid-area: actions;
      display: flex;
      align-items: end;
      justify-content: flex-end;
      gap: 8px;
      min-width: max-content;
    }
    .topPcmPanel label {
      display: grid;
      grid-template-rows: 15px 26px;
      min-width: auto;
      gap: 3px;
      justify-items: center;
      align-items: center;
    }
    .topPcmPanel label span {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 15px;
      text-align: center;
      line-height: 1.2;
      white-space: nowrap;
    }
    .topPcmPanel input,
    .topPcmPanel select {
      height: 26px;
      min-height: 26px;
      padding-top: 2px;
      padding-bottom: 2px;
    }
    .topPcmPanel input {
      text-align: center;
    }
    .topPcmPanel button {
      min-height: 28px;
      white-space: nowrap;
      padding: 0 9px;
    }
    .topPcmPanel #pcmSampleRate {
      width: 8ch;
    }
    .topPcmPanel #pcmChannels {
      width: 4ch;
    }
    .topPcmPanel #pcmStartOffset {
      width: 8ch;
    }
    .topPcmPanel #pcmEncoding {
      width: 168px;
    }
    .topPcmPanel #pcmEndianness {
      width: 78px;
    }
    .topPcmPanel #pcmEdit {
      grid-area: edit;
      display: none;
    }
    .topPcmPanel #pcmStatus {
      grid-area: status;
      position: relative;
      align-self: stretch;
      min-width: 0;
      max-width: 100%;
      white-space: nowrap;
      overflow-x: auto;
      overflow-y: visible;
      line-height: 1.3;
      text-align: center;
      scrollbar-width: none;
    }
    .topPcmPanel #pcmStatus::-webkit-scrollbar {
      display: none;
    }
    .topPcmPanel #pcmStatusText {
      display: block;
      width: max-content;
      max-width: none;
      margin: 0 auto;
      overflow: visible;
      text-overflow: clip;
      white-space: nowrap;
    }
    .topPcmPanel #pcmStatus::after {
      content: attr(data-tooltip);
      position: fixed;
      z-index: 45;
      top: var(--pcm-status-tooltip-top, 52px);
      left: var(--pcm-status-tooltip-left, 12px);
      width: max-content;
      max-width: min(520px, calc(100vw - 36px));
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
      backdrop-filter: blur(8px);
      box-shadow: 0 10px 24px rgb(0 0 0 / 28%);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.45;
      white-space: normal;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity 90ms ease, transform 90ms ease;
    }
    .topPcmPanel #pcmStatus:hover::after {
      opacity: 1;
      transform: translateY(0);
    }
    .topPcmPanel[data-collapsed="true"] {
      grid-template-areas: "title status edit";
      align-items: center;
      padding-top: 4px;
      padding-bottom: 4px;
    }
    .topPcmPanel[data-collapsed="true"] .pcmFields {
      display: none;
    }
    .topPcmPanel[data-collapsed="true"] .pcmActions {
      display: none;
    }
    .topPcmPanel[data-collapsed="true"] #pcmEdit {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .topPcmPanel[data-collapsed="true"] #pcmStatus {
      align-self: center;
      justify-self: center;
      width: min(720px, 100%);
      max-width: 100%;
    }
    .topPcmPanel[data-collapsed="true"] #pcmStatusText {
      margin: 0 auto;
    }
    .wavPcmPanel {
      position: fixed;
      z-index: 40;
      top: 58px;
      left: 12px;
      width: min(520px, calc(100vw - 36px));
      display: grid;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
      backdrop-filter: blur(10px);
      box-shadow: 0 16px 36px rgb(0 0 0 / 28%);
    }
    .wavPcmPanel[hidden] {
      display: none;
    }
    .headerInfoPanel {
      position: fixed;
      z-index: 42;
      top: 58px;
      left: 12px;
      width: min(680px, calc(100vw - 24px));
      max-height: min(680px, calc(100vh - 82px));
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
      backdrop-filter: blur(10px);
      box-shadow: 0 16px 36px rgb(0 0 0 / 28%);
    }
    .headerInfoPanel[hidden] {
      display: none;
    }
    .headerInfoHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .headerInfoBody {
      min-height: 0;
      overflow: auto;
    }
    .headerInfoEmpty {
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }
    .headerInfoSummary {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 10px;
      padding: 7px 9px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      line-height: 1.35;
      background: var(--vscode-input-background);
    }
    .headerInfoSummary strong {
      white-space: nowrap;
    }
    .headerInfoSummary span {
      color: var(--vscode-descriptionForeground);
    }
    .headerInfoSummary.is-info {
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 62%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 12%, var(--vscode-input-background));
    }
    .headerInfoSummary.is-warning {
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 62%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 10%, var(--vscode-input-background));
    }
    .headerInfoTable {
      width: max-content;
      min-width: 100%;
      max-width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
      table-layout: auto;
      font-size: 12px;
    }
    .headerInfoTable th,
    .headerInfoTable td {
      padding: 3px 6px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
      text-align: left;
      vertical-align: top;
      line-height: 1.3;
    }
    .headerInfoTable td {
      overflow-wrap: anywhere;
    }
    .headerInfoTable th:nth-child(1),
    .headerInfoTable th:nth-child(2),
    .headerInfoTable td:nth-child(1),
    .headerInfoTable td:nth-child(2) {
      white-space: nowrap;
      overflow-wrap: normal;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .headerInfoTable th {
      position: sticky;
      top: 0;
      z-index: 1;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-weight: 600;
    }
    .headerInfoTable .offsetColumn,
    .headerInfoTable .sizeColumn {
      white-space: nowrap;
      overflow-wrap: normal;
    }
    .headerInfoTable .offsetColumn {
      min-width: 92px;
    }
    .headerInfoTable .sizeColumn {
      min-width: 86px;
    }
    .headerInfoTable .bitsColumn {
      min-width: 118px;
      max-width: 150px;
      white-space: nowrap;
      overflow-wrap: normal;
    }
    .headerInfoTable .fieldColumn {
      min-width: 156px;
      max-width: 240px;
    }
    .headerInfoTable .valueColumn {
      min-width: 96px;
      max-width: 190px;
    }
    .headerInfoTable .noteColumn {
      min-width: 128px;
      max-width: 240px;
    }
    .headerInfoTable td:nth-child(3),
    .headerInfoTable td:nth-child(4),
    .headerInfoTable td:nth-child(5) {
      max-width: inherit;
    }
    .headerInfoTable td:nth-child(3) {
      padding-left: calc(6px + var(--header-field-depth, 0) * 16px);
    }
    .headerInfoTable tr[data-kind="box"] td {
      background: color-mix(in srgb, var(--vscode-sideBar-background) 72%, transparent);
    }
    .headerInfoTable tr[data-kind="box"] td:nth-child(3) {
      color: var(--vscode-foreground);
      font-weight: 700;
    }
    .wavPcmHeader {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .wavPcmGrid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .wavPcmGrid label {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .wavPcmGrid label span {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
    }
    .wavPcmGrid input,
    .wavPcmGrid select {
      width: 100%;
      height: 28px;
      text-align: center;
    }
    .wavPcmFooter {
      display: grid;
      grid-template-columns: 1fr auto auto;
      align-items: center;
      gap: 8px;
    }
    .wavPcmFooter #wavPcmStatus {
      min-width: 0;
      white-space: normal;
      line-height: 1.35;
    }
    .pcmPanel[hidden] {
      display: none;
    }
    .helpMenu {
      position: relative;
      flex: 0 0 auto;
    }
    .helpMenu summary {
      position: relative;
      list-style: none;
    }
    .helpMenu summary::-webkit-details-marker {
      display: none;
    }
    .helpMenu .iconButton {
      font-size: 18px;
      line-height: 1;
    }
    .helpPopover {
      position: absolute;
      z-index: 30;
      right: 0;
      top: calc(100% + 8px);
      width: min(430px, calc(100vw - 24px));
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      box-shadow: 0 12px 30px rgb(0 0 0 / 24%);
      line-height: 1.35;
      max-height: min(620px, calc(100vh - 92px));
      overflow: auto;
    }
    .helpSection {
      display: grid;
      gap: 5px;
      padding-bottom: 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
    }
    .helpSection:last-child {
      padding-bottom: 0;
      border-bottom: 0;
    }
    .helpSectionTitle {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .helpRow {
      display: grid;
      grid-template-columns: minmax(160px, 0.48fr) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .helpRow > :first-child {
      color: var(--vscode-descriptionForeground);
      min-width: 0;
    }
    .helpNote {
      color: var(--vscode-descriptionForeground);
    }
    .helpPopover kbd,
    .helpGesture {
      padding: 0 4px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
      font-family: var(--vscode-editor-font-family), monospace;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      display: block;
      border: 0;
      background: var(--vscode-editor-background);
      cursor: crosshair;
    }
    .plotResize {
      position: relative;
      min-height: 12px;
      cursor: row-resize;
      border-radius: 4px;
    }
    .plotResize::before {
      content: "";
      position: absolute;
      inset: 3px 0;
      border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent);
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .plotResize:hover::before,
    .plotResize:active::before {
      opacity: 1;
    }
    .plotResize::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 52px;
      height: 2px;
      border-radius: 999px;
      transform: translate(-50%, -50%);
      background: color-mix(in srgb, var(--vscode-focusBorder) 72%, var(--vscode-panel-border));
    }
    .selectionBox {
      position: fixed;
      border: 1px solid rgba(88, 166, 255, 0.85);
      background: rgba(88, 166, 255, 0.18);
      pointer-events: none;
      z-index: 20;
    }
    .selectionBox.isDraggingSelection {
      border-left-color: transparent;
    }
    .selectionBox::before {
      content: "";
      position: absolute;
      left: 0;
      top: -1px;
      bottom: -1px;
      width: 2px;
      transform: translateX(-1px);
      background: #ffcc66;
      display: none;
    }
    .contextMenu {
      position: fixed;
      z-index: 50;
      min-width: 190px;
      padding: 4px;
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 5px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
      box-shadow: 0 12px 28px rgb(0 0 0 / 32%);
    }
    .contextMenu[hidden] {
      display: none;
    }
    .contextMenu button {
      width: 100%;
      display: block;
      padding: 6px 10px;
      border: 0;
      border-radius: 3px;
      color: inherit;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .contextMenu button:hover,
    .contextMenu button:focus-visible {
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      outline: none;
    }
    .contextMenuTitle {
      padding: 4px 10px 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 4px;
    }
    .freqScaleMenu button.isChecked::before {
      content: "\u2713 ";
    }
    .freqScaleMenu button:not(.isChecked)::before {
      content: "\\00a0\\00a0";
    }
    .selectionAnalysisPane {
      position: fixed;
      z-index: 25;
      right: 18px;
      top: 112px;
      width: min(220px, calc(100vw - 36px));
      display: grid;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 76%, transparent);
      backdrop-filter: blur(8px);
      box-shadow: 0 12px 28px rgb(0 0 0 / 22%);
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .selectionAnalysisPane[hidden] {
      display: none;
    }
    .paneTitle {
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .paneTitleRow {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .paneSubtitleRow {
      margin-top: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .paneSubtitle {
      color: var(--vscode-foreground);
      font-size: 0.92em;
      font-weight: 600;
    }
    .analysisHelp,
    .metricHelp {
      position: relative;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      display: inline-grid;
      place-items: center;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 50%;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      font-size: 11px;
      line-height: 1;
      cursor: help;
    }
    .metricHelp {
      width: 14px;
      height: 14px;
      margin-left: 4px;
      font-size: 10px;
      vertical-align: text-top;
    }
    .floatingTooltip {
      position: fixed;
      z-index: 45;
      left: 12px;
      top: 12px;
      width: min(380px, calc(100vw - 36px));
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 86%, transparent);
      backdrop-filter: blur(8px);
      box-shadow: 0 10px 24px rgb(0 0 0 / 28%);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.5;
      text-shadow: 0 1px 1px rgb(0 0 0 / 28%);
      white-space: pre-line;
      pointer-events: none;
    }
    .floatingTooltip[hidden] {
      display: none;
    }
    .sliderTipValue {
      display: block;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .sliderTipHint {
      display: block;
      margin-top: 3px;
      text-align: center;
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
    }
    .analysisTable {
      width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      line-height: 1.35;
    }
    .analysisTable th,
    .analysisTable td {
      padding: 4px 0;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
      vertical-align: top;
    }
    .analysisTable tr:first-child th,
    .analysisTable tr:first-child td {
      border-top: 0;
    }
    .analysisTable th {
      width: 1%;
      padding-right: 10px;
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
      text-align: left;
      white-space: nowrap;
    }
    .analysisTable td {
      color: var(--vscode-foreground);
      overflow-wrap: anywhere;
      text-align: right;
    }
    .analysisValueLoading {
      color: var(--vscode-charts-blue, #4fc3f7) !important;
      font-style: italic;
    }
    @media (max-width: 720px) {
      .workspace {
        grid-template-columns: 1fr;
      }
      .controls {
        border-right: 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .controls[hidden] {
        display: none;
      }
      .selectionAnalysisPane {
        right: 12px;
        top: 104px;
      }
    }
  `,document.head.appendChild(n)}var Ae=document.querySelector("#app");if(!Ae)throw new Error("AudioLens root element missing");Pa();var Ce=acquireVsCodeApi();try{let n=new ee(Ce,oa(Ae));window.addEventListener("message",e=>{n.handleMessage(e.data)}),Ce.postMessage({type:"ready"})}catch(n){let e=n instanceof Error?n.message:String(n);Ae.textContent=`AudioLens initialization failed: ${e}`,Ce.postMessage({type:"showError",message:`AudioLens initialization failed: ${e}`})}})();
