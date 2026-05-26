import {
  DEFAULT_CHUNK_SIZE,
  ExtensionMessage,
  AudioLensConfig,
  AudioLensPreferences,
  SpectrogramAlgorithm,
  WebviewMessage,
  WindowFunction
} from "../shared/protocol";
import {
  createAnalysisCacheKey,
  computeWaveformPeaks,
  FrequencyScale,
  getVisibleRange,
  normalizeDbRange,
  SpectrogramPalette,
  WaveformPeaks
} from "../shared/analysis";
import { createAnalysisWorker, SpectrogramResult } from "./analysisWorker";
import { readAudioFileFacts } from "./audioFacts";
import { clamp, formatBytes, formatTime, guessMime, resizeCanvas } from "./dom";
import { getMessages, resolveLocale } from "./i18n";
import { LocaleMessages, LocaleSetting } from "./i18n/types";
import {
  createAudioBufferFromChannels,
  decodePcm,
  PcmEndianness,
  PcmFormat,
  PcmSampleFormat,
  validatePcmFormat
} from "./pcm";
import { applyLocale, ViewElements } from "./view";

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface AnalysisSettings {
  algorithm: SpectrogramAlgorithm;
  defaultTrackMode: "both" | "waveform" | "spectrogram";
  windowFunction: WindowFunction;
  fftSize: number;
  zeroPaddingFactor: number;
  channel: number;
  minDb: number;
  maxDb: number;
  autoBrightness: boolean;
  amplitudeZoom: number;
  timeZoom: number;
  timeOffset: number;
  frequencyScale: FrequencyScale;
  palette: SpectrogramPalette;
  playbackGain: number;
}

interface AudioFileMetadata {
  fileName: string;
  uri: string;
  size: number;
  trusted: boolean;
  extension: string;
  kind: "encoded" | "pcm";
}

interface TimeSelectionState {
  start: number;
  end: number;
}

interface SpectrogramRangeState {
  startSample: number;
  endSample: number;
}

interface PlotRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface VisibleRangeState {
  startSample: number;
  endSample: number;
  startTime: number;
  endTime: number;
}

type TrackViewMode = "waveform" | "spectrogram" | "both";

interface TrackView {
  channel: number;
  row: HTMLElement;
  waveform: HTMLCanvasElement;
  spectrogram: HTMLCanvasElement;
  mode: TrackViewMode;
  muted: boolean;
  solo: boolean;
}

const MIN_DRAG_PIXELS = 6;
const ENCODED_DECODE_TIMEOUT_MS = 8000;
const PLOT_MARGIN = { left: 78, top: 18, right: 18, bottom: 40 };
const TRACK_AXIS_WIDTH = 96;
const AXIS_FONT_SIZE = 13;
const WAVEFORM_AMPLITUDE_SCALE = 0.45;
const PLOT_HEIGHT_LIMITS = { waveformMin: 160, waveformMax: 520, spectrogramMin: 220, spectrogramMax: 860 };
const BAND_LIMITS = [
  { labelKey: "frequencyBand0To250", min: 0, max: 250 },
  { labelKey: "frequencyBand250To500", min: 250, max: 500 },
  { labelKey: "frequencyBand500To1k", min: 500, max: 1000 },
  { labelKey: "frequencyBand1To2k", min: 1000, max: 2000 },
  { labelKey: "frequencyBand2To4k", min: 2000, max: 4000 },
  { labelKey: "frequencyBand4To8k", min: 4000, max: 8000 },
  { labelKey: "frequencyBand8kPlus", min: 8000, max: Number.POSITIVE_INFINITY }
] satisfies Array<{ labelKey: keyof LocaleMessages; min: number; max: number }>;

