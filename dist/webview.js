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

  // src/webview/i18n/locales/de.ts
  var messages = {
    waitingAudioFile: "Warte auf Audiodatei",
    initializing: "Initialisierung",
    spectrogramSettings: "Spectrogram-Einstellungen",
    playPause: "Wiedergabe / Pause",
    playbackPosition: "Wiedergabeposition",
    closeSettings: "Einstellungen schliessen",
    spectrogramDisplay: "Spectrogram-Anzeige",
    algorithm: "Algorithmus",
    algorithmFrequency: "Frequenz",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Fenstergroesse",
    windowType: "Fenstertyp",
    windowRectangular: "Rechteck",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gauss (\u03B1=2.5)",
    windowGaussian35: "Gauss (\u03B1=3.5)",
    windowGaussian45: "Gauss (\u03B1=4.5)",
    zeroPaddingFactor: "Null-Padding-Faktor",
    frequencyScale: "Frequenzskala",
    palette: "Palette",
    paletteRose: "Rose",
    paletteClassic: "Klassisch",
    paletteGrayscale: "Graustufen",
    paletteInverseGrayscale: "Inverse Graustufen",
    minDb: "Min. dB",
    maxDb: "Max. dB",
    channel: "Kanal",
    timeZoom: "Zeitzoom",
    timePosition: "Zeitposition",
    amplitudeZoom: "Amplitudenzoom",
    mouseWheel: "Mausrad",
    refreshSpectrogram: "Spectrogram aktualisieren",
    resetView: "Ansicht zuruecksetzen",
    selectionAnalysis: "Auswahlanalyse",
    selectionStart: "Start",
    selectionEnd: "Ende",
    selectionDuration: "Dauer",
    rmsLevel: "RMS-Pegel",
    peakLevel: "Peak-Pegel",
    dominant: "Dominant",
    frequencyAnalysis: "Frequenzanalyse",
    bands: "Baender",
    waveform: "Wellenform",
    spectrogram: "Spectrogram",
    adjustWaveformHeight: "Wellenformhoehe anpassen",
    adjustSpectrogramHeight: "Spectrogram-Hoehe anpassen",
    ready: "Bereit",
    workspaceNotTrusted: "Arbeitsbereich nicht vertrauenswuerdig; Audioinhalte werden nicht uebertragen",
    fileTooLarge: "Datei ueberschreitet Limit",
    readingAudio: "Audio wird gelesen",
    readingAudioProgress: "Audio wird gelesen",
    decodingAudio: "Audio wird decodiert",
    audioLoaded: "Audio geladen",
    audioNotReady: "Audio ist nicht bereit",
    audioCannotPlay: "Dieses Audio kann im Webview nicht abgespielt werden",
    playbackFailed: "Wiedergabe fehlgeschlagen",
    analyzingSpectrogram: "Spectrogram wird analysiert",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens-Initialisierung fehlgeschlagen"
  };

  // src/webview/i18n/locales/en.ts
  var messages2 = {
    waitingAudioFile: "Waiting for audio file",
    initializing: "Initializing",
    spectrogramSettings: "Spectrogram settings",
    playPause: "Play / pause",
    playbackPosition: "Playback position",
    closeSettings: "Close settings",
    spectrogramDisplay: "Spectrogram display",
    algorithm: "Algorithm",
    algorithmFrequency: "Frequency",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Window size",
    windowType: "Window type",
    windowRectangular: "Rectangular",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "Zero padding factor",
    frequencyScale: "Frequency scale",
    palette: "Palette",
    paletteRose: "Rose",
    paletteClassic: "Classic",
    paletteGrayscale: "Grayscale",
    paletteInverseGrayscale: "Inverse grayscale",
    minDb: "Min dB",
    maxDb: "Max dB",
    channel: "Channel",
    timeZoom: "Time zoom",
    timePosition: "Time position",
    amplitudeZoom: "Amplitude zoom",
    mouseWheel: "Mouse wheel",
    refreshSpectrogram: "Refresh spectrogram",
    resetView: "Reset view",
    selectionAnalysis: "Selection analysis",
    selectionStart: "Start",
    selectionEnd: "End",
    selectionDuration: "Duration",
    rmsLevel: "RMS level",
    peakLevel: "Peak level",
    dominant: "Dominant",
    frequencyAnalysis: "Frequency analysis",
    bands: "Bands",
    waveform: "Waveform",
    spectrogram: "Spectrogram",
    adjustWaveformHeight: "Adjust waveform height",
    adjustSpectrogramHeight: "Adjust spectrogram height",
    ready: "Ready",
    workspaceNotTrusted: "Workspace not trusted; audio content is not transferred",
    fileTooLarge: "File exceeds limit",
    readingAudio: "Reading audio",
    readingAudioProgress: "Reading audio",
    decodingAudio: "Decoding audio",
    audioLoaded: "Audio loaded",
    audioNotReady: "Audio is not ready",
    audioCannotPlay: "This audio cannot be played in the webview",
    playbackFailed: "Playback failed",
    analyzingSpectrogram: "Analyzing spectrogram",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens initialization failed"
  };

  // src/webview/i18n/locales/es.ts
  var messages3 = {
    waitingAudioFile: "Esperando archivo de audio",
    initializing: "Inicializando",
    spectrogramSettings: "Ajustes del espectrograma",
    playPause: "Reproducir / pausar",
    playbackPosition: "Posici\xF3n de reproducci\xF3n",
    closeSettings: "Cerrar ajustes",
    spectrogramDisplay: "Vista del espectrograma",
    algorithm: "Algoritmo",
    algorithmFrequency: "Frecuencia",
    algorithmReassignment: "Reasignaci\xF3n",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Tama\xF1o de ventana",
    windowType: "Tipo de ventana",
    windowRectangular: "Rectangular",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussiana (\u03B1=2.5)",
    windowGaussian35: "Gaussiana (\u03B1=3.5)",
    windowGaussian45: "Gaussiana (\u03B1=4.5)",
    zeroPaddingFactor: "Factor de relleno cero",
    frequencyScale: "Escala de frecuencia",
    palette: "Paleta",
    paletteRose: "Rosa",
    paletteClassic: "Cl\xE1sica",
    paletteGrayscale: "Escala de grises",
    paletteInverseGrayscale: "Grises invertidos",
    minDb: "dB m\xEDn.",
    maxDb: "dB m\xE1x.",
    channel: "Canal",
    timeZoom: "Zoom de tiempo",
    timePosition: "Posici\xF3n temporal",
    amplitudeZoom: "Zoom de amplitud",
    mouseWheel: "Rueda del rat\xF3n",
    refreshSpectrogram: "Actualizar espectrograma",
    resetView: "Restablecer vista",
    selectionAnalysis: "An\xE1lisis de selecci\xF3n",
    selectionStart: "Inicio",
    selectionEnd: "Fin",
    selectionDuration: "Duraci\xF3n",
    rmsLevel: "Nivel RMS",
    peakLevel: "Nivel Peak",
    dominant: "Dominante",
    frequencyAnalysis: "An\xE1lisis de frecuencia",
    bands: "Bandas",
    waveform: "Forma de onda",
    spectrogram: "Espectrograma",
    adjustWaveformHeight: "Ajustar altura de forma de onda",
    adjustSpectrogramHeight: "Ajustar altura del espectrograma",
    ready: "Listo",
    workspaceNotTrusted: "\xC1rea no confiable; no se transfiere audio",
    fileTooLarge: "El archivo supera el l\xEDmite",
    readingAudio: "Leyendo audio",
    readingAudioProgress: "Leyendo audio",
    decodingAudio: "Decodificando audio",
    audioLoaded: "Audio cargado",
    audioNotReady: "El audio no est\xE1 listo",
    audioCannotPlay: "Este audio no se puede reproducir en el webview",
    playbackFailed: "Error de reproducci\xF3n",
    analyzingSpectrogram: "Analizando espectrograma",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "Error al inicializar AudioLens"
  };

  // src/webview/i18n/locales/fr.ts
  var messages4 = {
    waitingAudioFile: "En attente d'un fichier audio",
    initializing: "Initialisation",
    spectrogramSettings: "R\xE9glages du spectrogramme",
    playPause: "Lire / pause",
    playbackPosition: "Position de lecture",
    closeSettings: "Fermer les r\xE9glages",
    spectrogramDisplay: "Affichage du spectrogramme",
    algorithm: "Algorithme",
    algorithmFrequency: "Fr\xE9quence",
    algorithmReassignment: "R\xE9assignation",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Taille de fen\xEAtre",
    windowType: "Type de fen\xEAtre",
    windowRectangular: "Rectangulaire",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussienne (\u03B1=2.5)",
    windowGaussian35: "Gaussienne (\u03B1=3.5)",
    windowGaussian45: "Gaussienne (\u03B1=4.5)",
    zeroPaddingFactor: "Facteur de z\xE9ro-padding",
    frequencyScale: "\xC9chelle de fr\xE9quence",
    palette: "Palette",
    paletteRose: "Couleur (rose)",
    paletteClassic: "Couleur (classique)",
    paletteGrayscale: "Niveaux de gris",
    paletteInverseGrayscale: "Gris invers\xE9s",
    minDb: "dB min",
    maxDb: "dB max",
    channel: "Canal",
    timeZoom: "Zoom temporel",
    timePosition: "Position temporelle",
    amplitudeZoom: "Zoom d'amplitude",
    mouseWheel: "molette",
    refreshSpectrogram: "Actualiser le spectrogramme",
    resetView: "R\xE9initialiser la vue",
    selectionAnalysis: "Analyse de la s\xE9lection",
    selectionStart: "D\xE9but",
    selectionEnd: "Fin",
    selectionDuration: "Dur\xE9e",
    rmsLevel: "Niveau RMS dB",
    peakLevel: "Niveau Peak dB",
    dominant: "Dominante",
    frequencyAnalysis: "Analyse fr\xE9quentielle",
    bands: "Bandes",
    waveform: "Forme d'onde",
    spectrogram: "Spectrogramme",
    adjustWaveformHeight: "Ajuster la hauteur de la forme d'onde",
    adjustSpectrogramHeight: "Ajuster la hauteur du spectrogramme",
    ready: "Pr\xEAt",
    workspaceNotTrusted: "Espace non fiable",
    fileTooLarge: "Fichier au-del\xE0 de la limite",
    readingAudio: "Lecture de l'audio",
    readingAudioProgress: "Lecture de l'audio",
    decodingAudio: "D\xE9codage de l'audio",
    audioLoaded: "Audio charg\xE9",
    audioNotReady: "L'audio n'est pas pr\xEAt",
    audioCannotPlay: "Cet audio ne peut pas \xEAtre lu dans le Webview",
    playbackFailed: "\xC9chec de lecture",
    analyzingSpectrogram: "Analyse du spectrogramme",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "\xC9chec d'initialisation d'AudioLens"
  };

  // src/webview/i18n/locales/id.ts
  var messages5 = {
    waitingAudioFile: "Menunggu file audio",
    initializing: "Menginisialisasi",
    spectrogramSettings: "Pengaturan spectrogram",
    playPause: "Putar / jeda",
    playbackPosition: "Posisi putar",
    closeSettings: "Tutup pengaturan",
    spectrogramDisplay: "Tampilan spectrogram",
    algorithm: "Algoritma",
    algorithmFrequency: "Frekuensi",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Ukuran window",
    windowType: "Jenis window",
    windowRectangular: "Rectangular",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "Faktor zero padding",
    frequencyScale: "Skala frekuensi",
    palette: "Palet",
    paletteRose: "Rose",
    paletteClassic: "Klasik",
    paletteGrayscale: "Grayscale",
    paletteInverseGrayscale: "Grayscale terbalik",
    minDb: "Min dB",
    maxDb: "Maks dB",
    channel: "Kanal",
    timeZoom: "Zoom waktu",
    timePosition: "Posisi waktu",
    amplitudeZoom: "Zoom amplitudo",
    mouseWheel: "Roda mouse",
    refreshSpectrogram: "Segarkan spectrogram",
    resetView: "Reset tampilan",
    selectionAnalysis: "Analisis pilihan",
    selectionStart: "Mulai",
    selectionEnd: "Akhir",
    selectionDuration: "Durasi",
    rmsLevel: "Level RMS",
    peakLevel: "Level Peak",
    dominant: "Dominan",
    frequencyAnalysis: "Analisis frekuensi",
    bands: "Band",
    waveform: "Waveform",
    spectrogram: "Spectrogram",
    adjustWaveformHeight: "Atur tinggi waveform",
    adjustSpectrogramHeight: "Atur tinggi spectrogram",
    ready: "Siap",
    workspaceNotTrusted: "Workspace tidak tepercaya; konten audio tidak ditransfer",
    fileTooLarge: "File melebihi batas",
    readingAudio: "Membaca audio",
    readingAudioProgress: "Membaca audio",
    decodingAudio: "Mendekode audio",
    audioLoaded: "Audio dimuat",
    audioNotReady: "Audio belum siap",
    audioCannotPlay: "Audio ini tidak dapat diputar di webview",
    playbackFailed: "Pemutaran gagal",
    analyzingSpectrogram: "Menganalisis spectrogram",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "Inisialisasi AudioLens gagal"
  };

  // src/webview/i18n/locales/it.ts
  var messages6 = {
    waitingAudioFile: "In attesa del file audio",
    initializing: "Inizializzazione",
    spectrogramSettings: "Impostazioni spettrogramma",
    playPause: "Riproduci / pausa",
    playbackPosition: "Posizione di riproduzione",
    closeSettings: "Chiudi impostazioni",
    spectrogramDisplay: "Visualizzazione spettrogramma",
    algorithm: "Algoritmo",
    algorithmFrequency: "Frequenza",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Dimensione finestra",
    windowType: "Tipo finestra",
    windowRectangular: "Rettangolare",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussiana (\u03B1=2.5)",
    windowGaussian35: "Gaussiana (\u03B1=3.5)",
    windowGaussian45: "Gaussiana (\u03B1=4.5)",
    zeroPaddingFactor: "Fattore zero padding",
    frequencyScale: "Scala frequenza",
    palette: "Palette",
    paletteRose: "Rosa",
    paletteClassic: "Classica",
    paletteGrayscale: "Scala di grigi",
    paletteInverseGrayscale: "Grigi invertiti",
    minDb: "dB min",
    maxDb: "dB max",
    channel: "Canale",
    timeZoom: "Zoom tempo",
    timePosition: "Posizione tempo",
    amplitudeZoom: "Zoom ampiezza",
    mouseWheel: "Rotella mouse",
    refreshSpectrogram: "Aggiorna spettrogramma",
    resetView: "Reimposta vista",
    selectionAnalysis: "Analisi selezione",
    selectionStart: "Inizio",
    selectionEnd: "Fine",
    selectionDuration: "Durata",
    rmsLevel: "Livello RMS",
    peakLevel: "Livello Peak",
    dominant: "Dominante",
    frequencyAnalysis: "Analisi frequenze",
    bands: "Bande",
    waveform: "Forma d'onda",
    spectrogram: "Spettrogramma",
    adjustWaveformHeight: "Regola altezza forma d'onda",
    adjustSpectrogramHeight: "Regola altezza spettrogramma",
    ready: "Pronto",
    workspaceNotTrusted: "Workspace non attendibile; il contenuto audio non viene trasferito",
    fileTooLarge: "Il file supera il limite",
    readingAudio: "Lettura audio",
    readingAudioProgress: "Lettura audio",
    decodingAudio: "Decodifica audio",
    audioLoaded: "Audio caricato",
    audioNotReady: "Audio non pronto",
    audioCannotPlay: "Questo audio non puo essere riprodotto nella webview",
    playbackFailed: "Riproduzione non riuscita",
    analyzingSpectrogram: "Analisi spettrogramma",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "Inizializzazione di AudioLens non riuscita"
  };

  // src/webview/i18n/locales/ja.ts
  var messages7 = {
    waitingAudioFile: "\u97F3\u58F0\u30D5\u30A1\u30A4\u30EB\u5F85\u6A5F\u4E2D",
    initializing: "\u521D\u671F\u5316\u4E2D",
    spectrogramSettings: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u8A2D\u5B9A",
    playPause: "\u518D\u751F / \u4E00\u6642\u505C\u6B62",
    playbackPosition: "\u518D\u751F\u4F4D\u7F6E",
    closeSettings: "\u8A2D\u5B9A\u3092\u9589\u3058\u308B",
    spectrogramDisplay: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u8868\u793A",
    algorithm: "\u30A2\u30EB\u30B4\u30EA\u30BA\u30E0",
    algorithmFrequency: "\u5468\u6CE2\u6570",
    algorithmReassignment: "\u518D\u914D\u7F6E",
    algorithmPitchEac: "\u30D4\u30C3\u30C1 (EAC)",
    windowSize: "\u7A93\u30B5\u30A4\u30BA",
    windowType: "\u7A93\u30BF\u30A4\u30D7",
    windowRectangular: "\u77E9\u5F62",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "\u30BC\u30ED\u57CB\u3081\u4FC2\u6570",
    frequencyScale: "\u5468\u6CE2\u6570\u30B9\u30B1\u30FC\u30EB",
    palette: "\u30D1\u30EC\u30C3\u30C8",
    paletteRose: "\u30AB\u30E9\u30FC (rose)",
    paletteClassic: "\u30AB\u30E9\u30FC (classic)",
    paletteGrayscale: "\u30B0\u30EC\u30FC\u30B9\u30B1\u30FC\u30EB",
    paletteInverseGrayscale: "\u53CD\u8EE2\u30B0\u30EC\u30FC",
    minDb: "\u6700\u5C0F dB",
    maxDb: "\u6700\u5927 dB",
    channel: "\u30C1\u30E3\u30F3\u30CD\u30EB",
    timeZoom: "\u6642\u9593\u30BA\u30FC\u30E0",
    timePosition: "\u6642\u9593\u4F4D\u7F6E",
    amplitudeZoom: "\u632F\u5E45\u30BA\u30FC\u30E0",
    mouseWheel: "\u30DE\u30A6\u30B9\u30DB\u30A4\u30FC\u30EB",
    refreshSpectrogram: "\u518D\u5206\u6790",
    resetView: "\u8868\u793A\u3092\u30EA\u30BB\u30C3\u30C8",
    selectionAnalysis: "\u9078\u629E\u7BC4\u56F2\u5206\u6790",
    selectionStart: "\u958B\u59CB",
    selectionEnd: "\u7D42\u4E86",
    selectionDuration: "\u9577\u3055",
    rmsLevel: "RMS Lev DB",
    peakLevel: "Peak Lev DB",
    dominant: "\u512A\u52E2",
    frequencyAnalysis: "\u5468\u6CE2\u6570\u5206\u6790",
    bands: "\u5E2F\u57DF",
    waveform: "\u6CE2\u5F62",
    spectrogram: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0",
    adjustWaveformHeight: "\u6CE2\u5F62\u306E\u9AD8\u3055\u3092\u8ABF\u6574",
    adjustSpectrogramHeight: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u306E\u9AD8\u3055\u3092\u8ABF\u6574",
    ready: "\u6E96\u5099\u5B8C\u4E86",
    workspaceNotTrusted: "\u4FE1\u983C\u3055\u308C\u3066\u3044\u306A\u3044\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9",
    fileTooLarge: "\u30D5\u30A1\u30A4\u30EB\u304C\u4E0A\u9650\u3092\u8D85\u3048\u3066\u3044\u307E\u3059",
    readingAudio: "\u97F3\u58F0\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D",
    readingAudioProgress: "\u97F3\u58F0\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D",
    decodingAudio: "\u97F3\u58F0\u3092\u30C7\u30B3\u30FC\u30C9\u4E2D",
    audioLoaded: "\u97F3\u58F0\u3092\u8AAD\u307F\u8FBC\u307F\u307E\u3057\u305F",
    audioNotReady: "\u97F3\u58F0\u306E\u6E96\u5099\u304C\u3067\u304D\u3066\u3044\u307E\u305B\u3093",
    audioCannotPlay: "\u3053\u306E\u97F3\u58F0\u306F Webview \u3067\u518D\u751F\u3067\u304D\u307E\u305B\u3093",
    playbackFailed: "\u518D\u751F\u306B\u5931\u6557\u3057\u307E\u3057\u305F",
    analyzingSpectrogram: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u89E3\u6790\u4E2D",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens \u306E\u521D\u671F\u5316\u306B\u5931\u6557\u3057\u307E\u3057\u305F"
  };

  // src/webview/i18n/locales/ko.ts
  var messages8 = {
    waitingAudioFile: "\uC624\uB514\uC624 \uD30C\uC77C \uB300\uAE30 \uC911",
    initializing: "\uCD08\uAE30\uD654 \uC911",
    spectrogramSettings: "Spectrogram \uC124\uC815",
    playPause: "\uC7AC\uC0DD / \uC77C\uC2DC\uC815\uC9C0",
    playbackPosition: "\uC7AC\uC0DD \uC704\uCE58",
    closeSettings: "\uC124\uC815 \uB2EB\uAE30",
    spectrogramDisplay: "Spectrogram \uD45C\uC2DC",
    algorithm: "\uC54C\uACE0\uB9AC\uC998",
    algorithmFrequency: "\uC8FC\uD30C\uC218",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "\uC708\uB3C4\uC6B0 \uD06C\uAE30",
    windowType: "\uC708\uB3C4\uC6B0 \uC720\uD615",
    windowRectangular: "Rectangular",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "\uC81C\uB85C \uD328\uB529 \uACC4\uC218",
    frequencyScale: "\uC8FC\uD30C\uC218 \uC2A4\uCF00\uC77C",
    palette: "\uD314\uB808\uD2B8",
    paletteRose: "\uC0C9\uC0C1 (rose)",
    paletteClassic: "\uC0C9\uC0C1 (classic)",
    paletteGrayscale: "\uADF8\uB808\uC774\uC2A4\uCF00\uC77C",
    paletteInverseGrayscale: "\uBC18\uC804 \uADF8\uB808\uC774\uC2A4\uCF00\uC77C",
    minDb: "\uCD5C\uC18C dB",
    maxDb: "\uCD5C\uB300 dB",
    channel: "\uCC44\uB110",
    timeZoom: "\uC2DC\uAC04 \uD655\uB300",
    timePosition: "\uC2DC\uAC04 \uC704\uCE58",
    amplitudeZoom: "\uC9C4\uD3ED \uD655\uB300",
    mouseWheel: "\uB9C8\uC6B0\uC2A4 \uD720",
    refreshSpectrogram: "Spectrogram \uC0C8\uB85C\uACE0\uCE68",
    resetView: "\uBCF4\uAE30 \uCD08\uAE30\uD654",
    selectionAnalysis: "\uC120\uD0DD \uBD84\uC11D",
    selectionStart: "\uC2DC\uC791",
    selectionEnd: "\uB05D",
    selectionDuration: "\uAE38\uC774",
    rmsLevel: "RMS \uB808\uBCA8 DB",
    peakLevel: "Peak \uB808\uBCA8 DB",
    dominant: "\uC8FC\uC694",
    frequencyAnalysis: "\uC8FC\uD30C\uC218 \uBD84\uC11D",
    bands: "\uB300\uC5ED",
    waveform: "\uD30C\uD615",
    spectrogram: "Spectrogram",
    adjustWaveformHeight: "\uD30C\uD615 \uB192\uC774 \uC870\uC815",
    adjustSpectrogramHeight: "Spectrogram \uB192\uC774 \uC870\uC815",
    ready: "\uC900\uBE44\uB428",
    workspaceNotTrusted: "\uC2E0\uB8B0\uB418\uC9C0 \uC54A\uC740 \uC791\uC5C5 \uC601\uC5ED",
    fileTooLarge: "\uD30C\uC77C \uD55C\uB3C4 \uCD08\uACFC",
    readingAudio: "\uC624\uB514\uC624 \uC77D\uB294 \uC911",
    readingAudioProgress: "\uC624\uB514\uC624 \uC77D\uB294 \uC911",
    decodingAudio: "\uC624\uB514\uC624 \uB514\uCF54\uB529 \uC911",
    audioLoaded: "\uC624\uB514\uC624 \uB85C\uB4DC\uB428",
    audioNotReady: "\uC624\uB514\uC624\uAC00 \uC900\uBE44\uB418\uC9C0 \uC54A\uC74C",
    audioCannotPlay: "\uC774 \uC624\uB514\uC624\uB294 Webview\uC5D0\uC11C \uC7AC\uC0DD\uD560 \uC218 \uC5C6\uC74C",
    playbackFailed: "\uC7AC\uC0DD \uC2E4\uD328",
    analyzingSpectrogram: "Spectrogram \uBD84\uC11D \uC911",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens \uCD08\uAE30\uD654 \uC2E4\uD328"
  };

  // src/webview/i18n/locales/nl.ts
  var messages9 = {
    waitingAudioFile: "Wacht op audiobestand",
    initializing: "Initialiseren",
    spectrogramSettings: "Spectrograminstellingen",
    playPause: "Afspelen / pauze",
    playbackPosition: "Afspeelpositie",
    closeSettings: "Instellingen sluiten",
    spectrogramDisplay: "Spectrogramweergave",
    algorithm: "Algoritme",
    algorithmFrequency: "Frequentie",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Toonhoogte (EAC)",
    windowSize: "Venstergrootte",
    windowType: "Venstertype",
    windowRectangular: "Rechthoekig",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "Zero-paddingfactor",
    frequencyScale: "Frequentieschaal",
    palette: "Palet",
    paletteRose: "Roos",
    paletteClassic: "Klassiek",
    paletteGrayscale: "Grijswaarden",
    paletteInverseGrayscale: "Omgekeerde grijswaarden",
    minDb: "Min dB",
    maxDb: "Max dB",
    channel: "Kanaal",
    timeZoom: "Tijdzoom",
    timePosition: "Tijdpositie",
    amplitudeZoom: "Amplitudezoom",
    mouseWheel: "Muiswiel",
    refreshSpectrogram: "Spectrogram verversen",
    resetView: "Weergave resetten",
    selectionAnalysis: "Selectieanalyse",
    selectionStart: "Start",
    selectionEnd: "Einde",
    selectionDuration: "Duur",
    rmsLevel: "RMS-niveau",
    peakLevel: "Peak-niveau",
    dominant: "Dominant",
    frequencyAnalysis: "Frequentieanalyse",
    bands: "Banden",
    waveform: "Golfvorm",
    spectrogram: "Spectrogram",
    adjustWaveformHeight: "Golfvormhoogte aanpassen",
    adjustSpectrogramHeight: "Spectrogramhoogte aanpassen",
    ready: "Klaar",
    workspaceNotTrusted: "Werkruimte niet vertrouwd; audio-inhoud wordt niet overgedragen",
    fileTooLarge: "Bestand overschrijdt limiet",
    readingAudio: "Audio lezen",
    readingAudioProgress: "Audio lezen",
    decodingAudio: "Audio decoderen",
    audioLoaded: "Audio geladen",
    audioNotReady: "Audio is niet klaar",
    audioCannotPlay: "Deze audio kan niet in de webview worden afgespeeld",
    playbackFailed: "Afspelen mislukt",
    analyzingSpectrogram: "Spectrogram analyseren",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens-initialisatie mislukt"
  };

  // src/webview/i18n/locales/no.ts
  var messages10 = {
    waitingAudioFile: "Venter p\xE5 lydfil",
    initializing: "Initialiserer",
    spectrogramSettings: "Spectrogram-innstillinger",
    playPause: "Spill av / pause",
    playbackPosition: "Avspillingsposisjon",
    closeSettings: "Lukk innstillinger",
    spectrogramDisplay: "Spectrogram-visning",
    algorithm: "Algoritme",
    algorithmFrequency: "Frekvens",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Toneh\xF8yde (EAC)",
    windowSize: "Vindust\xF8rrelse",
    windowType: "Vindustype",
    windowRectangular: "Rektangul\xE6r",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "Nullutfyllingsfaktor",
    frequencyScale: "Frekvensskala",
    palette: "Palett",
    paletteRose: "Rose",
    paletteClassic: "Klassisk",
    paletteGrayscale: "Gr\xE5toner",
    paletteInverseGrayscale: "Inverterte gr\xE5toner",
    minDb: "Min dB",
    maxDb: "Maks dB",
    channel: "Kanal",
    timeZoom: "Tidszoom",
    timePosition: "Tidsposisjon",
    amplitudeZoom: "Amplitudezoom",
    mouseWheel: "Musehjul",
    refreshSpectrogram: "Oppdater spectrogram",
    resetView: "Tilbakestill visning",
    selectionAnalysis: "Utvalgsanalyse",
    selectionStart: "Start",
    selectionEnd: "Slutt",
    selectionDuration: "Varighet",
    rmsLevel: "RMS-niv\xE5",
    peakLevel: "Peak-niv\xE5",
    dominant: "Dominant",
    frequencyAnalysis: "Frekvensanalyse",
    bands: "B\xE5nd",
    waveform: "B\xF8lgeform",
    spectrogram: "Spectrogram",
    adjustWaveformHeight: "Juster b\xF8lgeformh\xF8yde",
    adjustSpectrogramHeight: "Juster spectrogram-h\xF8yde",
    ready: "Klar",
    workspaceNotTrusted: "Arbeidsomr\xE5det er ikke klarert; lydinnhold overf\xF8res ikke",
    fileTooLarge: "Filen overskrider grensen",
    readingAudio: "Leser lyd",
    readingAudioProgress: "Leser lyd",
    decodingAudio: "Dekoder lyd",
    audioLoaded: "Lyd lastet",
    audioNotReady: "Lyden er ikke klar",
    audioCannotPlay: "Denne lyden kan ikke spilles av i webview",
    playbackFailed: "Avspilling mislyktes",
    analyzingSpectrogram: "Analyserer spectrogram",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens-initialisering mislyktes"
  };

  // src/webview/i18n/locales/pl.ts
  var messages11 = {
    waitingAudioFile: "Oczekiwanie na plik audio",
    initializing: "Inicjalizacja",
    spectrogramSettings: "Ustawienia spektrogramu",
    playPause: "Odtw\xF3rz / pauza",
    playbackPosition: "Pozycja odtwarzania",
    closeSettings: "Zamknij ustawienia",
    spectrogramDisplay: "Widok spektrogramu",
    algorithm: "Algorytm",
    algorithmFrequency: "Cz\u0119stotliwo\u015B\u0107",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Rozmiar okna",
    windowType: "Typ okna",
    windowRectangular: "Prostok\u0105tne",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussowskie (\u03B1=2.5)",
    windowGaussian35: "Gaussowskie (\u03B1=3.5)",
    windowGaussian45: "Gaussowskie (\u03B1=4.5)",
    zeroPaddingFactor: "Wsp\xF3\u0142czynnik zero padding",
    frequencyScale: "Skala cz\u0119stotliwo\u015Bci",
    palette: "Paleta",
    paletteRose: "R\xF3\u017C",
    paletteClassic: "Klasyczna",
    paletteGrayscale: "Skala szaro\u015Bci",
    paletteInverseGrayscale: "Odwr\xF3cona szaro\u015B\u0107",
    minDb: "Min. dB",
    maxDb: "Maks. dB",
    channel: "Kana\u0142",
    timeZoom: "Powi\u0119kszenie czasu",
    timePosition: "Pozycja czasu",
    amplitudeZoom: "Powi\u0119kszenie amplitudy",
    mouseWheel: "K\xF3\u0142ko myszy",
    refreshSpectrogram: "Od\u015Bwie\u017C spektrogram",
    resetView: "Resetuj widok",
    selectionAnalysis: "Analiza zaznaczenia",
    selectionStart: "Start",
    selectionEnd: "Koniec",
    selectionDuration: "Czas trwania",
    rmsLevel: "Poziom RMS",
    peakLevel: "Poziom Peak",
    dominant: "Dominuj\u0105ca",
    frequencyAnalysis: "Analiza cz\u0119stotliwo\u015Bci",
    bands: "Pasma",
    waveform: "Przebieg",
    spectrogram: "Spektrogram",
    adjustWaveformHeight: "Dostosuj wysoko\u015B\u0107 przebiegu",
    adjustSpectrogramHeight: "Dostosuj wysoko\u015B\u0107 spektrogramu",
    ready: "Gotowe",
    workspaceNotTrusted: "Obszar roboczy nie jest zaufany; tre\u015B\u0107 audio nie jest przesy\u0142ana",
    fileTooLarge: "Plik przekracza limit",
    readingAudio: "Odczyt audio",
    readingAudioProgress: "Odczyt audio",
    decodingAudio: "Dekodowanie audio",
    audioLoaded: "Audio wczytane",
    audioNotReady: "Audio nie jest gotowe",
    audioCannotPlay: "Tego audio nie mo\u017Cna odtworzy\u0107 w webview",
    playbackFailed: "Odtwarzanie nie powiod\u0142o si\u0119",
    analyzingSpectrogram: "Analiza spektrogramu",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "Inicjalizacja AudioLens nie powiod\u0142a si\u0119"
  };

  // src/webview/i18n/locales/pt.ts
  var messages12 = {
    waitingAudioFile: "Aguardando \xE1udio",
    initializing: "Inicializando",
    spectrogramSettings: "Config. do espectrograma",
    playPause: "Reproduzir / pausar",
    playbackPosition: "Posi\xE7\xE3o de reprodu\xE7\xE3o",
    closeSettings: "Fechar ajustes",
    spectrogramDisplay: "Exibi\xE7\xE3o do espectrograma",
    algorithm: "Algoritmo",
    algorithmFrequency: "Frequ\xEAncia",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Tamanho da janela",
    windowType: "Tipo de janela",
    windowRectangular: "Retangular",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussiana (\u03B1=2.5)",
    windowGaussian35: "Gaussiana (\u03B1=3.5)",
    windowGaussian45: "Gaussiana (\u03B1=4.5)",
    zeroPaddingFactor: "Fator de zero padding",
    frequencyScale: "Escala de frequ\xEAncia",
    palette: "Paleta",
    paletteRose: "Rosa",
    paletteClassic: "Cl\xE1ssica",
    paletteGrayscale: "Tons de cinza",
    paletteInverseGrayscale: "Cinza inverso",
    minDb: "dB m\xEDn.",
    maxDb: "dB m\xE1x.",
    channel: "Canal",
    timeZoom: "Zoom temporal",
    timePosition: "Posi\xE7\xE3o temporal",
    amplitudeZoom: "Zoom de amplitude",
    mouseWheel: "Roda do mouse",
    refreshSpectrogram: "Atualizar espectrograma",
    resetView: "Redefinir vista",
    selectionAnalysis: "An\xE1lise da sele\xE7\xE3o",
    selectionStart: "In\xEDcio",
    selectionEnd: "Fim",
    selectionDuration: "Dura\xE7\xE3o",
    rmsLevel: "N\xEDvel RMS",
    peakLevel: "N\xEDvel Peak",
    dominant: "Dominante",
    frequencyAnalysis: "An\xE1lise de frequ\xEAncia",
    bands: "Bandas",
    waveform: "Forma de onda",
    spectrogram: "Espectrograma",
    adjustWaveformHeight: "Ajustar altura da forma de onda",
    adjustSpectrogramHeight: "Ajustar altura do espectrograma",
    ready: "Pronto",
    workspaceNotTrusted: "Workspace n\xE3o confi\xE1vel; o \xE1udio n\xE3o \xE9 transferido",
    fileTooLarge: "Arquivo excede o limite",
    readingAudio: "Lendo \xE1udio",
    readingAudioProgress: "Lendo \xE1udio",
    decodingAudio: "Decodificando \xE1udio",
    audioLoaded: "\xC1udio carregado",
    audioNotReady: "\xC1udio n\xE3o est\xE1 pronto",
    audioCannotPlay: "Este \xE1udio n\xE3o pode ser reproduzido no webview",
    playbackFailed: "Falha na reprodu\xE7\xE3o",
    analyzingSpectrogram: "Analisando espectrograma",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "Falha ao inicializar AudioLens"
  };

  // src/webview/i18n/locales/ru.ts
  var messages13 = {
    waitingAudioFile: "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E\u0444\u0430\u0439\u043B\u0430",
    initializing: "\u0418\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u044F",
    spectrogramSettings: "\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",
    playPause: "\u041F\u0443\u0441\u043A / \u043F\u0430\u0443\u0437\u0430",
    playbackPosition: "\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u044F",
    closeSettings: "\u0417\u0430\u043A\u0440\u044B\u0442\u044C \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",
    spectrogramDisplay: "\u041E\u0442\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",
    algorithm: "\u0410\u043B\u0433\u043E\u0440\u0438\u0442\u043C",
    algorithmFrequency: "\u0427\u0430\u0441\u0442\u043E\u0442\u0430",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "\u0412\u044B\u0441\u043E\u0442\u0430 \u0442\u043E\u043D\u0430 (EAC)",
    windowSize: "\u0420\u0430\u0437\u043C\u0435\u0440 \u043E\u043A\u043D\u0430",
    windowType: "\u0422\u0438\u043F \u043E\u043A\u043D\u0430",
    windowRectangular: "\u041F\u0440\u044F\u043C\u043E\u0443\u0433\u043E\u043B\u044C\u043D\u043E\u0435",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "\u041A\u043E\u044D\u0444. zero padding",
    frequencyScale: "\u0428\u043A\u0430\u043B\u0430 \u0447\u0430\u0441\u0442\u043E\u0442",
    palette: "\u041F\u0430\u043B\u0438\u0442\u0440\u0430",
    paletteRose: "\u0420\u043E\u0437\u0430",
    paletteClassic: "\u041A\u043B\u0430\u0441\u0441\u0438\u0447\u0435\u0441\u043A\u0430\u044F",
    paletteGrayscale: "\u0421\u0435\u0440\u0430\u044F \u0448\u043A\u0430\u043B\u0430",
    paletteInverseGrayscale: "\u0418\u043D\u0432\u0435\u0440\u0442. \u0441\u0435\u0440\u0430\u044F",
    minDb: "\u041C\u0438\u043D. dB",
    maxDb: "\u041C\u0430\u043A\u0441. dB",
    channel: "\u041A\u0430\u043D\u0430\u043B",
    timeZoom: "\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
    timePosition: "\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
    amplitudeZoom: "\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0430\u043C\u043F\u043B\u0438\u0442\u0443\u0434\u044B",
    mouseWheel: "\u041A\u043E\u043B\u0435\u0441\u043E \u043C\u044B\u0448\u0438",
    refreshSpectrogram: "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0443",
    resetView: "\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u0432\u0438\u0434",
    selectionAnalysis: "\u0410\u043D\u0430\u043B\u0438\u0437 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u044F",
    selectionStart: "\u041D\u0430\u0447\u0430\u043B\u043E",
    selectionEnd: "\u041A\u043E\u043D\u0435\u0446",
    selectionDuration: "\u0414\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C",
    rmsLevel: "\u0423\u0440\u043E\u0432\u0435\u043D\u044C RMS",
    peakLevel: "\u0423\u0440\u043E\u0432\u0435\u043D\u044C Peak",
    dominant: "\u0414\u043E\u043C\u0438\u043D\u0438\u0440\u0443\u044E\u0449\u0430\u044F",
    frequencyAnalysis: "\u0410\u043D\u0430\u043B\u0438\u0437 \u0447\u0430\u0441\u0442\u043E\u0442",
    bands: "\u041F\u043E\u043B\u043E\u0441\u044B",
    waveform: "\u0412\u043E\u043B\u043D\u0430",
    spectrogram: "\u0421\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0430",
    adjustWaveformHeight: "\u041D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u0432\u044B\u0441\u043E\u0442\u0443 \u0432\u043E\u043B\u043D\u044B",
    adjustSpectrogramHeight: "\u041D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u0432\u044B\u0441\u043E\u0442\u0443 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",
    ready: "\u0413\u043E\u0442\u043E\u0432\u043E",
    workspaceNotTrusted: "\u0420\u0430\u0431\u043E\u0447\u0430\u044F \u043E\u0431\u043B\u0430\u0441\u0442\u044C \u043D\u0435 \u0434\u043E\u0432\u0435\u0440\u0435\u043D\u0430; \u0430\u0443\u0434\u0438\u043E \u043D\u0435 \u043F\u0435\u0440\u0435\u0434\u0430\u0435\u0442\u0441\u044F",
    fileTooLarge: "\u0424\u0430\u0439\u043B \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 \u043B\u0438\u043C\u0438\u0442",
    readingAudio: "\u0427\u0442\u0435\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E",
    readingAudioProgress: "\u0427\u0442\u0435\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E",
    decodingAudio: "\u0414\u0435\u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E",
    audioLoaded: "\u0410\u0443\u0434\u0438\u043E \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E",
    audioNotReady: "\u0410\u0443\u0434\u0438\u043E \u043D\u0435 \u0433\u043E\u0442\u043E\u0432\u043E",
    audioCannotPlay: "\u042D\u0442\u043E \u0430\u0443\u0434\u0438\u043E \u043D\u0435\u043B\u044C\u0437\u044F \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0441\u0442\u0438 \u0432 webview",
    playbackFailed: "\u0421\u0431\u043E\u0439 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u044F",
    analyzingSpectrogram: "\u0410\u043D\u0430\u043B\u0438\u0437 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "\u0421\u0431\u043E\u0439 \u0438\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u0438 AudioLens"
  };

  // src/webview/i18n/locales/tr.ts
  var messages14 = {
    waitingAudioFile: "Ses dosyasi bekleniyor",
    initializing: "Baslatiliyor",
    spectrogramSettings: "Spektrogram ayarlari",
    playPause: "Oynat / duraklat",
    playbackPosition: "Oynatma konumu",
    closeSettings: "Ayarlari kapat",
    spectrogramDisplay: "Spektrogram gorunumu",
    algorithm: "Algoritma",
    algorithmFrequency: "Frekans",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Pitch (EAC)",
    windowSize: "Pencere boyutu",
    windowType: "Pencere tipi",
    windowRectangular: "Dikdortgen",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gauss (\u03B1=2.5)",
    windowGaussian35: "Gauss (\u03B1=3.5)",
    windowGaussian45: "Gauss (\u03B1=4.5)",
    zeroPaddingFactor: "Zero padding katsayisi",
    frequencyScale: "Frekans olcegi",
    palette: "Palet",
    paletteRose: "Gul",
    paletteClassic: "Klasik",
    paletteGrayscale: "Gri tonlama",
    paletteInverseGrayscale: "Ters gri tonlama",
    minDb: "Min dB",
    maxDb: "Maks dB",
    channel: "Kanal",
    timeZoom: "Zaman zumu",
    timePosition: "Zaman konumu",
    amplitudeZoom: "Genlik zumu",
    mouseWheel: "Fare tekeri",
    refreshSpectrogram: "Spektrogrami yenile",
    resetView: "Gorunumu sifirla",
    selectionAnalysis: "Secim analizi",
    selectionStart: "Baslangic",
    selectionEnd: "Bitis",
    selectionDuration: "Sure",
    rmsLevel: "RMS seviyesi",
    peakLevel: "Peak seviyesi",
    dominant: "Baskin",
    frequencyAnalysis: "Frekans analizi",
    bands: "Bantlar",
    waveform: "Dalga bicimi",
    spectrogram: "Spektrogram",
    adjustWaveformHeight: "Dalga bicimi yuksekligini ayarla",
    adjustSpectrogramHeight: "Spektrogram yuksekligini ayarla",
    ready: "Hazir",
    workspaceNotTrusted: "Calisma alani guvenilir degil; ses icerigi aktarilmaz",
    fileTooLarge: "Dosya siniri asiyor",
    readingAudio: "Ses okunuyor",
    readingAudioProgress: "Ses okunuyor",
    decodingAudio: "Ses cozuluyor",
    audioLoaded: "Ses yuklendi",
    audioNotReady: "Ses hazir degil",
    audioCannotPlay: "Bu ses webview icinde oynatilamiyor",
    playbackFailed: "Oynatma basarisiz",
    analyzingSpectrogram: "Spektrogram analiz ediliyor",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens baslatilamadi"
  };

  // src/webview/i18n/locales/vi.ts
  var messages15 = {
    waitingAudioFile: "\u0110ang ch\u1EDD t\u1EC7p \xE2m thanh",
    initializing: "\u0110ang kh\u1EDFi t\u1EA1o",
    spectrogramSettings: "C\xE0i \u0111\u1EB7t spectrogram",
    playPause: "Ph\xE1t / t\u1EA1m d\u1EEBng",
    playbackPosition: "V\u1ECB tr\xED ph\xE1t",
    closeSettings: "\u0110\xF3ng c\xE0i \u0111\u1EB7t",
    spectrogramDisplay: "Hi\u1EC3n th\u1ECB spectrogram",
    algorithm: "Thu\u1EADt to\xE1n",
    algorithmFrequency: "T\u1EA7n s\u1ED1",
    algorithmReassignment: "Reassignment",
    algorithmPitchEac: "Cao \u0111\u1ED9 (EAC)",
    windowSize: "K\xEDch th\u01B0\u1EDBc c\u1EEDa s\u1ED5",
    windowType: "Lo\u1EA1i c\u1EEDa s\u1ED5",
    windowRectangular: "Ch\u1EEF nh\u1EADt",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "H\u1EC7 s\u1ED1 zero padding",
    frequencyScale: "Thang t\u1EA7n s\u1ED1",
    palette: "B\u1EA3ng m\xE0u",
    paletteRose: "Rose",
    paletteClassic: "C\u1ED5 \u0111i\u1EC3n",
    paletteGrayscale: "Thang x\xE1m",
    paletteInverseGrayscale: "Thang x\xE1m \u0111\u1EA3o",
    minDb: "dB t\u1ED1i thi\u1EC3u",
    maxDb: "dB t\u1ED1i \u0111a",
    channel: "K\xEAnh",
    timeZoom: "Thu ph\xF3ng th\u1EDDi gian",
    timePosition: "V\u1ECB tr\xED th\u1EDDi gian",
    amplitudeZoom: "Thu ph\xF3ng bi\xEAn \u0111\u1ED9",
    mouseWheel: "Con l\u0103n chu\u1ED9t",
    refreshSpectrogram: "L\xE0m m\u1EDBi spectrogram",
    resetView: "\u0110\u1EB7t l\u1EA1i ch\u1EBF \u0111\u1ED9 xem",
    selectionAnalysis: "Ph\xE2n t\xEDch v\xF9ng ch\u1ECDn",
    selectionStart: "B\u1EAFt \u0111\u1EA7u",
    selectionEnd: "K\u1EBFt th\xFAc",
    selectionDuration: "Th\u1EDDi l\u01B0\u1EE3ng",
    rmsLevel: "M\u1EE9c RMS",
    peakLevel: "M\u1EE9c Peak",
    dominant: "Chi\u1EBFm \u01B0u th\u1EBF",
    frequencyAnalysis: "Ph\xE2n t\xEDch t\u1EA7n s\u1ED1",
    bands: "D\u1EA3i",
    waveform: "D\u1EA1ng s\xF3ng",
    spectrogram: "Spectrogram",
    adjustWaveformHeight: "\u0110i\u1EC1u ch\u1EC9nh chi\u1EC1u cao d\u1EA1ng s\xF3ng",
    adjustSpectrogramHeight: "\u0110i\u1EC1u ch\u1EC9nh chi\u1EC1u cao spectrogram",
    ready: "S\u1EB5n s\xE0ng",
    workspaceNotTrusted: "Workspace kh\xF4ng \u0111\xE1ng tin c\u1EADy; n\u1ED9i dung \xE2m thanh kh\xF4ng \u0111\u01B0\u1EE3c truy\u1EC1n",
    fileTooLarge: "T\u1EC7p v\u01B0\u1EE3t qu\xE1 gi\u1EDBi h\u1EA1n",
    readingAudio: "\u0110ang \u0111\u1ECDc \xE2m thanh",
    readingAudioProgress: "\u0110ang \u0111\u1ECDc \xE2m thanh",
    decodingAudio: "\u0110ang gi\u1EA3i m\xE3 \xE2m thanh",
    audioLoaded: "\u0110\xE3 t\u1EA3i \xE2m thanh",
    audioNotReady: "\xC2m thanh ch\u01B0a s\u1EB5n s\xE0ng",
    audioCannotPlay: "Kh\xF4ng th\u1EC3 ph\xE1t \xE2m thanh n\xE0y trong webview",
    playbackFailed: "Ph\xE1t th\u1EA5t b\u1EA1i",
    analyzingSpectrogram: "\u0110ang ph\xE2n t\xEDch spectrogram",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "Kh\u1EDFi t\u1EA1o AudioLens th\u1EA5t b\u1EA1i"
  };

  // src/webview/i18n/locales/zh-CN.ts
  var messages16 = {
    waitingAudioFile: "\u7B49\u5F85\u97F3\u9891\u6587\u4EF6",
    initializing: "\u6B63\u5728\u521D\u59CB\u5316",
    spectrogramSettings: "\u9891\u8C31\u56FE\u8BBE\u7F6E",
    playPause: "\u64AD\u653E / \u6682\u505C",
    playbackPosition: "\u64AD\u653E\u4F4D\u7F6E",
    closeSettings: "\u5173\u95ED\u8BBE\u7F6E",
    spectrogramDisplay: "\u9891\u8C31\u56FE\u663E\u793A",
    algorithm: "\u7B97\u6CD5",
    algorithmFrequency: "\u9891\u7387",
    algorithmReassignment: "\u91CD\u5206\u914D",
    algorithmPitchEac: "\u97F3\u9AD8 (EAC)",
    windowSize: "\u7A97\u53E3\u5927\u5C0F",
    windowType: "\u7A97\u53E3\u7C7B\u578B",
    windowRectangular: "\u77E9\u5F62",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "\u96F6\u586B\u5145\u56E0\u5B50",
    frequencyScale: "\u9891\u7387\u523B\u5EA6",
    palette: "\u8C03\u8272\u677F",
    paletteRose: "\u989C\u8272 (\u73AB\u7470)",
    paletteClassic: "\u989C\u8272 (\u7ECF\u5178)",
    paletteGrayscale: "\u7070\u5EA6",
    paletteInverseGrayscale: "\u53CD\u76F8\u7070\u5EA6",
    minDb: "\u6700\u5C0F dB",
    maxDb: "\u6700\u5927 dB",
    channel: "\u58F0\u9053",
    timeZoom: "\u65F6\u95F4\u7F29\u653E",
    timePosition: "\u65F6\u95F4\u4F4D\u7F6E",
    amplitudeZoom: "\u5E45\u5EA6\u7F29\u653E",
    mouseWheel: "\u9F20\u6807\u6EDA\u8F6E",
    refreshSpectrogram: "\u5237\u65B0\u9891\u8C31\u56FE",
    resetView: "\u91CD\u7F6E\u89C6\u56FE",
    selectionAnalysis: "\u9009\u533A\u5206\u6790",
    selectionStart: "\u5F00\u59CB",
    selectionEnd: "\u7ED3\u675F",
    selectionDuration: "\u65F6\u957F",
    rmsLevel: "RMS Lev DB",
    peakLevel: "Peak Lev DB",
    dominant: "\u4E3B\u9891",
    frequencyAnalysis: "\u9891\u7387\u5206\u6790",
    bands: "\u9891\u6BB5",
    waveform: "\u6CE2\u5F62",
    spectrogram: "\u9891\u8C31\u56FE",
    adjustWaveformHeight: "\u8C03\u6574\u6CE2\u5F62\u9AD8\u5EA6",
    adjustSpectrogramHeight: "\u8C03\u6574\u9891\u8C31\u56FE\u9AD8\u5EA6",
    ready: "\u5C31\u7EEA",
    workspaceNotTrusted: "\u5DE5\u4F5C\u533A\u4E0D\u53D7\u4FE1\u4EFB",
    fileTooLarge: "\u6587\u4EF6\u8D85\u8FC7\u9650\u5236",
    readingAudio: "\u6B63\u5728\u8BFB\u53D6\u97F3\u9891",
    readingAudioProgress: "\u6B63\u5728\u8BFB\u53D6\u97F3\u9891",
    decodingAudio: "\u6B63\u5728\u89E3\u7801\u97F3\u9891",
    audioLoaded: "\u97F3\u9891\u5DF2\u52A0\u8F7D",
    audioNotReady: "\u97F3\u9891\u5C1A\u672A\u5C31\u7EEA",
    audioCannotPlay: "\u6B64\u97F3\u9891\u65E0\u6CD5\u5728 Webview \u4E2D\u64AD\u653E",
    playbackFailed: "\u64AD\u653E\u5931\u8D25",
    analyzingSpectrogram: "\u6B63\u5728\u5206\u6790\u9891\u8C31\u56FE",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens \u521D\u59CB\u5316\u5931\u8D25"
  };

  // src/webview/i18n/locales/zh-TW.ts
  var messages17 = {
    waitingAudioFile: "\u7B49\u5F85\u97F3\u8A0A\u6A94\u6848",
    initializing: "\u521D\u59CB\u5316\u4E2D",
    spectrogramSettings: "\u983B\u8B5C\u5716\u8A2D\u5B9A",
    playPause: "\u64AD\u653E / \u66AB\u505C",
    playbackPosition: "\u64AD\u653E\u4F4D\u7F6E",
    closeSettings: "\u95DC\u9589\u8A2D\u5B9A",
    spectrogramDisplay: "\u983B\u8B5C\u5716\u986F\u793A",
    algorithm: "\u6F14\u7B97\u6CD5",
    algorithmFrequency: "\u983B\u7387",
    algorithmReassignment: "\u91CD\u5206\u914D",
    algorithmPitchEac: "\u97F3\u9AD8 (EAC)",
    windowSize: "\u8996\u7A97\u5927\u5C0F",
    windowType: "\u8996\u7A97\u985E\u578B",
    windowRectangular: "\u77E9\u5F62",
    windowBartlett: "Bartlett",
    windowHamming: "Hamming",
    windowHann: "Hann",
    windowBlackman: "Blackman",
    windowBlackmanHarris: "Blackman-Harris",
    windowWelch: "Welch",
    windowGaussian25: "Gaussian (\u03B1=2.5)",
    windowGaussian35: "Gaussian (\u03B1=3.5)",
    windowGaussian45: "Gaussian (\u03B1=4.5)",
    zeroPaddingFactor: "\u96F6\u586B\u5145\u56E0\u5B50",
    frequencyScale: "\u983B\u7387\u523B\u5EA6",
    palette: "\u8272\u76E4",
    paletteRose: "\u8272\u5F69 (\u73AB\u7470)",
    paletteClassic: "\u8272\u5F69 (\u7D93\u5178)",
    paletteGrayscale: "\u7070\u968E",
    paletteInverseGrayscale: "\u53CD\u5411\u7070\u968E",
    minDb: "\u6700\u5C0F dB",
    maxDb: "\u6700\u5927 dB",
    channel: "\u8072\u9053",
    timeZoom: "\u6642\u9593\u7E2E\u653E",
    timePosition: "\u6642\u9593\u4F4D\u7F6E",
    amplitudeZoom: "\u632F\u5E45\u7E2E\u653E",
    mouseWheel: "\u6ED1\u9F20\u6EFE\u8F2A",
    refreshSpectrogram: "\u91CD\u65B0\u6574\u7406\u983B\u8B5C\u5716",
    resetView: "\u91CD\u8A2D\u8996\u5716",
    selectionAnalysis: "\u9078\u5340\u5206\u6790",
    selectionStart: "\u958B\u59CB",
    selectionEnd: "\u7D50\u675F",
    selectionDuration: "\u6301\u7E8C\u6642\u9593",
    rmsLevel: "RMS Lev DB",
    peakLevel: "Peak Lev DB",
    dominant: "\u4E3B\u983B",
    frequencyAnalysis: "\u983B\u7387\u5206\u6790",
    bands: "\u983B\u5E36",
    waveform: "\u6CE2\u5F62",
    spectrogram: "\u983B\u8B5C\u5716",
    adjustWaveformHeight: "\u8ABF\u6574\u6CE2\u5F62\u9AD8\u5EA6",
    adjustSpectrogramHeight: "\u8ABF\u6574\u983B\u8B5C\u5716\u9AD8\u5EA6",
    ready: "\u5C31\u7DD2",
    workspaceNotTrusted: "\u5DE5\u4F5C\u5340\u4E0D\u53D7\u4FE1\u4EFB",
    fileTooLarge: "\u6A94\u6848\u8D85\u904E\u9650\u5236",
    readingAudio: "\u8B80\u53D6\u97F3\u8A0A\u4E2D",
    readingAudioProgress: "\u8B80\u53D6\u97F3\u8A0A\u4E2D",
    decodingAudio: "\u89E3\u78BC\u97F3\u8A0A\u4E2D",
    audioLoaded: "\u97F3\u8A0A\u5DF2\u8F09\u5165",
    audioNotReady: "\u97F3\u8A0A\u5C1A\u672A\u5C31\u7DD2",
    audioCannotPlay: "\u6B64\u97F3\u8A0A\u7121\u6CD5\u5728 Webview \u64AD\u653E",
    playbackFailed: "\u64AD\u653E\u5931\u6557",
    analyzingSpectrogram: "\u5206\u6790\u983B\u8B5C\u5716\u4E2D",
    frequencyBand0To250: "0-250",
    frequencyBand250To500: "250-500",
    frequencyBand500To1k: "0.5-1k",
    frequencyBand1To2k: "1-2k",
    frequencyBand2To4k: "2-4k",
    frequencyBand4To8k: "4-8k",
    frequencyBand8kPlus: "8k+",
    pad: "pad",
    hop: "hop",
    initializationFailed: "AudioLens \u521D\u59CB\u5316\u5931\u6557"
  };

  // src/webview/i18n/index.ts
  var localeMessages = {
    "zh-CN": messages16,
    "zh-TW": messages17,
    en: messages2,
    ja: messages7,
    ko: messages8,
    fr: messages4,
    de: messages,
    ru: messages13,
    es: messages3,
    it: messages6,
    pt: messages12,
    id: messages5,
    no: messages10,
    nl: messages9,
    pl: messages11,
    tr: messages14,
    vi: messages15
  };
  function getMessages(locale) {
    return localeMessages[locale] ?? messages2;
  }
  function normalizeLocale(language) {
    const value = (language || "en").toLowerCase();
    if (value === "zh-tw" || value === "zh-hk" || value === "zh-hant" || value.startsWith("zh-hant")) {
      return "zh-TW";
    }
    if (value === "zh-cn" || value === "zh-sg" || value === "zh-hans" || value.startsWith("zh")) {
      return "zh-CN";
    }
    if (value.startsWith("ja")) return "ja";
    if (value.startsWith("ko")) return "ko";
    if (value.startsWith("fr")) return "fr";
    if (value.startsWith("de")) return "de";
    if (value.startsWith("ru")) return "ru";
    if (value.startsWith("es")) return "es";
    if (value.startsWith("it")) return "it";
    if (value.startsWith("pt")) return "pt";
    if (value.startsWith("id")) return "id";
    if (value.startsWith("no") || value.startsWith("nb") || value.startsWith("nn")) return "no";
    if (value.startsWith("nl")) return "nl";
    if (value.startsWith("pl")) return "pl";
    if (value.startsWith("tr")) return "tr";
    if (value.startsWith("vi")) return "vi";
    return "en";
  }
  function resolveLocale(setting, vscodeLanguage) {
    if (setting && setting !== "auto") {
      return setting;
    }
    return normalizeLocale(vscodeLanguage);
  }

  // src/webview/view.ts
  function renderShell(root2) {
    root2.innerHTML = /* html */
    `
    <main class="shell">
      <header class="topbar">
        <div class="identity">
          <strong class="brand">AudioLens</strong>
          <span id="fileMeta" class="muted" data-i18n="waitingAudioFile">Waiting for audio file</span>
        </div>
        <div id="status" class="status" data-i18n="initializing">Initializing</div>
        <button id="settingsToggle" class="iconButton secondaryIcon" data-i18n-title="spectrogramSettings" data-i18n-aria="spectrogramSettings" title="Spectrogram settings" aria-label="Spectrogram settings">\u2699</button>
      </header>

      <section class="player">
        <button id="play" class="iconButton" data-i18n-title="playPause" data-i18n-aria="playPause" title="Play / pause" aria-label="Play / pause">\u25B6</button>
        <span id="clock" class="clock">0:00.000 / 0:00.000</span>
        <input id="seek" class="seek" type="range" min="0" max="1000" value="0" data-i18n-aria="playbackPosition" aria-label="Playback position" />
        <audio id="audio" preload="auto"></audio>
      </section>

      <aside id="settingsPanel" class="settingsPanel" hidden>
        <div class="settingsHeader">
          <strong data-i18n="spectrogramDisplay">Spectrogram display</strong>
          <button id="settingsClose" class="iconButton secondaryIcon" data-i18n-title="closeSettings" data-i18n-aria="closeSettings" title="Close settings" aria-label="Close settings">\xD7</button>
        </div>
        <label>
          <span data-i18n="algorithm">Algorithm</span>
          <select id="algorithm">
            <option value="frequency" data-i18n="algorithmFrequency">Frequency</option>
            <option value="reassignment" data-i18n="algorithmReassignment">Reassignment</option>
            <option value="pitchEac" data-i18n="algorithmPitchEac">Pitch (EAC)</option>
          </select>
        </label>
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
        <label>
          <span data-i18n="palette">Palette</span>
          <select id="palette">
            <option value="rose" data-i18n="paletteRose">Color (rose)</option>
            <option value="classic" data-i18n="paletteClassic">Color (classic)</option>
            <option value="grayscale" data-i18n="paletteGrayscale">Grayscale</option>
            <option value="inverseGrayscale" data-i18n="paletteInverseGrayscale">Inverse grayscale</option>
          </select>
        </label>
        <label>
          <span data-i18n="minDb">Min dB</span>
          <input id="minDb" type="number" min="-160" max="-1" step="1" value="-96" />
        </label>
        <label>
          <span data-i18n="maxDb">Max dB</span>
          <input id="maxDb" type="number" min="-80" max="24" step="1" value="0" />
        </label>
      </aside>

      <section class="workspace">
        <aside class="controls">
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
          <label>
            <span data-i18n="amplitudeZoom">Amplitude zoom</span>
            <input id="amplitudeZoom" type="range" min="0.25" max="32" step="0.25" value="1" />
            <small class="wheelHint"><kbd>Alt</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></small>
          </label>
          <button id="analyze" class="primary" data-i18n="refreshSpectrogram">Refresh spectrogram</button>
          <button id="resetView" class="secondary" data-i18n="resetView">Reset view</button>

          <section class="selectionAnalysisPane" data-i18n-aria="selectionAnalysis" aria-label="Selection analysis">
            <div class="paneTitle" data-i18n="selectionAnalysis">Selection analysis</div>
            <table class="analysisTable">
              <tbody>
                <tr><th data-i18n="selectionStart">Start</th><td id="analysisStart">--</td></tr>
                <tr><th data-i18n="selectionEnd">End</th><td id="analysisEnd">--</td></tr>
                <tr><th data-i18n="selectionDuration">Duration</th><td id="analysisDuration">--</td></tr>
                <tr><th data-i18n="rmsLevel">RMS Lev DB</th><td id="analysisRms">--</td></tr>
                <tr><th data-i18n="peakLevel">Peak Lev DB</th><td id="analysisPeak">--</td></tr>
                <tr><th data-i18n="dominant">Dominant</th><td id="analysisDominant">--</td></tr>
              </tbody>
            </table>
            <div class="paneSubtitle" data-i18n="frequencyAnalysis">Frequency analysis</div>
            <table class="analysisTable">
              <tbody id="analysisBands">
                <tr><th data-i18n="bands">Bands</th><td>--</td></tr>
              </tbody>
            </table>
          </section>
        </aside>

        <section id="figures" class="figures">
          <div class="figureHeader">
            <span data-i18n="waveform">Waveform</span>
            <span id="viewRange" class="muted">0.000s - 0.000s</span>
          </div>
          <div id="waveformPane" class="plotPane waveformPane">
            <canvas id="waveform" class="waveform"></canvas>
          </div>
          <div id="waveformResize" class="plotResize" role="separator" aria-orientation="horizontal" data-i18n-title="adjustWaveformHeight" title="Adjust waveform height"></div>
          <div class="figureHeader">
            <span data-i18n="spectrogram">Spectrogram</span>
            <span id="analysisMeta" class="muted"></span>
          </div>
          <div id="spectrogramPane" class="plotPane spectrogramPane">
            <canvas id="spectrogram" class="spectrogram"></canvas>
          </div>
          <div id="spectrogramResize" class="plotResize" role="separator" aria-orientation="horizontal" data-i18n-title="adjustSpectrogramHeight" title="Adjust spectrogram height"></div>
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
  function applyLocale(root2, messages18) {
    root2.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.dataset.i18n;
      if (key && messages18[key]) {
        element.textContent = messages18[key];
      }
    });
    root2.querySelectorAll("[data-i18n-title]").forEach((element) => {
      const key = element.dataset.i18nTitle;
      if (key && messages18[key]) {
        element.title = messages18[key];
      }
    });
    root2.querySelectorAll("[data-i18n-aria]").forEach((element) => {
      const key = element.dataset.i18nAria;
      if (key && messages18[key]) {
        element.setAttribute("aria-label", messages18[key]);
      }
    });
  }

  // src/webview/app.ts
  var MIN_DRAG_PIXELS = 6;
  var PLOT_MARGIN = { left: 78, top: 18, right: 18, bottom: 40 };
  var AXIS_FONT_SIZE = 13;
  var PLOT_HEIGHT_LIMITS = { waveformMin: 160, waveformMax: 520, spectrogramMin: 220, spectrogramMax: 860 };
  var BAND_LIMITS = [
    { labelKey: "frequencyBand0To250", min: 0, max: 250 },
    { labelKey: "frequencyBand250To500", min: 250, max: 500 },
    { labelKey: "frequencyBand500To1k", min: 500, max: 1e3 },
    { labelKey: "frequencyBand1To2k", min: 1e3, max: 2e3 },
    { labelKey: "frequencyBand2To4k", min: 2e3, max: 4e3 },
    { labelKey: "frequencyBand4To8k", min: 4e3, max: 8e3 },
    { labelKey: "frequencyBand8kPlus", min: 8e3, max: Number.POSITIVE_INFINITY }
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
    messages = getMessages("en");
    settings = {
      algorithm: "frequency",
      windowFunction: "hamming",
      fftSize: 512,
      zeroPaddingFactor: 2,
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
          this.applyLanguage(message.config);
          this.settings.windowFunction = message.config.analysis.windowFunction;
          this.settings.fftSize = message.config.analysis.fftSize;
          this.settings.zeroPaddingFactor = message.config.analysis.zeroPaddingFactor;
          this.applyPreferences(message.preferences);
          this.syncControls();
          await this.load(message.metadata);
          break;
        case "configChanged":
          this.config = message.config;
          this.applyLanguage(message.config);
          this.syncControls();
          this.updateSelectionAnalysis();
          this.redrawVisuals();
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
    applyLanguage(config) {
      const locale = resolveLocale(config.language, config.vscodeLanguage);
      this.messages = getMessages(locale);
      applyLocale(document, this.messages);
    }
    resetAnalysisWorker() {
      this.worker.terminate();
      this.worker = createAnalysisWorker();
      this.bindWorker();
    }
    async load(metadata) {
      this.elements.fileMeta.textContent = `${metadata.fileName} \xB7 ${formatBytes(metadata.size)}`;
      if (!metadata.trusted) {
        this.setStatus(this.messages.workspaceNotTrusted);
        return;
      }
      if (!this.config) {
        return;
      }
      const maxBytes = this.config.maxFileSizeMB * 1024 * 1024;
      if (metadata.size > maxBytes) {
        this.setStatus(`${this.messages.fileTooLarge}: ${formatBytes(metadata.size)} / ${this.config.maxFileSizeMB} MB`);
        return;
      }
      this.setStatus(this.messages.readingAudio);
      this.audioBytes = await this.readAll(metadata.size);
      const facts = readAudioFileFacts(this.audioBytes, metadata.fileName);
      this.setStatus(this.messages.decodingAudio);
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
      this.setStatus(this.messages.ready);
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
        this.setStatus(this.messages.audioLoaded);
      });
      this.elements.audio.addEventListener("error", () => {
        const detail = this.elements.audio.error?.message || this.messages.audioCannotPlay;
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
        this.reportPlaybackError(this.messages.audioNotReady);
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
      if (!this.elements.settingsPanel.hidden) {
        this.elements.settingsPanel.hidden = true;
        this.elements.settingsToggle.focus();
        return;
      }
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
      const detail = `${this.messages.playbackFailed}: ${message}`;
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
        this.setStatus(`${this.messages.readingAudioProgress} ${Math.round(offset / size * 100)}%`);
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
      this.setStatus(this.messages.analyzingSpectrogram);
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
      this.elements.analysisMeta.textContent = `${formatAlgorithm(this.settings.algorithm, this.messages)} \xB7 ${formatWindowFunction(this.settings.windowFunction, this.messages)} \xB7 ${this.settings.fftSize} \xB7 ${this.messages.pad} ${this.settings.zeroPaddingFactor} \xB7 ${this.settings.frequencyScale} \xB7 ${this.messages.hop} ${hopSize}`;
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
      this.setStatus(this.messages.ready);
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
      const trackpadPinchZoom = isTrackpadPinchZoom(event);
      const horizontalPan = isHorizontalTrackpadPan(event);
      if (!this.audioBuffer || !timeZoomModifier && !trackpadPinchZoom && !event.shiftKey && !event.altKey && !horizontalPan) {
        return;
      }
      event.preventDefault();
      if (timeZoomModifier || trackpadPinchZoom) {
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
      if (horizontalPan) {
        const range = this.visibleRange();
        const viewDuration = range.endTime - range.startTime;
        const delta = normalizeWheelDelta(event.deltaX, event.deltaMode);
        this.panTime(delta / 100 * viewDuration * 0.12, this.audioBuffer.duration);
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
      const spectrum = computeSpectrum(samples, startSample, endSample, this.analysisSampleRate(), this.settings.fftSize, this.settings.windowFunction, this.messages);
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
      const rows = bands.length > 0 ? bands : [{ label: this.messages.bands, percent: Number.NaN }];
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
  function isTrackpadPinchZoom(event) {
    return event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && Math.abs(normalizeWheelDelta(event.deltaY, event.deltaMode)) >= 1;
  }
  function isHorizontalTrackpadPan(event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return false;
    }
    const deltaX = Math.abs(normalizeWheelDelta(event.deltaX, event.deltaMode));
    const deltaY = Math.abs(normalizeWheelDelta(event.deltaY, event.deltaMode));
    return deltaX >= 1 && deltaX > deltaY;
  }
  function normalizeWheelDelta(value, mode) {
    if (mode === WheelEvent.DOM_DELTA_LINE) {
      return value * 16;
    }
    if (mode === WheelEvent.DOM_DELTA_PAGE) {
      return value * 800;
    }
    return value;
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
  function formatAlgorithm(value, messages18) {
    if (value === "reassignment") {
      return messages18.algorithmReassignment;
    }
    if (value === "pitchEac") {
      return messages18.algorithmPitchEac;
    }
    return messages18.algorithmFrequency;
  }
  function formatWindowFunction(value, messages18) {
    const labels = {
      rectangular: messages18.windowRectangular,
      bartlett: messages18.windowBartlett,
      hamming: messages18.windowHamming,
      hann: messages18.windowHann,
      blackman: messages18.windowBlackman,
      blackmanHarris: messages18.windowBlackmanHarris,
      welch: messages18.windowWelch,
      gaussian25: messages18.windowGaussian25,
      gaussian35: messages18.windowGaussian35,
      gaussian45: messages18.windowGaussian45
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
  function computeSpectrum(samples, startSample, endSample, sampleRate, requestedSize, windowFunction, messages18) {
    const available = Math.max(0, endSample - startSample);
    const fftSize = largestPowerOfTwo(Math.min(requestedSize, available));
    if (fftSize < 64) {
      return { dominantHz: 0, bands: BAND_LIMITS.map((band) => ({ label: messages18[band.labelKey], percent: 0 })) };
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
        label: messages18[band.labelKey],
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
