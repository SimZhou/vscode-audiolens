"use strict";
(() => {
  // src/shared/protocol.ts
  var DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

  // src/shared/analysis.ts
  function getVisibleRange(input) {
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
  function normalizeDbRange(minDb, maxDb) {
    const safeMin = clamp(Number.isFinite(minDb) ? minDb : -96, -160, -1);
    const safeMax = clamp(Number.isFinite(maxDb) ? maxDb : 0, -80, 24);
    return {
      minDb: safeMin,
      maxDb: Math.max(safeMax, safeMin + 1)
    };
  }
  function createAnalysisCacheKey(parts) {
    return [
      parts.channel,
      parts.startSample,
      parts.endSample,
      parts.fftSize,
      parts.windowFunction,
      parts.algorithm ?? "frequency",
      parts.zeroPaddingFactor ?? 1,
      parts.outputBins ?? 0,
      parts.targetFrames ?? 0,
      parts.minDb,
      parts.maxDb,
      parts.frequencyScale ?? "linear",
      parts.palette ?? "classic"
    ].join(":");
  }
  function computeWaveformPeaks(samples, startSample, endSample, width) {
    const min = new Float32Array(width);
    const max = new Float32Array(width);
    if (width <= 0 || samples.length === 0) {
      return { min, max };
    }
    const start = clamp(Math.floor(startSample), 0, samples.length);
    const end = clamp(Math.ceil(endSample), start, samples.length);
    const sampleCount = Math.max(1, end - start);
    for (let x = 0; x < width; x += 1) {
      const sampleStart = Math.min(end - 1, start + Math.floor(x * sampleCount / width));
      const sampleEnd = Math.min(end, Math.max(sampleStart + 1, start + Math.ceil((x + 1) * sampleCount / width)));
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
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // src/webview/analysisWorker.ts
  function createAnalysisWorker() {
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
          const freq = frequencyFromRatio(ratio, settings.frequencyScale, nyquist);
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

    function frequencyFromRatio(ratio, scale, nyquist) {
      const r = Math.max(0, Math.min(1, ratio));
      const top = Math.max(1, nyquist);
      if (scale === "log") {
        if (r <= 0) return 0;
        const low = 20;
        return Math.min(top, low * Math.pow(top / low, r));
      }
      if (scale === "mel") return melToHz(r * hzToMel(top));
      if (scale === "bark") return barkToHz(r * hzToBark(top));
      if (scale === "erb") return erbToHz(r * hzToErb(top));
      return r * top;
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

  // src/webview/audioFacts.ts
  function readAudioFileFacts(bytes, fileName) {
    const extension = fileName.toLowerCase().split(".").pop();
    if (extension === "wav" || extension === "wave") {
      return { sampleRate: readWavSampleRate(bytes) };
    }
    if (extension === "flac") {
      return { sampleRate: readFlacSampleRate(bytes) };
    }
    return {};
  }
  function readWavSampleRate(bytes) {
    if (bytes.byteLength < 28 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WAVE") {
      return void 0;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const id = ascii(bytes, offset, offset + 4);
      const size = view.getUint32(offset + 4, true);
      const dataOffset = offset + 8;
      if (id === "fmt " && dataOffset + 8 <= bytes.byteLength) {
        const sampleRate = view.getUint32(dataOffset + 4, true);
        return sampleRate > 0 ? sampleRate : void 0;
      }
      offset = dataOffset + size + size % 2;
    }
    return void 0;
  }
  function readFlacSampleRate(bytes) {
    if (bytes.byteLength < 42 || ascii(bytes, 0, 4) !== "fLaC") {
      return void 0;
    }
    const blockType = bytes[4] & 127;
    const length = bytes[5] << 16 | bytes[6] << 8 | bytes[7];
    if (blockType !== 0 || length < 34 || bytes.byteLength < 42) {
      return void 0;
    }
    const offset = 8;
    const sampleRate = bytes[offset + 10] << 12 | bytes[offset + 11] << 4 | bytes[offset + 12] >> 4;
    return sampleRate > 0 ? sampleRate : void 0;
  }
  function ascii(bytes, start, end) {
    let value = "";
    for (let index = start; index < end; index += 1) {
      value += String.fromCharCode(bytes[index] ?? 0);
    }
    return value;
  }

  // src/webview/dom.ts
  function query(selector, ctor) {
    const element = document.querySelector(selector);
    if (!(element instanceof ctor)) {
      throw new Error(`Missing element: ${selector}`);
    }
    return element;
  }
  function resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas 2D context unavailable");
    }
    return context;
  }
  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const whole = Math.floor(seconds % 60);
    const millis = Math.floor((seconds - Math.floor(seconds)) * 1e3);
    return `${minutes}:${String(whole).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }
  function formatBytes(size) {
    if (size < 1024) {
      return `${size} B`;
    }
    const units = ["KB", "MB", "GB"];
    let value = size / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
  }
  function clamp2(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function guessMime(fileName) {
    const extension = fileName.toLowerCase().split(".").pop();
    if (extension === "mp3") {
      return "audio/mpeg";
    }
    if (extension === "ogg" || extension === "opus") {
      return "audio/ogg";
    }
    if (extension === "flac") {
      return "audio/flac";
    }
    if (extension === "m4a" || extension === "aac") {
      return "audio/mp4";
    }
    return "audio/wav";
  }

  // src/webview/app.ts
  var MIN_DRAG_PIXELS = 6;
  var PLOT_MARGIN = { left: 78, top: 18, right: 18, bottom: 40 };
  var AXIS_FONT_SIZE = 13;
  var PLOT_HEIGHT_LIMITS = { waveformMin: 160, waveformMax: 520, spectrogramMin: 220, spectrogramMax: 860 };
  var BAND_LIMITS = [
    { label: "0-250", min: 0, max: 250 },
    { label: "250-500", min: 250, max: 500 },
    { label: "0.5-1k", min: 500, max: 1e3 },
    { label: "1-2k", min: 1e3, max: 2e3 },
    { label: "2-4k", min: 2e3, max: 4e3 },
    { label: "4-8k", min: 4e3, max: 8e3 },
    { label: "8k+", min: 8e3, max: Number.POSITIVE_INFINITY }
  ];
  var AudioLensApp = class {
    constructor(vscode2, elements) {
      this.vscode = vscode2;
      this.elements = elements;
      this.syncPlatformShortcuts();
      this.bindUi();
      this.updateSelectionAnalysis();
      this.bindWorker();
    }
    config;
    audioBuffer;
    audioBytes;
    objectUrl;
    requestSeq = 1;
    pendingAnalysisKey;
    lastSpectrogram;
    playheadTime;
    sourceSampleRate;
    selection;
    selectionPlaybackEnd;
    playbackFrameId;
    preferencesSaveTimer;
    analysisTimer;
    pendingChunks = /* @__PURE__ */ new Map();
    spectrogramCache = /* @__PURE__ */ new Map();
    waveformCache = /* @__PURE__ */ new Map();
    worker = createAnalysisWorker();
    settings = {
      algorithm: "frequency",
      windowFunction: "hann",
      fftSize: 2048,
      zeroPaddingFactor: 1,
      channel: 0,
      minDb: -96,
      maxDb: 0,
      amplitudeZoom: 1,
      timeZoom: 1,
      timeOffset: 0,
      frequencyScale: "linear",
      palette: "rose"
    };
    async handleMessage(message) {
      switch (message.type) {
        case "bootstrap":
          this.config = message.config;
          this.settings.windowFunction = message.config.analysis.windowFunction;
          this.settings.fftSize = message.config.analysis.fftSize;
          this.applyPreferences(message.preferences);
          this.syncControls();
          await this.load(message.metadata);
          break;
        case "fileChanged":
          await this.load(message.metadata);
          break;
        case "chunk":
          this.resolveChunk(message);
          break;
        case "error":
          this.setStatus(message.message);
          break;
      }
    }
    bindWorker() {
      this.worker.addEventListener("message", (event) => {
        this.drawSpectrogramResult(event.data);
      });
    }
    syncPlatformShortcuts() {
      const modifier = isMacPlatform() ? "\u2318" : "Ctrl";
      document.querySelectorAll("[data-time-zoom-modifier]").forEach((element) => {
        element.textContent = modifier;
      });
    }
    resetAnalysisWorker() {
      this.worker.terminate();
      this.worker = createAnalysisWorker();
      this.bindWorker();
    }
    async load(metadata) {
      this.elements.fileMeta.textContent = `${metadata.fileName} \xB7 ${formatBytes(metadata.size)}`;
      if (!metadata.trusted) {
        this.setStatus("\u5DE5\u4F5C\u533A\u672A\u53D7\u4FE1\u4EFB");
        return;
      }
      if (!this.config) {
        return;
      }
      const maxBytes = this.config.maxFileSizeMB * 1024 * 1024;
      if (metadata.size > maxBytes) {
        this.setStatus(`\u6587\u4EF6\u8D85\u8FC7\u9650\u5236\uFF1A${formatBytes(metadata.size)} / ${this.config.maxFileSizeMB} MB`);
        return;
      }
      this.setStatus("\u8BFB\u53D6\u97F3\u9891");
      this.audioBytes = await this.readAll(metadata.size);
      const facts = readAudioFileFacts(this.audioBytes, metadata.fileName);
      this.setStatus("\u89E3\u7801\u97F3\u9891");
      this.stopPlaybackTicker();
      const audioContext = facts.sampleRate ? new AudioContext({ sampleRate: facts.sampleRate }) : new AudioContext();
      this.audioBuffer = await audioContext.decodeAudioData(toArrayBuffer(this.audioBytes));
      this.sourceSampleRate = facts.sampleRate ?? this.audioBuffer.sampleRate;
      await audioContext.close();
      this.spectrogramCache.clear();
      this.waveformCache.clear();
      this.lastSpectrogram = void 0;
      this.selection = void 0;
      this.playheadTime = void 0;
      this.selectionPlaybackEnd = void 0;
      this.updateSelectionAnalysis();
      this.installAudioElement(metadata.fileName);
      this.populateChannels();
      this.redrawVisuals();
      if (this.config.autoAnalyze) {
        this.analyze();
      }
      this.setStatus("\u5C31\u7EEA");
    }
    bindUi() {
      this.elements.play.addEventListener("click", () => {
        void this.togglePlayback();
      });
      this.elements.audio.addEventListener("play", () => {
        this.elements.play.textContent = "\u23F8";
        this.startPlaybackTicker();
      });
      this.elements.audio.addEventListener("pause", () => {
        this.elements.play.textContent = "\u25B6";
        this.stopPlaybackTicker();
        this.syncPlaybackState({ redraw: true });
      });
      this.elements.audio.addEventListener("loadedmetadata", () => {
        this.updateClock();
        this.setStatus("\u97F3\u9891\u5DF2\u52A0\u8F7D");
      });
      this.elements.audio.addEventListener("error", () => {
        const detail = this.elements.audio.error?.message || "\u5F53\u524D\u97F3\u9891\u65E0\u6CD5\u88AB Webview \u64AD\u653E";
        this.reportPlaybackError(detail);
      });
      this.elements.audio.addEventListener("timeupdate", () => {
        this.syncPlaybackState({ redraw: this.playbackFrameId === void 0 });
      });
      this.elements.seek.addEventListener("input", () => {
        if (!Number.isNaN(this.elements.audio.duration)) {
          this.selectionPlaybackEnd = void 0;
          this.playheadTime = Number(this.elements.seek.value) / 1e3 * this.elements.audio.duration;
          this.elements.audio.currentTime = this.playheadTime;
          this.updateClock();
          this.redrawVisuals();
        }
      });
      this.elements.settingsToggle.addEventListener("click", () => {
        this.elements.settingsPanel.hidden = !this.elements.settingsPanel.hidden;
      });
      this.elements.settingsClose.addEventListener("click", () => {
        this.elements.settingsPanel.hidden = true;
      });
      this.elements.algorithm.addEventListener("change", () => {
        this.settings.algorithm = this.elements.algorithm.value;
        this.savePreferencesSoon();
        this.analyze();
      });
      this.elements.windowFunction.addEventListener("change", () => {
        this.settings.windowFunction = this.elements.windowFunction.value;
        this.savePreferencesSoon();
        this.analyze();
        this.updateSelectionAnalysis();
      });
      this.elements.fftSize.addEventListener("change", () => {
        this.settings.fftSize = Number(this.elements.fftSize.value);
        this.savePreferencesSoon();
        this.analyze();
        this.updateSelectionAnalysis();
      });
      this.elements.zeroPaddingFactor.addEventListener("change", () => {
        this.settings.zeroPaddingFactor = Number(this.elements.zeroPaddingFactor.value);
        this.savePreferencesSoon();
        this.analyze();
      });
      this.elements.channel.addEventListener("change", () => {
        this.settings.channel = Number(this.elements.channel.value);
        this.waveformCache.clear();
        this.analyze();
        this.updateSelectionAnalysis();
        this.redrawVisuals();
      });
      this.elements.frequencyScale.addEventListener("change", () => {
        this.settings.frequencyScale = this.elements.frequencyScale.value;
        this.savePreferencesSoon();
        this.analyze();
      });
      this.elements.palette.addEventListener("change", () => {
        this.settings.palette = this.elements.palette.value;
        this.savePreferencesSoon();
        this.analyze();
      });
      for (const input of this.analysisInputs()) {
        input.addEventListener("input", () => this.updateAnalysisSettings());
      }
      this.elements.analyze.addEventListener("click", () => this.analyze());
      this.elements.resetView.addEventListener("click", () => this.resetView());
      this.bindFigureInteraction(this.elements.waveform);
      this.bindFigureInteraction(this.elements.spectrogram);
      this.bindPlotResizer(this.elements.waveformResize, this.elements.waveformPane, "--waveform-height", PLOT_HEIGHT_LIMITS.waveformMin, PLOT_HEIGHT_LIMITS.waveformMax);
      this.bindPlotResizer(this.elements.spectrogramResize, this.elements.spectrogramPane, "--spectrogram-height", PLOT_HEIGHT_LIMITS.spectrogramMin, PLOT_HEIGHT_LIMITS.spectrogramMax);
      window.addEventListener("keydown", (event) => this.onKeyDown(event));
      window.addEventListener("resize", () => {
        this.redrawVisuals();
        this.scheduleAnalyze();
      });
    }
    async togglePlayback() {
      if (!this.elements.audio.src) {
        this.reportPlaybackError("\u97F3\u9891\u5C1A\u672A\u52A0\u8F7D\u5B8C\u6210");
        return;
      }
      try {
        if (this.elements.audio.paused) {
          this.preparePlaybackStart();
          await this.elements.audio.play();
        } else {
          this.selectionPlaybackEnd = void 0;
          this.elements.audio.pause();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.reportPlaybackError(message);
      }
    }
    preparePlaybackStart() {
      if (!this.audioBuffer) {
        return;
      }
      if (this.selection) {
        this.elements.audio.currentTime = this.selection.start;
        this.playheadTime = this.selection.start;
        this.selectionPlaybackEnd = this.selection.end;
        this.redrawVisuals();
        return;
      }
      if (this.playheadTime === void 0) {
        this.elements.audio.currentTime = 0;
        this.playheadTime = 0;
        this.redrawVisuals();
        return;
      }
      this.elements.audio.currentTime = clamp2(this.playheadTime, 0, this.audioBuffer.duration);
    }
    startPlaybackTicker() {
      if (this.playbackFrameId !== void 0) {
        return;
      }
      const tick = () => {
        this.syncPlaybackState({ redraw: true });
        if (!this.elements.audio.paused) {
          this.playbackFrameId = requestAnimationFrame(tick);
        } else {
          this.playbackFrameId = void 0;
        }
      };
      this.playbackFrameId = requestAnimationFrame(tick);
    }
    stopPlaybackTicker() {
      if (this.playbackFrameId === void 0) {
        return;
      }
      cancelAnimationFrame(this.playbackFrameId);
      this.playbackFrameId = void 0;
    }
    syncPlaybackState(options) {
      const audio = this.elements.audio;
      if (this.selectionPlaybackEnd !== void 0 && audio.currentTime >= this.selectionPlaybackEnd) {
        const end = this.selectionPlaybackEnd;
        this.selectionPlaybackEnd = void 0;
        audio.pause();
        audio.currentTime = end;
        this.playheadTime = end;
      } else {
        this.playheadTime = audio.currentTime;
      }
      this.updateClock();
      if (!Number.isNaN(audio.duration) && audio.duration > 0) {
        this.elements.seek.value = String(audio.currentTime / audio.duration * 1e3);
      }
      if (options.redraw) {
        this.redrawVisuals();
      }
    }
    onKeyDown(event) {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        void this.togglePlayback();
      }
      if (event.code === "Escape") {
        event.preventDefault();
        this.handleEscape();
      }
    }
    handleEscape() {
      if (this.selection) {
        this.selection = void 0;
        this.selectionPlaybackEnd = void 0;
        this.updateSelectionAnalysis();
        this.redrawVisuals();
        return;
      }
      this.elements.audio.pause();
      this.elements.audio.currentTime = 0;
      this.playheadTime = void 0;
      this.selectionPlaybackEnd = void 0;
      this.elements.seek.value = "0";
      this.updateClock();
      this.redrawVisuals();
    }
    reportPlaybackError(message) {
      const detail = "\u64AD\u653E\u5931\u8D25\uFF1A" + message;
      this.setStatus(detail);
      this.vscode.postMessage({ type: "showError", message: detail });
    }
    syncControls() {
      this.elements.algorithm.value = this.settings.algorithm;
      this.elements.windowFunction.value = this.settings.windowFunction;
      this.elements.fftSize.value = String(this.settings.fftSize);
      this.elements.zeroPaddingFactor.value = String(this.settings.zeroPaddingFactor);
      this.elements.timeZoom.value = String(this.settings.timeZoom);
      this.elements.timeOffset.value = String(this.settings.timeOffset);
      this.elements.amplitudeZoom.value = String(this.settings.amplitudeZoom);
      this.elements.minDb.value = String(this.settings.minDb);
      this.elements.maxDb.value = String(this.settings.maxDb);
      this.elements.frequencyScale.value = this.settings.frequencyScale;
      this.elements.palette.value = this.settings.palette;
    }
    analysisInputs() {
      return [
        this.elements.timeZoom,
        this.elements.timeOffset,
        this.elements.amplitudeZoom,
        this.elements.minDb,
        this.elements.maxDb
      ];
    }
    updateAnalysisSettings() {
      this.settings.timeZoom = clamp2(Number(this.elements.timeZoom.value), 1, 64);
      this.settings.timeOffset = clamp2(Number(this.elements.timeOffset.value), 0, 1);
      this.settings.amplitudeZoom = clamp2(Number(this.elements.amplitudeZoom.value), 0.25, 32);
      const range = normalizeDbRange(Number(this.elements.minDb.value), Number(this.elements.maxDb.value));
      this.settings.minDb = range.minDb;
      this.settings.maxDb = range.maxDb;
      this.savePreferencesSoon();
      this.syncControls();
      this.redrawVisuals();
      this.analyze();
    }
    applyPreferences(preferences) {
      if (preferences.algorithm) {
        this.settings.algorithm = preferences.algorithm;
      }
      if (preferences.windowFunction) {
        this.settings.windowFunction = preferences.windowFunction;
      }
      if (preferences.fftSize) {
        this.settings.fftSize = preferences.fftSize;
      }
      if (preferences.zeroPaddingFactor) {
        this.settings.zeroPaddingFactor = preferences.zeroPaddingFactor;
      }
      if (preferences.frequencyScale) {
        this.settings.frequencyScale = preferences.frequencyScale;
      }
      if (preferences.palette) {
        this.settings.palette = preferences.palette;
      }
      if (preferences.minDb !== void 0 && preferences.maxDb !== void 0) {
        const range = normalizeDbRange(preferences.minDb, preferences.maxDb);
        this.settings.minDb = range.minDb;
        this.settings.maxDb = range.maxDb;
      }
      if (preferences.amplitudeZoom !== void 0) {
        this.settings.amplitudeZoom = clamp2(preferences.amplitudeZoom, 0.25, 32);
      }
      if (preferences.waveformHeight !== void 0) {
        this.setPlotHeight("--waveform-height", preferences.waveformHeight, PLOT_HEIGHT_LIMITS.waveformMin, PLOT_HEIGHT_LIMITS.waveformMax);
      }
      if (preferences.spectrogramHeight !== void 0) {
        this.setPlotHeight("--spectrogram-height", preferences.spectrogramHeight, PLOT_HEIGHT_LIMITS.spectrogramMin, PLOT_HEIGHT_LIMITS.spectrogramMax);
      }
    }
    savePreferencesSoon() {
      if (this.preferencesSaveTimer !== void 0) {
        window.clearTimeout(this.preferencesSaveTimer);
      }
      this.preferencesSaveTimer = window.setTimeout(() => {
        this.preferencesSaveTimer = void 0;
        this.vscode.postMessage({ type: "updatePreferences", preferences: this.collectPreferences() });
      }, 180);
    }
    collectPreferences() {
      return {
        algorithm: this.settings.algorithm,
        windowFunction: this.settings.windowFunction,
        fftSize: this.settings.fftSize,
        zeroPaddingFactor: this.settings.zeroPaddingFactor,
        frequencyScale: this.settings.frequencyScale,
        palette: this.settings.palette,
        minDb: this.settings.minDb,
        maxDb: this.settings.maxDb,
        amplitudeZoom: this.settings.amplitudeZoom,
        waveformHeight: this.getPlotHeight(this.elements.waveformPane),
        spectrogramHeight: this.getPlotHeight(this.elements.spectrogramPane)
      };
    }
    resetView() {
      this.settings.timeZoom = 1;
      this.settings.timeOffset = 0;
      this.settings.amplitudeZoom = 1;
      this.selection = void 0;
      this.selectionPlaybackEnd = void 0;
      this.hideSelectionBox();
      this.syncControls();
      this.savePreferencesSoon();
      this.updateSelectionAnalysis();
      this.redrawVisuals();
      this.analyze();
    }
    resolveChunk(message) {
      const resolve = this.pendingChunks.get(message.requestId);
      if (!resolve) {
        return;
      }
      this.pendingChunks.delete(message.requestId);
      resolve(message);
    }
    async readAll(size) {
      const target = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const length = Math.min(DEFAULT_CHUNK_SIZE, size - offset);
        const requestId = this.requestSeq;
        this.requestSeq += 1;
        const chunk = await new Promise((resolve) => {
          this.pendingChunks.set(requestId, resolve);
          this.vscode.postMessage({ type: "readChunk", requestId, offset, length });
        });
        const bytes = new Uint8Array(chunk.bytes);
        target.set(bytes, offset);
        offset += bytes.byteLength;
        this.setStatus(`\u8BFB\u53D6\u97F3\u9891 ${Math.round(offset / size * 100)}%`);
      }
      return target;
    }
    installAudioElement(fileName) {
      if (!this.audioBytes) {
        return;
      }
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
      }
      this.objectUrl = URL.createObjectURL(new Blob([toArrayBuffer(this.audioBytes)], { type: guessMime(fileName) }));
      this.elements.audio.src = this.objectUrl;
      this.elements.audio.load();
      this.elements.seek.value = "0";
      this.updateClock();
    }
    populateChannels() {
      if (!this.audioBuffer) {
        return;
      }
      this.elements.channel.replaceChildren();
      for (let channel = 0; channel < this.audioBuffer.numberOfChannels; channel += 1) {
        const option = document.createElement("option");
        option.value = String(channel);
        option.textContent = `CH ${channel + 1}`;
        this.elements.channel.appendChild(option);
      }
      this.settings.channel = Math.min(this.settings.channel, this.audioBuffer.numberOfChannels - 1);
      this.elements.channel.value = String(this.settings.channel);
    }
    redrawVisuals() {
      this.drawWaveform();
      if (this.lastSpectrogram) {
        this.drawSpectrogramCanvas(this.lastSpectrogram);
      } else {
        this.drawEmptySpectrogram();
      }
    }
    drawWaveform() {
      if (!this.audioBuffer) {
        return;
      }
      const canvas = this.elements.waveform;
      const context = resizeCanvas(canvas);
      const range = this.visibleRange();
      const rect = this.getPlotRect(canvas);
      const width = canvas.width;
      const height = canvas.height;
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#101318";
      context.fillRect(0, 0, width, height);
      this.drawPlotFrame(context, rect);
      this.drawTimeAxis(context, rect, range);
      this.drawWaveformAxis(context, rect);
      const peaks = this.getWaveformPeaks(range.startSample, range.endSample, Math.max(1, Math.floor(rect.width)));
      const mid = rect.top + rect.height / 2;
      context.save();
      context.beginPath();
      context.rect(rect.left, rect.top, rect.width, rect.height);
      context.clip();
      context.strokeStyle = "#62d6a4";
      context.lineWidth = deviceLineWidth();
      context.beginPath();
      for (let i = 0; i < peaks.min.length; i += 1) {
        const x = rect.left + i;
        const min = peaks.min[i] ?? 0;
        const max = peaks.max[i] ?? 0;
        const minY = clamp2(mid - min * this.settings.amplitudeZoom * rect.height * 0.5, rect.top, rect.bottom);
        const maxY = clamp2(mid - max * this.settings.amplitudeZoom * rect.height * 0.5, rect.top, rect.bottom);
        const visibleTop = Math.min(minY, maxY);
        const visibleBottom = Math.max(minY, maxY);
        const halfPixel = deviceLineWidth() / 2;
        context.moveTo(x, visibleTop - halfPixel);
        context.lineTo(x, visibleBottom + halfPixel);
      }
      context.stroke();
      context.restore();
      this.drawSelectionOverlay(context, rect, range);
      this.drawPlayheadOverlay(context, rect, range);
      this.elements.viewRange.textContent = `${range.startTime.toFixed(3)}s - ${range.endTime.toFixed(3)}s`;
    }
    drawEmptySpectrogram() {
      const canvas = this.elements.spectrogram;
      const context = resizeCanvas(canvas);
      const rect = this.getPlotRect(canvas);
      const range = this.visibleRange();
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#101318";
      context.fillRect(0, 0, canvas.width, canvas.height);
      this.drawPlotFrame(context, rect);
      this.drawTimeAxis(context, rect, range);
      this.drawFrequencyAxis(context, rect);
    }
    scheduleAnalyze(delay = 80) {
      if (this.analysisTimer !== void 0) {
        window.clearTimeout(this.analysisTimer);
      }
      this.analysisTimer = window.setTimeout(() => {
        this.analysisTimer = void 0;
        this.analyze();
      }, delay);
    }
    analyze() {
      if (!this.audioBuffer) {
        return;
      }
      const { startSample, endSample } = this.visibleRange();
      const spectrogramRect = this.getPlotRect(this.elements.spectrogram);
      const targetFrames = Math.max(360, Math.min(1800, Math.floor(spectrogramRect.width / (window.devicePixelRatio || 1))));
      const outputBins = Math.max(192, Math.min(900, Math.floor(spectrogramRect.height / (window.devicePixelRatio || 1))));
      const cacheKey = createAnalysisCacheKey({
        channel: this.settings.channel,
        startSample,
        endSample,
        fftSize: this.settings.fftSize,
        windowFunction: this.settings.windowFunction,
        algorithm: this.settings.algorithm,
        zeroPaddingFactor: this.settings.zeroPaddingFactor,
        outputBins,
        targetFrames,
        minDb: this.settings.minDb,
        maxDb: this.settings.maxDb,
        frequencyScale: this.settings.frequencyScale,
        palette: this.settings.palette
      });
      const cached = this.spectrogramCache.get(cacheKey);
      if (cached) {
        this.drawSpectrogramResult(cached);
        return;
      }
      if (this.analysisTimer !== void 0) {
        window.clearTimeout(this.analysisTimer);
        this.analysisTimer = void 0;
      }
      if (this.pendingAnalysisKey) {
        this.resetAnalysisWorker();
      }
      const source = this.audioBuffer.getChannelData(this.settings.channel).slice(startSample, endSample);
      const windowSize = Math.min(this.settings.fftSize, Math.max(1, source.length));
      const hopSize = Math.max(1, Math.floor(Math.max(1, source.length - windowSize) / targetFrames));
      this.pendingAnalysisKey = cacheKey;
      this.setStatus("\u5206\u6790\u9891\u8C31");
      this.worker.postMessage(
        {
          type: "analyze",
          requestId: cacheKey,
          samples: source.buffer,
          sampleRate: this.analysisSampleRate(),
          settings: {
            algorithm: this.settings.algorithm,
            windowFunction: this.settings.windowFunction,
            fftSize: this.settings.fftSize,
            zeroPaddingFactor: this.settings.zeroPaddingFactor,
            outputBins,
            hopSize,
            minDb: this.settings.minDb,
            maxDb: this.settings.maxDb,
            frequencyScale: this.settings.frequencyScale,
            palette: this.settings.palette
          }
        },
        [source.buffer]
      );
      this.elements.analysisMeta.textContent = `${formatAlgorithm(this.settings.algorithm)} \xB7 ${formatWindowFunction(this.settings.windowFunction)} \xB7 ${this.settings.fftSize} \xB7 pad ${this.settings.zeroPaddingFactor} \xB7 ${this.settings.frequencyScale} \xB7 hop ${hopSize}`;
    }
    drawSpectrogramResult(result) {
      if (this.pendingAnalysisKey && result.requestId !== this.pendingAnalysisKey && !this.spectrogramCache.has(result.requestId)) {
        return;
      }
      if (result.requestId === this.pendingAnalysisKey) {
        this.spectrogramCache.set(result.requestId, result);
        this.pendingAnalysisKey = void 0;
      }
      this.lastSpectrogram = result;
      this.drawSpectrogramCanvas(result);
      this.setStatus("\u5C31\u7EEA");
    }
    drawSpectrogramCanvas(result) {
      const canvas = this.elements.spectrogram;
      const context = resizeCanvas(canvas);
      const rect = this.getPlotRect(canvas);
      const range = this.visibleRange();
      const image = new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height);
      const bufferCanvas = document.createElement("canvas");
      bufferCanvas.width = result.width;
      bufferCanvas.height = result.height;
      const bufferContext = bufferCanvas.getContext("2d", { alpha: false });
      if (!bufferContext) {
        return;
      }
      bufferContext.putImageData(image, 0, 0);
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#101318";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bufferCanvas, rect.left, rect.top, rect.width, rect.height);
      this.drawPlotFrame(context, rect);
      this.drawTimeAxis(context, rect, range);
      this.drawFrequencyAxis(context, rect);
      this.drawSelectionOverlay(context, rect, range);
      this.drawPlayheadOverlay(context, rect, range);
    }
    visibleRange() {
      if (!this.audioBuffer) {
        return { startSample: 0, endSample: 0, startTime: 0, endTime: 0 };
      }
      return getVisibleRange({
        duration: this.audioBuffer.duration,
        sampleRate: this.audioBuffer.sampleRate,
        timeZoom: this.settings.timeZoom,
        timeOffset: this.settings.timeOffset
      });
    }
    updateClock() {
      const current = formatTime(this.elements.audio.currentTime || 0);
      const duration = formatTime(Number.isFinite(this.elements.audio.duration) ? this.elements.audio.duration : 0);
      this.elements.clock.textContent = `${current} / ${duration}`;
    }
    setStatus(message) {
      this.elements.status.textContent = message;
    }
    getWaveformPeaks(startSample, endSample, width) {
      const cacheKey = `${this.settings.channel}:${startSample}:${endSample}:${width}`;
      const cached = this.waveformCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const samples = this.audioBuffer?.getChannelData(this.settings.channel);
      if (!samples || width <= 0) {
        return { min: new Float32Array(width), max: new Float32Array(width) };
      }
      const peaks = computeWaveformPeaks(samples, startSample, endSample, width);
      this.waveformCache.set(cacheKey, peaks);
      return peaks;
    }
    bindFigureInteraction(canvas) {
      let startX = 0;
      let isDragging = false;
      canvas.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.resetView();
      });
      canvas.addEventListener(
        "wheel",
        (event) => {
          this.handleWheel(event, canvas);
        },
        { passive: false }
      );
      canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        isDragging = true;
        startX = event.clientX;
        canvas.setPointerCapture(event.pointerId);
        this.updateSelectionBox(canvas, startX, event.clientX);
      });
      canvas.addEventListener("pointermove", (event) => {
        if (!isDragging) {
          return;
        }
        this.updateSelectionBox(canvas, startX, event.clientX);
      });
      canvas.addEventListener("pointerup", (event) => {
        if (!isDragging) {
          return;
        }
        isDragging = false;
        canvas.releasePointerCapture(event.pointerId);
        this.hideSelectionBox();
        if (Math.abs(startX - event.clientX) < MIN_DRAG_PIXELS) {
          this.setPlayheadFromPointer(canvas, event.clientX);
        } else {
          this.setSelectionFromPointer(canvas, startX, event.clientX);
        }
      });
    }
    handleWheel(event, canvas) {
      const timeZoomModifier = isTimeZoomModifier(event);
      if (!this.audioBuffer || !timeZoomModifier && !event.shiftKey && !event.altKey) {
        return;
      }
      event.preventDefault();
      if (timeZoomModifier) {
        const ratio = this.canvasXRatio(canvas, event.clientX);
        const anchorTime = this.timeFromCanvasX(canvas, event.clientX);
        const factor = event.deltaY < 0 ? 1.25 : 0.8;
        this.applyTimeZoom(this.settings.timeZoom * factor, anchorTime, ratio);
        this.syncControls();
        this.redrawVisuals();
        this.scheduleAnalyze();
        return;
      }
      if (event.shiftKey) {
        const range = this.visibleRange();
        const duration = this.audioBuffer.duration;
        const direction = event.deltaY > 0 ? 1 : -1;
        const viewDuration = range.endTime - range.startTime;
        this.panTime(direction * viewDuration * 0.12, duration);
        this.syncControls();
        this.redrawVisuals();
        this.scheduleAnalyze();
        return;
      }
      if (event.altKey) {
        const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
        this.settings.amplitudeZoom = clamp2(this.settings.amplitudeZoom * factor, 0.25, 32);
        this.syncControls();
        this.redrawVisuals();
      }
    }
    setPlayheadFromPointer(canvas, clientX) {
      if (!this.audioBuffer) {
        return;
      }
      const time = this.timeFromCanvasX(canvas, clientX);
      this.selection = void 0;
      this.selectionPlaybackEnd = void 0;
      this.updateSelectionAnalysis();
      this.playheadTime = clamp2(time, 0, this.audioBuffer.duration);
      this.elements.audio.currentTime = this.playheadTime;
      this.updateClock();
      this.redrawVisuals();
    }
    setSelectionFromPointer(canvas, fromX, toX) {
      if (!this.audioBuffer) {
        return;
      }
      const start = clamp2(this.timeFromCanvasX(canvas, fromX), 0, this.audioBuffer.duration);
      const end = clamp2(this.timeFromCanvasX(canvas, toX), 0, this.audioBuffer.duration);
      const selection = { start: Math.min(start, end), end: Math.max(start, end) };
      if (selection.end - selection.start < 1e-3) {
        return;
      }
      this.selection = selection;
      this.playheadTime = selection.start;
      this.selectionPlaybackEnd = void 0;
      this.elements.audio.currentTime = selection.start;
      this.updateClock();
      this.updateSelectionAnalysis();
      this.redrawVisuals();
    }
    updateSelectionBox(canvas, fromX, toX) {
      const canvasRect = canvas.getBoundingClientRect();
      const shellRect = this.elements.selectionBox.parentElement?.getBoundingClientRect();
      if (!shellRect) {
        return;
      }
      const plot = this.getCssPlotRect(canvas);
      const from = clamp2(fromX - canvasRect.left, plot.left, plot.right);
      const to = clamp2(toX - canvasRect.left, plot.left, plot.right);
      this.elements.selectionBox.hidden = false;
      this.elements.selectionBox.style.left = `${canvasRect.left - shellRect.left + Math.min(from, to)}px`;
      this.elements.selectionBox.style.top = `${canvasRect.top - shellRect.top + plot.top}px`;
      this.elements.selectionBox.style.width = `${Math.abs(from - to)}px`;
      this.elements.selectionBox.style.height = `${plot.height}px`;
    }
    hideSelectionBox() {
      this.elements.selectionBox.hidden = true;
    }
    bindPlotResizer(handle, pane, variableName, minHeight, maxHeight) {
      let startY = 0;
      let startHeight = 0;
      let frameId;
      const redraw = () => {
        frameId = void 0;
        this.redrawVisuals();
      };
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        startY = event.clientY;
        startHeight = pane.getBoundingClientRect().height;
        handle.setPointerCapture(event.pointerId);
        document.body.style.userSelect = "none";
      });
      handle.addEventListener("pointermove", (event) => {
        if (!handle.hasPointerCapture(event.pointerId)) {
          return;
        }
        const nextHeight = clamp2(startHeight + event.clientY - startY, minHeight, maxHeight);
        this.setPlotHeight(variableName, nextHeight, minHeight, maxHeight);
        if (frameId === void 0) {
          frameId = requestAnimationFrame(redraw);
        }
      });
      handle.addEventListener("pointerup", (event) => {
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
        document.body.style.userSelect = "";
        if (frameId !== void 0) {
          cancelAnimationFrame(frameId);
          frameId = void 0;
        }
        this.redrawVisuals();
        this.analyze();
        this.savePreferencesSoon();
      });
    }
    setPlotHeight(variableName, value, minHeight, maxHeight) {
      this.elements.figures.style.setProperty(variableName, `${Math.round(clamp2(value, minHeight, maxHeight))}px`);
    }
    getPlotHeight(pane) {
      return Math.round(pane.getBoundingClientRect().height);
    }
    updateSelectionAnalysis() {
      if (!this.audioBuffer || !this.selection) {
        this.elements.analysisStart.textContent = "--";
        this.elements.analysisEnd.textContent = "--";
        this.elements.analysisDuration.textContent = "--";
        this.elements.analysisRms.textContent = "--";
        this.elements.analysisPeak.textContent = "--";
        this.elements.analysisDominant.textContent = "--";
        this.renderFrequencyRows([]);
        return;
      }
      const samples = this.audioBuffer.getChannelData(this.settings.channel);
      const startSample = Math.floor(this.selection.start * this.audioBuffer.sampleRate);
      const endSample = Math.min(samples.length, Math.ceil(this.selection.end * this.audioBuffer.sampleRate));
      const count = Math.max(1, endSample - startSample);
      const stride = Math.max(1, Math.ceil(count / 2e6));
      let sumSquares = 0;
      let peak = 0;
      let measured = 0;
      for (let index = startSample; index < endSample; index += stride) {
        const value = samples[index] ?? 0;
        sumSquares += value * value;
        peak = Math.max(peak, Math.abs(value));
        measured += 1;
      }
      const spectrum = computeSpectrum(samples, startSample, endSample, this.analysisSampleRate(), this.settings.fftSize, this.settings.windowFunction);
      this.elements.analysisStart.textContent = `${this.selection.start.toFixed(3)}s`;
      this.elements.analysisEnd.textContent = `${this.selection.end.toFixed(3)}s`;
      this.elements.analysisDuration.textContent = `${(this.selection.end - this.selection.start).toFixed(3)}s`;
      this.elements.analysisRms.textContent = formatDb(amplitudeToDb(Math.sqrt(sumSquares / Math.max(1, measured))));
      this.elements.analysisPeak.textContent = formatDb(amplitudeToDb(peak));
      this.elements.analysisDominant.textContent = formatHz(spectrum.dominantHz);
      this.renderFrequencyRows(spectrum.bands);
    }
    renderFrequencyRows(bands) {
      this.elements.analysisBands.replaceChildren();
      const rows = bands.length > 0 ? bands : [{ label: "Bands", percent: Number.NaN }];
      for (const band of rows) {
        const row = document.createElement("tr");
        const name = document.createElement("th");
        const value = document.createElement("td");
        name.textContent = band.label;
        value.textContent = Number.isFinite(band.percent) ? `${band.percent.toFixed(1)}%` : "--";
        row.append(name, value);
        this.elements.analysisBands.appendChild(row);
      }
    }
    analysisSampleRate() {
      return this.sourceSampleRate ?? this.audioBuffer?.sampleRate ?? 1;
    }
    getPlotRect(canvas) {
      const ratio = window.devicePixelRatio || 1;
      const left = PLOT_MARGIN.left * ratio;
      const top = PLOT_MARGIN.top * ratio;
      const right = Math.max(left + 1, canvas.width - PLOT_MARGIN.right * ratio);
      const bottom = Math.max(top + 1, canvas.height - PLOT_MARGIN.bottom * ratio);
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }
    getCssPlotRect(canvas) {
      const ratio = window.devicePixelRatio || 1;
      const rect = this.getPlotRect(canvas);
      const left = rect.left / ratio;
      const top = rect.top / ratio;
      const right = rect.right / ratio;
      const bottom = rect.bottom / ratio;
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }
    drawPlotFrame(context, rect) {
      context.strokeStyle = "#2d3540";
      context.lineWidth = deviceLineWidth();
      context.strokeRect(rect.left, rect.top, rect.width, rect.height);
    }
    drawTimeAxis(context, rect, range) {
      context.save();
      context.fillStyle = "#9aa7b4";
      context.strokeStyle = "#25303a";
      context.font = axisFont();
      context.textAlign = "center";
      context.textBaseline = "top";
      const ticks = 5;
      for (let index = 0; index <= ticks; index += 1) {
        const ratio = index / ticks;
        const x = rect.left + ratio * rect.width;
        const time = range.startTime + ratio * (range.endTime - range.startTime);
        context.beginPath();
        context.moveTo(x, rect.top);
        context.lineTo(x, rect.bottom);
        context.stroke();
        context.fillText(`${time.toFixed(2)}s`, x, rect.bottom + devicePx(10));
      }
      context.restore();
    }
    drawWaveformAxis(context, rect) {
      context.save();
      context.fillStyle = "#9aa7b4";
      context.strokeStyle = "#35414d";
      context.font = axisFont();
      context.textAlign = "right";
      context.textBaseline = "middle";
      const values = [1 / this.settings.amplitudeZoom, 0, -1 / this.settings.amplitudeZoom];
      for (const value of values) {
        const y = rect.top + (0.5 - value * this.settings.amplitudeZoom * 0.5) * rect.height;
        context.beginPath();
        context.moveTo(rect.left, y);
        context.lineTo(rect.right, y);
        context.stroke();
        context.fillText(value.toFixed(2), rect.left - devicePx(10), y);
      }
      context.restore();
    }
    drawFrequencyAxis(context, rect) {
      if (!this.audioBuffer) {
        return;
      }
      context.save();
      context.fillStyle = "#9aa7b4";
      context.strokeStyle = "#25303a";
      context.font = axisFont();
      context.textAlign = "right";
      context.textBaseline = "middle";
      const nyquist = this.analysisSampleRate() / 2;
      const ticks = 5;
      for (let index = 0; index <= ticks; index += 1) {
        const ratio = index / ticks;
        const y = rect.bottom - ratio * rect.height;
        const frequency = frequencyFromRatio(ratio, this.settings.frequencyScale, nyquist);
        context.beginPath();
        context.moveTo(rect.left, y);
        context.lineTo(rect.right, y);
        context.stroke();
        context.fillText(formatHz(frequency), rect.left - devicePx(10), y);
      }
      context.restore();
    }
    drawSelectionOverlay(context, rect, range) {
      if (!this.selection) {
        return;
      }
      const start = this.timeToX(this.selection.start, rect, range);
      const end = this.timeToX(this.selection.end, rect, range);
      const left = clamp2(Math.min(start, end), rect.left, rect.right);
      const right = clamp2(Math.max(start, end), rect.left, rect.right);
      if (right <= rect.left || left >= rect.right || right - left < 1) {
        return;
      }
      context.save();
      context.fillStyle = "rgba(88, 166, 255, 0.18)";
      context.strokeStyle = "rgba(88, 166, 255, 0.85)";
      context.fillRect(left, rect.top, right - left, rect.height);
      context.strokeRect(left, rect.top, right - left, rect.height);
      context.restore();
    }
    drawPlayheadOverlay(context, rect, range) {
      if (this.playheadTime === void 0 || this.playheadTime < range.startTime || this.playheadTime > range.endTime) {
        return;
      }
      const x = this.timeToX(this.playheadTime, rect, range);
      context.save();
      context.strokeStyle = "#ffcc66";
      context.lineWidth = 2 * deviceLineWidth();
      context.beginPath();
      context.moveTo(x, rect.top);
      context.lineTo(x, rect.bottom);
      context.stroke();
      context.restore();
    }
    timeToX(time, rect, range) {
      const duration = Math.max(1e-3, range.endTime - range.startTime);
      return rect.left + (time - range.startTime) / duration * rect.width;
    }
    timeFromCanvasX(canvas, clientX) {
      const range = this.visibleRange();
      const ratio = this.canvasXRatio(canvas, clientX);
      return range.startTime + ratio * (range.endTime - range.startTime);
    }
    canvasXRatio(canvas, clientX) {
      const bounds = canvas.getBoundingClientRect();
      const plot = this.getPlotRect(canvas);
      const x = (clientX - bounds.left) * (canvas.width / Math.max(1, bounds.width));
      return clamp2((x - plot.left) / plot.width, 0, 1);
    }
    applyTimeZoom(nextZoom, anchorTime, anchorRatio) {
      if (!this.audioBuffer) {
        return;
      }
      const duration = this.audioBuffer.duration;
      this.settings.timeZoom = clamp2(nextZoom, 1, 64);
      const viewDuration = duration / this.settings.timeZoom;
      const maxStart = Math.max(0, duration - viewDuration);
      const startTime = clamp2(anchorTime - anchorRatio * viewDuration, 0, maxStart);
      this.settings.timeOffset = maxStart === 0 ? 0 : startTime / maxStart;
    }
    panTime(deltaSeconds, duration) {
      const viewDuration = duration / this.settings.timeZoom;
      const maxStart = Math.max(0, duration - viewDuration);
      const currentStart = maxStart * this.settings.timeOffset;
      const nextStart = clamp2(currentStart + deltaSeconds, 0, maxStart);
      this.settings.timeOffset = maxStart === 0 ? 0 : nextStart / maxStart;
    }
  };
  function toArrayBuffer(bytes) {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }
  function axisFont() {
    return `${Math.round(AXIS_FONT_SIZE * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
  }
  function deviceLineWidth() {
    return window.devicePixelRatio || 1;
  }
  function devicePx(value) {
    return value * (window.devicePixelRatio || 1);
  }
  function isTimeZoomModifier(event) {
    return isMacPlatform() ? event.metaKey : event.ctrlKey;
  }
  function isMacPlatform() {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
  }
  function isEditableTarget(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement;
  }
  function amplitudeToDb(value) {
    return 20 * Math.log10(Math.max(value, 1e-12));
  }
  function formatDb(value) {
    return `${value.toFixed(1)} dBFS`;
  }
  function formatAlgorithm(value) {
    if (value === "reassignment") {
      return "\u91CD\u65B0\u5206\u914D";
    }
    if (value === "pitchEac") {
      return "\u97F3\u9AD8(EAC)";
    }
    return "\u9891\u7387";
  }
  function formatWindowFunction(value) {
    const labels = {
      rectangular: "\u77E9\u5F62",
      bartlett: "Bartlett",
      hamming: "Hamming",
      hann: "Hann",
      blackman: "Blackman",
      blackmanHarris: "Blackman-Harris",
      welch: "Welch",
      gaussian25: "Gaussian 2.5",
      gaussian35: "Gaussian 3.5",
      gaussian45: "Gaussian 4.5"
    };
    return labels[value];
  }
  function formatHz(value) {
    if (value >= 1e3) {
      return `${(value / 1e3).toFixed(value >= 1e4 ? 1 : 2)} kHz`;
    }
    return `${Math.round(value)} Hz`;
  }
  function frequencyFromRatio(ratio, scale, nyquist) {
    const r = clamp2(ratio, 0, 1);
    const top = Math.max(1, nyquist);
    if (scale === "log") {
      if (r <= 0) {
        return 0;
      }
      const low = 20;
      return Math.min(top, low * Math.pow(top / low, r));
    }
    if (scale === "mel") {
      return melToHz(r * hzToMel(top));
    }
    if (scale === "bark") {
      return barkToHz(r * hzToBark(top));
    }
    if (scale === "erb") {
      return erbToHz(r * hzToErb(top));
    }
    return r * top;
  }
  function hzToMel(hz) {
    return 2595 * Math.log10(1 + hz / 700);
  }
  function melToHz(mel) {
    return 700 * (Math.pow(10, mel / 2595) - 1);
  }
  function hzToBark(hz) {
    return 6 * Math.asinh(hz / 600);
  }
  function barkToHz(bark) {
    return 600 * Math.sinh(bark / 6);
  }
  function hzToErb(hz) {
    return 21.4 * Math.log10(1 + 437e-5 * hz);
  }
  function erbToHz(erb) {
    return (Math.pow(10, erb / 21.4) - 1) / 437e-5;
  }
  function computeSpectrum(samples, startSample, endSample, sampleRate, requestedSize, windowFunction) {
    const available = Math.max(0, endSample - startSample);
    const fftSize = largestPowerOfTwo(Math.min(requestedSize, available));
    if (fftSize < 64) {
      return { dominantHz: 0, bands: BAND_LIMITS.map((band) => ({ label: band.label, percent: 0 })) };
    }
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const window2 = createWindow(windowFunction, fftSize);
    const offset = startSample + Math.max(0, Math.floor((available - fftSize) / 2));
    for (let index = 0; index < fftSize; index += 1) {
      re[index] = (samples[offset + index] ?? 0) * window2[index];
    }
    fft(re, im);
    let dominantBin = 1;
    let dominantPower = 0;
    let totalPower = 0;
    const bandPower = new Float64Array(BAND_LIMITS.length);
    for (let bin = 1; bin < fftSize / 2; bin += 1) {
      const power = re[bin] * re[bin] + im[bin] * im[bin];
      const frequency = bin * sampleRate / fftSize;
      totalPower += power;
      if (power > dominantPower) {
        dominantPower = power;
        dominantBin = bin;
      }
      const bandIndex = BAND_LIMITS.findIndex((band) => frequency >= band.min && frequency < band.max);
      if (bandIndex >= 0) {
        bandPower[bandIndex] += power;
      }
    }
    return {
      dominantHz: dominantBin * sampleRate / fftSize,
      bands: BAND_LIMITS.map((band, index) => ({
        label: band.label,
        percent: totalPower <= 0 ? 0 : bandPower[index] / totalPower * 100
      }))
    };
  }
  function largestPowerOfTwo(value) {
    let size = 1;
    while (size * 2 <= value) {
      size *= 2;
    }
    return size;
  }
  function createWindow(type, size) {
    const values = new Float32Array(size);
    const denom = Math.max(1, size - 1);
    const center = denom / 2;
    for (let i = 0; i < size; i += 1) {
      const phase = 2 * Math.PI * i / denom;
      const x = center === 0 ? 0 : (i - center) / center;
      if (type === "bartlett") {
        values[i] = 1 - Math.abs(x);
      } else if (type === "hamming") {
        values[i] = 0.54 - 0.46 * Math.cos(phase);
      } else if (type === "blackman") {
        values[i] = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
      } else if (type === "blackmanHarris") {
        values[i] = 0.35875 - 0.48829 * Math.cos(phase) + 0.14128 * Math.cos(2 * phase) - 0.01168 * Math.cos(3 * phase);
      } else if (type === "welch") {
        values[i] = 1 - x * x;
      } else if (type === "gaussian25") {
        values[i] = Math.exp(-0.5 * Math.pow(2.5 * x, 2));
      } else if (type === "gaussian35") {
        values[i] = Math.exp(-0.5 * Math.pow(3.5 * x, 2));
      } else if (type === "gaussian45") {
        values[i] = Math.exp(-0.5 * Math.pow(4.5 * x, 2));
      } else if (type === "rectangular") {
        values[i] = 1;
      } else {
        values[i] = 0.5 - 0.5 * Math.cos(phase);
      }
    }
    return values;
  }
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) {
        j ^= bit;
      }
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len;
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

  // src/webview/styles.ts
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
    :root {
      color-scheme: light dark;
    }
    * {
      box-sizing: border-box;
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
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr;
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
    .identity {
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex: 1;
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
    .status {
      color: var(--vscode-notificationsInfoIcon-foreground);
      white-space: nowrap;
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
    .secondaryIcon {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .iconButton:hover, .primary:hover, .secondary:hover {
      background: var(--vscode-button-hoverBackground);
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
      grid-template-columns: minmax(190px, 220px) 1fr;
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
    }
    .controls label, .settingsPanel label {
      display: grid;
      gap: 5px;
    }
    .controls label span, .settingsPanel label span {
      color: var(--vscode-descriptionForeground);
    }
    .controls select,
    .settingsPanel select,
    .settingsPanel input[type="number"] {
      width: 100%;
      min-height: 28px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 3px 6px;
    }
    .settingsPanel {
      position: absolute;
      z-index: 10;
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
      grid-template-rows: auto var(--waveform-height) 12px auto var(--spectrogram-height) 12px;
      gap: 8px;
      padding: 12px;
      overflow: auto;
      align-content: start;
      justify-items: stretch;
      scrollbar-gutter: stable;
    }
    .figureHeader {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--vscode-foreground);
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
      background: #101318;
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
      background: #101318;
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
      position: absolute;
      border: 1px solid rgba(88, 166, 255, 0.85);
      background: rgba(88, 166, 255, 0.18);
      pointer-events: none;
    }
    .selectionAnalysisPane {
      margin-top: auto;
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .paneTitle {
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .paneSubtitle {
      margin-top: 4px;
      color: var(--vscode-foreground);
      font-size: 0.92em;
      font-weight: 600;
    }
    .analysisTable {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
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
      width: 86px;
      padding-right: 8px;
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
      .selectionAnalysisPane {
        grid-column: 1 / -1;
        margin-top: 0;
      }
    }
  `;
    document.head.appendChild(style);
  }

  // src/webview/view.ts
  function renderShell(root2) {
    root2.innerHTML = /* html */
    `
    <main class="shell">
      <header class="topbar">
        <div class="identity">
          <strong class="brand">AudioLens</strong>
          <span id="fileMeta" class="muted">\u7B49\u5F85\u97F3\u9891\u6587\u4EF6</span>
        </div>
        <div id="status" class="status">\u521D\u59CB\u5316\u4E2D</div>
        <button id="settingsToggle" class="iconButton secondaryIcon" title="\u9891\u8C31\u8BBE\u7F6E" aria-label="\u9891\u8C31\u8BBE\u7F6E">\u2699</button>
      </header>

      <section class="player">
        <button id="play" class="iconButton" title="\u64AD\u653E/\u6682\u505C" aria-label="\u64AD\u653E/\u6682\u505C">\u25B6</button>
        <span id="clock" class="clock">0:00.000 / 0:00.000</span>
        <input id="seek" class="seek" type="range" min="0" max="1000" value="0" aria-label="\u64AD\u653E\u4F4D\u7F6E" />
        <audio id="audio" preload="auto"></audio>
      </section>

      <aside id="settingsPanel" class="settingsPanel" hidden>
        <div class="settingsHeader">
          <strong>\u9891\u8C31\u663E\u793A</strong>
          <button id="settingsClose" class="iconButton secondaryIcon" title="\u5173\u95ED\u8BBE\u7F6E" aria-label="\u5173\u95ED\u8BBE\u7F6E">\xD7</button>
        </div>
        <label>
          <span>\u7B97\u6CD5</span>
          <select id="algorithm">
            <option value="frequency">\u9891\u7387</option>
            <option value="reassignment">\u91CD\u65B0\u5206\u914D</option>
            <option value="pitchEac">\u97F3\u9AD8(EAC)</option>
          </select>
        </label>
        <label>
          <span>\u7A97\u53E3\u5927\u5C0F</span>
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
          <span>\u7A97\u53E3\u7C7B\u578B</span>
          <select id="windowFunction">
            <option value="rectangular">\u77E9\u5F62</option>
            <option value="bartlett">Bartlett</option>
            <option value="hamming">\u6C49\u660E(Hamming)</option>
            <option value="hann">\u6C49\u5B81(Hann)</option>
            <option value="blackman">Blackman</option>
            <option value="blackmanHarris">Blackman-Harris</option>
            <option value="welch">Welch</option>
            <option value="gaussian25">\u9AD8\u65AF(\u03B1=2.5)</option>
            <option value="gaussian35">\u9AD8\u65AF(\u03B1=3.5)</option>
            <option value="gaussian45">\u9AD8\u65AF(\u03B1=4.5)</option>
          </select>
        </label>
        <label>
          <span>\u96F6\u586B\u5145\u56E0\u5B50</span>
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
          <span>\u9891\u7387\u523B\u5EA6</span>
          <select id="frequencyScale">
            <option value="linear">Linear</option>
            <option value="log">Log</option>
            <option value="mel">Mel</option>
            <option value="bark">Bark</option>
            <option value="erb">ERB</option>
          </select>
        </label>
        <label>
          <span>\u914D\u8272</span>
          <select id="palette">
            <option value="rose">\u5F69\u8272\uFF08\u73AB\u7470\uFF09</option>
            <option value="classic">\u5F69\u8272\uFF08\u7ECF\u5178\uFF09</option>
            <option value="grayscale">\u7070\u5EA6</option>
            <option value="inverseGrayscale">\u53CD\u8F6C\u7070\u5EA6</option>
          </select>
        </label>
        <label>
          <span>\u4E0B\u9650 dB</span>
          <input id="minDb" type="number" min="-160" max="-1" step="1" value="-96" />
        </label>
        <label>
          <span>\u4E0A\u9650 dB</span>
          <input id="maxDb" type="number" min="-80" max="24" step="1" value="0" />
        </label>
      </aside>

      <section class="workspace">
        <aside class="controls">
          <label>
            <span>\u58F0\u9053</span>
            <select id="channel"></select>
          </label>
          <label>
            <span>\u65F6\u95F4\u7F29\u653E</span>
            <input id="timeZoom" type="range" min="1" max="64" step="0.25" value="1" />
            <small class="wheelHint"><kbd data-time-zoom-modifier>Ctrl</kbd> + \u6EDA\u8F6E</small>
          </label>
          <label>
            <span>\u65F6\u95F4\u4F4D\u7F6E</span>
            <input id="timeOffset" type="range" min="0" max="1" step="0.001" value="0" />
            <small class="wheelHint"><kbd>Shift</kbd> + \u6EDA\u8F6E</small>
          </label>
          <label>
            <span>\u5E45\u5EA6\u7F29\u653E</span>
            <input id="amplitudeZoom" type="range" min="0.25" max="32" step="0.25" value="1" />
            <small class="wheelHint"><kbd>Alt</kbd> + \u6EDA\u8F6E</small>
          </label>
          <button id="analyze" class="primary">\u5237\u65B0\u9891\u8C31</button>
          <button id="resetView" class="secondary">\u91CD\u7F6E\u89C6\u56FE</button>

          <section class="selectionAnalysisPane" aria-label="\u9009\u533A\u5206\u6790">
            <div class="paneTitle">\u9009\u533A\u5206\u6790</div>
            <table class="analysisTable">
              <tbody>
                <tr><th>\u5F00\u59CB</th><td id="analysisStart">--</td></tr>
                <tr><th>\u7ED3\u675F</th><td id="analysisEnd">--</td></tr>
                <tr><th>\u65F6\u957F</th><td id="analysisDuration">--</td></tr>
                <tr><th>RMS Lev DB</th><td id="analysisRms">--</td></tr>
                <tr><th>Peak Lev DB</th><td id="analysisPeak">--</td></tr>
                <tr><th>Dominant</th><td id="analysisDominant">--</td></tr>
              </tbody>
            </table>
            <div class="paneSubtitle">\u9891\u7387\u5206\u6790</div>
            <table class="analysisTable">
              <tbody id="analysisBands">
                <tr><th>Bands</th><td>--</td></tr>
              </tbody>
            </table>
          </section>
        </aside>

        <section id="figures" class="figures">
          <div class="figureHeader">
            <span>Waveform</span>
            <span id="viewRange" class="muted">0.000s - 0.000s</span>
          </div>
          <div id="waveformPane" class="plotPane waveformPane">
            <canvas id="waveform" class="waveform"></canvas>
          </div>
          <div id="waveformResize" class="plotResize" role="separator" aria-orientation="horizontal" title="\u8C03\u6574\u6CE2\u5F62\u9AD8\u5EA6"></div>
          <div class="figureHeader">
            <span>Spectrogram</span>
            <span id="analysisMeta" class="muted"></span>
          </div>
          <div id="spectrogramPane" class="plotPane spectrogramPane">
            <canvas id="spectrogram" class="spectrogram"></canvas>
          </div>
          <div id="spectrogramResize" class="plotResize" role="separator" aria-orientation="horizontal" title="\u8C03\u6574\u9891\u8C31\u9AD8\u5EA6"></div>
          <div id="selectionBox" class="selectionBox" hidden></div>
        </section>
      </section>

    </main>
  `;
    return {
      fileMeta: query("#fileMeta", HTMLSpanElement),
      status: query("#status", HTMLDivElement),
      play: query("#play", HTMLButtonElement),
      clock: query("#clock", HTMLSpanElement),
      seek: query("#seek", HTMLInputElement),
      audio: query("#audio", HTMLAudioElement),
      algorithm: query("#algorithm", HTMLSelectElement),
      zeroPaddingFactor: query("#zeroPaddingFactor", HTMLSelectElement),
      settingsToggle: query("#settingsToggle", HTMLButtonElement),
      settingsPanel: query("#settingsPanel", HTMLElement),
      settingsClose: query("#settingsClose", HTMLButtonElement),
      windowFunction: query("#windowFunction", HTMLSelectElement),
      fftSize: query("#fftSize", HTMLSelectElement),
      channel: query("#channel", HTMLSelectElement),
      timeZoom: query("#timeZoom", HTMLInputElement),
      timeOffset: query("#timeOffset", HTMLInputElement),
      amplitudeZoom: query("#amplitudeZoom", HTMLInputElement),
      minDb: query("#minDb", HTMLInputElement),
      maxDb: query("#maxDb", HTMLInputElement),
      frequencyScale: query("#frequencyScale", HTMLSelectElement),
      palette: query("#palette", HTMLSelectElement),
      analyze: query("#analyze", HTMLButtonElement),
      resetView: query("#resetView", HTMLButtonElement),
      viewRange: query("#viewRange", HTMLSpanElement),
      analysisMeta: query("#analysisMeta", HTMLSpanElement),
      analysisStart: query("#analysisStart", HTMLElement),
      analysisEnd: query("#analysisEnd", HTMLElement),
      analysisDuration: query("#analysisDuration", HTMLElement),
      analysisRms: query("#analysisRms", HTMLElement),
      analysisPeak: query("#analysisPeak", HTMLElement),
      analysisDominant: query("#analysisDominant", HTMLElement),
      analysisBands: query("#analysisBands", HTMLElement),
      figures: query("#figures", HTMLElement),
      waveformPane: query("#waveformPane", HTMLElement),
      spectrogramPane: query("#spectrogramPane", HTMLElement),
      waveformResize: query("#waveformResize", HTMLDivElement),
      spectrogramResize: query("#spectrogramResize", HTMLDivElement),
      waveform: query("#waveform", HTMLCanvasElement),
      spectrogram: query("#spectrogram", HTMLCanvasElement),
      selectionBox: query("#selectionBox", HTMLDivElement)
    };
  }

  // src/webview/main.ts
  var root = document.querySelector("#app");
  if (!root) {
    throw new Error("AudioLens root element missing");
  }
  injectStyles();
  var vscode = acquireVsCodeApi();
  try {
    const app = new AudioLensApp(vscode, renderShell(root));
    window.addEventListener("message", (event) => {
      void app.handleMessage(event.data);
    });
    vscode.postMessage({ type: "ready" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.textContent = `AudioLens \u521D\u59CB\u5316\u5931\u8D25\uFF1A${message}`;
    vscode.postMessage({ type: "showError", message: `AudioLens \u521D\u59CB\u5316\u5931\u8D25\uFF1A${message}` });
  }
})();
