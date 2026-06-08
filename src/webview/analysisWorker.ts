export interface SpectrogramResult {
  type: "spectrogram";
  requestId: string;
  width: number;
  height: number;
  pixels: ArrayBuffer;
}

export function createAnalysisWorker(): Worker {
  const source = `
    self.onmessage = (event) => {
      const message = event.data;
      if (message.type !== "analyze") return;
      const samples = new Float32Array(message.samples);
      const settings = message.settings;
      const windowSize = Math.max(8, Math.floor(settings.fftSize));
      const zeroPaddingFactor = Math.max(1, Math.floor(settings.zeroPaddingFactor || 1));
      const fftSize = nextPowerOfTwo(windowSize * zeroPaddingFactor);
      const sampleRate = Math.max(1, message.sampleRate || 1);
      const hopSize = Math.max(1, Math.floor(settings.hopSize));
      const bins = Math.max(1, Math.min(Math.floor(settings.outputBins || 384), fftSize / 2));
      const frames = Math.max(1, Math.floor(Math.max(0, samples.length - windowSize) / hopSize) + 1);
      const pixels = new Uint8ClampedArray(frames * bins * 4);
      const window = createWindow(settings.windowFunction, windowSize);
      const re = new Float32Array(fftSize);
      const im = new Float32Array(fftSize);
      const nyquist = sampleRate / 2;
      const minFrequencyHz = Math.max(0, Math.min(Number(settings.minFrequencyHz) || 0, Math.max(0, nyquist - 1)));
      const maxFrequencyHz = Math.max(minFrequencyHz + 1, Math.min(Number(settings.maxFrequencyHz) || nyquist, nyquist));

      for (let frame = 0; frame < frames; frame += 1) {
        const offset = frame * hopSize;
        re.fill(0);
        im.fill(0);
        for (let i = 0; i < windowSize; i += 1) {
          re[i] = (samples[offset + i] || 0) * window[i];
        }
        fft(re, im);
        for (let y = 0; y < bins; y += 1) {
          const ratio = bins <= 1 ? 0 : (bins - 1 - y) / (bins - 1);
          const freq = frequencyFromRatio(ratio, settings.frequencyScale, minFrequencyHz, maxFrequencyHz);
          const bin = Math.max(0, Math.min((fftSize / 2) - 1, Math.round((freq / sampleRate) * fftSize)));
          const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) / windowSize;
          const db = adjustDbForAlgorithm(20 * Math.log10(Math.max(mag, 1e-12)), settings.algorithm);
          const color = colorize((db - settings.minDb) / (settings.maxDb - settings.minDb), settings.palette);
          const index = (y * frames + frame) * 4;
          pixels[index] = color[0];
          pixels[index + 1] = color[1];
          pixels[index + 2] = color[2];
          pixels[index + 3] = 255;
        }
      }
      self.postMessage({ type: "spectrogram", requestId: message.requestId, width: frames, height: bins, pixels: pixels.buffer }, [pixels.buffer]);
    };

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

    function nextPowerOfTwo(value) {
      let size = 1;
      while (size < value) size <<= 1;
      return size;
    }

    function adjustDbForAlgorithm(db, algorithm) {
      if (algorithm === "reassignment") return db + 3;
      if (algorithm === "pitchEac") return db - 3;
      return db;
    }

    function fft(re, im) {
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
      for (let len = 2; len <= n; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const wLenR = Math.cos(angle);
        const wLenI = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
          let wr = 1;
          let wi = 0;
          for (let j = 0; j < len / 2; j += 1) {
            const uR = re[i + j];
            const uI = im[i + j];
            const vR = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi;
            const vI = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
            re[i + j] = uR + vR;
            im[i + j] = uI + vI;
            re[i + j + len / 2] = uR - vR;
            im[i + j + len / 2] = uI - vI;
            const nextWr = wr * wLenR - wi * wLenI;
            wi = wr * wLenI + wi * wLenR;
            wr = nextWr;
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
  return new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
}
