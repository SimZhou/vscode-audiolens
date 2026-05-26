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
    if (extension === "ogg") {
      return "audio/ogg";
    }
    if (extension === "opus") {
      return "audio/ogg; codecs=opus";
    }
    if (extension === "flac") {
      return "audio/flac";
    }
    if (extension === "m4a") {
      return "audio/mp4";
    }
    if (extension === "aac") {
      return "audio/aac";
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
    minDb: "Min. dB (Helligkeit)",
    maxDb: "Max. dB (Helligkeit)",
    autoBrightness: "Auto-Helligkeit",
    channel: "Kanal",
    timeZoom: "Zeitzoom",
    timePosition: "Zeitposition",
    amplitudeZoom: "Amplitudenzoom",
    mouseWheel: "Mausrad",
    help: "Hilfe",
    downloadAudio: "Audio herunterladen",
    settings: "Einstellungen",
    pcmReadAs: "Als PCM lesen",
    pcmParams: "PCM-Parameter",
    wavPcmRead: "WAV als PCM lesen",
    currentFileOnly: "Nur aktuelle Datei",
    sampleRate: "Abtastrate",
    channels: "Kan\xE4le",
    startOffsetBytes: "Offset (B)",
    bitDepth: "Bittiefe (bit)",
    sampleFormat: "Format",
    endianness: "Endian",
    read: "Lesen",
    saveDefault: "Standard speichern",
    cancel: "Abbrechen",
    defaultView: "Standardansicht",
    view: "Ansicht",
    viewBoth: "Mehrfachansicht",
    mute: "Stumm",
    solo: "Solo",
    timeLabel: "Zeit",
    helpTimeZoom: "Zeitzoom",
    helpTimePan: "Zeit verschieben",
    helpAmplitudeZoom: "Amplitudenzoom",
    helpRightClick: "Rechtsklick",
    helpPinch: "Pinch",
    helpHorizontalSwipe: "Horizontal wischen",
    helpDoubleClick: "Doppelklick",
    helpPlaybackGroup: "Wiedergabe & Auswahl",
    helpViewGroup: "Ansichtsnavigation",
    helpMouseGroup: "Maus & Trackpad",
    helpGainGroup: "Gain",
    helpPlayPause: "Wiedergabe / Pause",
    helpClearSelection: "Men\xFC schlie\xDFen, Auswahl l\xF6schen oder Wiedergabecursor zur\xFCcksetzen",
    helpResetTimeZoom: "Zeitzoom zur\xFCcksetzen",
    helpTrackpadZoom: "Mit Trackpad-Pinch die Zeit zoomen",
    helpTrackpadPan: "Horizontaler Trackpad-Swipe verschiebt die Zeit",
    helpGainReset: "Gain-Regler doppelklicken, um auf 0 dB zur\xFCckzusetzen",
    helpSelectionPlayback: "Wellenform oder Spektrogramm ziehen, um einen Bereich auszuw\xE4hlen. Bei aktiver Auswahl wird nur dieser Bereich abgespielt.",
    refreshSpectrogram: "Spectrogram aktualisieren",
    resetView: "Ansicht zuruecksetzen",
    selectionAnalysis: "Auswahlanalyse",
    selectionStart: "Start",
    selectionEnd: "Ende",
    selectionDuration: "Dauer",
    rmsLevel: "RMS-Pegel",
    peakLevel: "Peak-Pegel",
    dominant: "Dominant",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "Noise Floor",
    spectralCentroid: "Zentroid",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Basiswerte",
    selectionAnalysisHelp: "Auswahlanalyse:\nAnalysiert den ausgew\xE4hlten Zeitbereich und hilft bei Pegel, Dynamik, Clipping-Risiko, Noise Floor und Frequenzverteilung.\n\nUmfang:\nDie Ergebnisse werden nur f\xFCr den aktiven Kanal berechnet; Kan\xE4le werden nicht gemischt.\n\nKanal wechseln:\nKlicken Sie auf eine Spur, um sie aktiv zu machen.",
    rmsLevelHelp: "RMS-Pegel:\nZeigt die mittlere Energie des ausgew\xE4hlten Bereichs. Stabiler als Peak und n\xFCtzlich, um zu leise oder zu laute Sprache zu erkennen.",
    peakLevelHelp: "Peak-Pegel:\nZeigt den h\xF6chsten Momentanpegel im ausgew\xE4hlten Bereich. N\xFCtzlich f\xFCr N\xE4he zu 0 dBFS und Clipping-Risiko.",
    dominantHelp: "Dominante Frequenz:\nDie FFT-Bin-Frequenz mit der h\xF6chsten aufsummierten Leistung im ausgew\xE4hlten Bereich. Nicht zwingend Grundfrequenz oder wahrgenommene Tonh\xF6he.",
    crestFactorHelp: "Crest Factor:\nVerh\xE4ltnis von Peak zu RMS. Gr\xF6\xDFere Werte bedeuten st\xE4rkere Peaks gegen\xFCber der mittleren Energie.",
    clippingRatioHelp: "Clipping-Anteil:\nProzentualer Anteil von Samples nahe Full Scale. Hilft, \xDCbersteuerung und digitales Clipping schnell zu erkennen.",
    noiseFloorHelp: "Noise Floor:\nSch\xE4tzung aus einem niedrigen Perzentil kurzer RMS-Fenster. Bei \xFCberwiegend Sprache oder Musik kann der Wert vom echten Noise Floor abweichen.",
    spectralCentroidHelp: "Spektraler Zentroid:\nSchwerpunkt der spektralen Energie in Hz. Hilft einzusch\xE4tzen, ob ein Klang eher hell oder dunkel ist.",
    zeroCrossingRateHelp: "Zero-Crossing-Rate:\nRate der Vorzeichenwechsel. Eine einfache Zeitbereichsgr\xF6\xDFe f\xFCr hochfrequentes Rauschen, unvoiced speech und Frikative.",
    frequencyAnalysis: "Frequenzanalyse",
    frequencyAnalysisHelp: "Bedeutung:\nLinearer Energieanteil pro Frequenzband. Es ist kein RMS-Pegel und kein dB-Wert.\n\nBerechnung:\nDer ausgew\xE4hlte Bereich wird in Frames mit 50% \xDCberlappung geteilt. FFT-Bin-Leistung wird aufsummiert und auf Frequenzb\xE4nder verteilt.",
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
    transcodingAudio: "Audio wird mit FFmpeg transcodiert",
    encodedPlaybackOnly: "Dieses codierte Audioformat wird vom VS Code Webview-Decoder nicht unterst\xFCtzt. Installieren Sie FFmpeg auf dem Extension-Host, um Fallback-Decoding zu aktivieren.",
    waitingPcmParams: "Warte auf PCM-Parameter",
    pcmUsedDefaultParams: "Mit Standard-PCM-Parametern geladen.",
    pcmFillParams: "PCM-Parameter ausf\xFCllen und dann Lesen klicken.",
    wavPcmFillParams: "Parameter ausf\xFCllen und Lesen klicken, um die aktuelle WAV als PCM zu parsen.",
    currentPcmFormat: "Aktuell",
    savedDefaultPcmFormat: "Gespeicherter Standard",
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
    initializationFailed: "AudioLens-Initialisierung fehlgeschlagen",
    playbackGainLabel: "Gain",
    playbackGain: "Wiedergabe-Gain (Doppelklick zum Zur\xFCcksetzen)"
  };

  // src/webview/i18n/locales/en.ts
  var messages2 = {
    waitingAudioFile: "Waiting for audio file",
    initializing: "Initializing",
    spectrogramSettings: "Spectrogram settings",
    help: "Help",
    downloadAudio: "Download audio",
    settings: "Settings",
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
    minDb: "Min dB (brightness)",
    maxDb: "Max dB (brightness)",
    autoBrightness: "Auto brightness",
    channel: "Channel",
    timeZoom: "Time zoom",
    timePosition: "Time position",
    amplitudeZoom: "Amplitude zoom",
    mouseWheel: "Mouse wheel",
    refreshSpectrogram: "Refresh spectrogram",
    resetView: "Reset view",
    pcmReadAs: "Read as PCM",
    pcmParams: "PCM parameters",
    wavPcmRead: "Read WAV as PCM",
    currentFileOnly: "Current file only",
    sampleRate: "Sample rate",
    channels: "Channels",
    startOffsetBytes: "Offset (B)",
    bitDepth: "Bit depth (bit)",
    sampleFormat: "Format",
    endianness: "Endian",
    read: "Read",
    saveDefault: "Save default",
    cancel: "Cancel",
    defaultView: "Default view",
    view: "View",
    viewBoth: "Multi-view",
    mute: "Mute",
    solo: "Solo",
    timeLabel: "Time",
    helpTimeZoom: "Time zoom",
    helpTimePan: "Time pan",
    helpAmplitudeZoom: "Amplitude zoom",
    helpRightClick: "Right click",
    helpPinch: "Pinch",
    helpHorizontalSwipe: "Horizontal swipe",
    helpDoubleClick: "Double click",
    helpPlaybackGroup: "Playback & selection",
    helpViewGroup: "View navigation",
    helpMouseGroup: "Mouse & trackpad",
    helpGainGroup: "Gain",
    helpPlayPause: "Play / pause",
    helpClearSelection: "Close menu, clear selection, or reset playback cursor",
    helpResetTimeZoom: "Reset time zoom",
    helpTrackpadZoom: "Pinch on trackpad to zoom time",
    helpTrackpadPan: "Horizontal trackpad swipe pans time",
    helpGainReset: "Double-click the gain slider to reset to 0 dB",
    helpSelectionPlayback: "Drag waveform or spectrogram to select a segment. Playing with a selection active only plays that range.",
    selectionAnalysis: "Selection analysis",
    selectionAnalysisHelp: "Selection analysis:\nQuickly analyzes the selected time range to help inspect recording level, dynamic range, clipping risk, noise floor, and frequency distribution.\n\nScope:\nResults are calculated for the active channel only; channels are not mixed.\n\nSwitch channel:\nClick a track to make it active. RMS, Peak, Dominant, and frequency analysis then use that channel.",
    basicMetrics: "Basic metrics",
    selectionStart: "Start",
    selectionEnd: "End",
    selectionDuration: "Duration",
    rmsLevel: "RMS Level",
    peakLevel: "Peak Level",
    dominant: "Dominant",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "Noise floor",
    spectralCentroid: "Centroid",
    zeroCrossingRate: "ZCR",
    rmsLevelHelp: "RMS Level:\nCalculation:\nrms = sqrt(mean(sample\xB2))\nrmsDb = 20 \xD7 log10(rms)\n\nUse:\nShows average energy/loudness trend for the selected region. More stable than peak, useful for checking speech that is too quiet or too loud.\n\nLimit:\nRMS is not LUFS; it has no perceptual weighting or gating. Very long selections are sampled evenly to keep the UI responsive.\n\nReferences:\nMathWorks rms; librosa.feature.rms; Audacity Measure RMS.",
    peakLevelHelp: "Peak Level:\nCalculation:\npeak = max(abs(sample))\npeakDb = 20 \xD7 log10(peak)\n\nUse:\nShows the highest instantaneous level in the selection. Useful for checking whether audio is close to 0 dBFS or at clipping risk.\n\nLimit:\nPeak only reflects the maximum instant, not overall loudness. Very long selections are sampled evenly to keep the UI responsive.\n\nReferences:\nAdobe Audition Amplitude Statistics; Audacity Amplify; AES17 0 dBFS.",
    dominantHelp: "Dominant Frequency:\nThe FFT frequency bin with the highest accumulated power over the selected region.\n\nBin mapping:\nFor bin k:\nfreq = k \xD7 sampleRate / FFT size\n\nPower:\nFor each frame:\npower = re\xB2 + im\xB2\n\nSelection accumulation:\nbinPower[k] += power\n\nResult:\ndominantHz = k \xD7 sampleRate / FFT size, where k has max binPower.\n\nMeaning:\nIt is not necessarily the fundamental frequency or perceived pitch. Frequency resolution is sampleRate / FFT size.\n\nReferences:\nNumPy fftfreq; librosa spectral features.",
    crestFactorHelp: "Crest Factor:\nThe ratio between peak and RMS.\n\nCalculation:\ncrest = peak / rms\ncrestDb = peakDb - rmsDb\n\nUse:\nShows dynamic range and transient strength. Larger values mean peaks stand out more from average energy.\n\nLimit:\nUnstable for silence or very low-level audio. It describes dynamics but does not directly judge quality.\n\nReferences:\nMathWorks peak2rms; Signal Processing Toolbox descriptive statistics.",
    clippingRatioHelp: "Clipping Ratio:\nThe percentage of samples close to full scale.\n\nCalculation:\nclippingRatio = count(abs(sample) >= 0.999) / measuredSamples \xD7 100%\n\nUse:\nQuickly detects digital full-scale samples, recording overload, or hard clipping risk.\n\nLimit:\nAudio may already be limited or distorted before AudioLens; it can sound distorted even without full-scale samples.\n\nReferences:\nAudacity Find Clipping; Adobe Audition Amplitude Statistics; Netflix AudioClippingInspector.",
    noiseFloorHelp: "Noise Floor:\nEstimated from a low percentile of short-time RMS levels in quieter parts of the selection.\n\nCalculation:\n1. Split the selection into about 20 ms windows with 50% overlap.\n2. Compute RMS for each window.\n3. Use the 10th percentile RMS and convert it to dBFS.\n\nUse:\nEstimates background noise, silence cleanliness, and recording environment noise.\n\nLimit:\nThis is an unsupervised estimate. If the selection is mostly speech or music, it may not equal the true noise floor.\n\nReferences:\nAdobe Audition Minimum RMS; librosa.feature.rms; Audacity Noise Reduction.",
    spectralCentroidHelp: "Spectral Centroid:\nThe center of mass of spectral energy, in Hz.\n\nCalculation:\ncentroid = sum(freq[k] \xD7 power[k]) / sum(power[k])\n\nUse:\nIndicates whether the sound is brighter or darker. Speech with more high-frequency content usually has a higher centroid.\n\nLimit:\nAffected by noise, sibilance, and bandwidth. It is not pitch and cannot alone judge clarity.\n\nReferences:\nlibrosa.feature.spectral_centroid; MathWorks spectralCentroid.",
    zeroCrossingRateHelp: "Zero Crossing Rate:\nThe rate at which the signal changes sign.\n\nCalculation:\nzeroCrossingRate = zeroCrossings / durationSeconds\n\nUse:\nA rough time-domain feature for high-frequency noise, unvoiced speech, and fricatives.\n\nLimit:\nSensitive to noise and DC offset. It is not the same as frequency or pitch.\n\nReferences:\nlibrosa.feature.zero_crossing_rate; librosa.zero_crossings.",
    frequencyAnalysis: "Frequency analysis",
    frequencyAnalysisHelp: "Meaning:\nLinear energy percentage by frequency band. It is not RMS level and not dB.\n\nCalculation:\n1. Sample the active channel in the selection.\n2. Use the current window function and FFT size, split the full selection into frames with 50% overlap.\n3. Each bin power is re\xB2 + im\xB2.\n4. Accumulate bin power across all frames and assign bins into frequency bands.\n5. Display bandPower / totalPower \xD7 100%.\n\nNote:\nThis is a multi-frame spectral energy distribution for the whole selection; it is still not dB/RMS.",
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
    transcodingAudio: "Transcoding audio with FFmpeg",
    encodedPlaybackOnly: "This encoded audio format is not supported by the VS Code Webview decoder. Install FFmpeg on the extension host machine to enable fallback decoding.",
    waitingPcmParams: "Waiting for PCM parameters",
    pcmUsedDefaultParams: "Loaded with default PCM parameters.",
    pcmFillParams: "Fill PCM parameters, then click Read.",
    wavPcmFillParams: "Fill parameters, then click Read to parse the current WAV as PCM.",
    currentPcmFormat: "Current",
    savedDefaultPcmFormat: "Saved default",
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
    initializationFailed: "AudioLens initialization failed",
    playbackGainLabel: "Gain",
    playbackGain: "Playback Gain (Double-click to reset)"
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
    minDb: "dB m\xEDn. (brillo)",
    maxDb: "dB m\xE1x. (brillo)",
    autoBrightness: "Brillo autom\xE1tico",
    channel: "Canal",
    timeZoom: "Zoom de tiempo",
    timePosition: "Posici\xF3n temporal",
    amplitudeZoom: "Zoom de amplitud",
    mouseWheel: "Rueda del rat\xF3n",
    help: "Ayuda",
    downloadAudio: "Descargar audio",
    settings: "Ajustes",
    pcmReadAs: "Leer como PCM",
    pcmParams: "Par\xE1metros PCM",
    wavPcmRead: "Leer WAV como PCM",
    currentFileOnly: "Solo archivo actual",
    sampleRate: "Frecuencia de muestreo",
    channels: "Canales",
    startOffsetBytes: "Desplazamiento (B)",
    bitDepth: "Profundidad (bit)",
    sampleFormat: "Formato",
    endianness: "Endian",
    read: "Leer",
    saveDefault: "Guardar predeterminado",
    cancel: "Cancelar",
    defaultView: "Vista predeterminada",
    view: "Vista",
    viewBoth: "Vista m\xFAltiple",
    mute: "Silenciar",
    solo: "Solo",
    timeLabel: "Tiempo",
    helpTimeZoom: "Zoom de tiempo",
    helpTimePan: "Desplazar tiempo",
    helpAmplitudeZoom: "Zoom de amplitud",
    helpRightClick: "Clic derecho",
    helpPinch: "Pellizcar",
    helpHorizontalSwipe: "Deslizamiento horizontal",
    helpDoubleClick: "Doble clic",
    helpPlaybackGroup: "Reproducci\xF3n y selecci\xF3n",
    helpViewGroup: "Navegaci\xF3n de vista",
    helpMouseGroup: "Rat\xF3n y trackpad",
    helpGainGroup: "Ganancia",
    helpPlayPause: "Reproducir / pausar",
    helpClearSelection: "Cerrar men\xFA, borrar selecci\xF3n o reiniciar cursor de reproducci\xF3n",
    helpResetTimeZoom: "Reiniciar zoom de tiempo",
    helpTrackpadZoom: "Pellizcar en el trackpad para ampliar el tiempo",
    helpTrackpadPan: "Deslizamiento horizontal del trackpad para mover el tiempo",
    helpGainReset: "Doble clic en el control de ganancia para volver a 0 dB",
    helpSelectionPlayback: "Arrastra la forma de onda o el espectrograma para seleccionar un segmento. Con una selecci\xF3n activa, solo se reproduce ese rango.",
    refreshSpectrogram: "Actualizar espectrograma",
    resetView: "Restablecer vista",
    selectionAnalysis: "An\xE1lisis de selecci\xF3n",
    selectionStart: "Inicio",
    selectionEnd: "Fin",
    selectionDuration: "Duraci\xF3n",
    rmsLevel: "Nivel RMS",
    peakLevel: "Nivel Peak",
    dominant: "Dominante",
    crestFactor: "Cresta",
    clippingRatio: "Clipping",
    noiseFloor: "Ruido base",
    spectralCentroid: "Centroide",
    zeroCrossingRate: "ZCR",
    basicMetrics: "M\xE9tricas b\xE1sicas",
    selectionAnalysisHelp: "An\xE1lisis de selecci\xF3n:\nAnaliza r\xE1pidamente el rango seleccionado para revisar nivel, rango din\xE1mico, riesgo de clipping, ruido base y distribuci\xF3n de frecuencias.\n\n\xC1mbito:\nLos resultados se calculan solo para el canal activo; no se mezclan canales.\n\nCambiar canal:\nHaz clic en una pista para activarla.",
    rmsLevelHelp: "Nivel RMS:\nMuestra la energ\xEDa media de la selecci\xF3n. Es m\xE1s estable que el pico y ayuda a detectar voz demasiado baja o alta.",
    peakLevelHelp: "Nivel pico:\nMuestra el nivel instant\xE1neo m\xE1ximo de la selecci\xF3n. \xDAtil para revisar cercan\xEDa a 0 dBFS y riesgo de clipping.",
    dominantHelp: "Frecuencia dominante:\nBin FFT con mayor potencia acumulada en la selecci\xF3n. No necesariamente es la fundamental ni el pitch percibido.",
    crestFactorHelp: "Factor de cresta:\nRelaci\xF3n entre pico y RMS. Valores mayores indican picos m\xE1s destacados respecto a la energ\xEDa media.",
    clippingRatioHelp: "Proporci\xF3n de clipping:\nPorcentaje de muestras cercanas a escala completa. Ayuda a detectar sobrecarga o clipping digital.",
    noiseFloorHelp: "Ruido base:\nEstimado a partir de un percentil bajo de RMS de ventanas cortas. Si la selecci\xF3n es sobre todo voz o m\xFAsica, puede no coincidir con el ruido real.",
    spectralCentroidHelp: "Centroide espectral:\nCentro de masa de la energ\xEDa espectral en Hz. Indica si el sonido tiende a ser m\xE1s brillante u oscuro.",
    zeroCrossingRateHelp: "Tasa de cruces por cero:\nFrecuencia con la que la se\xF1al cambia de signo. \xDAtil para ruido de alta frecuencia, habla no sonora y fricativas.",
    frequencyAnalysis: "An\xE1lisis de frecuencia",
    frequencyAnalysisHelp: "Significado:\nPorcentaje de energ\xEDa lineal por banda de frecuencia. No es nivel RMS ni dB.\n\nC\xE1lculo:\nLa selecci\xF3n se divide en tramas con 50% de solape. Se acumula la potencia de bins FFT y se reparte por bandas.",
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
    transcodingAudio: "Transcodificando audio con FFmpeg",
    encodedPlaybackOnly: "Este formato de audio codificado no es compatible con el decodificador del Webview de VS Code. Instala FFmpeg en la m\xE1quina del host de la extensi\xF3n para activar la decodificaci\xF3n de respaldo.",
    waitingPcmParams: "Esperando par\xE1metros PCM",
    pcmUsedDefaultParams: "Cargado con par\xE1metros PCM predeterminados.",
    pcmFillParams: "Completa los par\xE1metros PCM y haz clic en Leer.",
    wavPcmFillParams: "Completa los par\xE1metros y haz clic en Leer para interpretar el WAV actual como PCM.",
    currentPcmFormat: "Actual",
    savedDefaultPcmFormat: "Predeterminado guardado",
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
    initializationFailed: "Error al inicializar AudioLens",
    playbackGainLabel: "Ganancia",
    playbackGain: "Ganancia de reproducci\xF3n (doble clic para reiniciar)"
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
    minDb: "dB min (luminosit\xE9)",
    maxDb: "dB max (luminosit\xE9)",
    autoBrightness: "Luminosit\xE9 auto",
    channel: "Canal",
    timeZoom: "Zoom temporel",
    timePosition: "Position temporelle",
    amplitudeZoom: "Zoom d'amplitude",
    mouseWheel: "molette",
    help: "Aide",
    downloadAudio: "T\xE9l\xE9charger l'audio",
    settings: "R\xE9glages",
    pcmReadAs: "Lire en PCM",
    pcmParams: "Param\xE8tres PCM",
    wavPcmRead: "Lire le WAV en PCM",
    currentFileOnly: "Fichier courant seulement",
    sampleRate: "Fr\xE9quence d'\xE9chantillonnage",
    channels: "Canaux",
    startOffsetBytes: "D\xE9calage (B)",
    bitDepth: "R\xE9solution (bit)",
    sampleFormat: "Format",
    endianness: "Boutisme",
    read: "Lire",
    saveDefault: "Enregistrer par d\xE9faut",
    cancel: "Annuler",
    defaultView: "Vue par d\xE9faut",
    view: "Vue",
    viewBoth: "Vue mixte",
    mute: "Muet",
    solo: "Solo",
    timeLabel: "Temps",
    helpTimeZoom: "Zoom temporel",
    helpTimePan: "Pan temporel",
    helpAmplitudeZoom: "Zoom d'amplitude",
    helpRightClick: "Clic droit",
    helpPinch: "Pincer",
    helpHorizontalSwipe: "Balayage horizontal",
    helpDoubleClick: "Double-clic",
    helpPlaybackGroup: "Lecture et s\xE9lection",
    helpViewGroup: "Navigation",
    helpMouseGroup: "Souris et pav\xE9 tactile",
    helpGainGroup: "Gain",
    helpPlayPause: "Lire / pause",
    helpClearSelection: "Fermer le menu, effacer la s\xE9lection ou r\xE9initialiser le curseur",
    helpResetTimeZoom: "R\xE9initialiser le zoom temporel",
    helpTrackpadZoom: "Pincer le pav\xE9 tactile pour zoomer le temps",
    helpTrackpadPan: "Balayage horizontal du pav\xE9 tactile pour d\xE9placer le temps",
    helpGainReset: "Double-cliquer le curseur de gain pour revenir \xE0 0 dB",
    helpSelectionPlayback: "Faites glisser la forme d'onde ou le spectrogramme pour s\xE9lectionner un segment. Avec une s\xE9lection active, seule cette plage est lue.",
    refreshSpectrogram: "Actualiser le spectrogramme",
    resetView: "R\xE9initialiser la vue",
    selectionAnalysis: "Analyse de la s\xE9lection",
    selectionStart: "D\xE9but",
    selectionEnd: "Fin",
    selectionDuration: "Dur\xE9e",
    rmsLevel: "Niveau RMS",
    peakLevel: "Niveau Peak",
    dominant: "Dominante",
    crestFactor: "Cr\xEAte",
    clippingRatio: "\xC9cr\xEAtage",
    noiseFloor: "Bruit de fond",
    spectralCentroid: "Centro\xEFde",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Mesures de base",
    selectionAnalysisHelp: "Analyse de la s\xE9lection:\nAnalyse rapidement la plage s\xE9lectionn\xE9e pour inspecter le niveau, la dynamique, le risque d'\xE9cr\xEAtage, le bruit de fond et la distribution fr\xE9quentielle.\n\nPort\xE9e:\nLes r\xE9sultats sont calcul\xE9s uniquement pour le canal actif; les canaux ne sont pas mix\xE9s.\n\nChanger de canal:\nCliquez sur une piste pour la rendre active.",
    rmsLevelHelp: "Niveau RMS:\nIndique l'\xE9nergie moyenne de la s\xE9lection. Plus stable que le pic, utile pour rep\xE9rer une parole trop faible ou trop forte.",
    peakLevelHelp: "Niveau cr\xEAte:\nIndique le niveau instantan\xE9 le plus \xE9lev\xE9 de la s\xE9lection. Utile pour v\xE9rifier la proximit\xE9 de 0 dBFS et le risque d'\xE9cr\xEAtage.",
    dominantHelp: "Fr\xE9quence dominante:\nBin FFT dont la puissance cumul\xE9e est la plus \xE9lev\xE9e dans la s\xE9lection. Ce n'est pas forc\xE9ment la fondamentale ni la hauteur per\xE7ue.",
    crestFactorHelp: "Facteur de cr\xEAte:\nRapport entre le pic et le RMS. Une valeur \xE9lev\xE9e signifie que les pics ressortent davantage de l'\xE9nergie moyenne.",
    clippingRatioHelp: "Taux d'\xE9cr\xEAtage:\nPourcentage d'\xE9chantillons proches du plein niveau. Permet de d\xE9tecter rapidement une surcharge ou un \xE9cr\xEAtage num\xE9rique.",
    noiseFloorHelp: "Bruit de fond:\nEstim\xE9 \xE0 partir d'un percentile bas des RMS court terme. Si la s\xE9lection contient surtout de la parole ou de la musique, il peut diff\xE9rer du vrai bruit de fond.",
    spectralCentroidHelp: "Centro\xEFde spectral:\nCentre de masse de l'\xE9nergie spectrale en Hz. Indique si le son est plut\xF4t clair ou sombre.",
    zeroCrossingRateHelp: "Taux de passage par z\xE9ro:\nNombre de changements de signe par seconde. Indice temporel utile pour le bruit haute fr\xE9quence, les sons non vois\xE9s et les fricatives.",
    frequencyAnalysis: "Analyse fr\xE9quentielle",
    frequencyAnalysisHelp: "Signification:\nPourcentage d'\xE9nergie lin\xE9aire par bande de fr\xE9quences. Ce n'est ni un niveau RMS ni un dB.\n\nCalcul:\nLa s\xE9lection est d\xE9coup\xE9e en trames avec 50% de recouvrement. La puissance des bins FFT est cumul\xE9e puis r\xE9partie dans les bandes.",
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
    transcodingAudio: "Transcodage audio avec FFmpeg",
    encodedPlaybackOnly: "Ce format audio encod\xE9 n'est pas pris en charge par le d\xE9codeur du Webview VS Code. Installez FFmpeg sur l'h\xF4te de l'extension pour activer le d\xE9codage de secours.",
    waitingPcmParams: "En attente des param\xE8tres PCM",
    pcmUsedDefaultParams: "Charg\xE9 avec les param\xE8tres PCM par d\xE9faut.",
    pcmFillParams: "Renseignez les param\xE8tres PCM, puis cliquez sur Lire.",
    wavPcmFillParams: "Renseignez les param\xE8tres, puis cliquez sur Lire pour analyser le WAV courant comme PCM.",
    currentPcmFormat: "Courant",
    savedDefaultPcmFormat: "Par d\xE9faut enregistr\xE9",
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
    initializationFailed: "\xC9chec d'initialisation d'AudioLens",
    playbackGainLabel: "Gain",
    playbackGain: "Gain de lecture (double-clic pour r\xE9initialiser)"
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
    minDb: "Min dB (kecerahan)",
    maxDb: "Maks dB (kecerahan)",
    autoBrightness: "Kecerahan otomatis",
    channel: "Kanal",
    timeZoom: "Zoom waktu",
    timePosition: "Posisi waktu",
    amplitudeZoom: "Zoom amplitudo",
    mouseWheel: "Roda mouse",
    help: "Bantuan",
    downloadAudio: "Unduh audio",
    settings: "Pengaturan",
    pcmReadAs: "Baca sebagai PCM",
    pcmParams: "Parameter PCM",
    wavPcmRead: "Baca WAV sebagai PCM",
    currentFileOnly: "Hanya file saat ini",
    sampleRate: "Sample rate",
    channels: "Jumlah kanal",
    startOffsetBytes: "Offset (B)",
    bitDepth: "Bit depth (bit)",
    sampleFormat: "Format",
    endianness: "Endian",
    read: "Baca",
    saveDefault: "Simpan default",
    cancel: "Batal",
    defaultView: "Tampilan default",
    view: "Tampilan",
    viewBoth: "Multi-view",
    mute: "Bisukan",
    solo: "Solo",
    timeLabel: "Waktu",
    helpTimeZoom: "Zoom waktu",
    helpTimePan: "Geser waktu",
    helpAmplitudeZoom: "Zoom amplitudo",
    helpRightClick: "Klik kanan",
    helpPinch: "Cubit",
    helpHorizontalSwipe: "Geser horizontal",
    helpDoubleClick: "Klik ganda",
    helpPlaybackGroup: "Pemutaran & pilihan",
    helpViewGroup: "Navigasi tampilan",
    helpMouseGroup: "Mouse & trackpad",
    helpGainGroup: "Gain",
    helpPlayPause: "Putar / jeda",
    helpClearSelection: "Tutup menu, hapus pilihan, atau reset kursor putar",
    helpResetTimeZoom: "Reset zoom waktu",
    helpTrackpadZoom: "Cubit trackpad untuk zoom waktu",
    helpTrackpadPan: "Geser horizontal trackpad untuk menggeser waktu",
    helpGainReset: "Klik ganda slider gain untuk reset ke 0 dB",
    helpSelectionPlayback: "Seret waveform atau spectrogram untuk memilih segmen. Saat pilihan aktif, hanya rentang itu yang diputar.",
    refreshSpectrogram: "Segarkan spectrogram",
    resetView: "Reset tampilan",
    selectionAnalysis: "Analisis pilihan",
    selectionStart: "Mulai",
    selectionEnd: "Akhir",
    selectionDuration: "Durasi",
    rmsLevel: "Level RMS",
    peakLevel: "Level Peak",
    dominant: "Dominan",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "Noise floor",
    spectralCentroid: "Centroid",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Metrik dasar",
    selectionAnalysisHelp: "Analisis pilihan:\nMenganalisis rentang waktu yang dipilih untuk memeriksa level, rentang dinamis, risiko clipping, noise floor, dan distribusi frekuensi.\n\nCakupan:\nHasil dihitung hanya untuk kanal aktif; kanal tidak dicampur.\n\nGanti kanal:\nKlik track untuk membuatnya aktif.",
    rmsLevelHelp: "Level RMS:\nMenunjukkan energi rata-rata pada pilihan. Lebih stabil daripada peak dan berguna untuk memeriksa suara terlalu pelan atau terlalu keras.",
    peakLevelHelp: "Level peak:\nMenunjukkan level sesaat tertinggi pada pilihan. Berguna untuk memeriksa kedekatan dengan 0 dBFS dan risiko clipping.",
    dominantHelp: "Frekuensi dominan:\nBin FFT dengan daya akumulasi tertinggi pada pilihan. Tidak selalu frekuensi dasar atau pitch yang terdengar.",
    crestFactorHelp: "Crest factor:\nRasio peak terhadap RMS. Nilai lebih besar berarti peak lebih menonjol dibanding energi rata-rata.",
    clippingRatioHelp: "Rasio clipping:\nPersentase sample yang dekat full scale. Membantu mendeteksi overload rekaman atau clipping digital.",
    noiseFloorHelp: "Noise floor:\nEstimasi dari persentil rendah RMS jangka pendek. Jika pilihan berisi banyak suara atau musik, nilainya bisa berbeda dari noise floor asli.",
    spectralCentroidHelp: "Spectral centroid:\nPusat massa energi spektral dalam Hz. Menunjukkan apakah suara cenderung terang atau gelap.",
    zeroCrossingRateHelp: "Zero crossing rate:\nLaju perubahan tanda sinyal. Berguna untuk noise frekuensi tinggi, ucapan tak bersuara, dan frikatif.",
    frequencyAnalysis: "Analisis frekuensi",
    frequencyAnalysisHelp: "Makna:\nPersentase energi linear per band frekuensi. Ini bukan level RMS dan bukan dB.\n\nPerhitungan:\nPilihan dibagi menjadi frame dengan 50% overlap; power bin FFT diakumulasi lalu dibagi ke band frekuensi.",
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
    transcodingAudio: "Mengonversi audio dengan FFmpeg",
    encodedPlaybackOnly: "Format audio ini tidak didukung decoder VS Code Webview. Instal FFmpeg di mesin extension host untuk mengaktifkan decoding fallback.",
    waitingPcmParams: "Menunggu parameter PCM",
    pcmUsedDefaultParams: "Dimuat dengan parameter PCM default.",
    pcmFillParams: "Isi parameter PCM, lalu klik Baca.",
    wavPcmFillParams: "Isi parameter, lalu klik Baca untuk membaca WAV saat ini sebagai PCM.",
    currentPcmFormat: "Saat ini",
    savedDefaultPcmFormat: "Default tersimpan",
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
    initializationFailed: "Inisialisasi AudioLens gagal",
    playbackGainLabel: "Gain",
    playbackGain: "Gain pemutaran (klik ganda untuk reset)"
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
    minDb: "dB min (luminosit\xE0)",
    maxDb: "dB max (luminosit\xE0)",
    autoBrightness: "Luminosit\xE0 auto",
    channel: "Canale",
    timeZoom: "Zoom tempo",
    timePosition: "Posizione tempo",
    amplitudeZoom: "Zoom ampiezza",
    mouseWheel: "Rotella mouse",
    help: "Aiuto",
    downloadAudio: "Scarica audio",
    settings: "Impostazioni",
    pcmReadAs: "Leggi come PCM",
    pcmParams: "Parametri PCM",
    wavPcmRead: "Leggi WAV come PCM",
    currentFileOnly: "Solo file corrente",
    sampleRate: "Frequenza di campionamento",
    channels: "Canali",
    startOffsetBytes: "Offset (B)",
    bitDepth: "Profondit\xE0 (bit)",
    sampleFormat: "Formato",
    endianness: "Endian",
    read: "Leggi",
    saveDefault: "Salva predefinito",
    cancel: "Annulla",
    defaultView: "Vista predefinita",
    view: "Vista",
    viewBoth: "Vista multipla",
    mute: "Muto",
    solo: "Solo",
    timeLabel: "Tempo",
    helpTimeZoom: "Zoom tempo",
    helpTimePan: "Pan tempo",
    helpAmplitudeZoom: "Zoom ampiezza",
    helpRightClick: "Clic destro",
    helpPinch: "Pizzica",
    helpHorizontalSwipe: "Scorrimento orizzontale",
    helpDoubleClick: "Doppio clic",
    helpPlaybackGroup: "Riproduzione e selezione",
    helpViewGroup: "Navigazione vista",
    helpMouseGroup: "Mouse e trackpad",
    helpGainGroup: "Guadagno",
    helpPlayPause: "Riproduci / pausa",
    helpClearSelection: "Chiudi menu, cancella selezione o reimposta cursore",
    helpResetTimeZoom: "Reimposta zoom tempo",
    helpTrackpadZoom: "Pizzica sul trackpad per zoomare il tempo",
    helpTrackpadPan: "Scorrimento orizzontale del trackpad per spostare il tempo",
    helpGainReset: "Doppio clic sul cursore guadagno per tornare a 0 dB",
    helpSelectionPlayback: "Trascina forma d'onda o spettrogramma per selezionare un segmento. Con una selezione attiva, viene riprodotto solo quel range.",
    refreshSpectrogram: "Aggiorna spettrogramma",
    resetView: "Reimposta vista",
    selectionAnalysis: "Analisi selezione",
    selectionStart: "Inizio",
    selectionEnd: "Fine",
    selectionDuration: "Durata",
    rmsLevel: "Livello RMS",
    peakLevel: "Livello Peak",
    dominant: "Dominante",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "Rumore di fondo",
    spectralCentroid: "Centroide",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Metriche base",
    selectionAnalysisHelp: "Analisi selezione:\nAnalizza rapidamente il range selezionato per controllare livello, dinamica, rischio clipping, rumore di fondo e distribuzione in frequenza.\n\nAmbito:\nI risultati sono calcolati solo sul canale attivo; i canali non vengono mixati.\n\nCambio canale:\nFai clic su una traccia per renderla attiva.",
    rmsLevelHelp: "Livello RMS:\nMostra l'energia media della selezione. \xC8 pi\xF9 stabile del picco ed \xE8 utile per verificare parlato troppo basso o troppo alto.",
    peakLevelHelp: "Livello picco:\nMostra il massimo livello istantaneo nella selezione. Utile per controllare vicinanza a 0 dBFS e rischio clipping.",
    dominantHelp: "Frequenza dominante:\nIl bin FFT con potenza accumulata maggiore nella selezione. Non \xE8 necessariamente la fondamentale o il pitch percepito.",
    crestFactorHelp: "Fattore di cresta:\nRapporto tra picco e RMS. Valori pi\xF9 alti indicano picchi pi\xF9 evidenti rispetto all'energia media.",
    clippingRatioHelp: "Percentuale di clipping:\nPercentuale di sample vicini al fondo scala. Aiuta a rilevare sovraccarico o clipping digitale.",
    noiseFloorHelp: "Rumore di fondo:\nStimato da un percentile basso degli RMS a breve termine. Se la selezione contiene soprattutto voce o musica, pu\xF2 differire dal rumore reale.",
    spectralCentroidHelp: "Centroide spettrale:\nCentro di massa dell'energia spettrale in Hz. Indica se il suono tende a essere pi\xF9 brillante o pi\xF9 scuro.",
    zeroCrossingRateHelp: "Tasso di attraversamenti dello zero:\nFrequenza con cui il segnale cambia segno. Utile per rumore ad alta frequenza, parlato non sonoro e fricative.",
    frequencyAnalysis: "Analisi frequenze",
    frequencyAnalysisHelp: "Significato:\nPercentuale di energia lineare per banda di frequenza. Non \xE8 livello RMS n\xE9 dB.\n\nCalcolo:\nLa selezione viene divisa in frame con 50% di overlap; la potenza dei bin FFT viene accumulata e assegnata alle bande.",
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
    transcodingAudio: "Transcodifica audio con FFmpeg",
    encodedPlaybackOnly: "Questo formato audio codificato non \xE8 supportato dal decoder Webview di VS Code. Installa FFmpeg sulla macchina dell'extension host per abilitare la decodifica di fallback.",
    waitingPcmParams: "In attesa dei parametri PCM",
    pcmUsedDefaultParams: "Caricato con i parametri PCM predefiniti.",
    pcmFillParams: "Inserisci i parametri PCM, poi fai clic su Leggi.",
    wavPcmFillParams: "Inserisci i parametri, poi fai clic su Leggi per interpretare il WAV corrente come PCM.",
    currentPcmFormat: "Corrente",
    savedDefaultPcmFormat: "Predefinito salvato",
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
    initializationFailed: "Inizializzazione di AudioLens non riuscita",
    playbackGainLabel: "Guadagno",
    playbackGain: "Guadagno di riproduzione (doppio clic per reimpostare)"
  };

  // src/webview/i18n/locales/ja.ts
  var messages7 = {
    waitingAudioFile: "\u97F3\u58F0\u30D5\u30A1\u30A4\u30EB\u5F85\u6A5F\u4E2D",
    initializing: "\u521D\u671F\u5316\u4E2D",
    spectrogramSettings: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u8A2D\u5B9A",
    help: "\u30D8\u30EB\u30D7",
    downloadAudio: "\u97F3\u58F0\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9",
    settings: "\u8A2D\u5B9A",
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
    paletteRose: "\u30AB\u30E9\u30FC (\u30ED\u30FC\u30BA)",
    paletteClassic: "\u30AB\u30E9\u30FC (\u30AF\u30E9\u30B7\u30C3\u30AF)",
    paletteGrayscale: "\u30B0\u30EC\u30FC\u30B9\u30B1\u30FC\u30EB",
    paletteInverseGrayscale: "\u53CD\u8EE2\u30B0\u30EC\u30FC",
    minDb: "\u6700\u5C0F dB (\u660E\u308B\u3055)",
    maxDb: "\u6700\u5927 dB (\u660E\u308B\u3055)",
    autoBrightness: "\u81EA\u52D5\u660E\u308B\u3055",
    channel: "\u30C1\u30E3\u30F3\u30CD\u30EB",
    timeZoom: "\u6642\u9593\u30BA\u30FC\u30E0",
    timePosition: "\u6642\u9593\u4F4D\u7F6E",
    amplitudeZoom: "\u632F\u5E45\u30BA\u30FC\u30E0",
    mouseWheel: "\u30DE\u30A6\u30B9\u30DB\u30A4\u30FC\u30EB",
    refreshSpectrogram: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u3092\u66F4\u65B0",
    resetView: "\u8868\u793A\u3092\u30EA\u30BB\u30C3\u30C8",
    pcmReadAs: "PCM \u3068\u3057\u3066\u8AAD\u307F\u8FBC\u3080",
    pcmParams: "PCM \u30D1\u30E9\u30E1\u30FC\u30BF",
    wavPcmRead: "WAV \u3092 PCM \u3068\u3057\u3066\u8AAD\u307F\u8FBC\u3080",
    currentFileOnly: "\u73FE\u5728\u306E\u30D5\u30A1\u30A4\u30EB\u306E\u307F",
    sampleRate: "\u30B5\u30F3\u30D7\u30EB\u30EC\u30FC\u30C8",
    channels: "\u30C1\u30E3\u30F3\u30CD\u30EB\u6570",
    startOffsetBytes: "\u30AA\u30D5\u30BB\u30C3\u30C8(B)",
    bitDepth: "\u30D3\u30C3\u30C8\u6DF1\u5EA6(bit)",
    sampleFormat: "\u5F62\u5F0F",
    endianness: "\u30A8\u30F3\u30C7\u30A3\u30A2\u30F3",
    read: "\u8AAD\u307F\u8FBC\u307F",
    saveDefault: "\u65E2\u5B9A\u5024\u3092\u4FDD\u5B58",
    cancel: "\u30AD\u30E3\u30F3\u30BB\u30EB",
    defaultView: "\u65E2\u5B9A\u30D3\u30E5\u30FC",
    view: "\u30D3\u30E5\u30FC",
    viewBoth: "\u30DE\u30EB\u30C1\u30D3\u30E5\u30FC",
    mute: "\u30DF\u30E5\u30FC\u30C8",
    solo: "\u30BD\u30ED",
    timeLabel: "\u6642\u9593",
    helpTimeZoom: "\u6642\u9593\u30BA\u30FC\u30E0",
    helpTimePan: "\u6642\u9593\u79FB\u52D5",
    helpAmplitudeZoom: "\u632F\u5E45\u30BA\u30FC\u30E0",
    helpRightClick: "\u53F3\u30AF\u30EA\u30C3\u30AF",
    helpPinch: "\u30D4\u30F3\u30C1",
    helpHorizontalSwipe: "\u6A2A\u30B9\u30EF\u30A4\u30D7",
    helpDoubleClick: "\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF",
    helpPlaybackGroup: "\u518D\u751F\u3068\u9078\u629E\u7BC4\u56F2",
    helpViewGroup: "\u8868\u793A\u64CD\u4F5C",
    helpMouseGroup: "\u30DE\u30A6\u30B9\u3068\u30C8\u30E9\u30C3\u30AF\u30D1\u30C3\u30C9",
    helpGainGroup: "\u30B2\u30A4\u30F3",
    helpPlayPause: "\u518D\u751F / \u4E00\u6642\u505C\u6B62",
    helpClearSelection: "\u30E1\u30CB\u30E5\u30FC\u3092\u9589\u3058\u308B\u3001\u9078\u629E\u7BC4\u56F2\u3092\u89E3\u9664\u3001\u307E\u305F\u306F\u518D\u751F\u30AB\u30FC\u30BD\u30EB\u3092\u30EA\u30BB\u30C3\u30C8",
    helpResetTimeZoom: "\u6642\u9593\u30BA\u30FC\u30E0\u3092\u30EA\u30BB\u30C3\u30C8",
    helpTrackpadZoom: "\u30C8\u30E9\u30C3\u30AF\u30D1\u30C3\u30C9\u306E\u30D4\u30F3\u30C1\u3067\u6642\u9593\u3092\u30BA\u30FC\u30E0",
    helpTrackpadPan: "\u30C8\u30E9\u30C3\u30AF\u30D1\u30C3\u30C9\u306E\u6A2A\u30B9\u30EF\u30A4\u30D7\u3067\u6642\u9593\u3092\u79FB\u52D5",
    helpGainReset: "\u30B2\u30A4\u30F3\u30B9\u30E9\u30A4\u30C0\u30FC\u3092\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF\u3057\u3066 0 dB \u306B\u623B\u3059",
    helpSelectionPlayback: "\u6CE2\u5F62\u307E\u305F\u306F\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u3092\u30C9\u30E9\u30C3\u30B0\u3057\u3066\u7BC4\u56F2\u3092\u9078\u629E\u3057\u307E\u3059\u3002\u9078\u629E\u7BC4\u56F2\u304C\u3042\u308B\u5834\u5408\u3001\u518D\u751F\u306F\u305D\u306E\u7BC4\u56F2\u3060\u3051\u306B\u306A\u308A\u307E\u3059\u3002",
    selectionAnalysis: "\u9078\u629E\u7BC4\u56F2\u5206\u6790",
    selectionAnalysisHelp: "\u9078\u629E\u7BC4\u56F2\u5206\u6790:\n\u9078\u629E\u3057\u305F\u6642\u9593\u7BC4\u56F2\u3092\u3059\u3070\u3084\u304F\u96C6\u8A08\u3057\u3001\u9332\u97F3\u30EC\u30D9\u30EB\u3001\u30C0\u30A4\u30CA\u30DF\u30C3\u30AF\u30EC\u30F3\u30B8\u3001\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0\u30EA\u30B9\u30AF\u3001\u30CE\u30A4\u30BA\u30D5\u30ED\u30A2\u3001\u5468\u6CE2\u6570\u5206\u5E03\u3092\u78BA\u8A8D\u3057\u307E\u3059\u3002\n\n\u5BFE\u8C61:\n\u7D50\u679C\u306F\u73FE\u5728\u30A2\u30AF\u30C6\u30A3\u30D6\u306A\u30C1\u30E3\u30F3\u30CD\u30EB\u3060\u3051\u3067\u8A08\u7B97\u3057\u307E\u3059\u3002\u8907\u6570\u30C1\u30E3\u30F3\u30CD\u30EB\u3092\u6DF7\u5408\u3057\u307E\u305B\u3093\u3002\n\n\u5207\u308A\u66FF\u3048:\n\u30C8\u30E9\u30C3\u30AF\u3092\u30AF\u30EA\u30C3\u30AF\u3059\u308B\u3068\u3001\u305D\u306E\u30C8\u30E9\u30C3\u30AF\u304C\u30A2\u30AF\u30C6\u30A3\u30D6\u30C1\u30E3\u30F3\u30CD\u30EB\u306B\u306A\u308A\u307E\u3059\u3002\u4EE5\u5F8C\u306E RMS\u3001Peak\u3001Dominant\u3001\u5468\u6CE2\u6570\u5206\u6790\u306F\u305D\u306E\u30C1\u30E3\u30F3\u30CD\u30EB\u3092\u4F7F\u3044\u307E\u3059\u3002",
    basicMetrics: "\u57FA\u672C\u6307\u6A19",
    selectionStart: "\u958B\u59CB",
    selectionEnd: "\u7D42\u4E86",
    selectionDuration: "\u9577\u3055",
    rmsLevel: "RMS\u30EC\u30D9\u30EB",
    peakLevel: "\u30D4\u30FC\u30AF\u30EC\u30D9\u30EB",
    dominant: "\u4E3B\u5468\u6CE2\u6570",
    crestFactor: "\u30AF\u30EC\u30B9\u30C8",
    clippingRatio: "\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0",
    noiseFloor: "\u30CE\u30A4\u30BA\u30D5\u30ED\u30A2",
    spectralCentroid: "\u91CD\u5FC3",
    zeroCrossingRate: "ZCR",
    rmsLevelHelp: "RMS\u30EC\u30D9\u30EB:\n\u8A08\u7B97:\nrms = sqrt(mean(sample\xB2))\nrmsDb = 20 \xD7 log10(rms)\n\n\u7528\u9014:\n\u9078\u629E\u7BC4\u56F2\u306E\u5E73\u5747\u7684\u306A\u30A8\u30CD\u30EB\u30AE\u30FC\u3084\u97F3\u91CF\u50BE\u5411\u3092\u793A\u3057\u307E\u3059\u3002\u30D4\u30FC\u30AF\u3088\u308A\u5B89\u5B9A\u3057\u3066\u304A\u308A\u3001\u97F3\u58F0\u304C\u5C0F\u3055\u3059\u304E\u308B\u3001\u307E\u305F\u306F\u5927\u304D\u3059\u304E\u308B\u304B\u3092\u78BA\u8A8D\u3057\u3084\u3059\u3044\u6307\u6A19\u3067\u3059\u3002\n\n\u5236\u9650:\nRMS \u306F LUFS \u3067\u306F\u306A\u304F\u3001\u8074\u611F\u91CD\u307F\u4ED8\u3051\u3084\u30B2\u30FC\u30C6\u30A3\u30F3\u30B0\u306F\u3042\u308A\u307E\u305B\u3093\u3002\u9577\u3044\u9078\u629E\u7BC4\u56F2\u3067\u306F UI \u5FDC\u7B54\u6027\u3092\u4FDD\u3064\u305F\u3081\u5747\u7B49\u30B5\u30F3\u30D7\u30EA\u30F3\u30B0\u3057\u307E\u3059\u3002\n\n\u53C2\u8003:\nMathWorks rms; librosa.feature.rms; Audacity Measure RMS.",
    peakLevelHelp: "\u30D4\u30FC\u30AF\u30EC\u30D9\u30EB:\n\u8A08\u7B97:\npeak = max(abs(sample))\npeakDb = 20 \xD7 log10(peak)\n\n\u7528\u9014:\n\u9078\u629E\u7BC4\u56F2\u5185\u306E\u6700\u5927\u77AC\u6642\u30EC\u30D9\u30EB\u3092\u793A\u3057\u307E\u3059\u30020 dBFS \u3078\u306E\u8FD1\u3055\u3084\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0\u30EA\u30B9\u30AF\u78BA\u8A8D\u306B\u6709\u7528\u3067\u3059\u3002\n\n\u5236\u9650:\n\u30D4\u30FC\u30AF\u306F\u6700\u5927\u77AC\u9593\u3060\u3051\u3092\u8868\u3057\u3001\u5168\u4F53\u306E\u5927\u304D\u3055\u306F\u8868\u3057\u307E\u305B\u3093\u3002\u9577\u3044\u9078\u629E\u7BC4\u56F2\u3067\u306F UI \u5FDC\u7B54\u6027\u3092\u4FDD\u3064\u305F\u3081\u5747\u7B49\u30B5\u30F3\u30D7\u30EA\u30F3\u30B0\u3057\u307E\u3059\u3002\n\n\u53C2\u8003:\nAdobe Audition Amplitude Statistics; Audacity Amplify; AES17 0 dBFS.",
    dominantHelp: "\u4E3B\u5468\u6CE2\u6570:\n\u9078\u629E\u7BC4\u56F2\u5168\u4F53\u3067\u7D2F\u7A4D\u30D1\u30EF\u30FC\u304C\u6700\u5927\u306E FFT \u5468\u6CE2\u6570\u30D3\u30F3\u3067\u3059\u3002\n\n\u30D3\u30F3\u5BFE\u5FDC:\n\u30D3\u30F3 k \u306E\u5468\u6CE2\u6570:\nfreq = k \xD7 sampleRate / FFT size\n\n\u30D1\u30EF\u30FC:\n\u5404\u30D5\u30EC\u30FC\u30E0\u3067:\npower = re\xB2 + im\xB2\n\n\u9078\u629E\u7BC4\u56F2\u3067\u306E\u7D2F\u7A4D:\nbinPower[k] += power\n\n\u7D50\u679C:\ndominantHz = k \xD7 sampleRate / FFT size\u3002k \u306F binPower \u304C\u6700\u5927\u306E\u30D3\u30F3\u3067\u3059\u3002\n\n\u610F\u5473:\n\u5FC5\u305A\u3057\u3082\u57FA\u672C\u5468\u6CE2\u6570\u3084\u77E5\u899A\u4E0A\u306E\u30D4\u30C3\u30C1\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002\u5468\u6CE2\u6570\u5206\u89E3\u80FD\u306F sampleRate / FFT size \u3067\u3059\u3002\n\n\u53C2\u8003:\nNumPy fftfreq; librosa spectral features.",
    crestFactorHelp: "\u30AF\u30EC\u30B9\u30C8\u30D5\u30A1\u30AF\u30BF\u30FC:\n\u30D4\u30FC\u30AF\u3068 RMS \u306E\u6BD4\u3067\u3059\u3002\n\n\u8A08\u7B97:\ncrest = peak / rms\ncrestDb = peakDb - rmsDb\n\n\u7528\u9014:\n\u30C0\u30A4\u30CA\u30DF\u30C3\u30AF\u30EC\u30F3\u30B8\u3084\u904E\u6E21\u6210\u5206\u306E\u5F37\u3055\u3092\u793A\u3057\u307E\u3059\u3002\u5024\u304C\u5927\u304D\u3044\u307B\u3069\u5E73\u5747\u30A8\u30CD\u30EB\u30AE\u30FC\u306B\u5BFE\u3057\u3066\u30D4\u30FC\u30AF\u304C\u76EE\u7ACB\u3061\u307E\u3059\u3002\n\n\u5236\u9650:\n\u7121\u97F3\u3084\u975E\u5E38\u306B\u5C0F\u3055\u3044\u97F3\u3067\u306F\u4E0D\u5B89\u5B9A\u3067\u3059\u3002\u30C0\u30A4\u30CA\u30DF\u30AF\u30B9\u3092\u793A\u3059\u6307\u6A19\u3067\u3042\u308A\u3001\u54C1\u8CEA\u3092\u76F4\u63A5\u5224\u5B9A\u3059\u308B\u3082\u306E\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002\n\n\u53C2\u8003:\nMathWorks peak2rms; Signal Processing Toolbox descriptive statistics.",
    clippingRatioHelp: "\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0\u7387:\n\u30D5\u30EB\u30B9\u30B1\u30FC\u30EB\u306B\u8FD1\u3044\u30B5\u30F3\u30D7\u30EB\u306E\u5272\u5408\u3067\u3059\u3002\n\n\u8A08\u7B97:\nclippingRatio = count(abs(sample) >= 0.999) / measuredSamples \xD7 100%\n\n\u7528\u9014:\n\u30C7\u30B8\u30BF\u30EB\u30D5\u30EB\u30B9\u30B1\u30FC\u30EB\u3001\u9332\u97F3\u904E\u5927\u3001\u30CF\u30FC\u30C9\u30AF\u30EA\u30C3\u30D4\u30F3\u30B0\u306E\u30EA\u30B9\u30AF\u3092\u7D20\u65E9\u304F\u691C\u51FA\u3057\u307E\u3059\u3002\n\n\u5236\u9650:\nAudioLens \u306B\u5165\u308B\u524D\u306B\u30EA\u30DF\u30C3\u30BF\u30FC\u3084\u6B6A\u307F\u304C\u304B\u304B\u3063\u3066\u3044\u308B\u5834\u5408\u3001\u30D5\u30EB\u30B9\u30B1\u30FC\u30EB\u30B5\u30F3\u30D7\u30EB\u304C\u306A\u304F\u3066\u3082\u6B6A\u3093\u3067\u805E\u3053\u3048\u308B\u3053\u3068\u304C\u3042\u308A\u307E\u3059\u3002\n\n\u53C2\u8003:\nAudacity Find Clipping; Adobe Audition Amplitude Statistics; Netflix AudioClippingInspector.",
    noiseFloorHelp: "\u30CE\u30A4\u30BA\u30D5\u30ED\u30A2:\n\u9078\u629E\u7BC4\u56F2\u5185\u306E\u9759\u304B\u306A\u90E8\u5206\u306B\u304A\u3051\u308B\u77ED\u6642\u9593 RMS \u306E\u4F4E\u30D1\u30FC\u30BB\u30F3\u30BF\u30A4\u30EB\u304B\u3089\u63A8\u5B9A\u3057\u307E\u3059\u3002\n\n\u8A08\u7B97:\n1. \u9078\u629E\u7BC4\u56F2\u3092\u7D04 20 ms\u300150% \u30AA\u30FC\u30D0\u30FC\u30E9\u30C3\u30D7\u306E\u7A93\u306B\u5206\u5272\u3057\u307E\u3059\u3002\n2. \u5404\u7A93\u306E RMS \u3092\u8A08\u7B97\u3057\u307E\u3059\u3002\n3. RMS \u306E 10 \u30D1\u30FC\u30BB\u30F3\u30BF\u30A4\u30EB\u3092 dBFS \u306B\u5909\u63DB\u3057\u307E\u3059\u3002\n\n\u7528\u9014:\n\u80CC\u666F\u30CE\u30A4\u30BA\u3001\u7121\u97F3\u90E8\u5206\u306E\u304D\u308C\u3044\u3055\u3001\u9332\u97F3\u74B0\u5883\u306E\u30CE\u30A4\u30BA\u3092\u63A8\u5B9A\u3057\u307E\u3059\u3002\n\n\u5236\u9650:\n\u6559\u5E2B\u306A\u3057\u63A8\u5B9A\u3067\u3059\u3002\u9078\u629E\u7BC4\u56F2\u306E\u5927\u534A\u304C\u97F3\u58F0\u3084\u97F3\u697D\u306E\u5834\u5408\u3001\u771F\u306E\u30CE\u30A4\u30BA\u30D5\u30ED\u30A2\u3068\u306F\u4E00\u81F4\u3057\u306A\u3044\u3053\u3068\u304C\u3042\u308A\u307E\u3059\u3002\n\n\u53C2\u8003:\nAdobe Audition Minimum RMS; librosa.feature.rms; Audacity Noise Reduction.",
    spectralCentroidHelp: "\u30B9\u30DA\u30AF\u30C8\u30EB\u91CD\u5FC3:\n\u30B9\u30DA\u30AF\u30C8\u30EB\u30A8\u30CD\u30EB\u30AE\u30FC\u306E\u91CD\u5FC3\u3092 Hz \u3067\u8868\u3057\u307E\u3059\u3002\n\n\u8A08\u7B97:\ncentroid = sum(freq[k] \xD7 power[k]) / sum(power[k])\n\n\u7528\u9014:\n\u97F3\u304C\u660E\u308B\u3044\u304B\u6697\u3044\u304B\u306E\u50BE\u5411\u3092\u793A\u3057\u307E\u3059\u3002\u9AD8\u57DF\u6210\u5206\u306E\u591A\u3044\u97F3\u58F0\u306F\u4E00\u822C\u306B\u91CD\u5FC3\u304C\u9AD8\u304F\u306A\u308A\u307E\u3059\u3002\n\n\u5236\u9650:\n\u30CE\u30A4\u30BA\u3001\u6B6F\u64E6\u97F3\u3001\u5E2F\u57DF\u5E45\u306E\u5F71\u97FF\u3092\u53D7\u3051\u307E\u3059\u3002\u30D4\u30C3\u30C1\u3067\u306F\u306A\u304F\u3001\u5358\u72EC\u3067\u660E\u77AD\u5EA6\u3092\u5224\u65AD\u3059\u308B\u3082\u306E\u3067\u3082\u3042\u308A\u307E\u305B\u3093\u3002\n\n\u53C2\u8003:\nlibrosa.feature.spectral_centroid; MathWorks spectralCentroid.",
    zeroCrossingRateHelp: "\u30BC\u30ED\u4EA4\u5DEE\u7387:\n\u4FE1\u53F7\u306E\u7B26\u53F7\u304C\u5909\u308F\u308B\u983B\u5EA6\u3067\u3059\u3002\n\n\u8A08\u7B97:\nzeroCrossingRate = zeroCrossings / durationSeconds\n\n\u7528\u9014:\n\u9AD8\u5468\u6CE2\u30CE\u30A4\u30BA\u3001\u7121\u58F0\u97F3\u3001\u6469\u64E6\u97F3\u306A\u3069\u3092\u5927\u307E\u304B\u306B\u898B\u308B\u6642\u9593\u9818\u57DF\u7279\u5FB4\u91CF\u3067\u3059\u3002\n\n\u5236\u9650:\n\u30CE\u30A4\u30BA\u3084 DC \u30AA\u30D5\u30BB\u30C3\u30C8\u306B\u654F\u611F\u3067\u3059\u3002\u5468\u6CE2\u6570\u3084\u30D4\u30C3\u30C1\u305D\u306E\u3082\u306E\u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002\n\n\u53C2\u8003:\nlibrosa.feature.zero_crossing_rate; librosa.zero_crossings.",
    frequencyAnalysis: "\u5468\u6CE2\u6570\u5206\u6790",
    frequencyAnalysisHelp: "\u610F\u5473:\n\u5468\u6CE2\u6570\u5E2F\u57DF\u3054\u3068\u306E\u7DDA\u5F62\u30A8\u30CD\u30EB\u30AE\u30FC\u5272\u5408\u3067\u3059\u3002RMS \u30EC\u30D9\u30EB\u3067\u3082 dB \u3067\u3082\u3042\u308A\u307E\u305B\u3093\u3002\n\n\u8A08\u7B97:\n1. \u9078\u629E\u7BC4\u56F2\u5185\u306E\u30A2\u30AF\u30C6\u30A3\u30D6\u30C1\u30E3\u30F3\u30CD\u30EB\u3092\u30B5\u30F3\u30D7\u30EA\u30F3\u30B0\u3057\u307E\u3059\u3002\n2. \u73FE\u5728\u306E\u7A93\u95A2\u6570\u3068 FFT \u30B5\u30A4\u30BA\u3092\u4F7F\u3044\u3001\u9078\u629E\u7BC4\u56F2\u5168\u4F53\u3092 50% \u30AA\u30FC\u30D0\u30FC\u30E9\u30C3\u30D7\u306E\u30D5\u30EC\u30FC\u30E0\u306B\u5206\u5272\u3057\u307E\u3059\u3002\n3. \u5404\u30D3\u30F3\u306E\u30D1\u30EF\u30FC\u306F re\xB2 + im\xB2 \u3067\u3059\u3002\n4. \u5168\u30D5\u30EC\u30FC\u30E0\u3067\u30D3\u30F3\u306E\u30D1\u30EF\u30FC\u3092\u7D2F\u7A4D\u3057\u3001\u5468\u6CE2\u6570\u5E2F\u57DF\u3078\u5272\u308A\u5F53\u3066\u307E\u3059\u3002\n5. bandPower / totalPower \xD7 100% \u3092\u8868\u793A\u3057\u307E\u3059\u3002\n\n\u6CE8:\n\u3053\u308C\u306F\u9078\u629E\u7BC4\u56F2\u5168\u4F53\u306E\u8907\u6570\u30D5\u30EC\u30FC\u30E0\u306B\u3088\u308B\u30B9\u30DA\u30AF\u30C8\u30EB\u30A8\u30CD\u30EB\u30AE\u30FC\u5206\u5E03\u3067\u3042\u308A\u3001dB/RMS \u3067\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
    bands: "\u5E2F\u57DF",
    waveform: "\u6CE2\u5F62",
    spectrogram: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0",
    adjustWaveformHeight: "\u6CE2\u5F62\u306E\u9AD8\u3055\u3092\u8ABF\u6574",
    adjustSpectrogramHeight: "\u30B9\u30DA\u30AF\u30C8\u30ED\u30B0\u30E9\u30E0\u306E\u9AD8\u3055\u3092\u8ABF\u6574",
    ready: "\u6E96\u5099\u5B8C\u4E86",
    workspaceNotTrusted: "\u4FE1\u983C\u3055\u308C\u3066\u3044\u306A\u3044\u30EF\u30FC\u30AF\u30B9\u30DA\u30FC\u30B9\u306E\u305F\u3081\u3001\u97F3\u58F0\u5185\u5BB9\u306F\u8EE2\u9001\u3055\u308C\u307E\u305B\u3093",
    fileTooLarge: "\u30D5\u30A1\u30A4\u30EB\u304C\u4E0A\u9650\u3092\u8D85\u3048\u3066\u3044\u307E\u3059",
    readingAudio: "\u97F3\u58F0\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D",
    readingAudioProgress: "\u97F3\u58F0\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D",
    decodingAudio: "\u97F3\u58F0\u3092\u30C7\u30B3\u30FC\u30C9\u4E2D",
    transcodingAudio: "FFmpeg \u3067\u97F3\u58F0\u3092\u5909\u63DB\u4E2D",
    encodedPlaybackOnly: "\u3053\u306E\u30A8\u30F3\u30B3\u30FC\u30C9\u5F62\u5F0F\u306F VS Code Webview \u306E\u30C7\u30B3\u30FC\u30C0\u30FC\u3067\u30B5\u30DD\u30FC\u30C8\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002\u515C\u5E95\u30C7\u30B3\u30FC\u30C9\u3092\u6709\u52B9\u306B\u3059\u308B\u306B\u306F\u3001\u62E1\u5F35\u6A5F\u80FD\u30DB\u30B9\u30C8\u5074\u306E\u30DE\u30B7\u30F3\u306B FFmpeg \u3092\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    waitingPcmParams: "PCM \u30D1\u30E9\u30E1\u30FC\u30BF\u5F85\u6A5F\u4E2D",
    pcmUsedDefaultParams: "\u65E2\u5B9A\u306E PCM \u30D1\u30E9\u30E1\u30FC\u30BF\u3067\u8AAD\u307F\u8FBC\u307F\u307E\u3057\u305F\u3002",
    pcmFillParams: "PCM \u30D1\u30E9\u30E1\u30FC\u30BF\u3092\u5165\u529B\u3057\u3066\u304B\u3089\u3001\u8AAD\u307F\u8FBC\u307F\u3092\u30AF\u30EA\u30C3\u30AF\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
    wavPcmFillParams: "\u30D1\u30E9\u30E1\u30FC\u30BF\u3092\u5165\u529B\u3057\u3066\u304B\u3089\u8AAD\u307F\u8FBC\u307F\u3092\u30AF\u30EA\u30C3\u30AF\u3057\u3001\u73FE\u5728\u306E WAV \u3092 PCM \u3068\u3057\u3066\u89E3\u6790\u3057\u307E\u3059\u3002",
    currentPcmFormat: "\u73FE\u5728",
    savedDefaultPcmFormat: "\u4FDD\u5B58\u6E08\u307F\u65E2\u5B9A\u5024",
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
    initializationFailed: "AudioLens \u306E\u521D\u671F\u5316\u306B\u5931\u6557\u3057\u307E\u3057\u305F",
    playbackGainLabel: "\u30B2\u30A4\u30F3",
    playbackGain: "\u518D\u751F\u30B2\u30A4\u30F3 (\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF\u3067\u30EA\u30BB\u30C3\u30C8)"
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
    minDb: "\uCD5C\uC18C dB (\uBC1D\uAE30)",
    maxDb: "\uCD5C\uB300 dB (\uBC1D\uAE30)",
    autoBrightness: "\uC790\uB3D9 \uBC1D\uAE30",
    channel: "\uCC44\uB110",
    timeZoom: "\uC2DC\uAC04 \uD655\uB300",
    timePosition: "\uC2DC\uAC04 \uC704\uCE58",
    amplitudeZoom: "\uC9C4\uD3ED \uD655\uB300",
    mouseWheel: "\uB9C8\uC6B0\uC2A4 \uD720",
    help: "\uB3C4\uC6C0\uB9D0",
    downloadAudio: "\uC624\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC",
    settings: "\uC124\uC815",
    pcmReadAs: "PCM\uC73C\uB85C \uC77D\uAE30",
    pcmParams: "PCM \uB9E4\uAC1C\uBCC0\uC218",
    wavPcmRead: "WAV\uB97C PCM\uC73C\uB85C \uC77D\uAE30",
    currentFileOnly: "\uD604\uC7AC \uD30C\uC77C\uB9CC",
    sampleRate: "\uC0D8\uD50C\uB808\uC774\uD2B8",
    channels: "\uCC44\uB110 \uC218",
    startOffsetBytes: "\uC624\uD504\uC14B(B)",
    bitDepth: "\uBE44\uD2B8 \uAE4A\uC774(bit)",
    sampleFormat: "\uD615\uC2DD",
    endianness: "\uC5D4\uB514\uC5B8",
    read: "\uC77D\uAE30",
    saveDefault: "\uAE30\uBCF8\uAC12 \uC800\uC7A5",
    cancel: "\uCDE8\uC18C",
    defaultView: "\uAE30\uBCF8 \uBCF4\uAE30",
    view: "\uBCF4\uAE30",
    viewBoth: "\uBA40\uD2F0\uBDF0",
    mute: "\uC74C\uC18C\uAC70",
    solo: "\uC194\uB85C",
    timeLabel: "\uC2DC\uAC04",
    helpTimeZoom: "\uC2DC\uAC04 \uD655\uB300",
    helpTimePan: "\uC2DC\uAC04 \uC774\uB3D9",
    helpAmplitudeZoom: "\uC9C4\uD3ED \uD655\uB300",
    helpRightClick: "\uC624\uB978\uCABD \uD074\uB9AD",
    helpPinch: "\uD540\uCE58",
    helpHorizontalSwipe: "\uAC00\uB85C \uC2A4\uC640\uC774\uD504",
    helpDoubleClick: "\uB354\uBE14 \uD074\uB9AD",
    helpPlaybackGroup: "\uC7AC\uC0DD \uBC0F \uC120\uD0DD",
    helpViewGroup: "\uBCF4\uAE30 \uD0D0\uC0C9",
    helpMouseGroup: "\uB9C8\uC6B0\uC2A4 \uBC0F \uD2B8\uB799\uD328\uB4DC",
    helpGainGroup: "\uAC8C\uC778",
    helpPlayPause: "\uC7AC\uC0DD / \uC77C\uC2DC\uC815\uC9C0",
    helpClearSelection: "\uBA54\uB274 \uB2EB\uAE30, \uC120\uD0DD \uD574\uC81C \uB610\uB294 \uC7AC\uC0DD \uCEE4\uC11C \uCD08\uAE30\uD654",
    helpResetTimeZoom: "\uC2DC\uAC04 \uD655\uB300 \uCD08\uAE30\uD654",
    helpTrackpadZoom: "\uD2B8\uB799\uD328\uB4DC \uD540\uCE58\uB85C \uC2DC\uAC04 \uD655\uB300/\uCD95\uC18C",
    helpTrackpadPan: "\uD2B8\uB799\uD328\uB4DC \uAC00\uB85C \uC2A4\uC640\uC774\uD504\uB85C \uC2DC\uAC04 \uC774\uB3D9",
    helpGainReset: "\uAC8C\uC778 \uC2AC\uB77C\uC774\uB354\uB97C \uB354\uBE14 \uD074\uB9AD\uD558\uC5EC 0 dB\uB85C \uCD08\uAE30\uD654",
    helpSelectionPlayback: "\uD30C\uD615 \uB610\uB294 \uC2A4\uD399\uD2B8\uB85C\uADF8\uB7A8\uC744 \uB4DC\uB798\uADF8\uD558\uC5EC \uAD6C\uAC04\uC744 \uC120\uD0DD\uD569\uB2C8\uB2E4. \uC120\uD0DD \uAD6C\uAC04\uC774 \uC788\uC73C\uBA74 \uD574\uB2F9 \uBC94\uC704\uB9CC \uC7AC\uC0DD\uD569\uB2C8\uB2E4.",
    refreshSpectrogram: "Spectrogram \uC0C8\uB85C\uACE0\uCE68",
    resetView: "\uBCF4\uAE30 \uCD08\uAE30\uD654",
    selectionAnalysis: "\uC120\uD0DD \uBD84\uC11D",
    selectionStart: "\uC2DC\uC791",
    selectionEnd: "\uB05D",
    selectionDuration: "\uAE38\uC774",
    rmsLevel: "RMS \uB808\uBCA8",
    peakLevel: "\uD53C\uD06C \uB808\uBCA8",
    dominant: "\uC8FC\uC694",
    crestFactor: "\uD06C\uB808\uC2A4\uD2B8",
    clippingRatio: "\uD074\uB9AC\uD551",
    noiseFloor: "\uB178\uC774\uC988 \uD50C\uB85C\uC5B4",
    spectralCentroid: "\uC911\uC2EC",
    zeroCrossingRate: "ZCR",
    basicMetrics: "\uAE30\uBCF8 \uC9C0\uD45C",
    selectionAnalysisHelp: "\uC120\uD0DD \uBD84\uC11D:\n\uC120\uD0DD\uD55C \uC2DC\uAC04 \uBC94\uC704\uC758 \uB808\uBCA8, \uB2E4\uC774\uB0B4\uBBF9 \uB808\uC778\uC9C0, \uD074\uB9AC\uD551 \uC704\uD5D8, \uB178\uC774\uC988 \uD50C\uB85C\uC5B4, \uC8FC\uD30C\uC218 \uBD84\uD3EC\uB97C \uBE60\uB974\uAC8C \uD655\uC778\uD569\uB2C8\uB2E4.\n\n\uBC94\uC704:\n\uACB0\uACFC\uB294 \uD65C\uC131 \uCC44\uB110\uB9CC \uACC4\uC0B0\uD558\uBA70 \uC5EC\uB7EC \uCC44\uB110\uC744 \uBBF9\uC2A4\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.\n\n\uCC44\uB110 \uC804\uD658:\n\uD2B8\uB799\uC744 \uD074\uB9AD\uD558\uBA74 \uD574\uB2F9 \uD2B8\uB799\uC774 \uD65C\uC131 \uCC44\uB110\uC774 \uB429\uB2C8\uB2E4.",
    rmsLevelHelp: "RMS \uB808\uBCA8:\n\uC120\uD0DD \uAD6C\uAC04\uC758 \uD3C9\uADE0 \uC5D0\uB108\uC9C0\uB97C \uB098\uD0C0\uB0C5\uB2C8\uB2E4. peak\uBCF4\uB2E4 \uC548\uC815\uC801\uC774\uBA70 \uC74C\uC131\uC774 \uB108\uBB34 \uC791\uAC70\uB098 \uD070\uC9C0 \uD655\uC778\uD560 \uB54C \uC720\uC6A9\uD569\uB2C8\uB2E4.",
    peakLevelHelp: "\uD53C\uD06C \uB808\uBCA8:\n\uC120\uD0DD \uAD6C\uAC04\uC5D0\uC11C \uAC00\uC7A5 \uD070 \uC21C\uAC04 \uB808\uBCA8\uC785\uB2C8\uB2E4. 0 dBFS \uB610\uB294 \uD074\uB9AC\uD551 \uC704\uD5D8\uC5D0 \uAC00\uAE4C\uC6B4\uC9C0 \uD655\uC778\uD560 \uB54C \uC720\uC6A9\uD569\uB2C8\uB2E4.",
    dominantHelp: "\uC8FC\uC694 \uC8FC\uD30C\uC218:\n\uC120\uD0DD \uAD6C\uAC04\uC5D0\uC11C \uB204\uC801 \uD30C\uC6CC\uAC00 \uAC00\uC7A5 \uD070 FFT bin\uC758 \uC8FC\uD30C\uC218\uC785\uB2C8\uB2E4. \uBC18\uB4DC\uC2DC \uAE30\uBCF8 \uC8FC\uD30C\uC218\uB098 \uC9C0\uAC01\uB418\uB294 pitch\uB294 \uC544\uB2D9\uB2C8\uB2E4.",
    crestFactorHelp: "\uD06C\uB808\uC2A4\uD2B8 \uD329\uD130:\npeak\uC640 RMS\uC758 \uBE44\uC728\uC785\uB2C8\uB2E4. \uD070 \uAC12\uC740 \uD3C9\uADE0 \uC5D0\uB108\uC9C0\uBCF4\uB2E4 \uD53C\uD06C\uAC00 \uB354 \uB450\uB4DC\uB7EC\uC9D0\uC744 \uC758\uBBF8\uD569\uB2C8\uB2E4.",
    clippingRatioHelp: "\uD074\uB9AC\uD551 \uBE44\uC728:\n\uD480\uC2A4\uCF00\uC77C\uC5D0 \uAC00\uAE4C\uC6B4 \uC0D8\uD50C\uC758 \uBE44\uC728\uC785\uB2C8\uB2E4. \uB179\uC74C \uACFC\uBD80\uD558\uB098 \uB514\uC9C0\uD138 \uD074\uB9AC\uD551 \uC704\uD5D8\uC744 \uBE60\uB974\uAC8C \uD655\uC778\uD569\uB2C8\uB2E4.",
    noiseFloorHelp: "\uB178\uC774\uC988 \uD50C\uB85C\uC5B4:\n\uC9E7\uC740 RMS \uCC3D\uC758 \uB0AE\uC740 \uD37C\uC13C\uD0C0\uC77C\uB85C \uBC30\uACBD \uB178\uC774\uC988\uB97C \uCD94\uC815\uD569\uB2C8\uB2E4. \uC120\uD0DD \uAD6C\uAC04\uC774 \uB300\uBD80\uBD84 \uC74C\uC131\uC774\uB098 \uC74C\uC545\uC774\uBA74 \uC2E4\uC81C \uB178\uC774\uC988 \uD50C\uB85C\uC5B4\uC640 \uB2E4\uB97C \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
    spectralCentroidHelp: "\uC2A4\uD399\uD2B8\uB7FC \uC911\uC2EC:\n\uC2A4\uD399\uD2B8\uB7FC \uC5D0\uB108\uC9C0\uC758 \uC911\uC2EC\uC744 Hz\uB85C \uB098\uD0C0\uB0C5\uB2C8\uB2E4. \uC18C\uB9AC\uAC00 \uBC1D\uC740\uC9C0 \uC5B4\uB450\uC6B4\uC9C0 \uBCF4\uB294 \uB370 \uC720\uC6A9\uD569\uB2C8\uB2E4.",
    zeroCrossingRateHelp: "\uC601\uAD50\uCC28\uC728:\n\uC2E0\uD638 \uBD80\uD638\uAC00 \uBC14\uB00C\uB294 \uBE44\uC728\uC785\uB2C8\uB2E4. \uACE0\uC8FC\uD30C \uB178\uC774\uC988, \uBB34\uC131\uC74C, \uB9C8\uCC30\uC74C \uD655\uC778\uC5D0 \uC720\uC6A9\uD55C \uC2DC\uAC04 \uC601\uC5ED \uD2B9\uC9D5\uC785\uB2C8\uB2E4.",
    frequencyAnalysis: "\uC8FC\uD30C\uC218 \uBD84\uC11D",
    frequencyAnalysisHelp: "\uC758\uBBF8:\n\uC8FC\uD30C\uC218 \uB300\uC5ED\uBCC4 \uC120\uD615 \uC5D0\uB108\uC9C0 \uBE44\uC728\uC785\uB2C8\uB2E4. RMS \uB808\uBCA8\uC774\uB098 dB\uAC00 \uC544\uB2D9\uB2C8\uB2E4.\n\n\uACC4\uC0B0:\n\uC120\uD0DD \uAD6C\uAC04 \uC804\uCCB4\uB97C 50% overlap frame\uC73C\uB85C \uB098\uB204\uACE0, \uAC01 FFT bin\uC758 power\uB97C \uB204\uC801\uD55C \uB4A4 \uB300\uC5ED\uBCC4 \uBE44\uC728\uC744 \uD45C\uC2DC\uD569\uB2C8\uB2E4.",
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
    transcodingAudio: "FFmpeg\uB85C \uC624\uB514\uC624 \uBCC0\uD658 \uC911",
    encodedPlaybackOnly: "\uC774 \uC778\uCF54\uB529 \uD615\uC2DD\uC740 VS Code Webview \uB514\uCF54\uB354\uC5D0\uC11C \uC9C0\uC6D0\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. fallback \uB514\uCF54\uB529\uC744 \uC0AC\uC6A9\uD558\uB824\uBA74 extension host \uBA38\uC2E0\uC5D0 FFmpeg\uB97C \uC124\uCE58\uD558\uC138\uC694.",
    waitingPcmParams: "PCM \uB9E4\uAC1C\uBCC0\uC218 \uB300\uAE30 \uC911",
    pcmUsedDefaultParams: "\uAE30\uBCF8 PCM \uB9E4\uAC1C\uBCC0\uC218\uB85C \uB85C\uB4DC\uD588\uC2B5\uB2C8\uB2E4.",
    pcmFillParams: "PCM \uB9E4\uAC1C\uBCC0\uC218\uB97C \uC785\uB825\uD55C \uB4A4 \uC77D\uAE30\uB97C \uD074\uB9AD\uD558\uC138\uC694.",
    wavPcmFillParams: "\uB9E4\uAC1C\uBCC0\uC218\uB97C \uC785\uB825\uD55C \uB4A4 \uC77D\uAE30\uB97C \uD074\uB9AD\uD558\uC5EC \uD604\uC7AC WAV\uB97C PCM\uC73C\uB85C \uD574\uC11D\uD558\uC138\uC694.",
    currentPcmFormat: "\uD604\uC7AC",
    savedDefaultPcmFormat: "\uC800\uC7A5\uB41C \uAE30\uBCF8\uAC12",
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
    initializationFailed: "AudioLens \uCD08\uAE30\uD654 \uC2E4\uD328",
    playbackGainLabel: "\uAC8C\uC778",
    playbackGain: "\uC7AC\uC0DD \uAC8C\uC778 (\uB354\uBE14 \uD074\uB9AD\uD558\uC5EC \uCD08\uAE30\uD654)"
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
    minDb: "Min dB (helderheid)",
    maxDb: "Max dB (helderheid)",
    autoBrightness: "Auto-helderheid",
    channel: "Kanaal",
    timeZoom: "Tijdzoom",
    timePosition: "Tijdpositie",
    amplitudeZoom: "Amplitudezoom",
    mouseWheel: "Muiswiel",
    help: "Help",
    downloadAudio: "Audio downloaden",
    settings: "Instellingen",
    pcmReadAs: "Als PCM lezen",
    pcmParams: "PCM-parameters",
    wavPcmRead: "WAV als PCM lezen",
    currentFileOnly: "Alleen huidig bestand",
    sampleRate: "Samplefrequentie",
    channels: "Kanalen",
    startOffsetBytes: "Offset (B)",
    bitDepth: "Bitdiepte (bit)",
    sampleFormat: "Formaat",
    endianness: "Endian",
    read: "Lezen",
    saveDefault: "Standaard opslaan",
    cancel: "Annuleren",
    defaultView: "Standaardweergave",
    view: "Weergave",
    viewBoth: "Multi-weergave",
    mute: "Dempen",
    solo: "Solo",
    timeLabel: "Tijd",
    helpTimeZoom: "Tijdzoom",
    helpTimePan: "Tijd verschuiven",
    helpAmplitudeZoom: "Amplitudezoom",
    helpRightClick: "Rechtsklik",
    helpPinch: "Knijpen",
    helpHorizontalSwipe: "Horizontaal vegen",
    helpDoubleClick: "Dubbelklik",
    helpPlaybackGroup: "Afspelen en selectie",
    helpViewGroup: "Weergavenavigatie",
    helpMouseGroup: "Muis en trackpad",
    helpGainGroup: "Gain",
    helpPlayPause: "Afspelen / pauze",
    helpClearSelection: "Menu sluiten, selectie wissen of afspeelcursor resetten",
    helpResetTimeZoom: "Tijdzoom resetten",
    helpTrackpadZoom: "Knijp op trackpad om tijd te zoomen",
    helpTrackpadPan: "Horizontale trackpad-swipe verschuift tijd",
    helpGainReset: "Dubbelklik de gain-schuif om naar 0 dB te resetten",
    helpSelectionPlayback: "Sleep over golfvorm of spectrogram om een segment te selecteren. Met actieve selectie wordt alleen dat bereik afgespeeld.",
    refreshSpectrogram: "Spectrogram verversen",
    resetView: "Weergave resetten",
    selectionAnalysis: "Selectieanalyse",
    selectionStart: "Start",
    selectionEnd: "Einde",
    selectionDuration: "Duur",
    rmsLevel: "RMS-niveau",
    peakLevel: "Peak-niveau",
    dominant: "Dominant",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "Ruisvloer",
    spectralCentroid: "Centroid",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Basismetingen",
    selectionAnalysisHelp: "Selectieanalyse:\nAnalyseert snel het geselecteerde tijdsbereik voor niveau, dynamiek, clippingrisico, ruisvloer en frequentieverdeling.\n\nBereik:\nResultaten worden alleen voor het actieve kanaal berekend; kanalen worden niet gemixt.\n\nKanaal wisselen:\nKlik op een spoor om het actief te maken.",
    rmsLevelHelp: "RMS-niveau:\nToont gemiddelde energie in de selectie. Stabieler dan peak en nuttig voor te zachte of te luide spraak.",
    peakLevelHelp: "Peak-niveau:\nToont het hoogste momentane niveau in de selectie. Nuttig voor nabijheid van 0 dBFS en clippingrisico.",
    dominantHelp: "Dominante frequentie:\nFFT-bin met de hoogste opgetelde power in de selectie. Dit is niet noodzakelijk de grondtoon of waargenomen toonhoogte.",
    crestFactorHelp: "Crest factor:\nVerhouding tussen peak en RMS. Hogere waarden betekenen sterkere pieken ten opzichte van gemiddelde energie.",
    clippingRatioHelp: "Clippingratio:\nPercentage samples dicht bij full scale. Helpt overbelasting of digitale clipping snel te detecteren.",
    noiseFloorHelp: "Ruisvloer:\nGeschat uit een laag percentiel van korte RMS-vensters. Bij vooral spraak of muziek kan dit afwijken van de echte ruisvloer.",
    spectralCentroidHelp: "Spectrale centroid:\nZwaartepunt van spectrale energie in Hz. Geeft aan of geluid helderder of donkerder is.",
    zeroCrossingRateHelp: "Zero-crossing-rate:\nHoe vaak het signaal van teken wisselt. Nuttig voor hoogfrequente ruis, stemloze spraak en fricatieven.",
    frequencyAnalysis: "Frequentieanalyse",
    frequencyAnalysisHelp: "Betekenis:\nLineair energiepercentage per frequentieband. Het is geen RMS-niveau en geen dB.\n\nBerekening:\nDe selectie wordt in frames met 50% overlap verdeeld. FFT-bin-power wordt opgeteld en aan frequentiebanden toegewezen.",
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
    transcodingAudio: "Audio transcoderen met FFmpeg",
    encodedPlaybackOnly: "Dit gecodeerde audioformaat wordt niet ondersteund door de VS Code Webview-decoder. Installeer FFmpeg op de extension host-machine voor fallback-decoding.",
    waitingPcmParams: "Wachten op PCM-parameters",
    pcmUsedDefaultParams: "Geladen met standaard PCM-parameters.",
    pcmFillParams: "Vul PCM-parameters in en klik op Lezen.",
    wavPcmFillParams: "Vul parameters in en klik op Lezen om de huidige WAV als PCM te parsen.",
    currentPcmFormat: "Huidig",
    savedDefaultPcmFormat: "Opgeslagen standaard",
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
    initializationFailed: "AudioLens-initialisatie mislukt",
    playbackGainLabel: "Gain",
    playbackGain: "Afspeel-gain (dubbelklik om te resetten)"
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
    minDb: "Min dB (lysstyrke)",
    maxDb: "Maks dB (lysstyrke)",
    autoBrightness: "Auto-lysstyrke",
    channel: "Kanal",
    timeZoom: "Tidszoom",
    timePosition: "Tidsposisjon",
    amplitudeZoom: "Amplitudezoom",
    mouseWheel: "Musehjul",
    help: "Hjelp",
    downloadAudio: "Last ned lyd",
    settings: "Innstillinger",
    pcmReadAs: "Les som PCM",
    pcmParams: "PCM-parametere",
    wavPcmRead: "Les WAV som PCM",
    currentFileOnly: "Bare gjeldende fil",
    sampleRate: "Samplingsrate",
    channels: "Kanaler",
    startOffsetBytes: "Offset (B)",
    bitDepth: "Bitdybde (bit)",
    sampleFormat: "Format",
    endianness: "Endian",
    read: "Les",
    saveDefault: "Lagre standard",
    cancel: "Avbryt",
    defaultView: "Standardvisning",
    view: "Visning",
    viewBoth: "Flervisning",
    mute: "Demp",
    solo: "Solo",
    timeLabel: "Tid",
    helpTimeZoom: "Tidszoom",
    helpTimePan: "Tidspanorering",
    helpAmplitudeZoom: "Amplitudezoom",
    helpRightClick: "H\xF8yreklikk",
    helpPinch: "Knip",
    helpHorizontalSwipe: "Horisontal sveip",
    helpDoubleClick: "Dobbeltklikk",
    helpPlaybackGroup: "Avspilling og utvalg",
    helpViewGroup: "Visningsnavigasjon",
    helpMouseGroup: "Mus og styreflate",
    helpGainGroup: "Gain",
    helpPlayPause: "Spill av / pause",
    helpClearSelection: "Lukk meny, fjern utvalg eller tilbakestill avspillingsmark\xF8r",
    helpResetTimeZoom: "Tilbakestill tidszoom",
    helpTrackpadZoom: "Knip p\xE5 styreflaten for \xE5 zoome tid",
    helpTrackpadPan: "Horisontal sveip p\xE5 styreflaten flytter tid",
    helpGainReset: "Dobbeltklikk gain-glidebryteren for \xE5 g\xE5 til 0 dB",
    helpSelectionPlayback: "Dra i b\xF8lgeform eller spectrogram for \xE5 velge et segment. Med aktivt utvalg spilles bare dette omr\xE5det.",
    refreshSpectrogram: "Oppdater spectrogram",
    resetView: "Tilbakestill visning",
    selectionAnalysis: "Utvalgsanalyse",
    selectionStart: "Start",
    selectionEnd: "Slutt",
    selectionDuration: "Varighet",
    rmsLevel: "RMS-niv\xE5",
    peakLevel: "Peak-niv\xE5",
    dominant: "Dominant",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "St\xF8ygulv",
    spectralCentroid: "Centroid",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Grunnm\xE5linger",
    selectionAnalysisHelp: "Utvalgsanalyse:\nAnalyserer valgt tidsomr\xE5de for niv\xE5, dynamikk, clipping-risiko, st\xF8ygulv og frekvensfordeling.\n\nOmfang:\nResultater beregnes bare for aktiv kanal; kanaler mikses ikke.\n\nBytt kanal:\nKlikk p\xE5 et spor for \xE5 gj\xF8re det aktivt.",
    rmsLevelHelp: "RMS-niv\xE5:\nViser gjennomsnittlig energi i utvalget. Mer stabilt enn peak og nyttig for \xE5 sjekke tale som er for lav eller h\xF8y.",
    peakLevelHelp: "Peak-niv\xE5:\nViser h\xF8yeste \xF8yeblikksniv\xE5 i utvalget. Nyttig for \xE5 sjekke n\xE6rhet til 0 dBFS og clipping-risiko.",
    dominantHelp: "Dominant frekvens:\nFFT-bin med h\xF8yest akkumulert effekt i utvalget. Det er ikke n\xF8dvendigvis grunntone eller oppfattet pitch.",
    crestFactorHelp: "Crest factor:\nForholdet mellom peak og RMS. H\xF8yere verdier betyr tydeligere topper mot gjennomsnittsenergien.",
    clippingRatioHelp: "Clipping-andel:\nProsentandel samples n\xE6r full skala. Hjelper \xE5 oppdage overstyring og digital clipping.",
    noiseFloorHelp: "St\xF8ygulv:\nEstimert fra lav persentil av korttids-RMS. Hvis utvalget mest er tale eller musikk, kan verdien avvike fra faktisk st\xF8ygulv.",
    spectralCentroidHelp: "Spektral centroid:\nTyngdepunktet til spektral energi i Hz. Indikerer om lyden heller mot lys eller m\xF8rk.",
    zeroCrossingRateHelp: "Zero crossing rate:\nHvor ofte signalet skifter fortegn. Nyttig for h\xF8yfrekvent st\xF8y, ustemt tale og frikativer.",
    frequencyAnalysis: "Frekvensanalyse",
    frequencyAnalysisHelp: "Betydning:\nLine\xE6r energiprosent per frekvensb\xE5nd. Det er ikke RMS-niv\xE5 og ikke dB.\n\nBeregning:\nUtvalget deles i rammer med 50% overlapp. FFT-bin-effekt akkumuleres og fordeles p\xE5 frekvensb\xE5nd.",
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
    transcodingAudio: "Transkoder lyd med FFmpeg",
    encodedPlaybackOnly: "Dette kodede lydformatet st\xF8ttes ikke av VS Code Webview-dekoderen. Installer FFmpeg p\xE5 extension host-maskinen for fallback-dekoding.",
    waitingPcmParams: "Venter p\xE5 PCM-parametere",
    pcmUsedDefaultParams: "Lastet med standard PCM-parametere.",
    pcmFillParams: "Fyll inn PCM-parametere og klikk Les.",
    wavPcmFillParams: "Fyll inn parametere og klikk Les for \xE5 tolke gjeldende WAV som PCM.",
    currentPcmFormat: "Gjeldende",
    savedDefaultPcmFormat: "Lagret standard",
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
    initializationFailed: "AudioLens-initialisering mislyktes",
    playbackGainLabel: "Gain",
    playbackGain: "Avspillings-gain (dobbeltklikk for \xE5 tilbakestille)"
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
    minDb: "Min. dB (jasno\u015B\u0107)",
    maxDb: "Maks. dB (jasno\u015B\u0107)",
    autoBrightness: "Auto-jasno\u015B\u0107",
    channel: "Kana\u0142",
    timeZoom: "Powi\u0119kszenie czasu",
    timePosition: "Pozycja czasu",
    amplitudeZoom: "Powi\u0119kszenie amplitudy",
    mouseWheel: "K\xF3\u0142ko myszy",
    help: "Pomoc",
    downloadAudio: "Pobierz audio",
    settings: "Ustawienia",
    pcmReadAs: "Czytaj jako PCM",
    pcmParams: "Parametry PCM",
    wavPcmRead: "Czytaj WAV jako PCM",
    currentFileOnly: "Tylko bie\u017C\u0105cy plik",
    sampleRate: "Cz\u0119stotliwo\u015B\u0107 pr\xF3bkowania",
    channels: "Kana\u0142y",
    startOffsetBytes: "Offset (B)",
    bitDepth: "G\u0142\u0119bia bitowa (bit)",
    sampleFormat: "Format",
    endianness: "Endian",
    read: "Czytaj",
    saveDefault: "Zapisz domy\u015Blne",
    cancel: "Anuluj",
    defaultView: "Widok domy\u015Blny",
    view: "Widok",
    viewBoth: "Widok \u0142\u0105czony",
    mute: "Wycisz",
    solo: "Solo",
    timeLabel: "Czas",
    helpTimeZoom: "Powi\u0119kszenie czasu",
    helpTimePan: "Przesuwanie czasu",
    helpAmplitudeZoom: "Powi\u0119kszenie amplitudy",
    helpRightClick: "Prawy klik",
    helpPinch: "Gest szczypania",
    helpHorizontalSwipe: "Przesuni\u0119cie poziome",
    helpDoubleClick: "Dwuklik",
    helpPlaybackGroup: "Odtwarzanie i zaznaczenie",
    helpViewGroup: "Nawigacja widoku",
    helpMouseGroup: "Mysz i trackpad",
    helpGainGroup: "Wzmocnienie",
    helpPlayPause: "Odtw\xF3rz / pauza",
    helpClearSelection: "Zamknij menu, wyczy\u015B\u0107 zaznaczenie lub zresetuj kursor",
    helpResetTimeZoom: "Zresetuj powi\u0119kszenie czasu",
    helpTrackpadZoom: "Gest szczypania na trackpadzie powi\u0119ksza czas",
    helpTrackpadPan: "Poziome przesuni\u0119cie trackpada przesuwa czas",
    helpGainReset: "Dwuklik suwaka wzmocnienia resetuje do 0 dB",
    helpSelectionPlayback: "Przeci\u0105gnij po przebiegu lub spektrogramie, aby zaznaczy\u0107 segment. Przy aktywnym zaznaczeniu odtwarzany jest tylko ten zakres.",
    refreshSpectrogram: "Od\u015Bwie\u017C spektrogram",
    resetView: "Resetuj widok",
    selectionAnalysis: "Analiza zaznaczenia",
    selectionStart: "Start",
    selectionEnd: "Koniec",
    selectionDuration: "Czas trwania",
    rmsLevel: "Poziom RMS",
    peakLevel: "Poziom Peak",
    dominant: "Dominuj\u0105ca",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "Poziom szumu",
    spectralCentroid: "Centroid",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Podstawowe metryki",
    selectionAnalysisHelp: "Analiza zaznaczenia:\nSzybko analizuje wybrany zakres czasu pod k\u0105tem poziomu, dynamiki, ryzyka clippingu, poziomu szumu i rozk\u0142adu cz\u0119stotliwo\u015Bci.\n\nZakres:\nWyniki s\u0105 liczone tylko dla aktywnego kana\u0142u; kana\u0142y nie s\u0105 miksowane.\n\nZmiana kana\u0142u:\nKliknij \u015Bcie\u017Ck\u0119, aby j\u0105 uaktywni\u0107.",
    rmsLevelHelp: "Poziom RMS:\nPokazuje \u015Bredni\u0105 energi\u0119 zaznaczenia. Stabilniejszy ni\u017C peak i przydatny do kontroli zbyt cichej lub g\u0142o\u015Bnej mowy.",
    peakLevelHelp: "Poziom peak:\nPokazuje najwy\u017Cszy chwilowy poziom w zaznaczeniu. Przydatny do sprawdzania blisko\u015Bci 0 dBFS i ryzyka clippingu.",
    dominantHelp: "Cz\u0119stotliwo\u015B\u0107 dominuj\u0105ca:\nBin FFT o najwi\u0119kszej skumulowanej mocy w zaznaczeniu. Nie musi by\u0107 cz\u0119stotliwo\u015Bci\u0105 podstawow\u0105 ani s\u0142yszan\u0105 wysoko\u015Bci\u0105.",
    crestFactorHelp: "Crest factor:\nStosunek peak do RMS. Wi\u0119ksze warto\u015Bci oznaczaj\u0105 mocniejsze piki wzgl\u0119dem \u015Bredniej energii.",
    clippingRatioHelp: "Udzia\u0142 clippingu:\nProcent pr\xF3bek bliskich pe\u0142nej skali. Pomaga wykrywa\u0107 przesterowanie i clipping cyfrowy.",
    noiseFloorHelp: "Poziom szumu:\nEstymowany z niskiego percentyla kr\xF3tkookresowego RMS. Przy zaznaczeniu z mow\u0105 lub muzyk\u0105 mo\u017Ce r\xF3\u017Cni\u0107 si\u0119 od rzeczywistego szumu.",
    spectralCentroidHelp: "Centroid widmowy:\n\u015Arodek masy energii widmowej w Hz. Wskazuje, czy d\u017Awi\u0119k jest ja\u015Bniejszy czy ciemniejszy.",
    zeroCrossingRateHelp: "Zero crossing rate:\nCz\u0119sto\u015B\u0107 zmian znaku sygna\u0142u. Przydatne dla szumu wysokocz\u0119stotliwo\u015Bciowego, mowy bezd\u017Awi\u0119cznej i frykatyw.",
    frequencyAnalysis: "Analiza cz\u0119stotliwo\u015Bci",
    frequencyAnalysisHelp: "Znaczenie:\nLiniowy procent energii w pasmach cz\u0119stotliwo\u015Bci. To nie jest poziom RMS ani dB.\n\nObliczanie:\nZaznaczenie dzieli si\u0119 na ramki z 50% overlap. Moc bin\xF3w FFT jest sumowana i przypisywana do pasm.",
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
    transcodingAudio: "Transkodowanie audio przez FFmpeg",
    encodedPlaybackOnly: "Ten zakodowany format audio nie jest obs\u0142ugiwany przez dekoder VS Code Webview. Zainstaluj FFmpeg na maszynie hosta rozszerzenia, aby w\u0142\u0105czy\u0107 dekodowanie awaryjne.",
    waitingPcmParams: "Oczekiwanie na parametry PCM",
    pcmUsedDefaultParams: "Wczytano z domy\u015Blnymi parametrami PCM.",
    pcmFillParams: "Uzupe\u0142nij parametry PCM, a nast\u0119pnie kliknij Czytaj.",
    wavPcmFillParams: "Uzupe\u0142nij parametry i kliknij Czytaj, aby sparsowa\u0107 bie\u017C\u0105cy WAV jako PCM.",
    currentPcmFormat: "Bie\u017C\u0105cy",
    savedDefaultPcmFormat: "Zapisane domy\u015Blne",
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
    initializationFailed: "Inicjalizacja AudioLens nie powiod\u0142a si\u0119",
    playbackGainLabel: "Wzmocnienie",
    playbackGain: "Wzmocnienie odtwarzania (dwuklik resetuje)"
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
    minDb: "dB m\xEDn. (brilho)",
    maxDb: "dB m\xE1x. (brilho)",
    autoBrightness: "Brilho autom\xE1tico",
    channel: "Canal",
    timeZoom: "Zoom temporal",
    timePosition: "Posi\xE7\xE3o temporal",
    amplitudeZoom: "Zoom de amplitude",
    mouseWheel: "Roda do mouse",
    help: "Ajuda",
    downloadAudio: "Baixar \xE1udio",
    settings: "Ajustes",
    pcmReadAs: "Ler como PCM",
    pcmParams: "Par\xE2metros PCM",
    wavPcmRead: "Ler WAV como PCM",
    currentFileOnly: "Somente arquivo atual",
    sampleRate: "Taxa de amostragem",
    channels: "Canais",
    startOffsetBytes: "Offset (B)",
    bitDepth: "Profundidade (bit)",
    sampleFormat: "Formato",
    endianness: "Endian",
    read: "Ler",
    saveDefault: "Salvar padr\xE3o",
    cancel: "Cancelar",
    defaultView: "Vista padr\xE3o",
    view: "Vista",
    viewBoth: "Multi-view",
    mute: "Mudo",
    solo: "Solo",
    timeLabel: "Tempo",
    helpTimeZoom: "Zoom temporal",
    helpTimePan: "Pan temporal",
    helpAmplitudeZoom: "Zoom de amplitude",
    helpRightClick: "Clique direito",
    helpPinch: "Pin\xE7ar",
    helpHorizontalSwipe: "Deslize horizontal",
    helpDoubleClick: "Duplo clique",
    helpPlaybackGroup: "Reprodu\xE7\xE3o e sele\xE7\xE3o",
    helpViewGroup: "Navega\xE7\xE3o da vista",
    helpMouseGroup: "Mouse e trackpad",
    helpGainGroup: "Ganho",
    helpPlayPause: "Reproduzir / pausar",
    helpClearSelection: "Fechar menu, limpar sele\xE7\xE3o ou redefinir cursor",
    helpResetTimeZoom: "Redefinir zoom temporal",
    helpTrackpadZoom: "Pin\xE7ar no trackpad para ampliar o tempo",
    helpTrackpadPan: "Deslize horizontal do trackpad move o tempo",
    helpGainReset: "Duplo clique no controle de ganho para voltar a 0 dB",
    helpSelectionPlayback: "Arraste a forma de onda ou o espectrograma para selecionar um segmento. Com sele\xE7\xE3o ativa, s\xF3 esse intervalo \xE9 reproduzido.",
    refreshSpectrogram: "Atualizar espectrograma",
    resetView: "Redefinir vista",
    selectionAnalysis: "An\xE1lise da sele\xE7\xE3o",
    selectionStart: "In\xEDcio",
    selectionEnd: "Fim",
    selectionDuration: "Dura\xE7\xE3o",
    rmsLevel: "N\xEDvel RMS",
    peakLevel: "N\xEDvel Peak",
    dominant: "Dominante",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "Piso de ru\xEDdo",
    spectralCentroid: "Centroide",
    zeroCrossingRate: "ZCR",
    basicMetrics: "M\xE9tricas b\xE1sicas",
    selectionAnalysisHelp: "An\xE1lise da sele\xE7\xE3o:\nAnalisa rapidamente o intervalo selecionado para inspecionar n\xEDvel, din\xE2mica, risco de clipping, piso de ru\xEDdo e distribui\xE7\xE3o de frequ\xEAncias.\n\nEscopo:\nOs resultados usam apenas o canal ativo; os canais n\xE3o s\xE3o mixados.\n\nTrocar canal:\nClique em uma trilha para torn\xE1-la ativa.",
    rmsLevelHelp: "N\xEDvel RMS:\nMostra a energia m\xE9dia da sele\xE7\xE3o. \xC9 mais est\xE1vel que o pico e ajuda a verificar fala muito baixa ou alta.",
    peakLevelHelp: "N\xEDvel de pico:\nMostra o maior n\xEDvel instant\xE2neo da sele\xE7\xE3o. \xDAtil para verificar proximidade de 0 dBFS e risco de clipping.",
    dominantHelp: "Frequ\xEAncia dominante:\nBin FFT com maior pot\xEAncia acumulada na sele\xE7\xE3o. N\xE3o \xE9 necessariamente a fundamental nem o pitch percebido.",
    crestFactorHelp: "Fator de crista:\nRaz\xE3o entre pico e RMS. Valores maiores indicam picos mais fortes em rela\xE7\xE3o \xE0 energia m\xE9dia.",
    clippingRatioHelp: "Propor\xE7\xE3o de clipping:\nPercentual de amostras pr\xF3ximas ao fundo de escala. Ajuda a detectar sobrecarga ou clipping digital.",
    noiseFloorHelp: "Piso de ru\xEDdo:\nEstimado a partir de um percentil baixo de RMS em janelas curtas. Se a sele\xE7\xE3o for principalmente fala ou m\xFAsica, pode n\xE3o corresponder ao ru\xEDdo real.",
    spectralCentroidHelp: "Centroide espectral:\nCentro de massa da energia espectral em Hz. Indica se o som tende a ser mais brilhante ou escuro.",
    zeroCrossingRateHelp: "Taxa de cruzamento por zero:\nFrequ\xEAncia com que o sinal muda de sinal. \xDAtil para ru\xEDdo de alta frequ\xEAncia, fala n\xE3o vozeada e fricativas.",
    frequencyAnalysis: "An\xE1lise de frequ\xEAncia",
    frequencyAnalysisHelp: "Significado:\nPercentual de energia linear por banda de frequ\xEAncia. N\xE3o \xE9 n\xEDvel RMS nem dB.\n\nC\xE1lculo:\nA sele\xE7\xE3o \xE9 dividida em frames com 50% de overlap; a pot\xEAncia dos bins FFT \xE9 acumulada e distribu\xEDda por bandas.",
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
    transcodingAudio: "Transcodificando \xE1udio com FFmpeg",
    encodedPlaybackOnly: "Este formato de \xE1udio codificado n\xE3o \xE9 suportado pelo decodificador do VS Code Webview. Instale o FFmpeg na m\xE1quina do extension host para ativar a decodifica\xE7\xE3o de fallback.",
    waitingPcmParams: "Aguardando par\xE2metros PCM",
    pcmUsedDefaultParams: "Carregado com par\xE2metros PCM padr\xE3o.",
    pcmFillParams: "Preencha os par\xE2metros PCM e clique em Ler.",
    wavPcmFillParams: "Preencha os par\xE2metros e clique em Ler para interpretar o WAV atual como PCM.",
    currentPcmFormat: "Atual",
    savedDefaultPcmFormat: "Padr\xE3o salvo",
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
    initializationFailed: "Falha ao inicializar AudioLens",
    playbackGainLabel: "Ganho",
    playbackGain: "Ganho de reprodu\xE7\xE3o (duplo clique para redefinir)"
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
    minDb: "\u041C\u0438\u043D. dB (\u044F\u0440\u043A\u043E\u0441\u0442\u044C)",
    maxDb: "\u041C\u0430\u043A\u0441. dB (\u044F\u0440\u043A\u043E\u0441\u0442\u044C)",
    autoBrightness: "\u0410\u0432\u0442\u043E-\u044F\u0440\u043A\u043E\u0441\u0442\u044C",
    channel: "\u041A\u0430\u043D\u0430\u043B",
    timeZoom: "\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
    timePosition: "\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
    amplitudeZoom: "\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0430\u043C\u043F\u043B\u0438\u0442\u0443\u0434\u044B",
    mouseWheel: "\u041A\u043E\u043B\u0435\u0441\u043E \u043C\u044B\u0448\u0438",
    help: "\u0421\u043F\u0440\u0430\u0432\u043A\u0430",
    downloadAudio: "\u0421\u043A\u0430\u0447\u0430\u0442\u044C \u0430\u0443\u0434\u0438\u043E",
    settings: "\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438",
    pcmReadAs: "\u0427\u0438\u0442\u0430\u0442\u044C \u043A\u0430\u043A PCM",
    pcmParams: "\u041F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B PCM",
    wavPcmRead: "\u0427\u0438\u0442\u0430\u0442\u044C WAV \u043A\u0430\u043A PCM",
    currentFileOnly: "\u0422\u043E\u043B\u044C\u043A\u043E \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0444\u0430\u0439\u043B",
    sampleRate: "\u0427\u0430\u0441\u0442\u043E\u0442\u0430 \u0434\u0438\u0441\u043A\u0440\u0435\u0442\u0438\u0437\u0430\u0446\u0438\u0438",
    channels: "\u041A\u0430\u043D\u0430\u043B\u044B",
    startOffsetBytes: "\u0421\u043C\u0435\u0449\u0435\u043D\u0438\u0435 (B)",
    bitDepth: "\u0411\u0438\u0442\u043D\u043E\u0441\u0442\u044C (bit)",
    sampleFormat: "\u0424\u043E\u0440\u043C\u0430\u0442",
    endianness: "\u041F\u043E\u0440\u044F\u0434\u043E\u043A \u0431\u0430\u0439\u0442",
    read: "\u0427\u0438\u0442\u0430\u0442\u044C",
    saveDefault: "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",
    cancel: "\u041E\u0442\u043C\u0435\u043D\u0430",
    defaultView: "\u0412\u0438\u0434 \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",
    view: "\u0412\u0438\u0434",
    viewBoth: "\u041C\u0443\u043B\u044C\u0442\u0438\u0432\u0438\u0434",
    mute: "\u0411\u0435\u0437 \u0437\u0432\u0443\u043A\u0430",
    solo: "\u0421\u043E\u043B\u043E",
    timeLabel: "\u0412\u0440\u0435\u043C\u044F",
    helpTimeZoom: "\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
    helpTimePan: "\u0421\u0434\u0432\u0438\u0433 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
    helpAmplitudeZoom: "\u041C\u0430\u0441\u0448\u0442\u0430\u0431 \u0430\u043C\u043F\u043B\u0438\u0442\u0443\u0434\u044B",
    helpRightClick: "\u041F\u0440\u0430\u0432\u044B\u0439 \u043A\u043B\u0438\u043A",
    helpPinch: "\u0429\u0438\u043F\u043E\u043A",
    helpHorizontalSwipe: "\u0413\u043E\u0440\u0438\u0437\u043E\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0432\u0430\u0439\u043F",
    helpDoubleClick: "\u0414\u0432\u043E\u0439\u043D\u043E\u0439 \u043A\u043B\u0438\u043A",
    helpPlaybackGroup: "\u0412\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u0438 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435",
    helpViewGroup: "\u041D\u0430\u0432\u0438\u0433\u0430\u0446\u0438\u044F \u0432\u0438\u0434\u0430",
    helpMouseGroup: "\u041C\u044B\u0448\u044C \u0438 \u0442\u0440\u0435\u043A\u043F\u0430\u0434",
    helpGainGroup: "\u0423\u0441\u0438\u043B\u0435\u043D\u0438\u0435",
    helpPlayPause: "\u041F\u0443\u0441\u043A / \u043F\u0430\u0443\u0437\u0430",
    helpClearSelection: "\u0417\u0430\u043A\u0440\u044B\u0442\u044C \u043C\u0435\u043D\u044E, \u043E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0438\u043B\u0438 \u0441\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u043A\u0443\u0440\u0441\u043E\u0440",
    helpResetTimeZoom: "\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u043C\u0430\u0441\u0448\u0442\u0430\u0431 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
    helpTrackpadZoom: "\u0429\u0438\u043F\u043E\u043A \u043D\u0430 \u0442\u0440\u0435\u043A\u043F\u0430\u0434\u0435 \u043C\u0430\u0441\u0448\u0442\u0430\u0431\u0438\u0440\u0443\u0435\u0442 \u0432\u0440\u0435\u043C\u044F",
    helpTrackpadPan: "\u0413\u043E\u0440\u0438\u0437\u043E\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0432\u0430\u0439\u043F \u0442\u0440\u0435\u043A\u043F\u0430\u0434\u0430 \u0441\u0434\u0432\u0438\u0433\u0430\u0435\u0442 \u0432\u0440\u0435\u043C\u044F",
    helpGainReset: "\u0414\u0432\u043E\u0439\u043D\u043E\u0439 \u043A\u043B\u0438\u043A \u043F\u043E \u043F\u043E\u043B\u0437\u0443\u043D\u043A\u0443 \u0443\u0441\u0438\u043B\u0435\u043D\u0438\u044F \u0441\u0431\u0440\u0430\u0441\u044B\u0432\u0430\u0435\u0442 \u0434\u043E 0 dB",
    helpSelectionPlayback: "\u041F\u043E\u0442\u044F\u043D\u0438\u0442\u0435 \u043F\u043E \u0432\u043E\u043B\u043D\u0435 \u0438\u043B\u0438 \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0435, \u0447\u0442\u043E\u0431\u044B \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u0441\u0435\u0433\u043C\u0435\u043D\u0442. \u041F\u0440\u0438 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u043C \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0438 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u043E\u0434\u0438\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u044D\u0442\u043E\u0442 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D.",
    refreshSpectrogram: "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0441\u043F\u0435\u043A\u0442\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0443",
    resetView: "\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u0432\u0438\u0434",
    selectionAnalysis: "\u0410\u043D\u0430\u043B\u0438\u0437 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u044F",
    selectionStart: "\u041D\u0430\u0447\u0430\u043B\u043E",
    selectionEnd: "\u041A\u043E\u043D\u0435\u0446",
    selectionDuration: "\u0414\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C",
    rmsLevel: "\u0423\u0440\u043E\u0432\u0435\u043D\u044C RMS",
    peakLevel: "\u0423\u0440\u043E\u0432\u0435\u043D\u044C Peak",
    dominant: "\u0414\u043E\u043C\u0438\u043D\u0438\u0440\u0443\u044E\u0449\u0430\u044F",
    crestFactor: "Crest",
    clippingRatio: "\u041A\u043B\u0438\u043F\u043F\u0438\u043D\u0433",
    noiseFloor: "\u0428\u0443\u043C\u043E\u0432\u043E\u0439 \u043F\u043E\u0440\u043E\u0433",
    spectralCentroid: "\u0426\u0435\u043D\u0442\u0440\u043E\u0438\u0434",
    zeroCrossingRate: "ZCR",
    basicMetrics: "\u0411\u0430\u0437\u043E\u0432\u044B\u0435 \u043C\u0435\u0442\u0440\u0438\u043A\u0438",
    selectionAnalysisHelp: "\u0410\u043D\u0430\u043B\u0438\u0437 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u044F:\n\u0411\u044B\u0441\u0442\u0440\u043E \u0430\u043D\u0430\u043B\u0438\u0437\u0438\u0440\u0443\u0435\u0442 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D \u0432\u0440\u0435\u043C\u0435\u043D\u0438: \u0443\u0440\u043E\u0432\u0435\u043D\u044C, \u0434\u0438\u043D\u0430\u043C\u0438\u043A\u0443, \u0440\u0438\u0441\u043A \u043A\u043B\u0438\u043F\u043F\u0438\u043D\u0433\u0430, \u0448\u0443\u043C\u043E\u0432\u043E\u0439 \u043F\u043E\u0440\u043E\u0433 \u0438 \u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0447\u0430\u0441\u0442\u043E\u0442.\n\n\u041E\u0431\u043B\u0430\u0441\u0442\u044C:\n\u0420\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u044B \u0441\u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0433\u043E \u043A\u0430\u043D\u0430\u043B\u0430; \u043A\u0430\u043D\u0430\u043B\u044B \u043D\u0435 \u0441\u043C\u0435\u0448\u0438\u0432\u0430\u044E\u0442\u0441\u044F.\n\n\u0421\u043C\u0435\u043D\u0430 \u043A\u0430\u043D\u0430\u043B\u0430:\n\u0429\u0435\u043B\u043A\u043D\u0438\u0442\u0435 \u0434\u043E\u0440\u043E\u0436\u043A\u0443, \u0447\u0442\u043E\u0431\u044B \u0441\u0434\u0435\u043B\u0430\u0442\u044C \u0435\u0435 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0439.",
    rmsLevelHelp: "\u0423\u0440\u043E\u0432\u0435\u043D\u044C RMS:\n\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0441\u0440\u0435\u0434\u043D\u044E\u044E \u044D\u043D\u0435\u0440\u0433\u0438\u044E \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u044F. \u0421\u0442\u0430\u0431\u0438\u043B\u044C\u043D\u0435\u0435 \u043F\u0438\u043A\u043E\u0432\u043E\u0433\u043E \u0443\u0440\u043E\u0432\u043D\u044F \u0438 \u043F\u043E\u043B\u0435\u0437\u0435\u043D \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0442\u0438\u0445\u043E\u0439 \u0438\u043B\u0438 \u0433\u0440\u043E\u043C\u043A\u043E\u0439 \u0440\u0435\u0447\u0438.",
    peakLevelHelp: "\u041F\u0438\u043A\u043E\u0432\u044B\u0439 \u0443\u0440\u043E\u0432\u0435\u043D\u044C:\n\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u043C\u0433\u043D\u043E\u0432\u0435\u043D\u043D\u044B\u0439 \u0443\u0440\u043E\u0432\u0435\u043D\u044C \u0432 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0438. \u041F\u043E\u043B\u0435\u0437\u0435\u043D \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0431\u043B\u0438\u0437\u043E\u0441\u0442\u0438 \u043A 0 dBFS \u0438 \u0440\u0438\u0441\u043A\u0430 \u043A\u043B\u0438\u043F\u043F\u0438\u043D\u0433\u0430.",
    dominantHelp: "\u0414\u043E\u043C\u0438\u043D\u0438\u0440\u0443\u044E\u0449\u0430\u044F \u0447\u0430\u0441\u0442\u043E\u0442\u0430:\nFFT-bin \u0441 \u043D\u0430\u0438\u0431\u043E\u043B\u044C\u0448\u0435\u0439 \u043D\u0430\u043A\u043E\u043F\u043B\u0435\u043D\u043D\u043E\u0439 \u043C\u043E\u0449\u043D\u043E\u0441\u0442\u044C\u044E \u0432 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0438. \u042D\u0442\u043E \u043D\u0435 \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E \u0444\u0443\u043D\u0434\u0430\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u0430\u044F \u0447\u0430\u0441\u0442\u043E\u0442\u0430 \u0438\u043B\u0438 \u0432\u043E\u0441\u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u043C\u0430\u044F \u0432\u044B\u0441\u043E\u0442\u0430.",
    crestFactorHelp: "Crest factor:\n\u041E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0435 peak \u043A RMS. \u0411\u043E\u043B\u044C\u0448\u0438\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F \u043E\u0437\u043D\u0430\u0447\u0430\u044E\u0442 \u0431\u043E\u043B\u0435\u0435 \u0432\u044B\u0440\u0430\u0436\u0435\u043D\u043D\u044B\u0435 \u043F\u0438\u043A\u0438 \u043E\u0442\u043D\u043E\u0441\u0438\u0442\u0435\u043B\u044C\u043D\u043E \u0441\u0440\u0435\u0434\u043D\u0435\u0439 \u044D\u043D\u0435\u0440\u0433\u0438\u0438.",
    clippingRatioHelp: "\u0414\u043E\u043B\u044F \u043A\u043B\u0438\u043F\u043F\u0438\u043D\u0433\u0430:\n\u041F\u0440\u043E\u0446\u0435\u043D\u0442 samples \u0431\u043B\u0438\u0437\u043A\u043E \u043A full scale. \u041F\u043E\u043C\u043E\u0433\u0430\u0435\u0442 \u0431\u044B\u0441\u0442\u0440\u043E \u043E\u0431\u043D\u0430\u0440\u0443\u0436\u0438\u0442\u044C \u043F\u0435\u0440\u0435\u0433\u0440\u0443\u0437\u043A\u0443 \u0437\u0430\u043F\u0438\u0441\u0438 \u0438\u043B\u0438 \u0446\u0438\u0444\u0440\u043E\u0432\u043E\u0439 \u043A\u043B\u0438\u043F\u043F\u0438\u043D\u0433.",
    noiseFloorHelp: "\u0428\u0443\u043C\u043E\u0432\u043E\u0439 \u043F\u043E\u0440\u043E\u0433:\n\u041E\u0446\u0435\u043D\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u043F\u043E \u043D\u0438\u0437\u043A\u043E\u043C\u0443 \u043F\u0440\u043E\u0446\u0435\u043D\u0442\u0438\u043B\u044E \u043A\u0440\u0430\u0442\u043A\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E\u0433\u043E RMS. \u0415\u0441\u043B\u0438 \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0432 \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u043C \u0440\u0435\u0447\u044C \u0438\u043B\u0438 \u043C\u0443\u0437\u044B\u043A\u0430, \u043E\u0446\u0435\u043D\u043A\u0430 \u043C\u043E\u0436\u0435\u0442 \u043E\u0442\u043B\u0438\u0447\u0430\u0442\u044C\u0441\u044F \u043E\u0442 \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0448\u0443\u043C\u0430.",
    spectralCentroidHelp: "\u0421\u043F\u0435\u043A\u0442\u0440\u0430\u043B\u044C\u043D\u044B\u0439 \u0446\u0435\u043D\u0442\u0440\u043E\u0438\u0434:\n\u0426\u0435\u043D\u0442\u0440 \u043C\u0430\u0441\u0441 \u0441\u043F\u0435\u043A\u0442\u0440\u0430\u043B\u044C\u043D\u043E\u0439 \u044D\u043D\u0435\u0440\u0433\u0438\u0438 \u0432 Hz. \u041F\u043E\u043C\u043E\u0433\u0430\u0435\u0442 \u043F\u043E\u043D\u044F\u0442\u044C, \u0437\u0432\u0443\u043A \u0431\u043E\u043B\u0435\u0435 \u044F\u0440\u043A\u0438\u0439 \u0438\u043B\u0438 \u0442\u0435\u043C\u043D\u044B\u0439.",
    zeroCrossingRateHelp: "Zero crossing rate:\n\u0427\u0430\u0441\u0442\u043E\u0442\u0430 \u0441\u043C\u0435\u043D\u044B \u0437\u043D\u0430\u043A\u0430 \u0441\u0438\u0433\u043D\u0430\u043B\u0430. \u041F\u043E\u043B\u0435\u0437\u043D\u043E \u0434\u043B\u044F \u0412\u0427-\u0448\u0443\u043C\u0430, \u0433\u043B\u0443\u0445\u043E\u0439 \u0440\u0435\u0447\u0438 \u0438 \u0444\u0440\u0438\u043A\u0430\u0442\u0438\u0432\u043E\u0432.",
    frequencyAnalysis: "\u0410\u043D\u0430\u043B\u0438\u0437 \u0447\u0430\u0441\u0442\u043E\u0442",
    frequencyAnalysisHelp: "\u0421\u043C\u044B\u0441\u043B:\n\u041B\u0438\u043D\u0435\u0439\u043D\u044B\u0439 \u043F\u0440\u043E\u0446\u0435\u043D\u0442 \u044D\u043D\u0435\u0440\u0433\u0438\u0438 \u043F\u043E \u0447\u0430\u0441\u0442\u043E\u0442\u043D\u044B\u043C \u043F\u043E\u043B\u043E\u0441\u0430\u043C. \u042D\u0442\u043E \u043D\u0435 RMS \u0438 \u043D\u0435 dB.\n\n\u0420\u0430\u0441\u0447\u0435\u0442:\n\u0412\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u0435 \u0434\u0435\u043B\u0438\u0442\u0441\u044F \u043D\u0430 \u0444\u0440\u0435\u0439\u043C\u044B \u0441 50% overlap. \u041C\u043E\u0449\u043D\u043E\u0441\u0442\u044C FFT-bin \u0441\u0443\u043C\u043C\u0438\u0440\u0443\u0435\u0442\u0441\u044F \u0438 \u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442\u0441\u044F \u043F\u043E \u043F\u043E\u043B\u043E\u0441\u0430\u043C.",
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
    transcodingAudio: "\u0422\u0440\u0430\u043D\u0441\u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0430\u0443\u0434\u0438\u043E \u0447\u0435\u0440\u0435\u0437 FFmpeg",
    encodedPlaybackOnly: "\u042D\u0442\u043E\u0442 \u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u0430\u0443\u0434\u0438\u043E\u0444\u043E\u0440\u043C\u0430\u0442 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0434\u0435\u043A\u043E\u0434\u0435\u0440\u043E\u043C VS Code Webview. \u0423\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0435 FFmpeg \u043D\u0430 \u043C\u0430\u0448\u0438\u043D\u0435 extension host, \u0447\u0442\u043E\u0431\u044B \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u044C fallback-\u0434\u0435\u043A\u043E\u0434\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435.",
    waitingPcmParams: "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u043E\u0432 PCM",
    pcmUsedDefaultParams: "\u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E \u0441 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u0430\u043C\u0438 PCM \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E.",
    pcmFillParams: "\u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B PCM \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u0427\u0438\u0442\u0430\u0442\u044C.",
    wavPcmFillParams: "\u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u0427\u0438\u0442\u0430\u0442\u044C, \u0447\u0442\u043E\u0431\u044B \u0440\u0430\u0437\u043E\u0431\u0440\u0430\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0438\u0439 WAV \u043A\u0430\u043A PCM.",
    currentPcmFormat: "\u0422\u0435\u043A\u0443\u0449\u0438\u0439",
    savedDefaultPcmFormat: "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",
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
    initializationFailed: "\u0421\u0431\u043E\u0439 \u0438\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u0438 AudioLens",
    playbackGainLabel: "\u0423\u0441\u0438\u043B\u0435\u043D\u0438\u0435",
    playbackGain: "\u0423\u0441\u0438\u043B\u0435\u043D\u0438\u0435 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0434\u0435\u043D\u0438\u044F (\u0434\u0432\u043E\u0439\u043D\u043E\u0439 \u043A\u043B\u0438\u043A \u0434\u043B\u044F \u0441\u0431\u0440\u043E\u0441\u0430)"
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
    minDb: "Min dB (parlakl\u0131k)",
    maxDb: "Maks dB (parlakl\u0131k)",
    autoBrightness: "Otomatik parlakl\u0131k",
    channel: "Kanal",
    timeZoom: "Zaman zumu",
    timePosition: "Zaman konumu",
    amplitudeZoom: "Genlik zumu",
    mouseWheel: "Fare tekeri",
    help: "Yard\u0131m",
    downloadAudio: "Sesi indir",
    settings: "Ayarlar",
    pcmReadAs: "PCM olarak oku",
    pcmParams: "PCM parametreleri",
    wavPcmRead: "WAV'i PCM olarak oku",
    currentFileOnly: "Yaln\u0131zca ge\xE7erli dosya",
    sampleRate: "\xD6rnekleme h\u0131z\u0131",
    channels: "Kanallar",
    startOffsetBytes: "Offset (B)",
    bitDepth: "Bit derinli\u011Fi (bit)",
    sampleFormat: "Format",
    endianness: "Endian",
    read: "Oku",
    saveDefault: "Varsay\u0131lan\u0131 kaydet",
    cancel: "\u0130ptal",
    defaultView: "Varsay\u0131lan g\xF6r\xFCn\xFCm",
    view: "G\xF6r\xFCn\xFCm",
    viewBoth: "\xC7oklu g\xF6r\xFCn\xFCm",
    mute: "Sessiz",
    solo: "Solo",
    timeLabel: "Zaman",
    helpTimeZoom: "Zaman zumu",
    helpTimePan: "Zaman kayd\u0131rma",
    helpAmplitudeZoom: "Genlik zumu",
    helpRightClick: "Sa\u011F t\u0131k",
    helpPinch: "S\u0131k\u0131\u015Ft\u0131r",
    helpHorizontalSwipe: "Yatay kayd\u0131r",
    helpDoubleClick: "\xC7ift t\u0131k",
    helpPlaybackGroup: "Oynatma ve se\xE7im",
    helpViewGroup: "G\xF6r\xFCn\xFCm gezinme",
    helpMouseGroup: "Fare ve trackpad",
    helpGainGroup: "Kazan\xE7",
    helpPlayPause: "Oynat / duraklat",
    helpClearSelection: "Men\xFCy\xFC kapat, se\xE7imi temizle veya oynatma imlecini s\u0131f\u0131rla",
    helpResetTimeZoom: "Zaman zumunu s\u0131f\u0131rla",
    helpTrackpadZoom: "Trackpad s\u0131k\u0131\u015Ft\u0131rma zaman zumu yapar",
    helpTrackpadPan: "Trackpad yatay kayd\u0131rma zaman\u0131 kayd\u0131r\u0131r",
    helpGainReset: "Kazan\xE7 kayd\u0131r\u0131c\u0131s\u0131na \xE7ift t\u0131klayarak 0 dB'ye s\u0131f\u0131rla",
    helpSelectionPlayback: "Bir segment se\xE7mek i\xE7in dalga bi\xE7imi veya spektrogram \xFCzerinde s\xFCr\xFCkle. Se\xE7im aktifken yaln\u0131zca o aral\u0131k oynat\u0131l\u0131r.",
    refreshSpectrogram: "Spektrogrami yenile",
    resetView: "Gorunumu sifirla",
    selectionAnalysis: "Secim analizi",
    selectionStart: "Baslangic",
    selectionEnd: "Bitis",
    selectionDuration: "Sure",
    rmsLevel: "RMS seviyesi",
    peakLevel: "Peak seviyesi",
    dominant: "Baskin",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "G\xFCr\xFClt\xFC taban\u0131",
    spectralCentroid: "Merkez",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Temel metrikler",
    selectionAnalysisHelp: "Se\xE7im analizi:\nSe\xE7ilen zaman aral\u0131\u011F\u0131n\u0131 seviye, dinamik aral\u0131k, clipping riski, g\xFCr\xFClt\xFC taban\u0131 ve frekans da\u011F\u0131l\u0131m\u0131 i\xE7in h\u0131zl\u0131ca analiz eder.\n\nKapsam:\nSonu\xE7lar yaln\u0131zca aktif kanal i\xE7in hesaplan\u0131r; kanallar kar\u0131\u015Ft\u0131r\u0131lmaz.\n\nKanal de\u011Fi\u015Ftirme:\nBir izi aktif yapmak i\xE7in \xFCzerine t\u0131kla.",
    rmsLevelHelp: "RMS seviyesi:\nSe\xE7imin ortalama enerjisini g\xF6sterir. Peak'ten daha stabildir ve \xE7ok d\xFC\u015F\xFCk veya \xE7ok y\xFCksek konu\u015Fmay\u0131 kontrol etmek i\xE7in kullan\u0131\u015Fl\u0131d\u0131r.",
    peakLevelHelp: "Peak seviyesi:\nSe\xE7imdeki en y\xFCksek anl\u0131k seviyeyi g\xF6sterir. 0 dBFS'e yak\u0131nl\u0131k ve clipping riski i\xE7in kullan\u0131\u015Fl\u0131d\u0131r.",
    dominantHelp: "Bask\u0131n frekans:\nSe\xE7imde en y\xFCksek birikmi\u015F g\xFCce sahip FFT bin frekans\u0131d\u0131r. Temel frekans veya alg\u0131lanan pitch olmak zorunda de\u011Fildir.",
    crestFactorHelp: "Crest factor:\nPeak/RMS oran\u0131. Daha b\xFCy\xFCk de\u011Ferler, ortalama enerjiye g\xF6re daha belirgin tepe noktalar\u0131 anlam\u0131na gelir.",
    clippingRatioHelp: "Clipping oran\u0131:\nFull scale'e yak\u0131n sample y\xFCzdesi. Kay\u0131t a\u015F\u0131r\u0131 y\xFCklenmesi veya dijital clipping riskini h\u0131zl\u0131ca g\xF6sterir.",
    noiseFloorHelp: "G\xFCr\xFClt\xFC taban\u0131:\nK\u0131sa RMS pencerelerinin d\xFC\u015F\xFCk y\xFCzdeliklerinden tahmin edilir. Se\xE7im \xE7o\u011Funlukla konu\u015Fma veya m\xFCzikse ger\xE7ek g\xFCr\xFClt\xFC taban\u0131ndan farkl\u0131 olabilir.",
    spectralCentroidHelp: "Spektral merkez:\nSpektral enerjinin Hz cinsinden a\u011F\u0131rl\u0131k merkezi. Sesin daha parlak veya koyu olma e\u011Filimini g\xF6sterir.",
    zeroCrossingRateHelp: "Zero crossing rate:\nSinyalin i\u015Faret de\u011Fi\u015Ftirme h\u0131z\u0131. Y\xFCksek frekansl\u0131 g\xFCr\xFClt\xFC, \xF6t\xFCms\xFCz konu\u015Fma ve s\xFCrt\xFCnmeli sesler i\xE7in kullan\u0131\u015Fl\u0131d\u0131r.",
    frequencyAnalysis: "Frekans analizi",
    frequencyAnalysisHelp: "Anlam:\nFrekans band\u0131 ba\u015F\u0131na do\u011Frusal enerji y\xFCzdesi. RMS seviyesi veya dB de\u011Fildir.\n\nHesaplama:\nSe\xE7im %50 overlap frame'lere b\xF6l\xFCn\xFCr; FFT bin g\xFCc\xFC toplan\u0131r ve frekans bantlar\u0131na atan\u0131r.",
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
    transcodingAudio: "Ses FFmpeg ile d\xF6n\xFC\u015Ft\xFCr\xFCl\xFCyor",
    encodedPlaybackOnly: "Bu kodlanm\u0131\u015F ses bi\xE7imi VS Code Webview decoder taraf\u0131ndan desteklenmiyor. Fallback decoding i\xE7in extension host makinesine FFmpeg kurun.",
    waitingPcmParams: "PCM parametreleri bekleniyor",
    pcmUsedDefaultParams: "Varsay\u0131lan PCM parametreleriyle y\xFCklendi.",
    pcmFillParams: "PCM parametrelerini girin, sonra Oku'ya t\u0131klay\u0131n.",
    wavPcmFillParams: "Parametreleri girin, sonra ge\xE7erli WAV'i PCM olarak ayr\u0131\u015Ft\u0131rmak i\xE7in Oku'ya t\u0131klay\u0131n.",
    currentPcmFormat: "Ge\xE7erli",
    savedDefaultPcmFormat: "Kaydedilen varsay\u0131lan",
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
    initializationFailed: "AudioLens baslatilamadi",
    playbackGainLabel: "Kazan\xE7",
    playbackGain: "Oynatma kazanc\u0131 (s\u0131f\u0131rlamak i\xE7in \xE7ift t\u0131k)"
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
    minDb: "dB t\u1ED1i thi\u1EC3u (\u0111\u1ED9 s\xE1ng)",
    maxDb: "dB t\u1ED1i \u0111a (\u0111\u1ED9 s\xE1ng)",
    autoBrightness: "\u0110\u1ED9 s\xE1ng t\u1EF1 \u0111\u1ED9ng",
    channel: "K\xEAnh",
    timeZoom: "Thu ph\xF3ng th\u1EDDi gian",
    timePosition: "V\u1ECB tr\xED th\u1EDDi gian",
    amplitudeZoom: "Thu ph\xF3ng bi\xEAn \u0111\u1ED9",
    mouseWheel: "Con l\u0103n chu\u1ED9t",
    help: "Tr\u1EE3 gi\xFAp",
    downloadAudio: "T\u1EA3i \xE2m thanh",
    settings: "C\xE0i \u0111\u1EB7t",
    pcmReadAs: "\u0110\u1ECDc nh\u01B0 PCM",
    pcmParams: "Tham s\u1ED1 PCM",
    wavPcmRead: "\u0110\u1ECDc WAV nh\u01B0 PCM",
    currentFileOnly: "Ch\u1EC9 t\u1EC7p hi\u1EC7n t\u1EA1i",
    sampleRate: "T\u1EA7n s\u1ED1 l\u1EA5y m\u1EABu",
    channels: "S\u1ED1 k\xEAnh",
    startOffsetBytes: "Offset (B)",
    bitDepth: "\u0110\u1ED9 s\xE2u bit (bit)",
    sampleFormat: "\u0110\u1ECBnh d\u1EA1ng",
    endianness: "Endian",
    read: "\u0110\u1ECDc",
    saveDefault: "L\u01B0u m\u1EB7c \u0111\u1ECBnh",
    cancel: "H\u1EE7y",
    defaultView: "Ch\u1EBF \u0111\u1ED9 xem m\u1EB7c \u0111\u1ECBnh",
    view: "Ch\u1EBF \u0111\u1ED9 xem",
    viewBoth: "\u0110a ch\u1EBF \u0111\u1ED9",
    mute: "T\u1EAFt ti\u1EBFng",
    solo: "Solo",
    timeLabel: "Th\u1EDDi gian",
    helpTimeZoom: "Thu ph\xF3ng th\u1EDDi gian",
    helpTimePan: "D\u1ECBch chuy\u1EC3n th\u1EDDi gian",
    helpAmplitudeZoom: "Thu ph\xF3ng bi\xEAn \u0111\u1ED9",
    helpRightClick: "Nh\u1EA5p ph\u1EA3i",
    helpPinch: "Ch\u1EE5m",
    helpHorizontalSwipe: "Vu\u1ED1t ngang",
    helpDoubleClick: "Nh\u1EA5p \u0111\xFAp",
    helpPlaybackGroup: "Ph\xE1t v\xE0 v\xF9ng ch\u1ECDn",
    helpViewGroup: "\u0110i\u1EC1u h\u01B0\u1EDBng ch\u1EBF \u0111\u1ED9 xem",
    helpMouseGroup: "Chu\u1ED9t v\xE0 trackpad",
    helpGainGroup: "Gain",
    helpPlayPause: "Ph\xE1t / t\u1EA1m d\u1EEBng",
    helpClearSelection: "\u0110\xF3ng menu, x\xF3a v\xF9ng ch\u1ECDn ho\u1EB7c \u0111\u1EB7t l\u1EA1i con tr\u1ECF ph\xE1t",
    helpResetTimeZoom: "\u0110\u1EB7t l\u1EA1i thu ph\xF3ng th\u1EDDi gian",
    helpTrackpadZoom: "Ch\u1EE5m tr\xEAn trackpad \u0111\u1EC3 thu ph\xF3ng th\u1EDDi gian",
    helpTrackpadPan: "Vu\u1ED1t ngang tr\xEAn trackpad \u0111\u1EC3 d\u1ECBch chuy\u1EC3n th\u1EDDi gian",
    helpGainReset: "Nh\u1EA5p \u0111\xFAp thanh gain \u0111\u1EC3 \u0111\u1EB7t l\u1EA1i v\u1EC1 0 dB",
    helpSelectionPlayback: "K\xE9o tr\xEAn d\u1EA1ng s\xF3ng ho\u1EB7c spectrogram \u0111\u1EC3 ch\u1ECDn \u0111o\u1EA1n. Khi c\xF3 v\xF9ng ch\u1ECDn, ch\u1EC9 v\xF9ng \u0111\xF3 \u0111\u01B0\u1EE3c ph\xE1t.",
    refreshSpectrogram: "L\xE0m m\u1EDBi spectrogram",
    resetView: "\u0110\u1EB7t l\u1EA1i ch\u1EBF \u0111\u1ED9 xem",
    selectionAnalysis: "Ph\xE2n t\xEDch v\xF9ng ch\u1ECDn",
    selectionStart: "B\u1EAFt \u0111\u1EA7u",
    selectionEnd: "K\u1EBFt th\xFAc",
    selectionDuration: "Th\u1EDDi l\u01B0\u1EE3ng",
    rmsLevel: "M\u1EE9c RMS",
    peakLevel: "M\u1EE9c Peak",
    dominant: "Chi\u1EBFm \u01B0u th\u1EBF",
    crestFactor: "Crest",
    clippingRatio: "Clipping",
    noiseFloor: "N\u1EC1n nhi\u1EC5u",
    spectralCentroid: "T\xE2m ph\u1ED5",
    zeroCrossingRate: "ZCR",
    basicMetrics: "Ch\u1EC9 s\u1ED1 c\u01A1 b\u1EA3n",
    selectionAnalysisHelp: "Ph\xE2n t\xEDch v\xF9ng ch\u1ECDn:\nPh\xE2n t\xEDch nhanh kho\u1EA3ng th\u1EDDi gian \u0111\xE3 ch\u1ECDn \u0111\u1EC3 ki\u1EC3m tra m\u1EE9c \xE2m, d\u1EA3i \u0111\u1ED9ng, nguy c\u01A1 clipping, n\u1EC1n nhi\u1EC5u v\xE0 ph\xE2n b\u1ED1 t\u1EA7n s\u1ED1.\n\nPh\u1EA1m vi:\nK\u1EBFt qu\u1EA3 ch\u1EC9 t\xEDnh tr\xEAn k\xEAnh \u0111ang ho\u1EA1t \u0111\u1ED9ng; kh\xF4ng tr\u1ED9n c\xE1c k\xEAnh.\n\n\u0110\u1ED5i k\xEAnh:\nNh\u1EA5p v\xE0o m\u1ED9t track \u0111\u1EC3 \u0111\u1EB7t n\xF3 l\xE0m k\xEAnh ho\u1EA1t \u0111\u1ED9ng.",
    rmsLevelHelp: "M\u1EE9c RMS:\nHi\u1EC3n th\u1ECB n\u0103ng l\u01B0\u1EE3ng trung b\xECnh c\u1EE7a v\xF9ng ch\u1ECDn. \u1ED4n \u0111\u1ECBnh h\u01A1n peak v\xE0 h\u1EEFu \xEDch \u0111\u1EC3 ki\u1EC3m tra gi\u1ECDng n\xF3i qu\xE1 nh\u1ECF ho\u1EB7c qu\xE1 l\u1EDBn.",
    peakLevelHelp: "M\u1EE9c peak:\nHi\u1EC3n th\u1ECB m\u1EE9c t\u1EE9c th\u1EDDi cao nh\u1EA5t trong v\xF9ng ch\u1ECDn. H\u1EEFu \xEDch \u0111\u1EC3 ki\u1EC3m tra g\u1EA7n 0 dBFS v\xE0 nguy c\u01A1 clipping.",
    dominantHelp: "T\u1EA7n s\u1ED1 chi\u1EBFm \u01B0u th\u1EBF:\nBin FFT c\xF3 c\xF4ng su\u1EA5t t\xEDch l\u0169y cao nh\u1EA5t trong v\xF9ng ch\u1ECDn. Kh\xF4ng nh\u1EA5t thi\u1EBFt l\xE0 t\u1EA7n s\u1ED1 c\u01A1 b\u1EA3n ho\u1EB7c pitch c\u1EA3m nh\u1EADn.",
    crestFactorHelp: "Crest factor:\nT\u1EC9 l\u1EC7 gi\u1EEFa peak v\xE0 RMS. Gi\xE1 tr\u1ECB l\u1EDBn h\u01A1n ngh\u0129a l\xE0 peak n\u1ED5i b\u1EADt h\u01A1n so v\u1EDBi n\u0103ng l\u01B0\u1EE3ng trung b\xECnh.",
    clippingRatioHelp: "T\u1EC9 l\u1EC7 clipping:\nPh\u1EA7n tr\u0103m sample g\u1EA7n full scale. Gi\xFAp ph\xE1t hi\u1EC7n qu\xE1 t\u1EA3i ghi \xE2m ho\u1EB7c clipping s\u1ED1.",
    noiseFloorHelp: "N\u1EC1n nhi\u1EC5u:\n\u01AF\u1EDBc l\u01B0\u1EE3ng t\u1EEB percentile th\u1EA5p c\u1EE7a RMS ng\u1EAFn h\u1EA1n. N\u1EBFu v\xF9ng ch\u1ECDn ch\u1EE7 y\u1EBFu l\xE0 gi\u1ECDng n\xF3i ho\u1EB7c nh\u1EA1c, gi\xE1 tr\u1ECB c\xF3 th\u1EC3 kh\xE1c n\u1EC1n nhi\u1EC5u th\u1EADt.",
    spectralCentroidHelp: "T\xE2m ph\u1ED5:\nTr\u1ECDng t\xE2m n\u0103ng l\u01B0\u1EE3ng ph\u1ED5 theo Hz. Cho bi\u1EBFt \xE2m thanh thi\xEAn s\xE1ng hay t\u1ED1i.",
    zeroCrossingRateHelp: "Zero crossing rate:\nT\u1ED1c \u0111\u1ED9 t\xEDn hi\u1EC7u \u0111\u1ED5i d\u1EA5u. H\u1EEFu \xEDch cho nhi\u1EC5u t\u1EA7n s\u1ED1 cao, \xE2m v\xF4 thanh v\xE0 \xE2m x\xE1t.",
    frequencyAnalysis: "Ph\xE2n t\xEDch t\u1EA7n s\u1ED1",
    frequencyAnalysisHelp: "\xDD ngh\u0129a:\nPh\u1EA7n tr\u0103m n\u0103ng l\u01B0\u1EE3ng tuy\u1EBFn t\xEDnh theo d\u1EA3i t\u1EA7n. \u0110\xE2y kh\xF4ng ph\u1EA3i m\u1EE9c RMS v\xE0 kh\xF4ng ph\u1EA3i dB.\n\nC\xE1ch t\xEDnh:\nV\xF9ng ch\u1ECDn \u0111\u01B0\u1EE3c chia th\xE0nh frame overlap 50%; c\xF4ng su\u1EA5t bin FFT \u0111\u01B0\u1EE3c t\xEDch l\u0169y r\u1ED3i ph\xE2n v\xE0o c\xE1c d\u1EA3i t\u1EA7n.",
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
    transcodingAudio: "\u0110ang chuy\u1EC3n m\xE3 \xE2m thanh b\u1EB1ng FFmpeg",
    encodedPlaybackOnly: "\u0110\u1ECBnh d\u1EA1ng \xE2m thanh m\xE3 h\xF3a n\xE0y kh\xF4ng \u0111\u01B0\u1EE3c b\u1ED9 gi\u1EA3i m\xE3 VS Code Webview h\u1ED7 tr\u1EE3. C\xE0i FFmpeg tr\xEAn m\xE1y extension host \u0111\u1EC3 b\u1EADt gi\u1EA3i m\xE3 d\u1EF1 ph\xF2ng.",
    waitingPcmParams: "\u0110ang ch\u1EDD tham s\u1ED1 PCM",
    pcmUsedDefaultParams: "\u0110\xE3 t\u1EA3i b\u1EB1ng tham s\u1ED1 PCM m\u1EB7c \u0111\u1ECBnh.",
    pcmFillParams: "\u0110i\u1EC1n tham s\u1ED1 PCM r\u1ED3i nh\u1EA5p \u0110\u1ECDc.",
    wavPcmFillParams: "\u0110i\u1EC1n tham s\u1ED1 r\u1ED3i nh\u1EA5p \u0110\u1ECDc \u0111\u1EC3 ph\xE2n t\xEDch WAV hi\u1EC7n t\u1EA1i nh\u01B0 PCM.",
    currentPcmFormat: "Hi\u1EC7n t\u1EA1i",
    savedDefaultPcmFormat: "M\u1EB7c \u0111\u1ECBnh \u0111\xE3 l\u01B0u",
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
    initializationFailed: "Kh\u1EDFi t\u1EA1o AudioLens th\u1EA5t b\u1EA1i",
    playbackGainLabel: "Gain",
    playbackGain: "Gain ph\xE1t l\u1EA1i (nh\u1EA5p \u0111\xFAp \u0111\u1EC3 \u0111\u1EB7t l\u1EA1i)"
  };

  // src/webview/i18n/locales/zh-CN.ts
  var messages16 = {
    waitingAudioFile: "\u7B49\u5F85\u97F3\u9891\u6587\u4EF6",
    initializing: "\u6B63\u5728\u521D\u59CB\u5316",
    spectrogramSettings: "\u9891\u8C31\u56FE\u8BBE\u7F6E",
    help: "\u5E2E\u52A9",
    downloadAudio: "\u4E0B\u8F7D\u97F3\u9891",
    settings: "\u8BBE\u7F6E",
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
    minDb: "\u6700\u5C0F dB (\u4EAE\u5EA6)",
    maxDb: "\u6700\u5927 dB (\u4EAE\u5EA6)",
    autoBrightness: "\u81EA\u52A8\u4EAE\u5EA6",
    channel: "\u58F0\u9053",
    timeZoom: "\u65F6\u95F4\u7F29\u653E",
    timePosition: "\u65F6\u95F4\u4F4D\u7F6E",
    amplitudeZoom: "\u5E45\u5EA6\u7F29\u653E",
    mouseWheel: "\u9F20\u6807\u6EDA\u8F6E",
    refreshSpectrogram: "\u5237\u65B0\u9891\u8C31\u56FE",
    resetView: "\u91CD\u7F6E\u89C6\u56FE",
    pcmReadAs: "\u6309 PCM \u8BFB\u53D6",
    pcmParams: "PCM \u53C2\u6570",
    wavPcmRead: "WAV \u6309 PCM \u8BFB\u53D6",
    currentFileOnly: "\u4EC5\u5BF9\u5F53\u524D\u6587\u4EF6\u751F\u6548",
    sampleRate: "\u91C7\u6837\u7387",
    channels: "\u901A\u9053\u6570",
    startOffsetBytes: "\u504F\u79FB(B)",
    bitDepth: "\u4F4D\u6DF1(bit)",
    sampleFormat: "\u683C\u5F0F",
    endianness: "\u7AEF\u5E8F",
    read: "\u8BFB\u53D6",
    saveDefault: "\u4FDD\u5B58\u9ED8\u8BA4",
    cancel: "\u53D6\u6D88",
    defaultView: "\u9ED8\u8BA4\u89C6\u56FE",
    view: "\u89C6\u56FE",
    viewBoth: "\u591A\u89C6\u56FE",
    mute: "\u9759\u97F3",
    solo: "\u72EC\u594F",
    timeLabel: "\u65F6\u95F4",
    helpTimeZoom: "\u65F6\u95F4\u7F29\u653E",
    helpTimePan: "\u65F6\u95F4\u5E73\u79FB",
    helpAmplitudeZoom: "\u5E45\u503C\u7F29\u653E",
    helpRightClick: "\u53F3\u952E",
    helpPinch: "\u53CC\u6307\u634F\u5408",
    helpHorizontalSwipe: "\u6A2A\u5411\u6ED1\u52A8",
    helpDoubleClick: "\u53CC\u51FB",
    helpPlaybackGroup: "\u64AD\u653E\u4E0E\u9009\u533A",
    helpViewGroup: "\u89C6\u56FE\u5BFC\u822A",
    helpMouseGroup: "\u9F20\u6807\u4E0E\u89E6\u63A7\u677F",
    helpGainGroup: "\u64AD\u653E\u589E\u76CA",
    helpPlayPause: "\u64AD\u653E / \u6682\u505C",
    helpClearSelection: "\u5173\u95ED\u83DC\u5355\u3001\u6E05\u9664\u9009\u533A\u6216\u91CD\u7F6E\u64AD\u653E\u6E38\u6807",
    helpResetTimeZoom: "\u91CD\u7F6E\u65F6\u95F4\u7F29\u653E",
    helpTrackpadZoom: "\u89E6\u63A7\u677F\u53CC\u6307\u634F\u5408\u53EF\u7F29\u653E\u65F6\u95F4",
    helpTrackpadPan: "\u89E6\u63A7\u677F\u6A2A\u5411\u6ED1\u52A8\u53EF\u5E73\u79FB\u65F6\u95F4",
    helpGainReset: "\u53CC\u51FB\u589E\u76CA\u6ED1\u5757\u53EF\u91CD\u7F6E\u4E3A 0 dB",
    helpSelectionPlayback: "\u5728\u6CE2\u5F62\u56FE\u6216\u8BED\u8C31\u56FE\u4E0A\u62D6\u62FD\u53EF\u6846\u9009\u7247\u6BB5\uFF1B\u6709\u9009\u533A\u65F6\u64AD\u653E\u53EA\u8BD5\u542C\u8BE5\u8303\u56F4\u3002",
    selectionAnalysis: "\u9009\u533A\u5206\u6790",
    selectionAnalysisHelp: "\u9009\u533A\u5206\u6790\uFF1A\n\u5BF9\u5F53\u524D\u6846\u9009\u7684\u65F6\u95F4\u8303\u56F4\u8FDB\u884C\u5FEB\u901F\u7EDF\u8BA1\uFF0C\u5E2E\u52A9\u5224\u65AD\u5F55\u97F3\u7535\u5E73\u3001\u52A8\u6001\u8303\u56F4\u3001\u524A\u6CE2\u98CE\u9669\u3001\u566A\u58F0\u5E95\u548C\u9891\u7387\u5206\u5E03\u3002\n\n\u5206\u6790\u5BF9\u8C61\uFF1A\n\u5F53\u524D\u7ED3\u679C\u53EA\u9488\u5BF9\u6FC0\u6D3B\u901A\u9053\uFF0C\u4E0D\u4F1A\u628A\u591A\u4E2A\u901A\u9053\u6DF7\u5408\u8BA1\u7B97\u3002\n\n\u5982\u4F55\u5207\u6362\uFF1A\n\u70B9\u51FB\u67D0\u4E00\u6761\u97F3\u8F68\u540E\uFF0C\u8BE5\u97F3\u8F68\u4F1A\u6210\u4E3A\u5F53\u524D\u6FC0\u6D3B\u901A\u9053\uFF1B\u4E4B\u540E\u7684 RMS\u3001Peak\u3001Dominant \u548C\u9891\u7387\u5206\u6790\u90FD\u4F1A\u4F7F\u7528\u8FD9\u4E2A\u901A\u9053\u7684\u6570\u636E\u3002",
    basicMetrics: "\u57FA\u7840\u6307\u6807",
    selectionStart: "\u5F00\u59CB",
    selectionEnd: "\u7ED3\u675F",
    selectionDuration: "\u65F6\u957F",
    rmsLevel: "RMS\u7535\u5E73",
    peakLevel: "\u5CF0\u503C\u7535\u5E73",
    dominant: "\u4E3B\u9891",
    crestFactor: "Crest",
    clippingRatio: "\u524A\u6CE2\u6BD4\u4F8B",
    noiseFloor: "\u566A\u58F0\u5E95",
    spectralCentroid: "\u9891\u8C31\u8D28\u5FC3",
    zeroCrossingRate: "\u8FC7\u96F6\u7387",
    rmsLevelHelp: "RMS \u7535\u5E73\uFF08RMS Level\uFF09\uFF1A\n\u8BA1\u7B97\uFF1A\nrms = sqrt(mean(sample\xB2))\nrmsDb = 20 \xD7 log10(rms)\n\n\u7528\u9014\uFF1A\n\u53CD\u6620\u9009\u533A\u6574\u4F53\u80FD\u91CF/\u5E73\u5747\u54CD\u5EA6\u8D8B\u52BF\uFF0C\u6BD4\u5CF0\u503C\u66F4\u7A33\u5B9A\uFF0C\u9002\u5408\u89C2\u5BDF\u8BED\u97F3\u662F\u5426\u8FC7\u8F7B\u6216\u8FC7\u54CD\u3002\n\n\u9650\u5236\uFF1A\nRMS \u4E0D\u662F LUFS\uFF0C\u4E0D\u5305\u542B\u542C\u611F\u52A0\u6743\u548C\u95E8\u9650\u5904\u7406\uFF1B\u8D85\u957F\u9009\u533A\u4F1A\u7B49\u8DDD\u91C7\u6837\u4EE5\u4FDD\u6301\u754C\u9762\u54CD\u5E94\u3002\n\n\u53C2\u8003\uFF1A\nMathWorks rms\uFF1Blibrosa.feature.rms\uFF1BAudacity Measure RMS\u3002",
    peakLevelHelp: "\u5CF0\u503C\u7535\u5E73\uFF08Peak Level\uFF09\uFF1A\n\u8BA1\u7B97\uFF1A\npeak = max(abs(sample))\npeakDb = 20 \xD7 log10(peak)\n\n\u7528\u9014\uFF1A\n\u53CD\u6620\u9009\u533A\u5185\u6700\u9AD8\u77AC\u65F6\u7535\u5E73\uFF0C\u9002\u5408\u68C0\u67E5\u662F\u5426\u63A5\u8FD1 0 dBFS \u6216\u5B58\u5728\u524A\u6CE2\u98CE\u9669\u3002\n\n\u9650\u5236\uFF1A\n\u5CF0\u503C\u53EA\u770B\u77AC\u65F6\u6700\u5927\u503C\uFF0C\u4E0D\u4EE3\u8868\u6574\u4F53\u54CD\u5EA6\uFF1B\u8D85\u957F\u9009\u533A\u4F1A\u7B49\u8DDD\u91C7\u6837\u4EE5\u4FDD\u6301\u754C\u9762\u54CD\u5E94\u3002\n\n\u53C2\u8003\uFF1A\nAdobe Audition Amplitude Statistics\uFF1BAudacity Amplify\uFF1BAES17 0 dBFS\u3002",
    dominantHelp: "\u4E3B\u9891\uFF08Dominant Frequency\uFF09\uFF1A\n\u8868\u793A\u6574\u4E2A\u9009\u533A\u5185\u7D2F\u8BA1\u529F\u7387\u6700\u5927\u7684 FFT \u9891\u7387 bin\u3002\n\nBin \u5212\u5206\uFF1A\n\u7B2C k \u4E2A bin \u5BF9\u5E94\u9891\u7387\uFF1A\nfreq = k \xD7 sampleRate / FFT size\n\n\u529F\u7387\u8BA1\u7B97\uFF1A\n\u6BCF\u4E00\u5E27\u4E2D\uFF0C\u6BCF\u4E2A bin \u7684\u529F\u7387\u4E3A\uFF1A\npower = re\xB2 + im\xB2\n\n\u9009\u533A\u7D2F\u8BA1\uFF1A\n\u5BF9\u6574\u4E2A\u9009\u533A\u505A\u591A\u5E27 FFT\uFF0C\u9010\u5E27\u7D2F\u52A0\u540C\u4E00\u4E2A bin \u7684\u529F\u7387\uFF1A\nbinPower[k] += power\n\n\u6700\u7EC8\u7ED3\u679C\uFF1A\n\u53D6 binPower \u6700\u5927\u7684 k\uFF1A\ndominantHz = k \xD7 sampleRate / FFT size\n\n\u542B\u4E49\uFF1A\n\u5B83\u4E0D\u7B49\u540C\u4E8E\u57FA\u9891\uFF0C\u4E5F\u4E0D\u4E00\u5B9A\u7B49\u540C\u4E8E\u542C\u611F\u97F3\u9AD8\u3002\n\u9891\u7387\u5206\u8FA8\u7387\u7531 sampleRate / FFT size \u51B3\u5B9A\u3002\n\n\u53C2\u8003\uFF1A\nNumPy fftfreq\uFF1Blibrosa spectral features\u3002",
    crestFactorHelp: "\u5CF0\u5747\u6BD4\uFF08Crest Factor\uFF09\uFF1A\n\u5CF0\u5747\u6BD4\uFF0C\u4E5F\u5C31\u662F\u5CF0\u503C\u4E0E RMS \u7684\u6BD4\u503C\u3002\n\n\u8BA1\u7B97\uFF1A\ncrest = peak / rms\ncrestDb = peakDb - rmsDb\n\n\u7528\u9014\uFF1A\n\u89C2\u5BDF\u52A8\u6001\u8303\u56F4\u548C\u77AC\u6001\u5F3A\u5EA6\u3002\u6570\u503C\u8D8A\u5927\uFF0C\u8868\u793A\u5CF0\u503C\u76F8\u5BF9\u5E73\u5747\u80FD\u91CF\u8D8A\u7A81\u51FA\u3002\n\n\u9650\u5236\uFF1A\n\u9759\u97F3\u6216\u6781\u4F4E\u7535\u5E73\u65F6\u4E0D\u7A33\u5B9A\uFF1B\u5B83\u4E0D\u80FD\u76F4\u63A5\u5224\u65AD\u97F3\u8D28\u597D\u574F\uFF0C\u53EA\u80FD\u63D0\u793A\u52A8\u6001\u7279\u5F81\u3002\n\n\u53C2\u8003\uFF1A\nMathWorks peak2rms\uFF1BSignal Processing Toolbox descriptive statistics\u3002",
    clippingRatioHelp: "\u524A\u6CE2\u6BD4\u4F8B\uFF08Clipping Ratio\uFF09\uFF1A\n\u7EDF\u8BA1\u9009\u533A\u4E2D\u63A5\u8FD1\u6EE1\u5E45\u5EA6\u7684\u91C7\u6837\u70B9\u6BD4\u4F8B\u3002\n\n\u8BA1\u7B97\uFF1A\nclippingRatio = count(abs(sample) >= 0.999) / measuredSamples \xD7 100%\n\n\u7528\u9014\uFF1A\n\u5FEB\u901F\u53D1\u73B0\u6570\u5B57\u6EE1\u5E45\u3001\u5F55\u97F3\u8FC7\u8F7D\u6216\u786C\u524A\u6CE2\u98CE\u9669\u3002\n\n\u9650\u5236\uFF1A\n\u6709\u4E9B\u97F3\u9891\u5728\u8FDB\u5165 AudioLens \u524D\u5DF2\u7ECF\u88AB\u9650\u5E45\u6216\u6A21\u62DF\u5931\u771F\uFF0C\u5373\u4F7F\u6CA1\u6709\u6EE1\u5E45\u91C7\u6837\u4E5F\u53EF\u80FD\u542C\u8D77\u6765\u5931\u771F\u3002\n\n\u53C2\u8003\uFF1A\nAudacity Find Clipping\uFF1BAdobe Audition Amplitude Statistics\uFF1BNetflix AudioClippingInspector\u3002",
    noiseFloorHelp: "\u566A\u58F0\u5E95\uFF08Noise Floor\uFF09\uFF1A\n\u7528\u77ED\u65F6 RMS \u7684\u4F4E\u5206\u4F4D\u6570\u4F30\u8BA1\u9009\u533A\u8F83\u5B89\u9759\u90E8\u5206\u7684\u7535\u5E73\u3002\n\n\u8BA1\u7B97\uFF1A\n1. \u5C06\u9009\u533A\u5207\u6210\u7EA6 20 ms \u7A97\u53E3\uFF0C50% overlap\u3002\n2. \u8BA1\u7B97\u6BCF\u4E2A\u7A97\u53E3 RMS\u3002\n3. \u53D6\u7B2C 10 \u767E\u5206\u4F4D RMS\uFF0C\u5E76\u6362\u7B97\u4E3A dBFS\u3002\n\n\u7528\u9014\uFF1A\n\u4F30\u8BA1\u5E95\u566A\u3001\u7A7A\u767D\u6BB5\u6D01\u51C0\u5EA6\u548C\u5F55\u97F3\u73AF\u5883\u566A\u58F0\u3002\n\n\u9650\u5236\uFF1A\n\u8FD9\u662F\u65E0\u76D1\u7763\u4F30\u8BA1\uFF1B\u5982\u679C\u9009\u533A\u51E0\u4E4E\u5168\u662F\u8BED\u97F3\u6216\u97F3\u4E50\uFF0C\u7ED3\u679C\u4E0D\u4E00\u5B9A\u7B49\u540C\u4E8E\u771F\u5B9E\u566A\u58F0\u5E95\u3002\n\n\u53C2\u8003\uFF1A\nAdobe Audition Minimum RMS\uFF1Blibrosa.feature.rms\uFF1BAudacity Noise Reduction\u3002",
    spectralCentroidHelp: "\u9891\u8C31\u8D28\u5FC3\uFF08Spectral Centroid\uFF09\uFF1A\n\u9891\u8C31\u80FD\u91CF\u7684\u91CD\u5FC3\uFF0C\u5355\u4F4D Hz\u3002\n\n\u8BA1\u7B97\uFF1A\ncentroid = sum(freq[k] \xD7 power[k]) / sum(power[k])\n\n\u7528\u9014\uFF1A\n\u89C2\u5BDF\u58F0\u97F3\u504F\u4EAE\u8FD8\u662F\u504F\u95F7\uFF1B\u8BED\u97F3\u9AD8\u9891\u6210\u5206\u66F4\u591A\u65F6\u901A\u5E38\u4F1A\u66F4\u9AD8\u3002\n\n\u9650\u5236\uFF1A\n\u4F1A\u53D7\u566A\u58F0\u3001\u9F7F\u97F3\u548C\u5E26\u5BBD\u5F71\u54CD\uFF1B\u5B83\u4E0D\u662F\u97F3\u9AD8\uFF0C\u4E5F\u4E0D\u80FD\u5355\u72EC\u5224\u65AD\u6E05\u6670\u5EA6\u3002\n\n\u53C2\u8003\uFF1A\nlibrosa.feature.spectral_centroid\uFF1BMathWorks spectralCentroid\u3002",
    zeroCrossingRateHelp: "\u8FC7\u96F6\u7387\uFF08Zero Crossing Rate\uFF09\uFF1A\n\u7EDF\u8BA1\u4FE1\u53F7\u6B63\u8D1F\u53F7\u53D8\u5316\u7684\u9891\u7387\u3002\n\n\u8BA1\u7B97\uFF1A\nzeroCrossingRate = zeroCrossings / durationSeconds\n\n\u7528\u9014\uFF1A\n\u7C97\u7565\u89C2\u5BDF\u9AD8\u9891\u566A\u58F0\u3001\u6E05\u97F3\u3001\u6469\u64E6\u97F3\u7B49\u6210\u5206\uFF1B\u8BED\u97F3\u5206\u6790\u4E2D\u5E38\u4F5C\u4E3A\u65F6\u57DF\u7279\u5F81\u3002\n\n\u9650\u5236\uFF1A\n\u5BB9\u6613\u53D7\u566A\u58F0\u548C DC offset \u5F71\u54CD\uFF1B\u5B83\u4E0D\u80FD\u76F4\u63A5\u4EE3\u8868\u9891\u7387\u6216\u97F3\u9AD8\u3002\n\n\u53C2\u8003\uFF1A\nlibrosa.feature.zero_crossing_rate\uFF1Blibrosa.zero_crossings\u3002",
    frequencyAnalysis: "\u9891\u7387\u5206\u6790",
    frequencyAnalysisHelp: "\u542B\u4E49\uFF1A\n\u9891\u6BB5\u7EBF\u6027\u80FD\u91CF\u5360\u6BD4\uFF0C\u4E0D\u662F RMS level\uFF0C\u4E5F\u4E0D\u662F dB\u3002\n\n\u8BA1\u7B97\uFF1A\n1. \u5BF9\u9009\u533A\u5185\u5F53\u524D\u901A\u9053\u53D6\u6837\u3002\n2. \u4F7F\u7528\u5F53\u524D\u7A97\u53E3\u51FD\u6570\u548C FFT size\uFF0C\u628A\u6574\u4E2A\u9009\u533A\u6309 50% overlap \u5206\u6210\u591A\u5E27\u3002\n3. \u6BCF\u4E2A\u9891\u7387 bin \u7684\u529F\u7387\u4E3A re\xB2 + im\xB2\u3002\n4. \u7D2F\u8BA1\u6240\u6709\u5E27\u7684 bin \u529F\u7387\uFF0C\u5E76\u6309\u9891\u7387\u5F52\u5165\u5404\u9891\u6BB5\u3002\n5. \u663E\u793A bandPower / totalPower \xD7 100%\u3002\n\n\u6CE8\u610F\uFF1A\n\u8FD9\u662F\u6574\u4E2A\u9009\u533A\u7684\u591A\u5E27\u9891\u8C31\u80FD\u91CF\u5206\u5E03\uFF1B\u4ECD\u4E0D\u662F dB/RMS\u3002",
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
    transcodingAudio: "\u6B63\u5728\u4F7F\u7528 FFmpeg \u8F6C\u7801\u97F3\u9891",
    encodedPlaybackOnly: "VS Code Webview \u89E3\u7801\u5668\u4E0D\u652F\u6301\u6B64\u7F16\u7801\u683C\u5F0F\u3002\u8BF7\u5728\u8FD0\u884C\u6269\u5C55\u5BBF\u4E3B\u7684\u673A\u5668\u4E0A\u5B89\u88C5 FFmpeg\uFF0C\u4EE5\u542F\u7528\u515C\u5E95\u89E3\u7801\u3002",
    waitingPcmParams: "\u7B49\u5F85 PCM \u53C2\u6570",
    pcmUsedDefaultParams: "\u5DF2\u4F7F\u7528\u9ED8\u8BA4 PCM \u53C2\u6570\u8BFB\u53D6\u3002",
    pcmFillParams: "\u8BF7\u586B\u5199 PCM \u53C2\u6570\uFF0C\u7136\u540E\u70B9\u51FB\u201C\u8BFB\u53D6\u201D\u3002",
    wavPcmFillParams: "\u586B\u5199\u53C2\u6570\u540E\u70B9\u51FB\u201C\u8BFB\u53D6\u201D\uFF0C\u5C06\u6309 PCM \u91CD\u65B0\u89E3\u6790\u5F53\u524D WAV\u3002",
    currentPcmFormat: "\u5F53\u524D",
    savedDefaultPcmFormat: "\u5DF2\u4FDD\u5B58\u9ED8\u8BA4\u53C2\u6570",
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
    initializationFailed: "AudioLens \u521D\u59CB\u5316\u5931\u8D25",
    playbackGainLabel: "\u64AD\u653E\u589E\u76CA",
    playbackGain: "\u64AD\u653E\u589E\u76CA (\u53CC\u51FB\u91CD\u7F6E\u4E3A 0)"
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
    minDb: "\u6700\u5C0F dB (\u4EAE\u5EA6)",
    maxDb: "\u6700\u5927 dB (\u4EAE\u5EA6)",
    autoBrightness: "\u81EA\u52D5\u4EAE\u5EA6",
    channel: "\u8072\u9053",
    timeZoom: "\u6642\u9593\u7E2E\u653E",
    timePosition: "\u6642\u9593\u4F4D\u7F6E",
    amplitudeZoom: "\u632F\u5E45\u7E2E\u653E",
    mouseWheel: "\u6ED1\u9F20\u6EFE\u8F2A",
    help: "\u8AAA\u660E",
    downloadAudio: "\u4E0B\u8F09\u97F3\u8A0A",
    settings: "\u8A2D\u5B9A",
    pcmReadAs: "\u6309 PCM \u8B80\u53D6",
    pcmParams: "PCM \u53C3\u6578",
    wavPcmRead: "WAV \u6309 PCM \u8B80\u53D6",
    currentFileOnly: "\u50C5\u5C0D\u76EE\u524D\u6A94\u6848\u751F\u6548",
    sampleRate: "\u53D6\u6A23\u7387",
    channels: "\u8072\u9053\u6578",
    startOffsetBytes: "\u504F\u79FB(B)",
    bitDepth: "\u4F4D\u5143\u6DF1\u5EA6(bit)",
    sampleFormat: "\u683C\u5F0F",
    endianness: "\u7AEF\u5E8F",
    read: "\u8B80\u53D6",
    saveDefault: "\u5132\u5B58\u9810\u8A2D",
    cancel: "\u53D6\u6D88",
    defaultView: "\u9810\u8A2D\u8996\u5716",
    view: "\u8996\u5716",
    viewBoth: "\u591A\u8996\u5716",
    mute: "\u975C\u97F3",
    solo: "\u7368\u594F",
    timeLabel: "\u6642\u9593",
    helpTimeZoom: "\u6642\u9593\u7E2E\u653E",
    helpTimePan: "\u6642\u9593\u5E73\u79FB",
    helpAmplitudeZoom: "\u632F\u5E45\u7E2E\u653E",
    helpRightClick: "\u53F3\u9375",
    helpPinch: "\u96D9\u6307\u634F\u5408",
    helpHorizontalSwipe: "\u6A6B\u5411\u6ED1\u52D5",
    helpDoubleClick: "\u96D9\u64CA",
    helpPlaybackGroup: "\u64AD\u653E\u8207\u9078\u5340",
    helpViewGroup: "\u8996\u5716\u5C0E\u89BD",
    helpMouseGroup: "\u6ED1\u9F20\u8207\u89F8\u63A7\u677F",
    helpGainGroup: "\u64AD\u653E\u589E\u76CA",
    helpPlayPause: "\u64AD\u653E / \u66AB\u505C",
    helpClearSelection: "\u95DC\u9589\u9078\u55AE\u3001\u6E05\u9664\u9078\u5340\u6216\u91CD\u8A2D\u64AD\u653E\u6E38\u6A19",
    helpResetTimeZoom: "\u91CD\u8A2D\u6642\u9593\u7E2E\u653E",
    helpTrackpadZoom: "\u89F8\u63A7\u677F\u96D9\u6307\u634F\u5408\u53EF\u7E2E\u653E\u6642\u9593",
    helpTrackpadPan: "\u89F8\u63A7\u677F\u6A6B\u5411\u6ED1\u52D5\u53EF\u5E73\u79FB\u6642\u9593",
    helpGainReset: "\u96D9\u64CA\u589E\u76CA\u6ED1\u687F\u53EF\u91CD\u8A2D\u70BA 0 dB",
    helpSelectionPlayback: "\u5728\u6CE2\u5F62\u5716\u6216\u983B\u8B5C\u5716\u4E0A\u62D6\u66F3\u53EF\u6846\u9078\u7247\u6BB5\uFF1B\u6709\u9078\u5340\u6642\u64AD\u653E\u53EA\u6703\u8A66\u807D\u8A72\u7BC4\u570D\u3002",
    refreshSpectrogram: "\u91CD\u65B0\u6574\u7406\u983B\u8B5C\u5716",
    resetView: "\u91CD\u8A2D\u8996\u5716",
    selectionAnalysis: "\u9078\u5340\u5206\u6790",
    selectionStart: "\u958B\u59CB",
    selectionEnd: "\u7D50\u675F",
    selectionDuration: "\u6301\u7E8C\u6642\u9593",
    rmsLevel: "RMS\u96FB\u5E73",
    peakLevel: "\u5CF0\u503C\u96FB\u5E73",
    dominant: "\u4E3B\u983B",
    crestFactor: "Crest",
    clippingRatio: "\u524A\u6CE2\u6BD4\u4F8B",
    noiseFloor: "\u566A\u8072\u5E95",
    spectralCentroid: "\u983B\u8B5C\u8CEA\u5FC3",
    zeroCrossingRate: "ZCR",
    basicMetrics: "\u57FA\u790E\u6307\u6A19",
    selectionAnalysisHelp: "\u9078\u5340\u5206\u6790\uFF1A\n\u5C0D\u76EE\u524D\u6846\u9078\u7684\u6642\u9593\u7BC4\u570D\u9032\u884C\u5FEB\u901F\u7D71\u8A08\uFF0C\u5354\u52A9\u5224\u65B7\u9304\u97F3\u96FB\u5E73\u3001\u52D5\u614B\u7BC4\u570D\u3001\u524A\u6CE2\u98A8\u96AA\u3001\u566A\u8072\u5E95\u8207\u983B\u7387\u5206\u4F48\u3002\n\n\u5206\u6790\u5C0D\u8C61\uFF1A\n\u7D50\u679C\u53EA\u91DD\u5C0D\u555F\u7528\u4E2D\u7684\u8072\u9053\uFF0C\u4E0D\u6703\u6DF7\u5408\u591A\u500B\u8072\u9053\u3002\n\n\u5982\u4F55\u5207\u63DB\uFF1A\n\u9EDE\u64CA\u67D0\u4E00\u689D\u97F3\u8ECC\u5F8C\uFF0C\u8A72\u97F3\u8ECC\u6703\u6210\u70BA\u76EE\u524D\u555F\u7528\u8072\u9053\u3002",
    rmsLevelHelp: "RMS \u96FB\u5E73\uFF1A\n\u986F\u793A\u9078\u5340\u7684\u5E73\u5747\u80FD\u91CF\uFF0C\u6BD4\u5CF0\u503C\u66F4\u7A69\u5B9A\uFF0C\u9069\u5408\u6AA2\u67E5\u8A9E\u97F3\u662F\u5426\u904E\u5C0F\u6216\u904E\u5927\u3002",
    peakLevelHelp: "\u5CF0\u503C\u96FB\u5E73\uFF1A\n\u986F\u793A\u9078\u5340\u4E2D\u7684\u6700\u9AD8\u77AC\u6642\u96FB\u5E73\uFF0C\u9069\u5408\u6AA2\u67E5\u662F\u5426\u63A5\u8FD1 0 dBFS \u6216\u6709\u524A\u6CE2\u98A8\u96AA\u3002",
    dominantHelp: "\u4E3B\u983B\uFF1A\n\u9078\u5340\u5167\u7D2F\u7A4D\u529F\u7387\u6700\u5927\u7684 FFT bin \u5C0D\u61C9\u983B\u7387\u3002\u5B83\u4E0D\u4E00\u5B9A\u662F\u57FA\u983B\u6216\u807D\u611F\u97F3\u9AD8\u3002",
    crestFactorHelp: "Crest Factor\uFF1A\n\u5CF0\u503C\u8207 RMS \u7684\u6BD4\u503C\u3002\u6578\u503C\u8D8A\u5927\uFF0C\u8868\u793A\u5CF0\u503C\u76F8\u5C0D\u5E73\u5747\u80FD\u91CF\u8D8A\u7A81\u51FA\u3002",
    clippingRatioHelp: "\u524A\u6CE2\u6BD4\u4F8B\uFF1A\n\u63A5\u8FD1\u6EFF\u523B\u5EA6\u7684 sample \u6BD4\u4F8B\uFF0C\u7528\u65BC\u5FEB\u901F\u5075\u6E2C\u9304\u97F3\u904E\u8F09\u6216\u6578\u4F4D\u524A\u6CE2\u98A8\u96AA\u3002",
    noiseFloorHelp: "\u566A\u8072\u5E95\uFF1A\n\u7531\u77ED\u6642 RMS \u7684\u4F4E\u767E\u5206\u4F4D\u4F30\u7B97\u80CC\u666F\u566A\u8072\u3002\u82E5\u9078\u5340\u5927\u591A\u662F\u8A9E\u97F3\u6216\u97F3\u6A02\uFF0C\u53EF\u80FD\u4E0D\u7B49\u65BC\u771F\u5BE6\u566A\u8072\u5E95\u3002",
    spectralCentroidHelp: "\u983B\u8B5C\u8CEA\u5FC3\uFF1A\n\u983B\u8B5C\u80FD\u91CF\u7684\u91CD\u5FC3\uFF0C\u55AE\u4F4D\u70BA Hz\uFF0C\u7528\u65BC\u89C0\u5BDF\u8072\u97F3\u504F\u4EAE\u6216\u504F\u6697\u3002",
    zeroCrossingRateHelp: "\u904E\u96F6\u7387\uFF1A\n\u8A0A\u865F\u6539\u8B8A\u6B63\u8CA0\u865F\u7684\u983B\u7387\uFF0C\u5E38\u7528\u65BC\u89C0\u5BDF\u9AD8\u983B\u566A\u8072\u3001\u7121\u8072\u5B50\u97F3\u8207\u6469\u64E6\u97F3\u3002",
    frequencyAnalysis: "\u983B\u7387\u5206\u6790",
    frequencyAnalysisHelp: "\u542B\u7FA9\uFF1A\n\u5404\u983B\u5E36\u7684\u7DDA\u6027\u80FD\u91CF\u767E\u5206\u6BD4\uFF0C\u4E0D\u662F RMS \u96FB\u5E73\uFF0C\u4E5F\u4E0D\u662F dB\u3002\n\n\u8A08\u7B97\uFF1A\n\u5C07\u9078\u5340\u5207\u6210 50% overlap \u7684 FFT frame\uFF0C\u7D2F\u7A4D\u5404 bin \u529F\u7387\u5F8C\u5206\u914D\u5230\u983B\u5E36\u4E26\u986F\u793A\u767E\u5206\u6BD4\u3002",
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
    transcodingAudio: "\u6B63\u5728\u4F7F\u7528 FFmpeg \u8F49\u78BC\u97F3\u8A0A",
    encodedPlaybackOnly: "VS Code Webview \u89E3\u78BC\u5668\u4E0D\u652F\u63F4\u6B64\u7DE8\u78BC\u683C\u5F0F\u3002\u8ACB\u5728\u57F7\u884C\u64F4\u5145\u529F\u80FD\u5BBF\u4E3B\u7684\u6A5F\u5668\u4E0A\u5B89\u88DD FFmpeg\uFF0C\u4EE5\u555F\u7528\u5099\u63F4\u89E3\u78BC\u3002",
    waitingPcmParams: "\u7B49\u5F85 PCM \u53C3\u6578",
    pcmUsedDefaultParams: "\u5DF2\u4F7F\u7528\u9810\u8A2D PCM \u53C3\u6578\u8F09\u5165\u3002",
    pcmFillParams: "\u8ACB\u586B\u5BEB PCM \u53C3\u6578\uFF0C\u7136\u5F8C\u9EDE\u64CA\u8B80\u53D6\u3002",
    wavPcmFillParams: "\u8ACB\u586B\u5BEB\u53C3\u6578\uFF0C\u7136\u5F8C\u9EDE\u64CA\u8B80\u53D6\uFF0C\u5C07\u76EE\u524D WAV \u6309 PCM \u89E3\u6790\u3002",
    currentPcmFormat: "\u76EE\u524D",
    savedDefaultPcmFormat: "\u5DF2\u5132\u5B58\u9810\u8A2D",
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
    initializationFailed: "AudioLens \u521D\u59CB\u5316\u5931\u6557",
    playbackGainLabel: "\u589E\u76CA",
    playbackGain: "\u64AD\u653E\u589E\u76CA (\u96D9\u64CA\u91CD\u8A2D\u70BA 0)"
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
    return { ...messages2, ...localeMessages[locale] ?? {} };
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

  // src/webview/pcm.ts
  function decodePcm(bytes, format) {
    const data = pcmPayloadBytes(bytes, format);
    const bytesPerSample = getBytesPerSample(format);
    const frameSize = getFrameSize(format);
    if (bytesPerSample <= 0 || frameSize <= 0 || data.byteLength % frameSize !== 0) {
      throw new Error("PCM parameters do not match the file size.");
    }
    const frames = data.byteLength / frameSize;
    const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
    for (let frame = 0; frame < frames; frame += 1) {
      const frameOffset = frame * frameSize;
      for (let channel = 0; channel < format.channels; channel += 1) {
        const offset = frameOffset + channel * bytesPerSample;
        channels[channel][frame] = readSample(data, offset, format);
      }
    }
    return { sampleRate: format.sampleRate, channels };
  }
  function createAudioBufferFromChannels(audioContext, decoded) {
    const frames = decoded.channels[0]?.length ?? 0;
    const audioBuffer = audioContext.createBuffer(decoded.channels.length, frames, decoded.sampleRate);
    decoded.channels.forEach((samples, channel) => audioBuffer.getChannelData(channel).set(samples));
    return audioBuffer;
  }
  function validatePcmFormat(bytes, format) {
    const startOffsetBytes = format.startOffsetBytes ?? 0;
    if (!Number.isFinite(format.sampleRate) || format.sampleRate <= 0) {
      return "PCM sample rate must be greater than 0.";
    }
    if (!Number.isInteger(format.channels) || format.channels <= 0) {
      return "PCM channel count must be a positive integer.";
    }
    if (![8, 16, 24, 32].includes(format.bitDepth)) {
      return "PCM bit depth must be 8/16/24/32-bit.";
    }
    if (format.sampleFormat === "float" && format.bitDepth !== 32) {
      return "Float PCM currently supports 32-bit only.";
    }
    if (!Number.isInteger(startOffsetBytes) || startOffsetBytes < 0) {
      return "PCM start offset must be a non-negative integer.";
    }
    if (startOffsetBytes >= bytes.byteLength) {
      return `PCM start offset ${startOffsetBytes} bytes exceeds the file size.`;
    }
    const dataBytes = bytes.byteLength - startOffsetBytes;
    const frameSize = getFrameSize(format);
    if (frameSize <= 0 || dataBytes % frameSize !== 0) {
      return `Data size after offset (${dataBytes} bytes) is not aligned to the current PCM parameters.`;
    }
    return void 0;
  }
  function pcmPayloadBytes(bytes, format) {
    return bytes.subarray(format.startOffsetBytes ?? 0);
  }
  function readSample(bytes, offset, format) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, getBytesPerSample(format));
    if (format.sampleFormat === "float") {
      return clamp3(view.getFloat32(0, format.endianness === "little"), -1, 1);
    }
    if (format.bitDepth === 8) {
      return view.getInt8(0) / 128;
    }
    if (format.bitDepth === 16) {
      return view.getInt16(0, format.endianness === "little") / 32768;
    }
    if (format.bitDepth === 24) {
      const little = format.endianness === "little";
      const raw = little ? view.getUint8(0) | view.getUint8(1) << 8 | view.getUint8(2) << 16 : view.getUint8(2) | view.getUint8(1) << 8 | view.getUint8(0) << 16;
      return signExtend24(raw) / 8388608;
    }
    return view.getInt32(0, format.endianness === "little") / 2147483648;
  }
  function signExtend24(value) {
    return value & 8388608 ? value | ~16777215 : value;
  }
  function getBytesPerSample(format) {
    return format.sampleFormat === "float" ? 4 : format.bitDepth / 8;
  }
  function getFrameSize(format) {
    return getBytesPerSample(format) * format.channels;
  }
  function clamp3(value, min, max) {
    return Math.max(min, Math.min(max, value));
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
          <button id="pcmReveal" class="secondary pcmReveal" data-i18n="pcmReadAs" hidden>Read as PCM</button>
        </div>
        <div id="status" class="status" data-i18n="initializing" hidden>Initializing</div>
        <section id="pcmPanel" class="pcmPanel topPcmPanel" hidden>
          <div class="paneTitle" data-i18n="pcmParams">PCM parameters</div>
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
            <span data-i18n="bitDepth">Bit depth (bit)</span>
            <select id="pcmBitDepth">
              <option value="8">8</option>
              <option value="16">16</option>
              <option value="24">24</option>
              <option value="32">32</option>
            </select>
          </label>
          <label>
            <span data-i18n="sampleFormat">Format</span>
            <select id="pcmSampleFormat">
              <option value="signed-int">Int</option>
              <option value="float">Float</option>
            </select>
          </label>
          <label>
            <span data-i18n="endianness">Endian</span>
            <select id="pcmEndianness">
              <option value="little">LE</option>
              <option value="big">BE</option>
            </select>
          </label>
          <button id="pcmApply" class="secondary" data-i18n="read">Read</button>
          <button id="pcmSaveDefault" class="secondary" data-i18n="saveDefault">Save default</button>
          <span id="pcmStatus" class="muted"><span id="pcmStatusText"></span></span>
        </section>
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
              <div class="helpSectionTitle" data-i18n="helpGainGroup">Gain</div>
              <div class="helpRow"><span><span class="helpGesture" data-i18n="helpDoubleClick">Double click</span></span><span data-i18n="helpGainReset">Double-click the gain slider to reset to 0 dB</span></div>
            </section>
          </div>
        </details>
        <div class="gainControl" data-i18n-title="playbackGain" data-i18n-tooltip="playbackGain" data-tooltip="Playback Gain (Double-click to reset)" title="Playback Gain (Double-click to reset)" aria-label="Playback Gain">
          <span class="gainTitle" data-i18n="playbackGainLabel" data-i18n-title="playbackGain" title="Playback Gain (Double-click to reset)">Gain</span>
          <span id="gainLabel" class="gainLabel" data-i18n-title="playbackGain" title="Playback Gain (Double-click to reset)">0 dB</span>
          <input id="playbackGain" class="gainSlider" type="range" min="-12" max="24" step="1" value="0" data-i18n-title="playbackGain" title="Playback Gain (Double-click to reset)" />
        </div>
        <button id="settingsToggle" class="iconButton secondaryIcon" data-i18n-title="settings" data-i18n-aria="settings" data-i18n-tooltip="settings" title="Settings" aria-label="Settings" data-tooltip="Settings"><span class="settingsGlyph">\u2699</span></button>
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
            <span data-i18n="bitDepth">Bit depth (bit)</span>
            <select id="wavPcmBitDepth">
              <option value="8">8</option>
              <option value="16">16</option>
              <option value="24">24</option>
              <option value="32">32</option>
            </select>
          </label>
          <label>
            <span data-i18n="sampleFormat">Format</span>
            <select id="wavPcmSampleFormat">
              <option value="signed-int">Int</option>
              <option value="float">Float</option>
            </select>
          </label>
          <label>
            <span data-i18n="endianness">Endian</span>
            <select id="wavPcmEndianness">
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
          <label>
            <span data-i18n="amplitudeZoom">Amplitude zoom</span>
            <input id="amplitudeZoom" type="range" min="0.25" max="32" step="0.25" value="1" />
            <small class="wheelHint"><kbd data-amplitude-zoom-modifier>Alt</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></small>
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
          <div id="floatingTooltip" class="floatingTooltip" hidden></div>
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
      defaultTrackMode: query("#defaultTrackMode", HTMLSelectElement),
      zeroPaddingFactor: query("#zeroPaddingFactor", HTMLSelectElement),
      settingsToggle: query("#settingsToggle", HTMLButtonElement),
      downloadAudio: query("#downloadAudio", HTMLButtonElement),
      helpMenu: query("#helpMenu", HTMLElement),
      gainLabel: query("#gainLabel", HTMLSpanElement),
      playbackGain: query("#playbackGain", HTMLInputElement),
      settingsPanel: query("#settingsPanel", HTMLElement),
      windowFunction: query("#windowFunction", HTMLSelectElement),
      fftSize: query("#fftSize", HTMLSelectElement),
      channel: query("#channel", HTMLSelectElement),
      pcmPanel: query("#pcmPanel", HTMLElement),
      pcmReveal: query("#pcmReveal", HTMLButtonElement),
      pcmSampleRate: query("#pcmSampleRate", HTMLInputElement),
      pcmChannels: query("#pcmChannels", HTMLInputElement),
      pcmStartOffset: query("#pcmStartOffset", HTMLInputElement),
      pcmBitDepth: query("#pcmBitDepth", HTMLSelectElement),
      pcmSampleFormat: query("#pcmSampleFormat", HTMLSelectElement),
      pcmEndianness: query("#pcmEndianness", HTMLSelectElement),
      pcmApply: query("#pcmApply", HTMLButtonElement),
      pcmSaveDefault: query("#pcmSaveDefault", HTMLButtonElement),
      pcmStatus: query("#pcmStatus", HTMLSpanElement),
      pcmStatusText: query("#pcmStatusText", HTMLSpanElement),
      wavPcmPanel: query("#wavPcmPanel", HTMLElement),
      wavPcmSampleRate: query("#wavPcmSampleRate", HTMLInputElement),
      wavPcmChannels: query("#wavPcmChannels", HTMLInputElement),
      wavPcmStartOffset: query("#wavPcmStartOffset", HTMLInputElement),
      wavPcmBitDepth: query("#wavPcmBitDepth", HTMLSelectElement),
      wavPcmSampleFormat: query("#wavPcmSampleFormat", HTMLSelectElement),
      wavPcmEndianness: query("#wavPcmEndianness", HTMLSelectElement),
      wavPcmApply: query("#wavPcmApply", HTMLButtonElement),
      wavPcmCancel: query("#wavPcmCancel", HTMLButtonElement),
      wavPcmStatus: query("#wavPcmStatus", HTMLSpanElement),
      timeZoom: query("#timeZoom", HTMLInputElement),
      timeOffset: query("#timeOffset", HTMLInputElement),
      amplitudeZoom: query("#amplitudeZoom", HTMLInputElement),
      minDb: query("#minDb", HTMLInputElement),
      maxDb: query("#maxDb", HTMLInputElement),
      autoBrightness: query("#autoBrightness", HTMLInputElement),
      frequencyScale: query("#frequencyScale", HTMLSelectElement),
      palette: query("#palette", HTMLSelectElement),
      analyze: query("#analyze", HTMLButtonElement),
      resetView: query("#resetView", HTMLButtonElement),
      viewRange: query("#viewRange", HTMLSpanElement),
      timeline: query("#timeline", HTMLCanvasElement),
      analysisMeta: query("#analysisMeta", HTMLSpanElement),
      analysisStart: query("#analysisStart", HTMLElement),
      analysisEnd: query("#analysisEnd", HTMLElement),
      analysisDuration: query("#analysisDuration", HTMLElement),
      analysisRms: query("#analysisRms", HTMLElement),
      analysisPeak: query("#analysisPeak", HTMLElement),
      analysisDominant: query("#analysisDominant", HTMLElement),
      analysisCrest: query("#analysisCrest", HTMLElement),
      analysisClipping: query("#analysisClipping", HTMLElement),
      analysisNoiseFloor: query("#analysisNoiseFloor", HTMLElement),
      analysisCentroid: query("#analysisCentroid", HTMLElement),
      analysisZcr: query("#analysisZcr", HTMLElement),
      analysisBands: query("#analysisBands", HTMLElement),
      figures: query("#figures", HTMLElement),
      trackList: query("#trackList", HTMLElement),
      waveformPane: query("#waveformPane", HTMLElement),
      spectrogramPane: query("#spectrogramPane", HTMLElement),
      waveformResize: query("#waveformResize", HTMLDivElement),
      spectrogramResize: query("#spectrogramResize", HTMLDivElement),
      waveform: query("#waveform", HTMLCanvasElement),
      spectrogram: query("#spectrogram", HTMLCanvasElement),
      selectionBox: query("#selectionBox", HTMLDivElement),
      floatingTooltip: query("#floatingTooltip", HTMLDivElement)
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
    root2.querySelectorAll("[data-i18n-tooltip]").forEach((element) => {
      const key = element.dataset.i18nTooltip;
      if (key && messages18[key]) {
        element.dataset.tooltip = messages18[key];
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
  var ENCODED_DECODE_TIMEOUT_MS = 8e3;
  var PLOT_MARGIN = { left: 78, top: 18, right: 18, bottom: 40 };
  var TRACK_AXIS_WIDTH = 96;
  var AXIS_FONT_SIZE = 13;
  var WAVEFORM_AMPLITUDE_SCALE = 0.45;
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
    trackViews = [];
    defaultPcmFormat;
    currentFileName = "";
    objectUrl;
    requestSeq = 1;
    pendingAnalysisKeys = /* @__PURE__ */ new Set();
    playheadTime;
    dragPlayheadTime;
    sourceSampleRate;
    selection;
    selectionPlaybackEnd;
    isDraggingSelection = false;
    playbackFrameId;
    preferencesSaveTimer;
    analysisTimer;
    playbackAudioContext;
    playbackGainNode;
    playbackSourceNode;
    playbackSplitterNode;
    playbackMergerNode;
    playbackChannelGains = [];
    pendingChunks = /* @__PURE__ */ new Map();
    pendingTranscodes = /* @__PURE__ */ new Map();
    pendingAnalysisTargets = /* @__PURE__ */ new Map();
    spectrogramCache = /* @__PURE__ */ new Map();
    spectrogramBitmapCache = /* @__PURE__ */ new Map();
    spectrogramRangeCache = /* @__PURE__ */ new Map();
    lastSpectrogramByChannel = /* @__PURE__ */ new Map();
    waveformCache = /* @__PURE__ */ new Map();
    worker = createAnalysisWorker();
    messages = getMessages("en");
    settings = {
      algorithm: "frequency",
      defaultTrackMode: "both",
      windowFunction: "hamming",
      fftSize: 512,
      zeroPaddingFactor: 2,
      channel: 0,
      minDb: -96,
      maxDb: 0,
      autoBrightness: true,
      amplitudeZoom: 1,
      timeZoom: 1,
      timeOffset: 0,
      frequencyScale: "linear",
      palette: "rose",
      playbackGain: 0
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
        case "transcodedAudio":
          this.resolveTranscode(message);
          break;
        case "transcodeError":
          this.rejectTranscode(message);
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
      const timeZoomModifier = isMacPlatform() ? "\u2318" : "Ctrl";
      const amplitudeZoomModifier = isMacPlatform() ? "\u2325" : "Alt";
      const commandModifier = isMacPlatform() ? "\u2318" : "Ctrl";
      document.querySelectorAll("[data-time-zoom-modifier]").forEach((element) => {
        element.textContent = timeZoomModifier;
      });
      document.querySelectorAll("[data-amplitude-zoom-modifier]").forEach((element) => {
        element.textContent = amplitudeZoomModifier;
      });
      document.querySelectorAll("[data-command-modifier]").forEach((element) => {
        element.textContent = commandModifier;
      });
    }
    applyLanguage(config) {
      const locale = resolveLocale(config.language, config.vscodeLanguage);
      this.messages = getMessages(locale);
      applyLocale(document, this.messages);
      this.updateResetViewButtonState();
      this.updateTrackLabels();
      this.redrawVisuals();
    }
    resetAnalysisWorker() {
      this.worker.terminate();
      this.worker = createAnalysisWorker();
      this.bindWorker();
    }
    clearDecodedAudio() {
      this.audioBuffer = void 0;
      this.sourceSampleRate = void 0;
      this.clearAudioElement();
      this.spectrogramCache.clear();
      this.spectrogramBitmapCache.clear();
      this.spectrogramRangeCache.clear();
      this.lastSpectrogramByChannel.clear();
      this.waveformCache.clear();
      this.pendingAnalysisKeys.clear();
      this.pendingAnalysisTargets.clear();
      this.trackViews = [];
      this.elements.trackList.replaceChildren();
      this.elements.seek.value = "0";
      this.updateClock();
    }
    clearAudioElement() {
      this.elements.audio.pause();
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = void 0;
      }
      this.elements.audio.removeAttribute("src");
      this.elements.audio.load();
    }
    async load(metadata) {
      this.currentFileName = metadata.fileName;
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
      this.setStatus(metadata.kind === "pcm" ? this.messages.waitingPcmParams : this.messages.decodingAudio);
      this.elements.pcmReveal.hidden = metadata.kind === "pcm" || metadata.extension !== "wav";
      this.elements.wavPcmPanel.hidden = true;
      this.stopPlaybackTicker();
      if (metadata.kind === "pcm") {
        const loaded = await this.loadPcm(metadata);
        if (!loaded) {
          return;
        }
      } else {
        await this.loadEncoded(metadata.fileName);
        if (!this.audioBuffer) {
          this.settings.channel = 0;
          this.selection = void 0;
          this.playheadTime = void 0;
          this.dragPlayheadTime = void 0;
          this.selectionPlaybackEnd = void 0;
          this.updateSelectionAnalysis();
          this.redrawVisuals();
          return;
        }
      }
      this.settings.channel = 0;
      this.applyAutoAmplitudeZoom();
      this.spectrogramCache.clear();
      this.spectrogramBitmapCache.clear();
      this.spectrogramRangeCache.clear();
      this.lastSpectrogramByChannel.clear();
      this.waveformCache.clear();
      this.selection = void 0;
      this.playheadTime = void 0;
      this.dragPlayheadTime = void 0;
      this.selectionPlaybackEnd = void 0;
      this.updateSelectionAnalysis();
      this.populateChannels();
      this.renderTrackList();
      this.applyAutoBrightness();
      this.redrawVisuals();
      if (this.config.autoAnalyze) {
        this.scheduleAnalyze(0);
      }
      this.setStatus(this.messages.ready);
    }
    async loadEncoded(fileName) {
      if (!this.audioBytes) {
        return;
      }
      const facts = readAudioFileFacts(this.audioBytes, fileName);
      this.elements.pcmPanel.hidden = true;
      this.elements.wavPcmPanel.hidden = true;
      const audioContext = facts.sampleRate ? new AudioContext({ sampleRate: facts.sampleRate }) : new AudioContext();
      try {
        this.audioBuffer = await decodeAudioDataWithTimeout(audioContext, this.audioBytes, ENCODED_DECODE_TIMEOUT_MS);
        this.sourceSampleRate = facts.sampleRate ?? this.audioBuffer.sampleRate;
        this.installAudioElementFromBytes(fileName);
      } catch (error) {
        console.warn("AudioLens encoded decode fallback:", error);
        await audioContext.close().catch(() => void 0);
        await this.loadEncodedViaFfmpeg(fileName);
        return;
      } finally {
        await audioContext.close().catch(() => void 0);
      }
    }
    async loadEncodedViaFfmpeg(fileName) {
      this.setStatus(this.messages.transcodingAudio);
      try {
        const bytes = await this.requestTranscodedAudio();
        const audioContext = new AudioContext();
        try {
          this.audioBuffer = await decodeAudioDataWithTimeout(audioContext, bytes, ENCODED_DECODE_TIMEOUT_MS);
          this.sourceSampleRate = this.audioBuffer.sampleRate;
        } finally {
          await audioContext.close().catch(() => void 0);
        }
        this.installAudioElementFromBytes(`${fileName}.wav`, bytes, "audio/wav");
      } catch (error) {
        console.warn("AudioLens FFmpeg fallback failed:", error);
        this.clearDecodedAudio();
        const detail = error instanceof Error ? error.message : String(error);
        this.setStatus(`${this.messages.encodedPlaybackOnly} ${detail}`);
      }
    }
    async loadPcm(_metadata) {
      if (!this.audioBytes) {
        return false;
      }
      this.elements.pcmPanel.hidden = false;
      this.elements.pcmReveal.hidden = true;
      this.elements.wavPcmPanel.hidden = true;
      this.clearDecodedAudio();
      if (this.defaultPcmFormat) {
        this.writePcmControls(this.defaultPcmFormat);
        this.setPcmStatus(this.elements.pcmStatus, this.messages.pcmUsedDefaultParams);
        await this.applyPcmFormat(this.defaultPcmFormat);
        return true;
      }
      this.writePcmControls(this.readPcmControls());
      this.setPcmStatus(this.elements.pcmStatus, this.messages.pcmFillParams);
      return false;
    }
    bindUi() {
      this.elements.play.addEventListener("click", () => {
        void this.togglePlayback();
      });
      this.elements.downloadAudio.addEventListener("click", () => {
        this.downloadCurrentAudio();
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
      this.elements.playbackGain.addEventListener("input", () => {
        this.settings.playbackGain = Number(this.elements.playbackGain.value);
        this.elements.gainLabel.textContent = `${this.settings.playbackGain > 0 ? "+" : ""}${this.settings.playbackGain} dB`;
        this.updateGainNode();
        this.savePreferencesSoon();
      });
      this.elements.playbackGain.addEventListener("dblclick", () => {
        this.settings.playbackGain = 0;
        this.elements.playbackGain.value = "0";
        this.elements.gainLabel.textContent = "0 dB";
        this.updateGainNode();
        this.savePreferencesSoon();
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
        if (!this.elements.settingsPanel.hidden) {
          this.helpMenuElement().open = false;
        }
      });
      this.elements.helpMenu.addEventListener("toggle", () => {
        if (this.helpMenuElement().open) {
          this.elements.settingsPanel.hidden = true;
        }
      });
      this.elements.pcmReveal.addEventListener("click", () => {
        this.showWavPcmPanel();
      });
      this.elements.wavPcmApply.addEventListener("click", () => {
        void this.applyWavPcmFormat();
      });
      this.elements.wavPcmCancel.addEventListener("click", () => {
        this.hideWavPcmPanel();
      });
      document.addEventListener("pointerdown", (event) => {
        this.closeFloatingMenusFromPointer(event);
      });
      this.elements.algorithm.addEventListener("change", () => {
        this.settings.algorithm = this.elements.algorithm.value;
        this.savePreferencesSoon();
        this.analyze();
      });
      this.elements.defaultTrackMode.addEventListener("change", () => {
        this.settings.defaultTrackMode = this.elements.defaultTrackMode.value;
        this.applyDefaultTrackModeToCurrentTracks();
        this.savePreferencesSoon();
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
        this.renderTrackSelection();
      });
      this.elements.pcmApply.addEventListener("click", () => {
        void this.applyPcmFormat(this.readPcmControls());
      });
      this.elements.pcmSaveDefault.addEventListener("click", () => {
        this.saveDefaultPcmFormat();
      });
      this.elements.pcmStatus.addEventListener("mouseenter", () => {
        this.positionPcmStatusTooltip();
      });
      this.elements.pcmStatus.addEventListener("focusin", () => {
        this.positionPcmStatusTooltip();
      });
      this.bindAnalysisTooltips();
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
      this.elements.autoBrightness.addEventListener("change", () => {
        this.settings.autoBrightness = this.elements.autoBrightness.checked;
        if (this.settings.autoBrightness) {
          this.applyAutoBrightness();
        }
        this.savePreferencesSoon();
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
        if (!this.elements.wavPcmPanel.hidden) {
          this.positionWavPcmPanel();
        }
        this.positionPcmStatusTooltip();
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
          this.updateGainNode();
          if (this.playbackAudioContext?.state === "suspended") {
            await this.playbackAudioContext.resume();
          }
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
      this.followPlayheadDuringPlayback();
      if (options.redraw) {
        this.redrawVisuals();
      }
    }
    followPlayheadDuringPlayback() {
      if (!this.audioBuffer || this.playheadTime === void 0 || this.elements.audio.paused) {
        return;
      }
      const range = this.visibleRange();
      const duration = this.audioBuffer.duration;
      const viewDuration = range.endTime - range.startTime;
      if (viewDuration <= 0 || viewDuration >= duration) {
        return;
      }
      const margin = viewDuration * 0.12;
      if (this.selectionPlaybackEnd !== void 0 && this.playheadTime >= range.startTime && this.playheadTime <= range.endTime) {
        const selectionEndsInView = this.selectionPlaybackEnd <= range.endTime;
        const playheadHasRoomAhead = this.playheadTime < range.endTime - margin;
        if (selectionEndsInView || playheadHasRoomAhead) {
          return;
        }
      }
      if (this.playheadTime <= range.endTime - margin && this.playheadTime >= range.startTime + margin) {
        return;
      }
      const maxStart = Math.max(0, duration - viewDuration);
      const targetStart = clamp2(this.playheadTime - viewDuration * 0.78, 0, maxStart);
      this.settings.timeOffset = maxStart === 0 ? 0 : targetStart / maxStart;
      this.syncControls();
      this.scheduleAnalyze(0);
    }
    onKeyDown(event) {
      if (isEditableTarget(event.target)) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        this.resetTimeZoom();
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
      if (this.helpMenuElement().open) {
        this.helpMenuElement().open = false;
        this.elements.helpMenu.querySelector("summary")?.focus();
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
      this.dragPlayheadTime = void 0;
      this.selectionPlaybackEnd = void 0;
      this.elements.seek.value = "0";
      this.updateClock();
      this.redrawVisuals();
    }
    closeFloatingMenusFromPointer(event) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!this.elements.settingsPanel.hidden && !this.elements.settingsPanel.contains(target) && !this.elements.settingsToggle.contains(target)) {
        this.elements.settingsPanel.hidden = true;
      }
      if (this.helpMenuElement().open && !this.elements.helpMenu.contains(target)) {
        this.helpMenuElement().open = false;
      }
      this.hideFloatingTooltip();
      if (!this.elements.wavPcmPanel.hidden && !this.elements.wavPcmPanel.contains(target) && !this.elements.pcmReveal.contains(target)) {
        this.hideWavPcmPanel();
      }
    }
    helpMenuElement() {
      return this.elements.helpMenu;
    }
    bindAnalysisTooltips() {
      document.querySelectorAll(".analysisHelp, .metricHelp").forEach((trigger) => {
        trigger.addEventListener("mouseenter", () => this.showFloatingTooltip(trigger));
        trigger.addEventListener("focusin", () => this.showFloatingTooltip(trigger));
        trigger.addEventListener("mouseleave", () => this.hideFloatingTooltip());
        trigger.addEventListener("focusout", () => this.hideFloatingTooltip());
      });
    }
    showFloatingTooltip(trigger) {
      const text = trigger.dataset.tooltip;
      if (!text) {
        return;
      }
      const tooltip = this.elements.floatingTooltip;
      tooltip.textContent = text;
      tooltip.hidden = false;
      tooltip.style.width = "";
      const margin = 12;
      const triggerRect = trigger.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const tooltipWidth = Math.min(tooltipRect.width || 380, window.innerWidth - margin * 2);
      const left = clamp2(triggerRect.left - tooltipWidth - 10, margin, Math.max(margin, window.innerWidth - tooltipWidth - margin));
      const preferredTop = triggerRect.top + triggerRect.height * 0.45 - tooltipRect.height * 0.45;
      const top = clamp2(preferredTop, margin, Math.max(margin, window.innerHeight - tooltipRect.height - margin));
      tooltip.style.width = `${tooltipWidth}px`;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    }
    hideFloatingTooltip() {
      this.elements.floatingTooltip.hidden = true;
    }
    reportPlaybackError(message) {
      const detail = `${this.messages.playbackFailed}: ${message}`;
      this.setStatus(detail);
      this.vscode.postMessage({ type: "showError", message: detail });
    }
    downloadCurrentAudio() {
      if (!this.currentFileName) {
        this.reportPlaybackError(this.messages.audioNotReady);
        return;
      }
      this.vscode.postMessage({ type: "downloadAudio" });
    }
    syncControls() {
      this.elements.algorithm.value = this.settings.algorithm;
      this.elements.defaultTrackMode.value = this.settings.defaultTrackMode;
      this.elements.windowFunction.value = this.settings.windowFunction;
      this.elements.fftSize.value = String(this.settings.fftSize);
      this.elements.zeroPaddingFactor.value = String(this.settings.zeroPaddingFactor);
      this.elements.timeZoom.value = String(this.settings.timeZoom);
      this.elements.timeOffset.value = String(this.settings.timeOffset);
      this.elements.amplitudeZoom.value = String(this.settings.amplitudeZoom);
      this.elements.minDb.value = String(this.settings.minDb);
      this.elements.maxDb.value = String(this.settings.maxDb);
      this.elements.autoBrightness.checked = this.settings.autoBrightness;
      this.elements.frequencyScale.value = this.settings.frequencyScale;
      this.elements.palette.value = this.settings.palette;
      this.updateResetViewButtonState();
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
      const minDbStr = this.elements.minDb.value;
      const maxDbStr = this.elements.maxDb.value;
      if (!minDbStr || !maxDbStr) {
        return;
      }
      const minDbRaw = Number(minDbStr);
      const maxDbRaw = Number(maxDbStr);
      if (!Number.isFinite(minDbRaw) || !Number.isFinite(maxDbRaw)) {
        return;
      }
      const range = normalizeDbRange(minDbRaw, maxDbRaw);
      this.settings.minDb = range.minDb;
      this.settings.maxDb = range.maxDb;
      this.settings.autoBrightness = false;
      this.elements.autoBrightness.checked = false;
      this.savePreferencesSoon();
      this.syncControls();
      this.redrawVisuals();
      this.analyze();
    }
    applyPreferences(preferences) {
      if (preferences.algorithm) {
        this.settings.algorithm = preferences.algorithm;
      }
      if (preferences.defaultTrackMode) {
        this.settings.defaultTrackMode = preferences.defaultTrackMode;
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
      if (preferences.autoBrightness !== void 0) {
        this.settings.autoBrightness = preferences.autoBrightness;
      }
      if (preferences.waveformHeight !== void 0) {
        this.setPlotHeight("--waveform-height", preferences.waveformHeight, PLOT_HEIGHT_LIMITS.waveformMin, PLOT_HEIGHT_LIMITS.waveformMax);
      }
      if (preferences.spectrogramHeight !== void 0) {
        this.setPlotHeight("--spectrogram-height", preferences.spectrogramHeight, PLOT_HEIGHT_LIMITS.spectrogramMin, PLOT_HEIGHT_LIMITS.spectrogramMax);
      }
      if (preferences.defaultPcmFormat) {
        this.defaultPcmFormat = preferences.defaultPcmFormat;
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
        defaultTrackMode: this.settings.defaultTrackMode,
        windowFunction: this.settings.windowFunction,
        fftSize: this.settings.fftSize,
        zeroPaddingFactor: this.settings.zeroPaddingFactor,
        frequencyScale: this.settings.frequencyScale,
        palette: this.settings.palette,
        minDb: this.settings.minDb,
        maxDb: this.settings.maxDb,
        autoBrightness: this.settings.autoBrightness,
        playbackGain: this.settings.playbackGain,
        waveformHeight: this.getPlotHeight(this.elements.waveformPane),
        spectrogramHeight: this.getPlotHeight(this.elements.spectrogramPane),
        defaultPcmFormat: this.defaultPcmFormat
      };
    }
    applyAutoBrightness() {
      if (!this.settings.autoBrightness || !this.audioBuffer) {
        return;
      }
      const { minDb, maxDb } = this.computeAutoDbRange();
      const range = normalizeDbRange(minDb, maxDb);
      this.settings.minDb = Math.round(range.minDb * 100) / 100;
      this.settings.maxDb = Math.round(range.maxDb * 100) / 100;
      this.syncControls();
      this.analyze();
    }
    computeAutoDbRange() {
      if (!this.audioBuffer) {
        return { minDb: -96, maxDb: 0 };
      }
      const stride = Math.max(1, Math.ceil(this.audioBuffer.length / 2e6));
      let sumSquares = 0;
      let peak = 0;
      let measured = 0;
      for (let channel = 0; channel < this.audioBuffer.numberOfChannels; channel += 1) {
        const samples = this.audioBuffer.getChannelData(channel);
        let channelSquares = 0;
        let channelPeak = 0;
        let channelMeasured = 0;
        for (let i = 0; i < samples.length; i += stride) {
          const v = samples[i] ?? 0;
          channelSquares += v * v;
          channelPeak = Math.max(channelPeak, Math.abs(v));
          channelMeasured += 1;
        }
        const channelRms = Math.sqrt(channelSquares / Math.max(1, channelMeasured));
        if (channelRms < 1e-8 && channelPeak < 1e-8) {
          continue;
        }
        sumSquares += channelSquares;
        peak = Math.max(peak, channelPeak);
        measured += channelMeasured;
      }
      if (measured === 0) {
        return { minDb: -96, maxDb: 0 };
      }
      const rmsDb = amplitudeToDb(Math.sqrt(sumSquares / Math.max(1, measured)));
      const peakDb = amplitudeToDb(peak);
      return normalizeDbRange(rmsDb - 72, peakDb - 27);
    }
    applyAutoAmplitudeZoom() {
      const peak = this.computeAudioPeak();
      if (peak <= 1e-6) {
        this.settings.amplitudeZoom = 1;
        return;
      }
      const target = peak < 0.95 ? 0.95 : 1.05;
      this.settings.amplitudeZoom = clamp2(target / peak, 0.25, 32);
    }
    computeAudioPeak() {
      if (!this.audioBuffer) {
        return 0;
      }
      let peak = 0;
      for (let channel = 0; channel < this.audioBuffer.numberOfChannels; channel += 1) {
        const samples = this.audioBuffer.getChannelData(channel);
        for (let index = 0; index < samples.length; index += 1) {
          peak = Math.max(peak, Math.abs(samples[index] ?? 0));
        }
      }
      return peak;
    }
    resetView() {
      this.settings.timeZoom = 1;
      this.settings.timeOffset = 0;
      this.applyAutoAmplitudeZoom();
      this.selection = void 0;
      this.selectionPlaybackEnd = void 0;
      this.hideSelectionBox();
      this.syncControls();
      this.savePreferencesSoon();
      this.updateSelectionAnalysis();
      this.redrawVisuals();
      this.analyze();
    }
    resetTimeZoom() {
      this.settings.timeZoom = 1;
      this.settings.timeOffset = 0;
      this.syncControls();
      this.savePreferencesSoon();
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
    resolveTranscode(message) {
      const pending = this.pendingTranscodes.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pendingTranscodes.delete(message.requestId);
      pending.resolve(message);
    }
    rejectTranscode(message) {
      const pending = this.pendingTranscodes.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pendingTranscodes.delete(message.requestId);
      pending.reject(new Error(message.message));
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
    async requestTranscodedAudio() {
      const requestId = this.requestSeq;
      this.requestSeq += 1;
      const message = await new Promise((resolve, reject) => {
        this.pendingTranscodes.set(requestId, { resolve, reject });
        this.vscode.postMessage({ type: "transcodeAudio", requestId });
      });
      return new Uint8Array(message.bytes);
    }
    installAudioElementFromBytes(fileName, bytes = this.audioBytes, mime = guessMime(fileName)) {
      if (!bytes) {
        return;
      }
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
      }
      this.objectUrl = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }));
      this.elements.audio.src = this.objectUrl;
      this.elements.audio.load();
      this.elements.seek.value = "0";
      this.updateClock();
    }
    installAudioElementFromBuffer(fileName) {
      if (!this.audioBuffer) {
        return;
      }
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
      }
      this.objectUrl = URL.createObjectURL(new Blob([encodeWav(this.audioBuffer)], { type: "audio/wav" }));
      this.elements.audio.src = this.objectUrl;
      this.elements.audio.load();
      this.elements.seek.value = "0";
      this.updateClock();
      this.elements.fileMeta.textContent = `${fileName} \xB7 ${this.audioBuffer.numberOfChannels}ch \xB7 ${this.audioBuffer.sampleRate} Hz`;
    }
    async applyPcmFormat(format, statusElement = this.elements.pcmStatus) {
      if (!this.audioBytes) {
        return;
      }
      const error = validatePcmFormat(this.audioBytes, format);
      if (error) {
        this.setPcmStatus(statusElement, error);
        this.setStatus(error);
        return;
      }
      this.writePcmControls(format);
      const decoded = decodePcm(this.audioBytes, format);
      const audioContext = new AudioContext({ sampleRate: decoded.sampleRate });
      this.audioBuffer = createAudioBufferFromChannels(audioContext, decoded);
      this.sourceSampleRate = decoded.sampleRate;
      await audioContext.close();
      this.settings.channel = 0;
      this.applyAutoAmplitudeZoom();
      this.spectrogramCache.clear();
      this.spectrogramBitmapCache.clear();
      this.spectrogramRangeCache.clear();
      this.lastSpectrogramByChannel.clear();
      this.waveformCache.clear();
      this.selection = void 0;
      this.selectionPlaybackEnd = void 0;
      this.playheadTime = void 0;
      this.installAudioElementFromBuffer(this.currentFileName);
      this.populateChannels();
      this.renderTrackList();
      this.applyAutoBrightness();
      this.redrawVisuals();
      if (this.config?.autoAnalyze) {
        this.scheduleAnalyze(0);
      }
      this.setPcmStatus(statusElement, `${this.messages.currentPcmFormat}: ${formatPcmFormat(format)}`);
      this.setStatus(this.messages.ready);
    }
    showWavPcmPanel() {
      if (!this.audioBytes) {
        return;
      }
      this.elements.wavPcmPanel.hidden = false;
      this.elements.pcmReveal.hidden = true;
      this.writeWavPcmControls(this.suggestPcmFormatForCurrentFile());
      this.setPcmStatus(this.elements.wavPcmStatus, this.messages.wavPcmFillParams);
      this.positionWavPcmPanel();
    }
    async applyWavPcmFormat() {
      await this.applyPcmFormat(this.readWavPcmControls(), this.elements.wavPcmStatus);
      if (this.elements.wavPcmStatus.textContent?.startsWith(`${this.messages.currentPcmFormat}:`)) {
        this.hideWavPcmPanel();
      }
    }
    hideWavPcmPanel() {
      this.elements.wavPcmPanel.hidden = true;
      this.elements.pcmReveal.hidden = false;
    }
    positionWavPcmPanel() {
      const anchor = this.elements.pcmReveal.getBoundingClientRect();
      const panel = this.elements.wavPcmPanel;
      const margin = 12;
      const panelWidth = Math.min(520, window.innerWidth - margin * 2);
      const left = clamp2(anchor.left, margin, Math.max(margin, window.innerWidth - panelWidth - margin));
      panel.style.width = `${panelWidth}px`;
      panel.style.left = `${left}px`;
      panel.style.top = `${anchor.bottom + 8}px`;
    }
    suggestPcmFormatForCurrentFile() {
      const current = this.readPcmControls();
      return {
        sampleRate: Math.max(1, Math.floor(this.audioBuffer?.sampleRate ?? current.sampleRate)),
        channels: Math.max(1, Math.floor(this.audioBuffer?.numberOfChannels ?? current.channels)),
        bitDepth: current.bitDepth,
        sampleFormat: current.sampleFormat,
        endianness: current.endianness,
        startOffsetBytes: this.findWaveDataOffset() ?? current.startOffsetBytes ?? 0
      };
    }
    findWaveDataOffset() {
      const bytes = this.audioBytes;
      if (!bytes || bytes.byteLength < 12 || asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "WAVE") {
        return void 0;
      }
      let offset = 12;
      while (offset + 8 <= bytes.byteLength) {
        const chunkId = asciiAt(bytes, offset, 4);
        const chunkSize = readUint32Le(bytes, offset + 4);
        const payloadOffset = offset + 8;
        if (chunkId === "data") {
          return payloadOffset;
        }
        offset = payloadOffset + chunkSize + chunkSize % 2;
      }
      return void 0;
    }
    saveDefaultPcmFormat() {
      const format = this.readPcmControls();
      if (this.audioBytes) {
        const error = validatePcmFormat(this.audioBytes, format);
        if (error) {
          this.setPcmStatus(this.elements.pcmStatus, error);
          this.setStatus(error);
          return;
        }
      }
      this.defaultPcmFormat = format;
      this.vscode.postMessage({ type: "updatePreferences", preferences: this.collectPreferences() });
      this.setPcmStatus(this.elements.pcmStatus, `${this.messages.savedDefaultPcmFormat}: ${formatPcmFormat(format)}`);
    }
    setPcmStatus(element, message) {
      if (element === this.elements.pcmStatus) {
        this.elements.pcmStatusText.textContent = message;
        this.positionPcmStatusTooltip();
      } else {
        element.textContent = message;
      }
      element.dataset.tooltip = message;
    }
    positionPcmStatusTooltip() {
      const rect = this.elements.pcmStatus.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const margin = 12;
      const tooltipWidth = Math.min(520, window.innerWidth - margin * 2);
      const left = clamp2(rect.left, margin, Math.max(margin, window.innerWidth - tooltipWidth - margin));
      this.elements.pcmStatus.style.setProperty("--pcm-status-tooltip-left", `${left}px`);
      this.elements.pcmStatus.style.setProperty("--pcm-status-tooltip-top", `${rect.bottom + 8}px`);
    }
    readPcmControls() {
      return {
        sampleRate: Math.max(1, Math.floor(Number(this.elements.pcmSampleRate.value) || 16e3)),
        channels: Math.max(1, Math.floor(Number(this.elements.pcmChannels.value) || 1)),
        bitDepth: Number(this.elements.pcmBitDepth.value),
        sampleFormat: this.elements.pcmSampleFormat.value,
        endianness: this.elements.pcmEndianness.value,
        startOffsetBytes: Math.max(0, Math.floor(Number(this.elements.pcmStartOffset.value) || 0))
      };
    }
    writePcmControls(format) {
      this.elements.pcmSampleRate.value = String(format.sampleRate);
      this.elements.pcmChannels.value = String(format.channels);
      this.elements.pcmStartOffset.value = String(format.startOffsetBytes ?? 0);
      this.elements.pcmBitDepth.value = String(format.bitDepth);
      this.elements.pcmSampleFormat.value = format.sampleFormat;
      this.elements.pcmEndianness.value = format.endianness;
    }
    readWavPcmControls() {
      return {
        sampleRate: Math.max(1, Math.floor(Number(this.elements.wavPcmSampleRate.value) || 16e3)),
        channels: Math.max(1, Math.floor(Number(this.elements.wavPcmChannels.value) || 1)),
        bitDepth: Number(this.elements.wavPcmBitDepth.value),
        sampleFormat: this.elements.wavPcmSampleFormat.value,
        endianness: this.elements.wavPcmEndianness.value,
        startOffsetBytes: Math.max(0, Math.floor(Number(this.elements.wavPcmStartOffset.value) || 0))
      };
    }
    writeWavPcmControls(format) {
      this.elements.wavPcmSampleRate.value = String(format.sampleRate);
      this.elements.wavPcmChannels.value = String(format.channels);
      this.elements.wavPcmStartOffset.value = String(format.startOffsetBytes ?? 0);
      this.elements.wavPcmBitDepth.value = String(format.bitDepth);
      this.elements.wavPcmSampleFormat.value = format.sampleFormat;
      this.elements.wavPcmEndianness.value = format.endianness;
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
    renderTrackList() {
      this.elements.trackList.replaceChildren();
      this.trackViews = [];
      if (!this.audioBuffer) {
        this.elements.trackList.hidden = true;
        return;
      }
      this.elements.trackList.hidden = false;
      for (let channel = 0; channel < this.audioBuffer.numberOfChannels; channel += 1) {
        this.addTrackRow(channel);
      }
      this.renderTrackSelection();
    }
    addTrackRow(channel) {
      const row = document.createElement("div");
      row.className = "trackRow";
      row.dataset.channel = String(channel);
      const sidebar = document.createElement("div");
      sidebar.className = "trackSidebar";
      const title = document.createElement("div");
      title.className = "trackTitle";
      title.textContent = `CH ${channel + 1}`;
      const mute = document.createElement("button");
      mute.type = "button";
      mute.className = "trackToggle trackMute";
      mute.textContent = this.messages.mute;
      const solo = document.createElement("button");
      solo.type = "button";
      solo.className = "trackToggle trackSolo";
      solo.textContent = this.messages.solo;
      const mode = document.createElement("select");
      mode.className = "trackMode";
      this.populateTrackModeOptions(mode);
      mode.value = this.settings.defaultTrackMode;
      sidebar.append(title, mute, solo, mode);
      const body = document.createElement("div");
      body.className = "trackBody";
      const waveformWrap = document.createElement("div");
      waveformWrap.className = "trackCanvasWrap trackWaveformWrap";
      const waveform = document.createElement("canvas");
      waveform.className = "trackWaveform";
      waveform.dataset.channel = String(channel);
      waveformWrap.append(waveform);
      const spectrogramWrap = document.createElement("div");
      spectrogramWrap.className = "trackCanvasWrap trackSpectrogramWrap";
      const spectrogram = document.createElement("canvas");
      spectrogram.className = "trackSpectrogram";
      spectrogram.dataset.channel = String(channel);
      spectrogramWrap.append(spectrogram);
      body.append(waveformWrap, spectrogramWrap);
      row.append(sidebar, body);
      const view = {
        channel,
        row,
        waveform,
        spectrogram,
        mode: this.settings.defaultTrackMode,
        muted: false,
        solo: false
      };
      const select = () => this.selectChannel(channel);
      waveform.addEventListener("click", select);
      spectrogram.addEventListener("click", select);
      mute.addEventListener("click", () => {
        this.toggleMute(view);
      });
      solo.addEventListener("click", () => {
        this.toggleSolo(view);
      });
      mode.addEventListener("change", () => {
        view.mode = mode.value;
        this.applyTrackMode(view);
        this.redrawVisuals();
        this.analyze();
      });
      this.bindFigureInteraction(waveform);
      this.bindFigureInteraction(spectrogram);
      this.elements.trackList.append(row);
      this.trackViews.push(view);
      this.applyTrackMode(view);
    }
    toggleSolo(target) {
      const enabled = !target.solo;
      for (const view of this.trackViews) {
        view.solo = enabled && view === target;
      }
      this.syncAllTrackToggleButtons();
      this.updatePlaybackChannelGains();
    }
    toggleMute(target) {
      target.muted = !target.muted;
      for (const view of this.trackViews) {
        view.solo = false;
      }
      this.syncAllTrackToggleButtons();
      this.updatePlaybackChannelGains();
    }
    syncAllTrackToggleButtons() {
      for (const view of this.trackViews) {
        this.syncTrackToggleButtons(view);
      }
    }
    updateTrackLabels() {
      for (const view of this.trackViews) {
        view.row.querySelector(".trackMute")?.replaceChildren(document.createTextNode(this.messages.mute));
        view.row.querySelector(".trackSolo")?.replaceChildren(document.createTextNode(this.messages.solo));
        const modeSelect = view.row.querySelector(".trackMode");
        if (modeSelect) {
          const value = modeSelect.value;
          this.populateTrackModeOptions(modeSelect);
          modeSelect.value = value;
        }
      }
    }
    populateTrackModeOptions(select) {
      const options = [
        ["both", this.messages.viewBoth],
        ["waveform", this.messages.waveform],
        ["spectrogram", this.messages.spectrogram]
      ];
      select.replaceChildren();
      for (const [value, label] of options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
      }
    }
    syncTrackToggleButtons(view) {
      const hasSolo = this.trackViews.some((item) => item.solo);
      const effectiveMuted = hasSolo ? !view.solo : view.muted;
      view.row.querySelector(".trackSolo")?.classList.toggle("isActive", view.solo);
      view.row.querySelector(".trackMute")?.classList.toggle("isActive", effectiveMuted);
    }
    selectChannel(channel) {
      this.settings.channel = clamp2(channel, 0, Math.max(0, (this.audioBuffer?.numberOfChannels ?? 1) - 1));
      this.elements.channel.value = String(this.settings.channel);
      this.renderTrackSelection();
      this.updateSelectionAnalysis();
      this.redrawVisuals();
      this.analyze();
    }
    renderTrackSelection() {
      this.trackViews.forEach((view) => {
        view.row.classList.toggle("isSelected", view.channel === this.settings.channel);
      });
    }
    applyTrackMode(view) {
      view.row.dataset.mode = view.mode;
    }
    applyDefaultTrackModeToCurrentTracks() {
      for (const view of this.trackViews) {
        view.mode = this.settings.defaultTrackMode;
        const modeSelect = view.row.querySelector(".trackMode");
        if (modeSelect) {
          modeSelect.value = view.mode;
        }
        this.applyTrackMode(view);
      }
      this.redrawVisuals();
      this.analyze();
    }
    samplesForActiveTrack() {
      return this.samplesForChannel(this.settings.channel);
    }
    samplesForChannel(channel) {
      if (!this.audioBuffer) {
        return void 0;
      }
      return this.audioBuffer.getChannelData(clamp2(channel, 0, this.audioBuffer.numberOfChannels - 1));
    }
    redrawVisuals() {
      this.updateResetViewButtonState();
      const range = this.visibleRange();
      this.elements.viewRange.textContent = this.messages.timeLabel;
      this.elements.viewRange.title = `${range.startTime.toFixed(3)}s - ${range.endTime.toFixed(3)}s`;
      this.drawTimeline();
      this.drawTrackVisuals();
      this.updatePersistentSelectionBox();
    }
    drawTimeline() {
      const canvas = this.elements.timeline;
      const context = resizeCanvas(canvas);
      const range = this.visibleRange();
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = canvasBackgroundColor();
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (!this.audioBuffer) {
        return;
      }
      const ratio = window.devicePixelRatio || 1;
      const left = TRACK_AXIS_WIDTH * ratio;
      const right = Math.max(left + 1, canvas.width);
      const rect = { left, top: 0, right, bottom: canvas.height, width: right - left, height: canvas.height };
      context.save();
      context.fillStyle = axisTextColor();
      context.font = axisFont();
      context.textBaseline = "middle";
      const timelineVerticalPadding = 3 * ratio;
      const majorTickHeight = 7 * ratio;
      const labelToTickGap = 5 * ratio;
      const labelHeight = 12 * ratio;
      const availableHeight = Math.max(1, canvas.height - timelineVerticalPadding * 2);
      const rulerHeight = Math.min(availableHeight, labelHeight + labelToTickGap + majorTickHeight);
      const rulerTop = timelineVerticalPadding + Math.max(0, (availableHeight - rulerHeight) / 2);
      const textY = rulerTop + labelHeight / 2;
      const baseline = rulerTop + labelHeight + labelToTickGap + majorTickHeight;
      const visibleDuration = Math.max(1e-3, range.endTime - range.startTime);
      const majorStep = chooseTimelineStep(visibleDuration, rect.width / ratio, 92);
      const minorStep = chooseTimelineMinorStep(majorStep);
      context.strokeStyle = timelineMajorColor();
      context.lineWidth = deviceLineWidth();
      context.beginPath();
      context.moveTo(rect.left, baseline);
      context.lineTo(rect.right, baseline);
      context.stroke();
      const minorStart = Math.ceil(range.startTime / minorStep) * minorStep;
      for (let time = minorStart; time <= range.endTime + minorStep * 0.5; time += minorStep) {
        const x = this.timeToX(time, rect, range);
        const isMajor = isTimelineMajorTick(time, majorStep);
        context.strokeStyle = isMajor ? timelineMajorColor() : timelineMinorColor();
        context.lineWidth = isMajor ? deviceLineWidth() : Math.max(1, deviceLineWidth() * 0.75);
        context.beginPath();
        context.moveTo(x, baseline - (isMajor ? majorTickHeight : 4 * ratio));
        context.lineTo(x, baseline);
        context.stroke();
        if (!isMajor) {
          continue;
        }
        context.fillStyle = axisTextColor();
        context.textAlign = rect.right - x < 40 * ratio ? "right" : "center";
        context.fillText(formatTimelineTick(time, majorStep), x, textY);
      }
      this.drawTimelinePlayhead(context, rect, range);
      context.restore();
    }
    drawTimelinePlayhead(context, rect, range) {
      const playheadTime = this.dragPlayheadTime ?? this.playheadTime;
      if (playheadTime === void 0 || playheadTime < range.startTime || playheadTime > range.endTime) {
        return;
      }
      const x = this.timeToX(playheadTime, rect, range);
      context.strokeStyle = "#ffcc66";
      context.fillStyle = "#ffcc66";
      context.lineWidth = 2 * deviceLineWidth();
      context.beginPath();
      context.moveTo(x, rect.top);
      context.lineTo(x, rect.bottom);
      context.stroke();
    }
    drawTrackVisuals() {
      if (!this.audioBuffer) {
        return;
      }
      for (const view of this.trackViews) {
        if (view.mode !== "spectrogram") {
          this.drawChannelWaveform(view.waveform, view.channel);
        }
        if (view.mode !== "waveform") {
          const cached = this.spectrogramCache.get(this.createSpectrogramCacheKey(view.channel, view.spectrogram));
          if (cached) {
            this.drawSpectrogramCanvas(view.spectrogram, cached);
          } else {
            const last = this.lastSpectrogramByChannel.get(view.channel);
            if (last) {
              this.drawSpectrogramCanvas(view.spectrogram, last);
            } else {
              this.drawEmptySpectrogram(view.spectrogram);
            }
          }
        }
      }
    }
    drawChannelWaveform(canvas, channel) {
      if (!this.audioBuffer) {
        return;
      }
      const samples = this.samplesForChannel(channel);
      if (!samples) {
        return;
      }
      const context = resizeCanvas(canvas);
      const range = this.visibleRange();
      const rect = this.getPlotRect(canvas);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = canvasBackgroundColor();
      context.fillRect(0, 0, canvas.width, canvas.height);
      this.drawPlotFrame(context, rect);
      this.drawWaveformAxis(context, rect);
      const peaks = this.getWaveformPeaks(channel, range.startSample, range.endSample, Math.max(1, Math.floor(rect.width)));
      const mid = rect.top + rect.height / 2;
      context.strokeStyle = "#8cc8ff";
      context.lineWidth = deviceLineWidth();
      context.beginPath();
      for (let i = 0; i < peaks.min.length; i += 1) {
        const min = peaks.min[i] ?? 0;
        const max = peaks.max[i] ?? 0;
        const x = rect.left + i;
        context.moveTo(x, clamp2(mid - min * this.settings.amplitudeZoom * rect.height * WAVEFORM_AMPLITUDE_SCALE, rect.top, rect.bottom));
        context.lineTo(x, clamp2(mid - max * this.settings.amplitudeZoom * rect.height * WAVEFORM_AMPLITUDE_SCALE, rect.top, rect.bottom));
      }
      context.stroke();
      this.drawSelectionOverlay(context, rect, range);
      this.drawPlayheadOverlay(context, rect, range);
    }
    drawEmptySpectrogram(canvas) {
      const context = resizeCanvas(canvas);
      const rect = this.getPlotRect(canvas);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = canvasBackgroundColor();
      context.fillRect(0, 0, canvas.width, canvas.height);
      this.drawPlotFrame(context, rect);
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
      if (this.analysisTimer !== void 0) {
        window.clearTimeout(this.analysisTimer);
        this.analysisTimer = void 0;
      }
      if (this.pendingAnalysisKeys.size > 0) {
        this.resetAnalysisWorker();
        this.pendingAnalysisKeys.clear();
        this.pendingAnalysisTargets.clear();
      }
      const visibleTracks = this.trackViews.filter((view) => view.mode !== "waveform");
      if (visibleTracks.length === 0) {
        return;
      }
      for (const view of visibleTracks) {
        this.analyzeChannel(view);
      }
    }
    analyzeChannel(view) {
      const { startSample, endSample } = this.visibleRange();
      const spectrogramRect = this.getPlotRect(view.spectrogram);
      const targetFrames = Math.max(360, Math.min(1800, Math.floor(spectrogramRect.width / (window.devicePixelRatio || 1))));
      const outputBins = Math.max(192, Math.min(900, Math.floor(spectrogramRect.height / (window.devicePixelRatio || 1))));
      const cacheKey = this.createSpectrogramCacheKey(view.channel, view.spectrogram, outputBins, targetFrames);
      const cached = this.spectrogramCache.get(cacheKey);
      if (cached) {
        this.drawSpectrogramCanvas(view.spectrogram, cached);
        return;
      }
      const samples = this.samplesForChannel(view.channel);
      if (!samples) {
        return;
      }
      const source = samples.slice(startSample, endSample);
      const windowSize = Math.min(this.settings.fftSize, Math.max(1, source.length));
      const hopSize = Math.max(1, Math.floor(Math.max(1, source.length - windowSize) / targetFrames));
      this.pendingAnalysisKeys.add(cacheKey);
      this.pendingAnalysisTargets.set(cacheKey, view.channel);
      this.spectrogramRangeCache.set(cacheKey, { startSample, endSample });
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
    createSpectrogramCacheKey(channel, canvas, outputBins, targetFrames) {
      const rect = this.getPlotRect(canvas);
      const bins = outputBins ?? Math.max(192, Math.min(900, Math.floor(rect.height / (window.devicePixelRatio || 1))));
      const frames = targetFrames ?? Math.max(360, Math.min(1800, Math.floor(rect.width / (window.devicePixelRatio || 1))));
      const { startSample, endSample } = this.visibleRange();
      return createAnalysisCacheKey({
        channel,
        startSample,
        endSample,
        fftSize: this.settings.fftSize,
        windowFunction: this.settings.windowFunction,
        algorithm: this.settings.algorithm,
        zeroPaddingFactor: this.settings.zeroPaddingFactor,
        outputBins: bins,
        targetFrames: frames,
        minDb: this.settings.minDb,
        maxDb: this.settings.maxDb,
        frequencyScale: this.settings.frequencyScale,
        palette: this.settings.palette
      });
    }
    drawSpectrogramResult(result) {
      if (!this.pendingAnalysisKeys.has(result.requestId) && !this.spectrogramCache.has(result.requestId)) {
        return;
      }
      this.spectrogramCache.set(result.requestId, result);
      this.pendingAnalysisKeys.delete(result.requestId);
      const targetChannel = this.pendingAnalysisTargets.get(result.requestId);
      this.pendingAnalysisTargets.delete(result.requestId);
      for (const view of this.trackViews) {
        const key = this.createSpectrogramCacheKey(view.channel, view.spectrogram);
        if (key === result.requestId || view.channel === targetChannel) {
          this.lastSpectrogramByChannel.set(view.channel, result);
          if (view.mode !== "waveform") {
            this.drawSpectrogramCanvas(view.spectrogram, result);
          }
        }
      }
      if (this.pendingAnalysisKeys.size === 0) {
        this.setStatus(this.messages.ready);
      }
    }
    drawSpectrogramCanvas(canvas, result) {
      const context = resizeCanvas(canvas);
      const rect = this.getPlotRect(canvas);
      const bitmap = this.spectrogramBitmapForResult(result);
      if (!bitmap) {
        return;
      }
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = canvasBackgroundColor();
      context.fillRect(0, 0, canvas.width, canvas.height);
      this.drawSpectrogramBitmap(context, bitmap, rect, result);
      this.drawPlotFrame(context, rect);
      this.drawFrequencyAxis(context, rect);
      const range = this.visibleRange();
      this.drawSelectionOverlay(context, rect, range);
      this.drawPlayheadOverlay(context, rect, range);
    }
    drawSpectrogramBitmap(context, bitmap, rect, result) {
      const sourceRange = this.spectrogramRangeCache.get(result.requestId);
      const currentRange = this.visibleRange();
      if (!sourceRange) {
        context.drawImage(bitmap, rect.left, rect.top, rect.width, rect.height);
        return;
      }
      const sourceDuration = Math.max(1, sourceRange.endSample - sourceRange.startSample);
      const currentDuration = Math.max(1, currentRange.endSample - currentRange.startSample);
      const overlapStart = Math.max(sourceRange.startSample, currentRange.startSample);
      const overlapEnd = Math.min(sourceRange.endSample, currentRange.endSample);
      if (overlapEnd <= overlapStart) {
        context.drawImage(bitmap, rect.left, rect.top, rect.width, rect.height);
        return;
      }
      const sourceX = (overlapStart - sourceRange.startSample) / sourceDuration * bitmap.width;
      const sourceWidth = Math.max(1, (overlapEnd - overlapStart) / sourceDuration * bitmap.width);
      const targetX = rect.left + (overlapStart - currentRange.startSample) / currentDuration * rect.width;
      const targetWidth = Math.max(1, (overlapEnd - overlapStart) / currentDuration * rect.width);
      context.drawImage(bitmap, sourceX, 0, sourceWidth, bitmap.height, targetX, rect.top, targetWidth, rect.height);
    }
    spectrogramBitmapForResult(result) {
      const cached = this.spectrogramBitmapCache.get(result.requestId);
      if (cached) {
        return cached;
      }
      const bitmap = document.createElement("canvas");
      bitmap.width = result.width;
      bitmap.height = result.height;
      const bitmapContext = bitmap.getContext("2d", { alpha: false });
      if (!bitmapContext) {
        return void 0;
      }
      const image = new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height);
      bitmapContext.putImageData(image, 0, 0);
      this.spectrogramBitmapCache.set(result.requestId, bitmap);
      return bitmap;
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
      this.elements.status.hidden = !this.shouldShowStatus(message);
    }
    shouldShowStatus(message) {
      return !(!message || message === this.messages.initializing || message === this.messages.ready || message === this.messages.audioLoaded);
    }
    updateResetViewButtonState() {
      const isDirty = Math.abs(this.settings.timeZoom - 1) > 1e-6 || Math.abs(this.settings.timeOffset) > 1e-6 || Math.abs(this.settings.amplitudeZoom - 1) > 1e-6 || Boolean(this.selection);
      this.elements.resetView.classList.toggle("isProminent", isDirty);
    }
    updateGainNode() {
      if (!this.playbackAudioContext) {
        this.playbackAudioContext = new AudioContext();
        this.playbackSourceNode = this.playbackAudioContext.createMediaElementSource(this.elements.audio);
        this.playbackGainNode = this.playbackAudioContext.createGain();
      }
      this.rebuildPlaybackChannelGraph();
      if (this.playbackGainNode) {
        const multiplier = Math.pow(10, this.settings.playbackGain / 20);
        this.playbackGainNode.gain.value = multiplier;
      }
      this.updatePlaybackChannelGains();
    }
    rebuildPlaybackChannelGraph() {
      if (!this.playbackAudioContext || !this.playbackSourceNode || !this.playbackGainNode) {
        return;
      }
      this.playbackSourceNode.disconnect();
      this.playbackSplitterNode?.disconnect();
      this.playbackMergerNode?.disconnect();
      this.playbackGainNode.disconnect();
      for (const gain of this.playbackChannelGains) {
        gain.disconnect();
      }
      if (!this.audioBuffer) {
        this.playbackSourceNode.connect(this.playbackGainNode);
        this.playbackGainNode.connect(this.playbackAudioContext.destination);
        this.playbackChannelGains = [];
        this.playbackSplitterNode = void 0;
        this.playbackMergerNode = void 0;
        return;
      }
      const channels = this.audioBuffer.numberOfChannels;
      this.playbackSplitterNode = this.playbackAudioContext.createChannelSplitter(channels);
      this.playbackMergerNode = this.playbackAudioContext.createChannelMerger(2);
      this.playbackChannelGains = Array.from({ length: channels }, () => this.playbackAudioContext.createGain());
      this.playbackSourceNode.connect(this.playbackSplitterNode);
      this.playbackChannelGains.forEach((gain, channel) => {
        this.playbackSplitterNode?.connect(gain, channel);
        gain.connect(this.playbackMergerNode, 0, 0);
        gain.connect(this.playbackMergerNode, 0, 1);
      });
      this.playbackMergerNode.connect(this.playbackGainNode);
      this.playbackGainNode.connect(this.playbackAudioContext.destination);
    }
    updatePlaybackChannelGains() {
      const hasSolo = this.trackViews.some((view) => view.solo);
      const enabledChannels = this.trackViews.length > 0 ? this.trackViews.filter((view) => hasSolo ? view.solo : !view.muted).length : this.playbackChannelGains.length;
      const channelGain = enabledChannels > 0 ? 1 / enabledChannels : 0;
      this.playbackChannelGains.forEach((gain, channel) => {
        const view = this.trackViews.find((item) => item.channel === channel);
        const enabled = view ? hasSolo ? view.solo : !view.muted : true;
        gain.gain.value = enabled ? channelGain : 0;
      });
    }
    getWaveformPeaks(channel, startSample, endSample, width) {
      const cacheKey = `ch-${channel}:${startSample}:${endSample}:${width}`;
      const cached = this.waveformCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const samples = this.samplesForChannel(channel);
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
        this.isDraggingSelection = true;
        this.selectionPlaybackEnd = void 0;
        startX = event.clientX;
        this.setDragPlayheadFromPointer(canvas, startX);
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
        this.isDraggingSelection = false;
        this.hideSelectionBox();
        if (Math.abs(startX - event.clientX) < MIN_DRAG_PIXELS) {
          this.setPlayheadFromPointer(canvas, event.clientX);
        } else {
          this.setSelectionFromPointer(canvas, startX, event.clientX);
        }
        this.dragPlayheadTime = void 0;
        this.drawTimeline();
      });
      canvas.addEventListener("pointercancel", () => {
        isDragging = false;
        this.isDraggingSelection = false;
        this.dragPlayheadTime = void 0;
        this.hideSelectionBox();
        this.redrawVisuals();
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
      this.dragPlayheadTime = void 0;
      this.elements.audio.currentTime = this.playheadTime;
      this.updateClock();
      this.redrawVisuals();
    }
    setDragPlayheadFromPointer(canvas, clientX) {
      if (!this.audioBuffer) {
        return;
      }
      const time = this.timeFromCanvasX(canvas, clientX);
      this.dragPlayheadTime = clamp2(time, 0, this.audioBuffer.duration);
      this.drawTimeline();
      if (this.elements.audio.paused) {
        this.drawTrackVisuals();
      }
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
      this.dragPlayheadTime = void 0;
      this.selectionPlaybackEnd = this.elements.audio.paused ? void 0 : selection.end;
      this.elements.audio.currentTime = selection.start;
      this.updateClock();
      this.updateSelectionAnalysis();
      this.redrawVisuals();
    }
    updateSelectionBox(canvas, fromX, toX) {
      const canvasRect = canvas.getBoundingClientRect();
      const plot = this.getCssPlotRect(canvas);
      const visiblePlots = this.visibleSelectionPlotRects();
      const from = clamp2(fromX - canvasRect.left, plot.left, plot.right);
      const to = clamp2(toX - canvasRect.left, plot.left, plot.right);
      const top = visiblePlots.length > 0 ? Math.min(...visiblePlots.map((rect) => rect.top)) : canvasRect.top + plot.top;
      const bottom = visiblePlots.length > 0 ? Math.max(...visiblePlots.map((rect) => rect.bottom)) : canvasRect.top + plot.bottom;
      this.elements.selectionBox.hidden = false;
      this.elements.selectionBox.classList.add("isDraggingSelection");
      this.elements.selectionBox.style.left = `${canvasRect.left + Math.min(from, to)}px`;
      this.elements.selectionBox.style.top = `${top}px`;
      this.elements.selectionBox.style.width = `${Math.abs(from - to)}px`;
      this.elements.selectionBox.style.height = `${Math.max(1, bottom - top)}px`;
    }
    updatePersistentSelectionBox() {
      if (this.isDraggingSelection) {
        return;
      }
      if (!this.selection || !this.audioBuffer) {
        this.hideSelectionBox();
        return;
      }
      const anchor = this.firstVisiblePlotCanvas();
      if (!anchor) {
        this.hideSelectionBox();
        return;
      }
      const canvasRect = anchor.getBoundingClientRect();
      const plot = this.getCssPlotRect(anchor);
      const visiblePlots = this.visibleSelectionPlotRects();
      const range = this.visibleRange();
      const start = this.timeToX(this.selection.start, plot, range);
      const end = this.timeToX(this.selection.end, plot, range);
      const left = clamp2(Math.min(start, end), plot.left, plot.right);
      const right = clamp2(Math.max(start, end), plot.left, plot.right);
      if (right <= plot.left || left >= plot.right || right - left < 1 || visiblePlots.length === 0) {
        this.hideSelectionBox();
        return;
      }
      const top = Math.min(...visiblePlots.map((rect) => rect.top));
      const bottom = Math.max(...visiblePlots.map((rect) => rect.bottom));
      this.elements.selectionBox.hidden = false;
      this.elements.selectionBox.classList.remove("isDraggingSelection");
      this.elements.selectionBox.style.left = `${canvasRect.left + left}px`;
      this.elements.selectionBox.style.top = `${top}px`;
      this.elements.selectionBox.style.width = `${right - left}px`;
      this.elements.selectionBox.style.height = `${Math.max(1, bottom - top)}px`;
    }
    firstVisiblePlotCanvas() {
      for (const view of this.trackViews) {
        for (const canvas of [view.waveform, view.spectrogram]) {
          if (canvas.offsetParent !== null && canvas.getBoundingClientRect().width > 0) {
            return canvas;
          }
        }
      }
      return void 0;
    }
    visibleSelectionPlotRects() {
      const rects = [];
      for (const view of this.trackViews) {
        const canvases = [view.waveform, view.spectrogram];
        for (const canvas of canvases) {
          if (canvas.offsetParent === null) {
            continue;
          }
          const canvasRect = canvas.getBoundingClientRect();
          if (canvasRect.width <= 0 || canvasRect.height <= 0) {
            continue;
          }
          const plot = this.getCssPlotRect(canvas);
          rects.push({
            top: canvasRect.top + plot.top,
            bottom: canvasRect.top + plot.bottom
          });
        }
      }
      return rects;
    }
    hideSelectionBox() {
      this.elements.selectionBox.classList.remove("isDraggingSelection");
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
        this.elements.analysisStart.closest(".selectionAnalysisPane")?.setAttribute("hidden", "");
        this.elements.analysisStart.textContent = "--";
        this.elements.analysisEnd.textContent = "--";
        this.elements.analysisDuration.textContent = "--";
        this.elements.analysisRms.textContent = "--";
        this.elements.analysisPeak.textContent = "--";
        this.elements.analysisDominant.textContent = "--";
        this.elements.analysisCrest.textContent = "--";
        this.elements.analysisClipping.textContent = "--";
        this.elements.analysisNoiseFloor.textContent = "--";
        this.elements.analysisCentroid.textContent = "--";
        this.elements.analysisZcr.textContent = "--";
        this.renderFrequencyRows([]);
        return;
      }
      this.elements.analysisStart.closest(".selectionAnalysisPane")?.removeAttribute("hidden");
      const samples = this.samplesForActiveTrack();
      if (!samples) {
        return;
      }
      const startSample = Math.floor(this.selection.start * this.audioBuffer.sampleRate);
      const endSample = Math.min(samples.length, Math.ceil(this.selection.end * this.audioBuffer.sampleRate));
      const timeMetrics = computeTimeSelectionMetrics(samples, startSample, endSample, this.audioBuffer.sampleRate);
      const spectrum = computeSpectrum(samples, startSample, endSample, this.analysisSampleRate(), this.settings.fftSize, this.settings.windowFunction, this.messages);
      this.elements.analysisStart.textContent = `${this.selection.start.toFixed(3)}s`;
      this.elements.analysisEnd.textContent = `${this.selection.end.toFixed(3)}s`;
      this.elements.analysisDuration.textContent = `${(this.selection.end - this.selection.start).toFixed(3)}s`;
      this.elements.analysisRms.textContent = formatDb(amplitudeToDb(timeMetrics.rms));
      this.elements.analysisPeak.textContent = formatDb(amplitudeToDb(timeMetrics.peak));
      this.elements.analysisDominant.textContent = formatHz(spectrum.dominantHz);
      this.elements.analysisCrest.textContent = Number.isFinite(timeMetrics.crestDb) ? `${timeMetrics.crestDb.toFixed(1)} dB` : "--";
      this.elements.analysisClipping.textContent = `${timeMetrics.clippingPercent.toFixed(3)}%`;
      this.elements.analysisNoiseFloor.textContent = formatDb(timeMetrics.noiseFloorDb);
      this.elements.analysisCentroid.textContent = formatHz(spectrum.centroidHz);
      this.elements.analysisZcr.textContent = `${timeMetrics.zeroCrossingRate.toFixed(1)}/s`;
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
      if (canvas.classList.contains("trackWaveform") || canvas.classList.contains("trackSpectrogram")) {
        const ratio2 = window.devicePixelRatio || 1;
        const left2 = TRACK_AXIS_WIDTH * ratio2;
        const top2 = 0;
        const right2 = Math.max(left2 + 1, canvas.width);
        const bottom2 = Math.max(top2 + 1, canvas.height);
        return { left: left2, top: top2, right: right2, bottom: bottom2, width: right2 - left2, height: bottom2 - top2 };
      }
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
      context.strokeStyle = axisFrameColor();
      context.lineWidth = deviceLineWidth();
      context.strokeRect(rect.left, rect.top, rect.width, rect.height);
    }
    drawWaveformAxis(context, rect) {
      context.save();
      context.fillStyle = axisTextColor();
      context.strokeStyle = axisGridColor();
      context.font = axisFont();
      context.textAlign = "right";
      const visibleAmplitude = 0.5 / Math.max(1e-6, this.settings.amplitudeZoom * WAVEFORM_AMPLITUDE_SCALE);
      const mid = rect.top + rect.height / 2;
      for (const { value, y } of [
        { value: visibleAmplitude, y: rect.top },
        { value: 0, y: mid },
        { value: -visibleAmplitude, y: rect.bottom }
      ]) {
        context.beginPath();
        context.moveTo(rect.left, y);
        context.lineTo(rect.right, y);
        context.stroke();
        if (value > 0) {
          context.textBaseline = "top";
          context.fillText(formatAmplitudeAxis(value), rect.left - devicePx(8), rect.top + devicePx(2));
        } else if (value < 0) {
          context.textBaseline = "bottom";
          context.fillText(formatAmplitudeAxis(value), rect.left - devicePx(8), rect.bottom - devicePx(2));
        } else {
          context.textBaseline = "middle";
          context.fillText(formatAmplitudeAxis(value), rect.left - devicePx(8), y);
        }
      }
      context.restore();
    }
    drawFrequencyAxis(context, rect) {
      if (!this.audioBuffer) {
        return;
      }
      context.save();
      context.fillStyle = axisTextColor();
      context.strokeStyle = axisGridColor();
      context.font = axisFont();
      context.textAlign = "right";
      const nyquist = this.analysisSampleRate() / 2;
      const ticks = 5;
      for (let index = 0; index <= ticks; index += 1) {
        const ratio = index / ticks;
        const frequency = frequencyFromRatio(ratio, this.settings.frequencyScale, nyquist);
        const y = rect.bottom - ratio * rect.height;
        context.beginPath();
        context.moveTo(rect.left, y);
        context.lineTo(rect.right, y);
        context.stroke();
        if (index === ticks) {
          context.textBaseline = "top";
          context.fillText(formatAxisHz(frequency), rect.left - devicePx(10), rect.top + devicePx(2));
        } else if (index === 0) {
          context.textBaseline = "bottom";
          context.fillText(formatAxisHz(frequency), rect.left - devicePx(10), rect.bottom - devicePx(2));
        } else {
          context.textBaseline = "middle";
          context.fillText(formatAxisHz(frequency), rect.left - devicePx(10), y);
        }
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
      context.fillRect(left, rect.top, right - left, rect.height);
      context.restore();
    }
    drawPlayheadOverlay(context, rect, range) {
      const playheadTime = this.dragPlayheadTime ?? this.playheadTime;
      if (playheadTime === void 0 || playheadTime < range.startTime || playheadTime > range.endTime) {
        return;
      }
      const x = this.timeToX(playheadTime, rect, range);
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
  async function decodeAudioDataWithTimeout(audioContext, bytes, timeoutMs) {
    let timeoutId;
    try {
      return await Promise.race([
        audioContext.decodeAudioData(toArrayBuffer(bytes)),
        new Promise((_, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error(`decodeAudioData timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId !== void 0) {
        window.clearTimeout(timeoutId);
      }
    }
  }
  function encodeWav(audioBuffer) {
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const frames = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const dataSize = frames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, dataSize, true);
    const channelData = Array.from({ length: channels }, (_, channel) => audioBuffer.getChannelData(channel));
    let offset = 44;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const value = clamp2(channelData[channel][frame] ?? 0, -1, 1);
        view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
        offset += bytesPerSample;
      }
    }
    return buffer;
  }
  function writeAscii(view, offset, value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }
  function axisFont() {
    return `${Math.round(AXIS_FONT_SIZE * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
  }
  function cssColor(name, fallback) {
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    return value || fallback;
  }
  function colorMix(foreground, background, foregroundRatio) {
    const fg = parseCssRgb(foreground);
    const bg = parseCssRgb(background);
    if (!fg || !bg) {
      return foreground;
    }
    const ratio = clamp2(foregroundRatio, 0, 1);
    const red = Math.round(fg.red * ratio + bg.red * (1 - ratio));
    const green = Math.round(fg.green * ratio + bg.green * (1 - ratio));
    const blue = Math.round(fg.blue * ratio + bg.blue * (1 - ratio));
    return `rgb(${red} ${green} ${blue})`;
  }
  function parseCssRgb(value) {
    const trimmed = value.trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
    if (hex) {
      const number = Number.parseInt(hex[1], 16);
      return { red: number >> 16 & 255, green: number >> 8 & 255, blue: number & 255 };
    }
    const rgb = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(trimmed);
    if (rgb) {
      return { red: Number(rgb[1]), green: Number(rgb[2]), blue: Number(rgb[3]) };
    }
    return void 0;
  }
  function canvasBackgroundColor() {
    return cssColor("--vscode-editor-background", "#1e1e1e");
  }
  function axisTextColor() {
    return cssColor("--vscode-descriptionForeground", "#9aa7b4");
  }
  function axisGridColor() {
    return cssColor("--vscode-panel-border", "#25303a");
  }
  function timelineMajorColor() {
    return cssColor("--vscode-descriptionForeground", "#9aa7b4");
  }
  function timelineMinorColor() {
    return colorMix(cssColor("--vscode-descriptionForeground", "#9aa7b4"), cssColor("--vscode-editor-background", "#1e1e1e"), 0.58);
  }
  function axisFrameColor() {
    return cssColor("--vscode-panel-border", "#2d3540");
  }
  function deviceLineWidth() {
    return window.devicePixelRatio || 1;
  }
  function devicePx(value) {
    return value * (window.devicePixelRatio || 1);
  }
  function chooseTimelineStep(duration, widthCssPx, minLabelPx) {
    const targetTicks = Math.max(1, Math.floor(widthCssPx / minLabelPx));
    return niceTimeStep(duration / targetTicks);
  }
  function chooseTimelineMinorStep(majorStep) {
    const exponent = Math.floor(Math.log10(majorStep));
    const base = majorStep / Math.pow(10, exponent);
    const divisions = base === 2 ? 4 : 5;
    return majorStep / divisions;
  }
  function niceTimeStep(rawStep) {
    const safeStep = Math.max(1e-3, rawStep);
    const exponent = Math.floor(Math.log10(safeStep));
    const base = safeStep / Math.pow(10, exponent);
    const niceBase = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
    return niceBase * Math.pow(10, exponent);
  }
  function isTimelineMajorTick(time, majorStep) {
    const nearest = Math.round(time / majorStep) * majorStep;
    return Math.abs(time - nearest) <= majorStep * 1e-4;
  }
  function formatTimelineTick(time, step) {
    if (step >= 10) {
      return `${Math.round(time)}s`;
    }
    if (step >= 1) {
      return `${time.toFixed(1)}s`;
    }
    if (step >= 0.01) {
      return `${time.toFixed(2)}s`;
    }
    return `${time.toFixed(3)}s`;
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
  function formatAxisHz(value) {
    return `${Math.round(value)} Hz`;
  }
  function formatAmplitudeAxis(value) {
    const magnitude = Math.abs(value);
    if (magnitude === 0) {
      return "0.0";
    }
    if (magnitude >= 1) {
      return value.toFixed(1);
    }
    if (magnitude >= 0.1) {
      return value.toFixed(2);
    }
    return value.toFixed(3);
  }
  function formatPcmFormat(format) {
    const sampleFormat = format.sampleFormat === "float" ? "f" : "s";
    const endian = format.endianness === "little" ? "le" : "be";
    const offset = format.startOffsetBytes ? ` \xB7 offset ${format.startOffsetBytes}B` : "";
    return `${format.sampleRate} Hz \xB7 ${format.channels}ch \xB7 ${sampleFormat}${format.bitDepth}${endian}${offset}`;
  }
  function asciiAt(bytes, offset, length) {
    let value = "";
    for (let index = 0; index < length; index += 1) {
      value += String.fromCharCode(bytes[offset + index] ?? 0);
    }
    return value;
  }
  function readUint32Le(bytes, offset) {
    return ((bytes[offset] ?? 0) | (bytes[offset + 1] ?? 0) << 8 | (bytes[offset + 2] ?? 0) << 16 | (bytes[offset + 3] ?? 0) << 24) >>> 0;
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
      return { dominantHz: 0, centroidHz: 0, bands: BAND_LIMITS.map((band) => ({ label: messages18[band.labelKey], percent: 0 })) };
    }
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const window2 = createWindow(windowFunction, fftSize);
    let dominantBin = 1;
    let dominantPower = 0;
    let totalPower = 0;
    let weightedFrequencySum = 0;
    const bandPower = new Float64Array(BAND_LIMITS.length);
    const binPower = new Float64Array(Math.floor(fftSize / 2));
    const hopSize = Math.max(1, Math.floor(fftSize / 2));
    const lastFrameStart = Math.max(0, available - fftSize);
    let relativeStart = 0;
    while (relativeStart <= lastFrameStart) {
      const offset = startSample + relativeStart;
      im.fill(0);
      for (let index = 0; index < fftSize; index += 1) {
        re[index] = (samples[offset + index] ?? 0) * window2[index];
      }
      fft(re, im);
      for (let bin = 1; bin < fftSize / 2; bin += 1) {
        const power = re[bin] * re[bin] + im[bin] * im[bin];
        const frequency = bin * sampleRate / fftSize;
        totalPower += power;
        weightedFrequencySum += frequency * power;
        binPower[bin] += power;
        const bandIndex = BAND_LIMITS.findIndex((band) => frequency >= band.min && frequency < band.max);
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
    return {
      dominantHz: dominantBin * sampleRate / fftSize,
      centroidHz: totalPower <= 0 ? 0 : weightedFrequencySum / totalPower,
      bands: BAND_LIMITS.map((band, index) => ({
        label: messages18[band.labelKey],
        percent: totalPower <= 0 ? 0 : bandPower[index] / totalPower * 100
      }))
    };
  }
  function computeTimeSelectionMetrics(samples, startSample, endSample, sampleRate) {
    const count = Math.max(0, endSample - startSample);
    if (count <= 0) {
      return { rms: 0, peak: 0, crestDb: Number.NaN, clippingPercent: 0, noiseFloorDb: amplitudeToDb(0), zeroCrossingRate: 0 };
    }
    const stride = Math.max(1, Math.ceil(count / 2e6));
    let sumSquares = 0;
    let peak = 0;
    let clipped = 0;
    let zeroCrossings = 0;
    let measured = 0;
    let previousSign = 0;
    for (let index = startSample; index < endSample; index += stride) {
      const value = samples[index] ?? 0;
      const abs = Math.abs(value);
      const sign = value > 0 ? 1 : value < 0 ? -1 : previousSign;
      sumSquares += value * value;
      peak = Math.max(peak, abs);
      if (abs >= 0.999) {
        clipped += 1;
      }
      if (previousSign !== 0 && sign !== 0 && sign !== previousSign) {
        zeroCrossings += 1;
      }
      if (sign !== 0) {
        previousSign = sign;
      }
      measured += 1;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, measured));
    const peakDb = amplitudeToDb(peak);
    const rmsDb = amplitudeToDb(rms);
    const durationSeconds = count / Math.max(1, sampleRate);
    return {
      rms,
      peak,
      crestDb: rms <= 0 ? Number.NaN : peakDb - rmsDb,
      clippingPercent: clipped / Math.max(1, measured) * 100,
      noiseFloorDb: computeNoiseFloorDb(samples, startSample, endSample, sampleRate),
      zeroCrossingRate: zeroCrossings / Math.max(1e-9, durationSeconds)
    };
  }
  function computeNoiseFloorDb(samples, startSample, endSample, sampleRate) {
    const count = Math.max(0, endSample - startSample);
    if (count <= 0) {
      return amplitudeToDb(0);
    }
    const windowSize = Math.max(32, Math.floor(sampleRate * 0.02));
    const hopSize = Math.max(1, Math.floor(windowSize / 2));
    if (count < windowSize) {
      let sumSquares = 0;
      for (let index = startSample; index < endSample; index += 1) {
        const value = samples[index] ?? 0;
        sumSquares += value * value;
      }
      return amplitudeToDb(Math.sqrt(sumSquares / Math.max(1, count)));
    }
    const lastFrameStart = count - windowSize;
    const maxFrames = 4096;
    const frameStride = Math.max(hopSize, Math.ceil((lastFrameStart + 1) / maxFrames));
    const rmsValues = [];
    let relativeStart = 0;
    while (relativeStart <= lastFrameStart) {
      const offset = startSample + relativeStart;
      let sumSquares = 0;
      for (let index = 0; index < windowSize; index += 1) {
        const value = samples[offset + index] ?? 0;
        sumSquares += value * value;
      }
      rmsValues.push(Math.sqrt(sumSquares / windowSize));
      if (relativeStart === lastFrameStart) {
        break;
      }
      relativeStart = Math.min(relativeStart + frameStride, lastFrameStart);
    }
    rmsValues.sort((a, b) => a - b);
    const percentileIndex = Math.min(rmsValues.length - 1, Math.max(0, Math.floor((rmsValues.length - 1) * 0.1)));
    return amplitudeToDb(rmsValues[percentileIndex] ?? 0);
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
    .topbar {
      flex-wrap: wrap;
    }
    .identity {
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex: 1;
    }
    .gainControl {
      position: relative;
      display: grid;
      grid-template-columns: 6ch 80px;
      grid-template-rows: 14px 22px;
      align-items: center;
      column-gap: 8px;
      row-gap: 2px;
      margin-right: 8px;
    }
    .gainControl::after {
      content: attr(data-tooltip);
      position: absolute;
      z-index: 40;
      top: calc(100% + 8px);
      right: 0;
      width: max-content;
      max-width: min(280px, calc(100vw - 24px));
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 8px 22px rgb(0 0 0 / 24%);
      font-size: 12px;
      line-height: 1.35;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity 90ms ease, transform 90ms ease;
    }
    .gainControl:hover::after,
    .gainControl:has(:focus-visible)::after {
      opacity: 1;
      transform: translateY(0);
    }
    .gainTitle {
      grid-column: 1 / -1;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1;
      text-align: center;
      white-space: nowrap;
    }
    .gainLabel {
      font-variant-numeric: tabular-nums;
      flex: 0 0 6ch;
      width: 6ch;
      text-align: right;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .gainSlider {
      width: 80px;
      margin: 0;
    }
    .gainSlider:focus,
    .gainSlider:focus-visible {
      outline: none;
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
      display: grid;
      gap: 0;
    }
    .trackRow {
      position: relative;
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      min-height: 280px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .trackRow:first-child {
      margin-top: -1px;
    }
    .trackRow + .trackRow {
      margin-top: -1px;
    }
    .trackRow[data-mode="waveform"] {
      min-height: 132px;
    }
    .trackRow[data-mode="spectrogram"] {
      min-height: 220px;
    }
    .trackRow.isSelected {
      z-index: 2;
      border-color: var(--vscode-focusBorder);
      border-radius: 6px;
    }
    .trackSidebar {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      padding: 8px;
      border: 0;
      border-right: 1px solid var(--vscode-panel-border);
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
    .trackBody,
    .trackCanvasWrap {
      background: var(--vscode-editor-background);
    }
    .trackBody {
      display: grid;
      grid-template-rows: minmax(90px, 0.38fr) minmax(160px, 0.62fr);
      min-width: 0;
      min-height: 0;
      gap: 0;
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
    .topPcmPanel {
      flex: 1 1 620px;
      min-width: min(560px, 100%);
      max-width: 100%;
      overflow: visible;
    }
    .topPcmPanel .paneTitle {
      align-self: center;
      white-space: nowrap;
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
    .topPcmPanel #pcmBitDepth {
      width: 6ch;
    }
    .topPcmPanel #pcmSampleFormat {
      width: 8ch;
    }
    .topPcmPanel #pcmEndianness {
      width: 6ch;
    }
    .topPcmPanel #pcmStatus {
      position: relative;
      align-self: center;
      flex: 1 1 140px;
      min-width: 0;
      max-width: 260px;
      white-space: nowrap;
      overflow: visible;
      line-height: 1.3;
    }
    .topPcmPanel #pcmStatusText {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
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
    root.textContent = `AudioLens initialization failed: ${message}`;
    vscode.postMessage({ type: "showError", message: `AudioLens initialization failed: ${message}` });
  }
})();