export class AudioLensApp {
  private config: AudioLensConfig | undefined;
  private audioBuffer: AudioBuffer | undefined;
  private audioBytes: Uint8Array | undefined;
  private trackViews: TrackView[] = [];
  private defaultPcmFormat: PcmFormat | undefined;
  private currentFileName = "";
  private objectUrl: string | undefined;
  private requestSeq = 1;
  private pendingAnalysisKeys = new Set<string>();
  private playheadTime: number | undefined;
  private dragPlayheadTime: number | undefined;
  private sourceSampleRate: number | undefined;
  private selection: TimeSelectionState | undefined;
  private selectionPlaybackEnd: number | undefined;
  private isDraggingSelection = false;
  private playbackFrameId: number | undefined;
  private preferencesSaveTimer: number | undefined;
  private analysisTimer: number | undefined;
  private playbackAudioContext: AudioContext | undefined;
  private playbackGainNode: GainNode | undefined;
  private playbackSourceNode: MediaElementAudioSourceNode | undefined;
  private playbackSplitterNode: ChannelSplitterNode | undefined;
  private playbackMergerNode: ChannelMergerNode | undefined;
  private playbackChannelGains: GainNode[] = [];
  private readonly pendingChunks = new Map<number, (message: Extract<ExtensionMessage, { type: "chunk" }>) => void>();
  private readonly pendingTranscodes = new Map<number, {
    resolve: (message: Extract<ExtensionMessage, { type: "transcodedAudio" }>) => void;
    reject: (error: Error) => void;
  }>();
  private readonly pendingAnalysisTargets = new Map<string, number>();
  private readonly spectrogramCache = new Map<string, SpectrogramResult>();
  private readonly spectrogramBitmapCache = new Map<string, HTMLCanvasElement>();
  private readonly spectrogramRangeCache = new Map<string, SpectrogramRangeState>();
  private readonly lastSpectrogramByChannel = new Map<number, SpectrogramResult>();
  private readonly waveformCache = new Map<string, WaveformPeaks>();
  private worker = createAnalysisWorker();
  private messages = getMessages("en");
  private readonly settings: AnalysisSettings = {
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

  public constructor(
    private readonly vscode: VsCodeApi,
    private readonly elements: ViewElements
  ) {
    this.syncPlatformShortcuts();
    this.bindUi();
    this.updateSelectionAnalysis();
    this.bindWorker();
  }

  public async handleMessage(message: ExtensionMessage): Promise<void> {
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

  private bindWorker(): void {
    this.worker.addEventListener("message", (event: MessageEvent<SpectrogramResult>) => {
      this.drawSpectrogramResult(event.data);
    });
  }

  private syncPlatformShortcuts(): void {
    const timeZoomModifier = isMacPlatform() ? "⌘" : "Ctrl";
    const amplitudeZoomModifier = isMacPlatform() ? "⌥" : "Alt";
    const commandModifier = isMacPlatform() ? "⌘" : "Ctrl";
    document.querySelectorAll<HTMLElement>("[data-time-zoom-modifier]").forEach((element) => {
      element.textContent = timeZoomModifier;
    });
    document.querySelectorAll<HTMLElement>("[data-amplitude-zoom-modifier]").forEach((element) => {
      element.textContent = amplitudeZoomModifier;
    });
    document.querySelectorAll<HTMLElement>("[data-command-modifier]").forEach((element) => {
      element.textContent = commandModifier;
    });
  }

  private applyLanguage(config: AudioLensConfig): void {
    const locale = resolveLocale(config.language as LocaleSetting, config.vscodeLanguage);
    this.messages = getMessages(locale);
    applyLocale(document, this.messages);
    this.updateResetViewButtonState();
    this.updateTrackLabels();
    this.redrawVisuals();
  }

  private resetAnalysisWorker(): void {
    this.worker.terminate();
    this.worker = createAnalysisWorker();
    this.bindWorker();
  }

  private clearDecodedAudio(): void {
    this.audioBuffer = undefined;
    this.sourceSampleRate = undefined;
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

  private clearAudioElement(): void {
    this.elements.audio.pause();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
    this.elements.audio.removeAttribute("src");
    this.elements.audio.load();
  }

  private async load(metadata: AudioFileMetadata): Promise<void> {
    this.currentFileName = metadata.fileName;
    this.elements.fileMeta.textContent = `${metadata.fileName} · ${formatBytes(metadata.size)}`;

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
        this.selection = undefined;
        this.playheadTime = undefined;
        this.dragPlayheadTime = undefined;
        this.selectionPlaybackEnd = undefined;
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
    this.selection = undefined;
    this.playheadTime = undefined;
    this.dragPlayheadTime = undefined;
    this.selectionPlaybackEnd = undefined;
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

  private async loadEncoded(fileName: string): Promise<void> {
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
      await audioContext.close().catch(() => undefined);
      await this.loadEncodedViaFfmpeg(fileName);
      return;
    } finally {
      await audioContext.close().catch(() => undefined);
    }
  }

  private async loadEncodedViaFfmpeg(fileName: string): Promise<void> {
    this.setStatus(this.messages.transcodingAudio);
    try {
      const bytes = await this.requestTranscodedAudio();
      const audioContext = new AudioContext();
      try {
        this.audioBuffer = await decodeAudioDataWithTimeout(audioContext, bytes, ENCODED_DECODE_TIMEOUT_MS);
        this.sourceSampleRate = this.audioBuffer.sampleRate;
      } finally {
        await audioContext.close().catch(() => undefined);
      }
      this.installAudioElementFromBytes(`${fileName}.wav`, bytes, "audio/wav");
    } catch (error) {
      console.warn("AudioLens FFmpeg fallback failed:", error);
      this.clearDecodedAudio();
      const detail = error instanceof Error ? error.message : String(error);
      this.setStatus(`${this.messages.encodedPlaybackOnly} ${detail}`);
    }
  }

  private async loadPcm(_metadata: AudioFileMetadata): Promise<boolean> {
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

  private bindUi(): void {
    this.elements.play.addEventListener("click", () => {
      void this.togglePlayback();
    });
    this.elements.downloadAudio.addEventListener("click", () => {
      this.downloadCurrentAudio();
    });
    this.elements.audio.addEventListener("play", () => {
      this.elements.play.textContent = "⏸";
      this.startPlaybackTicker();
    });
    this.elements.audio.addEventListener("pause", () => {
      this.elements.play.textContent = "▶";
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
      this.syncPlaybackState({ redraw: this.playbackFrameId === undefined });
    });
    this.elements.seek.addEventListener("input", () => {
      if (!Number.isNaN(this.elements.audio.duration)) {
        this.selectionPlaybackEnd = undefined;
        this.playheadTime = (Number(this.elements.seek.value) / 1000) * this.elements.audio.duration;
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
      this.settings.algorithm = this.elements.algorithm.value as SpectrogramAlgorithm;
      this.savePreferencesSoon();
      this.analyze();
    });
    this.elements.defaultTrackMode.addEventListener("change", () => {
      this.settings.defaultTrackMode = this.elements.defaultTrackMode.value as TrackViewMode;
      this.applyDefaultTrackModeToCurrentTracks();
      this.savePreferencesSoon();
    });
    this.elements.windowFunction.addEventListener("change", () => {
      this.settings.windowFunction = this.elements.windowFunction.value as WindowFunction;
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
      this.settings.frequencyScale = this.elements.frequencyScale.value as FrequencyScale;
      this.savePreferencesSoon();
      this.analyze();
    });
    this.elements.palette.addEventListener("change", () => {
      this.settings.palette = this.elements.palette.value as SpectrogramPalette;
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

  private async togglePlayback(): Promise<void> {
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
        this.selectionPlaybackEnd = undefined;
        this.elements.audio.pause();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportPlaybackError(message);
    }
  }

  private preparePlaybackStart(): void {
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
    if (this.playheadTime === undefined) {
      this.elements.audio.currentTime = 0;
      this.playheadTime = 0;
      this.redrawVisuals();
      return;
    }
    this.elements.audio.currentTime = clamp(this.playheadTime, 0, this.audioBuffer.duration);
  }

  private startPlaybackTicker(): void {
    if (this.playbackFrameId !== undefined) {
      return;
    }

    const tick = () => {
      this.syncPlaybackState({ redraw: true });
      if (!this.elements.audio.paused) {
        this.playbackFrameId = requestAnimationFrame(tick);
      } else {
        this.playbackFrameId = undefined;
      }
    };
    this.playbackFrameId = requestAnimationFrame(tick);
  }

  private stopPlaybackTicker(): void {
    if (this.playbackFrameId === undefined) {
      return;
    }
    cancelAnimationFrame(this.playbackFrameId);
    this.playbackFrameId = undefined;
  }

  private syncPlaybackState(options: { redraw: boolean }): void {
    const audio = this.elements.audio;
    if (this.selectionPlaybackEnd !== undefined && audio.currentTime >= this.selectionPlaybackEnd) {
      const end = this.selectionPlaybackEnd;
      this.selectionPlaybackEnd = undefined;
      audio.pause();
      audio.currentTime = end;
      this.playheadTime = end;
    } else {
      this.playheadTime = audio.currentTime;
    }

    this.updateClock();
    if (!Number.isNaN(audio.duration) && audio.duration > 0) {
      this.elements.seek.value = String((audio.currentTime / audio.duration) * 1000);
    }
    this.followPlayheadDuringPlayback();
    if (options.redraw) {
      this.redrawVisuals();
    }
  }

  private followPlayheadDuringPlayback(): void {
    if (!this.audioBuffer || this.playheadTime === undefined || this.elements.audio.paused) {
      return;
    }
    const range = this.visibleRange();
    const duration = this.audioBuffer.duration;
    const viewDuration = range.endTime - range.startTime;
    if (viewDuration <= 0 || viewDuration >= duration) {
      return;
    }
    const margin = viewDuration * 0.12;
    if (this.playheadTime <= range.endTime - margin && this.playheadTime >= range.startTime + margin) {
      return;
    }
    const maxStart = Math.max(0, duration - viewDuration);
    const targetStart = clamp(this.playheadTime - viewDuration * 0.78, 0, maxStart);
    this.settings.timeOffset = maxStart === 0 ? 0 : targetStart / maxStart;
    this.syncControls();
    this.scheduleAnalyze(0);
  }

  private onKeyDown(event: KeyboardEvent): void {
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

  private handleEscape(): void {
    if (!this.elements.settingsPanel.hidden) {
      this.elements.settingsPanel.hidden = true;
      this.elements.settingsToggle.focus();
      return;
    }
    if (this.helpMenuElement().open) {
      this.helpMenuElement().open = false;
      this.elements.helpMenu.querySelector<HTMLElement>("summary")?.focus();
      return;
    }
    if (this.selection) {
      this.selection = undefined;
      this.selectionPlaybackEnd = undefined;
      this.updateSelectionAnalysis();
      this.redrawVisuals();
      return;
    }
    this.elements.audio.pause();
    this.elements.audio.currentTime = 0;
    this.playheadTime = undefined;
    this.dragPlayheadTime = undefined;
    this.selectionPlaybackEnd = undefined;
    this.elements.seek.value = "0";
    this.updateClock();
    this.redrawVisuals();
  }

  private closeFloatingMenusFromPointer(event: PointerEvent): void {
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
    if (
      !this.elements.wavPcmPanel.hidden &&
      !this.elements.wavPcmPanel.contains(target) &&
      !this.elements.pcmReveal.contains(target)
    ) {
      this.hideWavPcmPanel();
    }
  }

  private helpMenuElement(): HTMLDetailsElement {
    return this.elements.helpMenu as HTMLDetailsElement;
  }

  private bindAnalysisTooltips(): void {
    document.querySelectorAll<HTMLElement>(".analysisHelp, .metricHelp").forEach((trigger) => {
      trigger.addEventListener("mouseenter", () => this.showFloatingTooltip(trigger));
      trigger.addEventListener("focusin", () => this.showFloatingTooltip(trigger));
      trigger.addEventListener("mouseleave", () => this.hideFloatingTooltip());
      trigger.addEventListener("focusout", () => this.hideFloatingTooltip());
    });
  }

  private showFloatingTooltip(trigger: HTMLElement): void {
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
    const left = clamp(triggerRect.left - tooltipWidth - 10, margin, Math.max(margin, window.innerWidth - tooltipWidth - margin));
    const preferredTop = triggerRect.top + triggerRect.height * 0.45 - tooltipRect.height * 0.45;
    const top = clamp(preferredTop, margin, Math.max(margin, window.innerHeight - tooltipRect.height - margin));
    tooltip.style.width = `${tooltipWidth}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  private hideFloatingTooltip(): void {
    this.elements.floatingTooltip.hidden = true;
  }

  private reportPlaybackError(message: string): void {
    const detail = `${this.messages.playbackFailed}: ${message}`;
    this.setStatus(detail);
    this.vscode.postMessage({ type: "showError", message: detail });
  }

  private downloadCurrentAudio(): void {
    if (!this.currentFileName) {
      this.reportPlaybackError(this.messages.audioNotReady);
      return;
    }
    this.vscode.postMessage({ type: "downloadAudio" });
  }

  private syncControls(): void {
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

  private analysisInputs(): HTMLInputElement[] {
    return [
      this.elements.timeZoom,
      this.elements.timeOffset,
      this.elements.amplitudeZoom,
      this.elements.minDb,
      this.elements.maxDb
    ];
  }

  private updateAnalysisSettings(): void {
    this.settings.timeZoom = clamp(Number(this.elements.timeZoom.value), 1, 64);
    this.settings.timeOffset = clamp(Number(this.elements.timeOffset.value), 0, 1);
    this.settings.amplitudeZoom = clamp(Number(this.elements.amplitudeZoom.value), 0.25, 32);
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

  private applyPreferences(preferences: AudioLensPreferences): void {
    if (preferences.algorithm) {
      this.settings.algorithm = preferences.algorithm as SpectrogramAlgorithm;
    }
    if (preferences.defaultTrackMode) {
      this.settings.defaultTrackMode = preferences.defaultTrackMode;
    }
    if (preferences.windowFunction) {
      this.settings.windowFunction = preferences.windowFunction as WindowFunction;
    }
    if (preferences.fftSize) {
      this.settings.fftSize = preferences.fftSize;
    }
    if (preferences.zeroPaddingFactor) {
      this.settings.zeroPaddingFactor = preferences.zeroPaddingFactor;
    }
    if (preferences.frequencyScale) {
      this.settings.frequencyScale = preferences.frequencyScale as FrequencyScale;
    }
    if (preferences.palette) {
      this.settings.palette = preferences.palette as SpectrogramPalette;
    }
    if (preferences.minDb !== undefined && preferences.maxDb !== undefined) {
      const range = normalizeDbRange(preferences.minDb, preferences.maxDb);
      this.settings.minDb = range.minDb;
      this.settings.maxDb = range.maxDb;
    }
    if (preferences.autoBrightness !== undefined) {
      this.settings.autoBrightness = preferences.autoBrightness;
    }
    if (preferences.waveformHeight !== undefined) {
      this.setPlotHeight("--waveform-height", preferences.waveformHeight, PLOT_HEIGHT_LIMITS.waveformMin, PLOT_HEIGHT_LIMITS.waveformMax);
    }
    if (preferences.spectrogramHeight !== undefined) {
      this.setPlotHeight("--spectrogram-height", preferences.spectrogramHeight, PLOT_HEIGHT_LIMITS.spectrogramMin, PLOT_HEIGHT_LIMITS.spectrogramMax);
    }
    if (preferences.defaultPcmFormat) {
      this.defaultPcmFormat = preferences.defaultPcmFormat as PcmFormat;
    }
  }

  private savePreferencesSoon(): void {
    if (this.preferencesSaveTimer !== undefined) {
      window.clearTimeout(this.preferencesSaveTimer);
    }
    this.preferencesSaveTimer = window.setTimeout(() => {
      this.preferencesSaveTimer = undefined;
      this.vscode.postMessage({ type: "updatePreferences", preferences: this.collectPreferences() });
    }, 180);
  }

  private collectPreferences(): AudioLensPreferences {
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

  private applyAutoBrightness(): void {
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

  private computeAutoDbRange(): { minDb: number; maxDb: number } {
    if (!this.audioBuffer) {
      return { minDb: -96, maxDb: 0 };
    }
    const stride = Math.max(1, Math.ceil(this.audioBuffer.length / 2_000_000));
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

  private applyAutoAmplitudeZoom(): void {
    const peak = this.computeAudioPeak();
    if (peak <= 1e-6) {
      this.settings.amplitudeZoom = 1;
      return;
    }
    const target = peak < 0.95 ? 0.95 : 1.05;
    this.settings.amplitudeZoom = clamp(target / peak, 0.25, 32);
  }

  private computeAudioPeak(): number {
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

  private resetView(): void {
    this.settings.timeZoom = 1;
    this.settings.timeOffset = 0;
    this.applyAutoAmplitudeZoom();
    this.selection = undefined;
    this.selectionPlaybackEnd = undefined;
    this.hideSelectionBox();
    this.syncControls();
    this.savePreferencesSoon();
    this.updateSelectionAnalysis();
    this.redrawVisuals();
    this.analyze();
  }

  private resetTimeZoom(): void {
    this.settings.timeZoom = 1;
    this.settings.timeOffset = 0;
    this.syncControls();
    this.savePreferencesSoon();
    this.redrawVisuals();
    this.analyze();
  }

  private resolveChunk(message: Extract<ExtensionMessage, { type: "chunk" }>): void {
    const resolve = this.pendingChunks.get(message.requestId);
    if (!resolve) {
      return;
    }
    this.pendingChunks.delete(message.requestId);
    resolve(message);
  }

  private resolveTranscode(message: Extract<ExtensionMessage, { type: "transcodedAudio" }>): void {
    const pending = this.pendingTranscodes.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pendingTranscodes.delete(message.requestId);
    pending.resolve(message);
  }

  private rejectTranscode(message: Extract<ExtensionMessage, { type: "transcodeError" }>): void {
    const pending = this.pendingTranscodes.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pendingTranscodes.delete(message.requestId);
    pending.reject(new Error(message.message));
  }

  private async readAll(size: number): Promise<Uint8Array> {
    const target = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(DEFAULT_CHUNK_SIZE, size - offset);
      const requestId = this.requestSeq;
      this.requestSeq += 1;
      const chunk = await new Promise<Extract<ExtensionMessage, { type: "chunk" }>>((resolve) => {
        this.pendingChunks.set(requestId, resolve);
        this.vscode.postMessage({ type: "readChunk", requestId, offset, length });
      });
      const bytes = new Uint8Array(chunk.bytes);
      target.set(bytes, offset);
      offset += bytes.byteLength;
      this.setStatus(`${this.messages.readingAudioProgress} ${Math.round((offset / size) * 100)}%`);
    }
    return target;
  }

  private async requestTranscodedAudio(): Promise<Uint8Array> {
    const requestId = this.requestSeq;
    this.requestSeq += 1;
    const message = await new Promise<Extract<ExtensionMessage, { type: "transcodedAudio" }>>((resolve, reject) => {
      this.pendingTranscodes.set(requestId, { resolve, reject });
      this.vscode.postMessage({ type: "transcodeAudio", requestId });
    });
    return new Uint8Array(message.bytes);
  }

  private installAudioElementFromBytes(fileName: string, bytes = this.audioBytes, mime = guessMime(fileName)): void {
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

  private installAudioElementFromBuffer(fileName: string): void {
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
    this.elements.fileMeta.textContent = `${fileName} · ${this.audioBuffer.numberOfChannels}ch · ${this.audioBuffer.sampleRate} Hz`;
  }

  private async applyPcmFormat(format: PcmFormat, statusElement = this.elements.pcmStatus): Promise<void> {
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
    this.selection = undefined;
    this.selectionPlaybackEnd = undefined;
    this.playheadTime = undefined;
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

  private showWavPcmPanel(): void {
    if (!this.audioBytes) {
      return;
    }
    this.elements.wavPcmPanel.hidden = false;
    this.elements.pcmReveal.hidden = true;
    this.writeWavPcmControls(this.suggestPcmFormatForCurrentFile());
    this.setPcmStatus(this.elements.wavPcmStatus, this.messages.wavPcmFillParams);
    this.positionWavPcmPanel();
  }

  private async applyWavPcmFormat(): Promise<void> {
    await this.applyPcmFormat(this.readWavPcmControls(), this.elements.wavPcmStatus);
    if (this.elements.wavPcmStatus.textContent?.startsWith(`${this.messages.currentPcmFormat}:`)) {
      this.hideWavPcmPanel();
    }
  }

  private hideWavPcmPanel(): void {
    this.elements.wavPcmPanel.hidden = true;
    this.elements.pcmReveal.hidden = false;
  }

  private positionWavPcmPanel(): void {
    const anchor = this.elements.pcmReveal.getBoundingClientRect();
    const panel = this.elements.wavPcmPanel;
    const margin = 12;
    const panelWidth = Math.min(520, window.innerWidth - margin * 2);
    const left = clamp(anchor.left, margin, Math.max(margin, window.innerWidth - panelWidth - margin));
    panel.style.width = `${panelWidth}px`;
    panel.style.left = `${left}px`;
    panel.style.top = `${anchor.bottom + 8}px`;
  }

  private suggestPcmFormatForCurrentFile(): PcmFormat {
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

  private findWaveDataOffset(): number | undefined {
    const bytes = this.audioBytes;
    if (!bytes || bytes.byteLength < 12 || asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "WAVE") {
      return undefined;
    }

    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const chunkId = asciiAt(bytes, offset, 4);
      const chunkSize = readUint32Le(bytes, offset + 4);
      const payloadOffset = offset + 8;
      if (chunkId === "data") {
        return payloadOffset;
      }
      offset = payloadOffset + chunkSize + (chunkSize % 2);
    }
    return undefined;
  }

  private saveDefaultPcmFormat(): void {
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

  private setPcmStatus(element: HTMLElement, message: string): void {
    if (element === this.elements.pcmStatus) {
      this.elements.pcmStatusText.textContent = message;
      this.positionPcmStatusTooltip();
    } else {
      element.textContent = message;
    }
    element.dataset.tooltip = message;
  }

  private positionPcmStatusTooltip(): void {
    const rect = this.elements.pcmStatus.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const margin = 12;
    const tooltipWidth = Math.min(520, window.innerWidth - margin * 2);
    const left = clamp(rect.left, margin, Math.max(margin, window.innerWidth - tooltipWidth - margin));
    this.elements.pcmStatus.style.setProperty("--pcm-status-tooltip-left", `${left}px`);
    this.elements.pcmStatus.style.setProperty("--pcm-status-tooltip-top", `${rect.bottom + 8}px`);
  }

  private readPcmControls(): PcmFormat {
    return {
      sampleRate: Math.max(1, Math.floor(Number(this.elements.pcmSampleRate.value) || 16000)),
      channels: Math.max(1, Math.floor(Number(this.elements.pcmChannels.value) || 1)),
      bitDepth: Number(this.elements.pcmBitDepth.value) as PcmFormat["bitDepth"],
      sampleFormat: this.elements.pcmSampleFormat.value as PcmSampleFormat,
      endianness: this.elements.pcmEndianness.value as PcmEndianness,
      startOffsetBytes: Math.max(0, Math.floor(Number(this.elements.pcmStartOffset.value) || 0))
    };
  }

  private writePcmControls(format: PcmFormat): void {
    this.elements.pcmSampleRate.value = String(format.sampleRate);
    this.elements.pcmChannels.value = String(format.channels);
    this.elements.pcmStartOffset.value = String(format.startOffsetBytes ?? 0);
    this.elements.pcmBitDepth.value = String(format.bitDepth);
    this.elements.pcmSampleFormat.value = format.sampleFormat;
    this.elements.pcmEndianness.value = format.endianness;
  }

  private readWavPcmControls(): PcmFormat {
    return {
      sampleRate: Math.max(1, Math.floor(Number(this.elements.wavPcmSampleRate.value) || 16000)),
      channels: Math.max(1, Math.floor(Number(this.elements.wavPcmChannels.value) || 1)),
      bitDepth: Number(this.elements.wavPcmBitDepth.value) as PcmFormat["bitDepth"],
      sampleFormat: this.elements.wavPcmSampleFormat.value as PcmSampleFormat,
      endianness: this.elements.wavPcmEndianness.value as PcmEndianness,
      startOffsetBytes: Math.max(0, Math.floor(Number(this.elements.wavPcmStartOffset.value) || 0))
    };
  }

  private writeWavPcmControls(format: PcmFormat): void {
    this.elements.wavPcmSampleRate.value = String(format.sampleRate);
    this.elements.wavPcmChannels.value = String(format.channels);
    this.elements.wavPcmStartOffset.value = String(format.startOffsetBytes ?? 0);
    this.elements.wavPcmBitDepth.value = String(format.bitDepth);
    this.elements.wavPcmSampleFormat.value = format.sampleFormat;
    this.elements.wavPcmEndianness.value = format.endianness;
  }

  private populateChannels(): void {
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

  private renderTrackList(): void {
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

  private addTrackRow(channel: number): void {
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

    const view: TrackView = {
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
      view.mode = mode.value as TrackViewMode;
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

  private toggleSolo(target: TrackView): void {
    const enabled = !target.solo;
    for (const view of this.trackViews) {
      view.solo = enabled && view === target;
    }
    this.syncAllTrackToggleButtons();
    this.updatePlaybackChannelGains();
  }

  private toggleMute(target: TrackView): void {
    target.muted = !target.muted;
    for (const view of this.trackViews) {
      view.solo = false;
    }
    this.syncAllTrackToggleButtons();
    this.updatePlaybackChannelGains();
  }

  private syncAllTrackToggleButtons(): void {
    for (const view of this.trackViews) {
      this.syncTrackToggleButtons(view);
    }
  }

  private updateTrackLabels(): void {
    for (const view of this.trackViews) {
      view.row.querySelector<HTMLButtonElement>(".trackMute")?.replaceChildren(document.createTextNode(this.messages.mute));
      view.row.querySelector<HTMLButtonElement>(".trackSolo")?.replaceChildren(document.createTextNode(this.messages.solo));
      const modeSelect = view.row.querySelector<HTMLSelectElement>(".trackMode");
      if (modeSelect) {
        const value = modeSelect.value as TrackViewMode;
        this.populateTrackModeOptions(modeSelect);
        modeSelect.value = value;
      }
    }
  }

  private populateTrackModeOptions(select: HTMLSelectElement): void {
    const options: Array<[TrackViewMode, string]> = [
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

  private syncTrackToggleButtons(view: TrackView): void {
    const hasSolo = this.trackViews.some((item) => item.solo);
    const effectiveMuted = hasSolo ? !view.solo : view.muted;
    view.row.querySelector<HTMLButtonElement>(".trackSolo")?.classList.toggle("isActive", view.solo);
    view.row.querySelector<HTMLButtonElement>(".trackMute")?.classList.toggle("isActive", effectiveMuted);
  }

  private selectChannel(channel: number): void {
    this.settings.channel = clamp(channel, 0, Math.max(0, (this.audioBuffer?.numberOfChannels ?? 1) - 1));
    this.elements.channel.value = String(this.settings.channel);
    this.renderTrackSelection();
    this.updateSelectionAnalysis();
    this.redrawVisuals();
    this.analyze();
  }

  private renderTrackSelection(): void {
    this.trackViews.forEach((view) => {
      view.row.classList.toggle("isSelected", view.channel === this.settings.channel);
    });
  }

  private applyTrackMode(view: TrackView): void {
    view.row.dataset.mode = view.mode;
  }

  private applyDefaultTrackModeToCurrentTracks(): void {
    for (const view of this.trackViews) {
      view.mode = this.settings.defaultTrackMode;
      const modeSelect = view.row.querySelector<HTMLSelectElement>(".trackMode");
      if (modeSelect) {
        modeSelect.value = view.mode;
      }
      this.applyTrackMode(view);
    }
    this.redrawVisuals();
    this.analyze();
  }

  private samplesForActiveTrack(): Float32Array | undefined {
    return this.samplesForChannel(this.settings.channel);
  }

  private samplesForChannel(channel: number): Float32Array | undefined {
    if (!this.audioBuffer) {
      return undefined;
    }
    return this.audioBuffer.getChannelData(clamp(channel, 0, this.audioBuffer.numberOfChannels - 1));
  }

  private redrawVisuals(): void {
    this.updateResetViewButtonState();
    const range = this.visibleRange();
    this.elements.viewRange.textContent = this.messages.timeLabel;
    this.elements.viewRange.title = `${range.startTime.toFixed(3)}s - ${range.endTime.toFixed(3)}s`;
    this.drawTimeline();
    this.drawTrackVisuals();
    this.updatePersistentSelectionBox();
  }

  private drawTimeline(): void {
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
    const visibleDuration = Math.max(0.001, range.endTime - range.startTime);
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

  private drawTimelinePlayhead(context: CanvasRenderingContext2D, rect: PlotRect, range: VisibleRangeState): void {
    const playheadTime = this.dragPlayheadTime ?? this.playheadTime;
    if (playheadTime === undefined || playheadTime < range.startTime || playheadTime > range.endTime) {
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

  private drawTrackVisuals(): void {
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

  private drawChannelWaveform(canvas: HTMLCanvasElement, channel: number): void {
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
      context.moveTo(x, clamp(mid - min * this.settings.amplitudeZoom * rect.height * WAVEFORM_AMPLITUDE_SCALE, rect.top, rect.bottom));
      context.lineTo(x, clamp(mid - max * this.settings.amplitudeZoom * rect.height * WAVEFORM_AMPLITUDE_SCALE, rect.top, rect.bottom));
    }
    context.stroke();
    this.drawSelectionOverlay(context, rect, range);
    this.drawPlayheadOverlay(context, rect, range);
  }

  private drawEmptySpectrogram(canvas: HTMLCanvasElement): void {
    const context = resizeCanvas(canvas);
    const rect = this.getPlotRect(canvas);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = canvasBackgroundColor();
    context.fillRect(0, 0, canvas.width, canvas.height);
    this.drawPlotFrame(context, rect);
    this.drawFrequencyAxis(context, rect);
  }

  private scheduleAnalyze(delay = 80): void {
    if (this.analysisTimer !== undefined) {
      window.clearTimeout(this.analysisTimer);
    }
    this.analysisTimer = window.setTimeout(() => {
      this.analysisTimer = undefined;
      this.analyze();
    }, delay);
  }

  private analyze(): void {
    if (!this.audioBuffer) {
      return;
    }

    if (this.analysisTimer !== undefined) {
      window.clearTimeout(this.analysisTimer);
      this.analysisTimer = undefined;
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

  private analyzeChannel(view: TrackView): void {
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
    this.elements.analysisMeta.textContent = `${formatAlgorithm(this.settings.algorithm, this.messages)} · ${formatWindowFunction(this.settings.windowFunction, this.messages)} · ${this.settings.fftSize} · ${this.messages.pad} ${this.settings.zeroPaddingFactor} · ${this.settings.frequencyScale} · ${this.messages.hop} ${hopSize}`;
  }

  private createSpectrogramCacheKey(channel: number, canvas: HTMLCanvasElement, outputBins?: number, targetFrames?: number): string {
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

  private drawSpectrogramResult(result: SpectrogramResult): void {
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

  private drawSpectrogramCanvas(canvas: HTMLCanvasElement, result: SpectrogramResult): void {
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

  private drawSpectrogramBitmap(context: CanvasRenderingContext2D, bitmap: HTMLCanvasElement, rect: PlotRect, result: SpectrogramResult): void {
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
    const sourceX = ((overlapStart - sourceRange.startSample) / sourceDuration) * bitmap.width;
    const sourceWidth = Math.max(1, ((overlapEnd - overlapStart) / sourceDuration) * bitmap.width);
    const targetX = rect.left + ((overlapStart - currentRange.startSample) / currentDuration) * rect.width;
    const targetWidth = Math.max(1, ((overlapEnd - overlapStart) / currentDuration) * rect.width);
    context.drawImage(bitmap, sourceX, 0, sourceWidth, bitmap.height, targetX, rect.top, targetWidth, rect.height);
  }

  private spectrogramBitmapForResult(result: SpectrogramResult): HTMLCanvasElement | undefined {
    const cached = this.spectrogramBitmapCache.get(result.requestId);
    if (cached) {
      return cached;
    }
    const bitmap = document.createElement("canvas");
    bitmap.width = result.width;
    bitmap.height = result.height;
    const bitmapContext = bitmap.getContext("2d", { alpha: false });
    if (!bitmapContext) {
      return undefined;
    }
    const image = new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height);
    bitmapContext.putImageData(image, 0, 0);
    this.spectrogramBitmapCache.set(result.requestId, bitmap);
    return bitmap;
  }

  private visibleRange(): VisibleRangeState {
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

  private updateClock(): void {
    const current = formatTime(this.elements.audio.currentTime || 0);
    const duration = formatTime(Number.isFinite(this.elements.audio.duration) ? this.elements.audio.duration : 0);
    this.elements.clock.textContent = `${current} / ${duration}`;
  }

  private setStatus(message: string): void {
    this.elements.status.textContent = message;
    this.elements.status.hidden = !this.shouldShowStatus(message);
  }

  private shouldShowStatus(message: string): boolean {
    return !(
      !message ||
      message === this.messages.initializing ||
      message === this.messages.ready ||
      message === this.messages.audioLoaded
    );
  }

  private updateResetViewButtonState(): void {
    const isDirty =
      Math.abs(this.settings.timeZoom - 1) > 1e-6 ||
      Math.abs(this.settings.timeOffset) > 1e-6 ||
      Math.abs(this.settings.amplitudeZoom - 1) > 1e-6 ||
      Boolean(this.selection);
    this.elements.resetView.classList.toggle("isProminent", isDirty);
  }

  private updateGainNode(): void {
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

  private rebuildPlaybackChannelGraph(): void {
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
      this.playbackSplitterNode = undefined;
      this.playbackMergerNode = undefined;
      return;
    }
    const channels = this.audioBuffer.numberOfChannels;
    this.playbackSplitterNode = this.playbackAudioContext.createChannelSplitter(channels);
    this.playbackMergerNode = this.playbackAudioContext.createChannelMerger(2);
    this.playbackChannelGains = Array.from({ length: channels }, () => this.playbackAudioContext!.createGain());
    this.playbackSourceNode.connect(this.playbackSplitterNode);
    this.playbackChannelGains.forEach((gain, channel) => {
      this.playbackSplitterNode?.connect(gain, channel);
      gain.connect(this.playbackMergerNode!, 0, 0);
      gain.connect(this.playbackMergerNode!, 0, 1);
    });
    this.playbackMergerNode.connect(this.playbackGainNode);
    this.playbackGainNode.connect(this.playbackAudioContext.destination);
  }

  private updatePlaybackChannelGains(): void {
    const hasSolo = this.trackViews.some((view) => view.solo);
    const enabledChannels = this.trackViews.length > 0
      ? this.trackViews.filter((view) => (hasSolo ? view.solo : !view.muted)).length
      : this.playbackChannelGains.length;
    const channelGain = enabledChannels > 0 ? 1 / enabledChannels : 0;
    this.playbackChannelGains.forEach((gain, channel) => {
      const view = this.trackViews.find((item) => item.channel === channel);
      const enabled = view ? (hasSolo ? view.solo : !view.muted) : true;
      gain.gain.value = enabled ? channelGain : 0;
    });
  }

  private getWaveformPeaks(channel: number, startSample: number, endSample: number, width: number): WaveformPeaks {
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

  private bindFigureInteraction(canvas: HTMLCanvasElement): void {
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
      this.selectionPlaybackEnd = undefined;
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
      this.dragPlayheadTime = undefined;
      this.drawTimeline();
    });
    canvas.addEventListener("pointercancel", () => {
      isDragging = false;
      this.isDraggingSelection = false;
      this.dragPlayheadTime = undefined;
      this.hideSelectionBox();
      this.redrawVisuals();
    });
  }

  private handleWheel(event: WheelEvent, canvas: HTMLCanvasElement): void {
    const timeZoomModifier = isTimeZoomModifier(event);
    const trackpadPinchZoom = isTrackpadPinchZoom(event);
    const horizontalPan = isHorizontalTrackpadPan(event);
    if (!this.audioBuffer || (!timeZoomModifier && !trackpadPinchZoom && !event.shiftKey && !event.altKey && !horizontalPan)) {
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
      this.panTime((delta / 100) * viewDuration * 0.12, this.audioBuffer.duration);
      this.syncControls();
      this.redrawVisuals();
      this.scheduleAnalyze();
      return;
    }

    if (event.altKey) {
      const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
      this.settings.amplitudeZoom = clamp(this.settings.amplitudeZoom * factor, 0.25, 32);
      this.syncControls();
      this.redrawVisuals();
    }
  }

  private setPlayheadFromPointer(canvas: HTMLCanvasElement, clientX: number): void {
    if (!this.audioBuffer) {
      return;
    }
    const time = this.timeFromCanvasX(canvas, clientX);
    this.selection = undefined;
    this.selectionPlaybackEnd = undefined;
    this.updateSelectionAnalysis();
    this.playheadTime = clamp(time, 0, this.audioBuffer.duration);
    this.dragPlayheadTime = undefined;
    this.elements.audio.currentTime = this.playheadTime;
    this.updateClock();
    this.redrawVisuals();
  }

  private setDragPlayheadFromPointer(canvas: HTMLCanvasElement, clientX: number): void {
    if (!this.audioBuffer) {
      return;
    }
    const time = this.timeFromCanvasX(canvas, clientX);
    this.dragPlayheadTime = clamp(time, 0, this.audioBuffer.duration);
    this.drawTimeline();
    if (this.elements.audio.paused) {
      this.drawTrackVisuals();
    }
  }

  private setSelectionFromPointer(canvas: HTMLCanvasElement, fromX: number, toX: number): void {
    if (!this.audioBuffer) {
      return;
    }
    const start = clamp(this.timeFromCanvasX(canvas, fromX), 0, this.audioBuffer.duration);
    const end = clamp(this.timeFromCanvasX(canvas, toX), 0, this.audioBuffer.duration);
    const selection = { start: Math.min(start, end), end: Math.max(start, end) };
    if (selection.end - selection.start < 0.001) {
      return;
    }
    this.selection = selection;
    this.playheadTime = selection.start;
    this.dragPlayheadTime = undefined;
    this.selectionPlaybackEnd = this.elements.audio.paused ? undefined : selection.end;
    this.elements.audio.currentTime = selection.start;
    this.updateClock();
    this.updateSelectionAnalysis();
    this.redrawVisuals();
  }

  private updateSelectionBox(canvas: HTMLCanvasElement, fromX: number, toX: number): void {
    const canvasRect = canvas.getBoundingClientRect();
    const plot = this.getCssPlotRect(canvas);
    const visiblePlots = this.visibleSelectionPlotRects();
    const from = clamp(fromX - canvasRect.left, plot.left, plot.right);
    const to = clamp(toX - canvasRect.left, plot.left, plot.right);
    const top = visiblePlots.length > 0 ? Math.min(...visiblePlots.map((rect) => rect.top)) : canvasRect.top + plot.top;
    const bottom = visiblePlots.length > 0 ? Math.max(...visiblePlots.map((rect) => rect.bottom)) : canvasRect.top + plot.bottom;
    this.elements.selectionBox.hidden = false;
    this.elements.selectionBox.classList.add("isDraggingSelection");
    this.elements.selectionBox.style.left = `${canvasRect.left + Math.min(from, to)}px`;
    this.elements.selectionBox.style.top = `${top}px`;
    this.elements.selectionBox.style.width = `${Math.abs(from - to)}px`;
    this.elements.selectionBox.style.height = `${Math.max(1, bottom - top)}px`;
  }

  private updatePersistentSelectionBox(): void {
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
    const left = clamp(Math.min(start, end), plot.left, plot.right);
    const right = clamp(Math.max(start, end), plot.left, plot.right);
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

  private firstVisiblePlotCanvas(): HTMLCanvasElement | undefined {
    for (const view of this.trackViews) {
      for (const canvas of [view.waveform, view.spectrogram]) {
        if (canvas.offsetParent !== null && canvas.getBoundingClientRect().width > 0) {
          return canvas;
        }
      }
    }
    return undefined;
  }

  private visibleSelectionPlotRects(): Array<{ top: number; bottom: number }> {
    const rects: Array<{ top: number; bottom: number }> = [];
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

  private hideSelectionBox(): void {
    this.elements.selectionBox.classList.remove("isDraggingSelection");
    this.elements.selectionBox.hidden = true;
  }

  private bindPlotResizer(handle: HTMLElement, pane: HTMLElement, variableName: string, minHeight: number, maxHeight: number): void {
    let startY = 0;
    let startHeight = 0;
    let frameId: number | undefined;

    const redraw = () => {
      frameId = undefined;
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
      const nextHeight = clamp(startHeight + event.clientY - startY, minHeight, maxHeight);
      this.setPlotHeight(variableName, nextHeight, minHeight, maxHeight);
      if (frameId === undefined) {
        frameId = requestAnimationFrame(redraw);
      }
    });
    handle.addEventListener("pointerup", (event) => {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      document.body.style.userSelect = "";
      if (frameId !== undefined) {
        cancelAnimationFrame(frameId);
        frameId = undefined;
      }
      this.redrawVisuals();
      this.analyze();
      this.savePreferencesSoon();
    });
  }

  private setPlotHeight(variableName: string, value: number, minHeight: number, maxHeight: number): void {
    this.elements.figures.style.setProperty(variableName, `${Math.round(clamp(value, minHeight, maxHeight))}px`);
  }

  private getPlotHeight(pane: HTMLElement): number {
    return Math.round(pane.getBoundingClientRect().height);
  }

  private updateSelectionAnalysis(): void {
    if (!this.audioBuffer || !this.selection) {
      this.elements.analysisStart.closest<HTMLElement>(".selectionAnalysisPane")?.setAttribute("hidden", "");
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
    this.elements.analysisStart.closest<HTMLElement>(".selectionAnalysisPane")?.removeAttribute("hidden");

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

  private renderFrequencyRows(bands: Array<{ label: string; percent: number }>): void {
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

  private analysisSampleRate(): number {
    return this.sourceSampleRate ?? this.audioBuffer?.sampleRate ?? 1;
  }

  private getPlotRect(canvas: HTMLCanvasElement): PlotRect {
    if (canvas.classList.contains("trackWaveform") || canvas.classList.contains("trackSpectrogram")) {
      const ratio = window.devicePixelRatio || 1;
      const left = TRACK_AXIS_WIDTH * ratio;
      const top = 0;
      const right = Math.max(left + 1, canvas.width);
      const bottom = Math.max(top + 1, canvas.height);
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }
    const ratio = window.devicePixelRatio || 1;
    const left = PLOT_MARGIN.left * ratio;
    const top = PLOT_MARGIN.top * ratio;
    const right = Math.max(left + 1, canvas.width - PLOT_MARGIN.right * ratio);
    const bottom = Math.max(top + 1, canvas.height - PLOT_MARGIN.bottom * ratio);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  private getCssPlotRect(canvas: HTMLCanvasElement): PlotRect {
    const ratio = window.devicePixelRatio || 1;
    const rect = this.getPlotRect(canvas);
    const left = rect.left / ratio;
    const top = rect.top / ratio;
    const right = rect.right / ratio;
    const bottom = rect.bottom / ratio;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  private drawPlotFrame(context: CanvasRenderingContext2D, rect: PlotRect): void {
    context.strokeStyle = axisFrameColor();
    context.lineWidth = deviceLineWidth();
    context.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }

  private drawWaveformAxis(context: CanvasRenderingContext2D, rect: PlotRect): void {
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

  private drawFrequencyAxis(context: CanvasRenderingContext2D, rect: PlotRect): void {
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

  private drawSelectionOverlay(context: CanvasRenderingContext2D, rect: PlotRect, range: VisibleRangeState): void {
    if (!this.selection) {
      return;
    }
    const start = this.timeToX(this.selection.start, rect, range);
    const end = this.timeToX(this.selection.end, rect, range);
    const left = clamp(Math.min(start, end), rect.left, rect.right);
    const right = clamp(Math.max(start, end), rect.left, rect.right);
    if (right <= rect.left || left >= rect.right || right - left < 1) {
      return;
    }
    context.save();
    context.fillStyle = "rgba(88, 166, 255, 0.18)";
    context.fillRect(left, rect.top, right - left, rect.height);
    context.restore();
  }

  private drawPlayheadOverlay(context: CanvasRenderingContext2D, rect: PlotRect, range: VisibleRangeState): void {
    const playheadTime = this.dragPlayheadTime ?? this.playheadTime;
    if (playheadTime === undefined || playheadTime < range.startTime || playheadTime > range.endTime) {
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

  private timeToX(time: number, rect: PlotRect, range: VisibleRangeState): number {
    const duration = Math.max(0.001, range.endTime - range.startTime);
    return rect.left + ((time - range.startTime) / duration) * rect.width;
  }

  private timeFromCanvasX(canvas: HTMLCanvasElement, clientX: number): number {
    const range = this.visibleRange();
    const ratio = this.canvasXRatio(canvas, clientX);
    return range.startTime + ratio * (range.endTime - range.startTime);
  }

  private canvasXRatio(canvas: HTMLCanvasElement, clientX: number): number {
    const bounds = canvas.getBoundingClientRect();
    const plot = this.getPlotRect(canvas);
    const x = (clientX - bounds.left) * (canvas.width / Math.max(1, bounds.width));
    return clamp((x - plot.left) / plot.width, 0, 1);
  }

  private applyTimeZoom(nextZoom: number, anchorTime: number, anchorRatio: number): void {
    if (!this.audioBuffer) {
      return;
    }
    const duration = this.audioBuffer.duration;
    this.settings.timeZoom = clamp(nextZoom, 1, 64);
    const viewDuration = duration / this.settings.timeZoom;
    const maxStart = Math.max(0, duration - viewDuration);
    const startTime = clamp(anchorTime - anchorRatio * viewDuration, 0, maxStart);
    this.settings.timeOffset = maxStart === 0 ? 0 : startTime / maxStart;
  }

  private panTime(deltaSeconds: number, duration: number): void {
    const viewDuration = duration / this.settings.timeZoom;
    const maxStart = Math.max(0, duration - viewDuration);
    const currentStart = maxStart * this.settings.timeOffset;
    const nextStart = clamp(currentStart + deltaSeconds, 0, maxStart);
    this.settings.timeOffset = maxStart === 0 ? 0 : nextStart / maxStart;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function decodeAudioDataWithTimeout(audioContext: AudioContext, bytes: Uint8Array, timeoutMs: number): Promise<AudioBuffer> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      audioContext.decodeAudioData(toArrayBuffer(bytes)),
      new Promise<AudioBuffer>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`decodeAudioData timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function encodeWav(audioBuffer: AudioBuffer): ArrayBuffer {
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
      const value = clamp(channelData[channel][frame] ?? 0, -1, 1);
      view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function axisFont(): string {
  return `${Math.round(AXIS_FONT_SIZE * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
}

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function colorMix(foreground: string, background: string, foregroundRatio: number): string {
  const fg = parseCssRgb(foreground);
  const bg = parseCssRgb(background);
  if (!fg || !bg) {
    return foreground;
  }
  const ratio = clamp(foregroundRatio, 0, 1);
  const red = Math.round(fg.red * ratio + bg.red * (1 - ratio));
  const green = Math.round(fg.green * ratio + bg.green * (1 - ratio));
  const blue = Math.round(fg.blue * ratio + bg.blue * (1 - ratio));
  return `rgb(${red} ${green} ${blue})`;
}

function parseCssRgb(value: string): { red: number; green: number; blue: number } | undefined {
  const trimmed = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    const number = Number.parseInt(hex[1], 16);
    return { red: (number >> 16) & 255, green: (number >> 8) & 255, blue: number & 255 };
  }
  const rgb = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(trimmed);
  if (rgb) {
    return { red: Number(rgb[1]), green: Number(rgb[2]), blue: Number(rgb[3]) };
  }
  return undefined;
}

function canvasBackgroundColor(): string {
  return cssColor("--vscode-editor-background", "#1e1e1e");
}

function axisTextColor(): string {
  return cssColor("--vscode-descriptionForeground", "#9aa7b4");
}

function axisGridColor(): string {
  return cssColor("--vscode-panel-border", "#25303a");
}

function timelineMajorColor(): string {
  return cssColor("--vscode-descriptionForeground", "#9aa7b4");
}

function timelineMinorColor(): string {
  return colorMix(cssColor("--vscode-descriptionForeground", "#9aa7b4"), cssColor("--vscode-editor-background", "#1e1e1e"), 0.58);
}

function axisFrameColor(): string {
  return cssColor("--vscode-panel-border", "#2d3540");
}

function deviceLineWidth(): number {
  return window.devicePixelRatio || 1;
}

function devicePx(value: number): number {
  return value * (window.devicePixelRatio || 1);
}

function chooseTimelineStep(duration: number, widthCssPx: number, minLabelPx: number): number {
  const targetTicks = Math.max(1, Math.floor(widthCssPx / minLabelPx));
  return niceTimeStep(duration / targetTicks);
}

function chooseTimelineMinorStep(majorStep: number): number {
  const exponent = Math.floor(Math.log10(majorStep));
  const base = majorStep / Math.pow(10, exponent);
  const divisions = base === 2 ? 4 : 5;
  return majorStep / divisions;
}

function niceTimeStep(rawStep: number): number {
  const safeStep = Math.max(0.001, rawStep);
  const exponent = Math.floor(Math.log10(safeStep));
  const base = safeStep / Math.pow(10, exponent);
  const niceBase = base <= 1 ? 1 : base <= 2 ? 2 : base <= 5 ? 5 : 10;
  return niceBase * Math.pow(10, exponent);
}

function isTimelineMajorTick(time: number, majorStep: number): boolean {
  const nearest = Math.round(time / majorStep) * majorStep;
  return Math.abs(time - nearest) <= majorStep * 1e-4;
}

function formatTimelineTick(time: number, step: number): string {
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

function isTimeZoomModifier(event: WheelEvent): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

function isTrackpadPinchZoom(event: WheelEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && Math.abs(normalizeWheelDelta(event.deltaY, event.deltaMode)) >= 1;
}

function isHorizontalTrackpadPan(event: WheelEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const deltaX = Math.abs(normalizeWheelDelta(event.deltaX, event.deltaMode));
  const deltaY = Math.abs(normalizeWheelDelta(event.deltaY, event.deltaMode));
  return deltaX >= 1 && deltaX > deltaY;
}

function normalizeWheelDelta(value: number, mode: number): number {
  if (mode === WheelEvent.DOM_DELTA_LINE) {
    return value * 16;
  }
  if (mode === WheelEvent.DOM_DELTA_PAGE) {
    return value * 800;
  }
  return value;
}

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLButtonElement
  );
}

function amplitudeToDb(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

function formatDb(value: number): string {
  return `${value.toFixed(1)} dBFS`;
}

function formatAlgorithm(value: SpectrogramAlgorithm, messages: LocaleMessages): string {
  if (value === "reassignment") {
    return messages.algorithmReassignment;
  }
  if (value === "pitchEac") {
    return messages.algorithmPitchEac;
  }
  return messages.algorithmFrequency;
}

function formatWindowFunction(value: WindowFunction, messages: LocaleMessages): string {
  const labels: Record<WindowFunction, string> = {
    rectangular: messages.windowRectangular,
    bartlett: messages.windowBartlett,
    hamming: messages.windowHamming,
    hann: messages.windowHann,
    blackman: messages.windowBlackman,
    blackmanHarris: messages.windowBlackmanHarris,
    welch: messages.windowWelch,
    gaussian25: messages.windowGaussian25,
    gaussian35: messages.windowGaussian35,
    gaussian45: messages.windowGaussian45
  };
  return labels[value];
}

function formatHz(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz`;
  }
  return `${Math.round(value)} Hz`;
}

function formatAxisHz(value: number): string {
  return `${Math.round(value)} Hz`;
}

function formatAmplitudeAxis(value: number): string {
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

function formatPcmFormat(format: PcmFormat): string {
  const sampleFormat = format.sampleFormat === "float" ? "f" : "s";
  const endian = format.endianness === "little" ? "le" : "be";
  const offset = format.startOffsetBytes ? ` · offset ${format.startOffsetBytes}B` : "";
  return `${format.sampleRate} Hz · ${format.channels}ch · ${sampleFormat}${format.bitDepth}${endian}${offset}`;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function frequencyFromRatio(ratio: number, scale: FrequencyScale, nyquist: number): number {
  const r = clamp(ratio, 0, 1);
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

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function hzToBark(hz: number): number {
  return 6 * Math.asinh(hz / 600);
}

function barkToHz(bark: number): number {
  return 600 * Math.sinh(bark / 6);
}

function hzToErb(hz: number): number {
  return 21.4 * Math.log10(1 + 0.00437 * hz);
}

function erbToHz(erb: number): number {
  return (Math.pow(10, erb / 21.4) - 1) / 0.00437;
}

function computeSpectrum(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number,
  requestedSize: number,
  windowFunction: WindowFunction,
  messages: LocaleMessages
): { dominantHz: number; centroidHz: number; bands: Array<{ label: string; percent: number }> } {
  const available = Math.max(0, endSample - startSample);
  const fftSize = largestPowerOfTwo(Math.min(requestedSize, available));
  if (fftSize < 64) {
    return { dominantHz: 0, centroidHz: 0, bands: BAND_LIMITS.map((band) => ({ label: messages[band.labelKey], percent: 0 })) };
  }

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const window = createWindow(windowFunction, fftSize);

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
      re[index] = (samples[offset + index] ?? 0) * window[index];
    }
    fft(re, im);

    for (let bin = 1; bin < fftSize / 2; bin += 1) {
      const power = re[bin] * re[bin] + im[bin] * im[bin];
      const frequency = (bin * sampleRate) / fftSize;
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
    dominantHz: (dominantBin * sampleRate) / fftSize,
    centroidHz: totalPower <= 0 ? 0 : weightedFrequencySum / totalPower,
    bands: BAND_LIMITS.map((band, index) => ({
      label: messages[band.labelKey],
      percent: totalPower <= 0 ? 0 : (bandPower[index] / totalPower) * 100
    }))
  };
}

function computeTimeSelectionMetrics(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  sampleRate: number
): {
  rms: number;
  peak: number;
  crestDb: number;
  clippingPercent: number;
  noiseFloorDb: number;
  zeroCrossingRate: number;
} {
  const count = Math.max(0, endSample - startSample);
  if (count <= 0) {
    return { rms: 0, peak: 0, crestDb: Number.NaN, clippingPercent: 0, noiseFloorDb: amplitudeToDb(0), zeroCrossingRate: 0 };
  }

  const stride = Math.max(1, Math.ceil(count / 2_000_000));
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
    clippingPercent: (clipped / Math.max(1, measured)) * 100,
    noiseFloorDb: computeNoiseFloorDb(samples, startSample, endSample, sampleRate),
    zeroCrossingRate: zeroCrossings / Math.max(1e-9, durationSeconds)
  };
}

function computeNoiseFloorDb(samples: Float32Array, startSample: number, endSample: number, sampleRate: number): number {
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
  const rmsValues: number[] = [];
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

function largestPowerOfTwo(value: number): number {
  let size = 1;
  while (size * 2 <= value) {
    size *= 2;
  }
  return size;
}

function createWindow(type: WindowFunction, size: number): Float32Array {
  const values = new Float32Array(size);
  const denom = Math.max(1, size - 1);
  const center = denom / 2;
  for (let i = 0; i < size; i += 1) {
    const phase = (2 * Math.PI * i) / denom;
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

function fft(re: Float32Array, im: Float32Array): void {
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
