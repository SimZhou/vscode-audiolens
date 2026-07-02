export type WindowFunction =
  | "rectangular"
  | "bartlett"
  | "hamming"
  | "hann"
  | "blackman"
  | "blackmanHarris"
  | "welch"
  | "gaussian25"
  | "gaussian35"
  | "gaussian45";

export type SpectrogramAlgorithm = "frequency" | "reassignment" | "pitchEac";

export interface AnalysisDefaults {
  windowFunction: WindowFunction;
  fftSize: number;
  zeroPaddingFactor: number;
}

export interface AudioLensConfig {
  autoAnalyze: boolean;
  maxFileSizeMB: number;
  language: string;
  vscodeLanguage: string;
  profileSpectrogram: boolean;
  analysis: AnalysisDefaults;
}

export interface AudioLensPreferences {
  algorithm?: SpectrogramAlgorithm;
  windowFunction?: WindowFunction;
  fftSize?: number;
  zeroPaddingFactor?: number;
  frequencyScale?: string;
  palette?: string;
  minDb?: number;
  maxDb?: number;
  spectrogramMinHz?: number;
  spectrogramMaxHz?: number;
  spectrogramMaxFollowsNyquist?: boolean;
  autoBrightness?: boolean;
  amplitudeZoom?: number;
  defaultTrackMode?: "both" | "waveform" | "spectrogram";
  waveformHeight?: number;
  spectrogramHeight?: number;
  defaultTrackRowHeight?: number;
  defaultTrackWaveFr?: number;
  defaultTrackSpecFr?: number;
  defaultPcmFormat?: {
    sampleRate: number;
    channels: number;
    bitDepth: 8 | 16 | 24 | 32 | 64;
    sampleFormat: "signed-int" | "unsigned-int" | "float";
    endianness: "none" | "little" | "big";
    startOffsetBytes?: number;
  };
}

export interface AudioMetadata {
  fileName: string;
  uri: string;
  size: number;
  trusted: boolean;
  extension: string;
  kind: "encoded" | "pcm";
  sourceKind?: "ark";
  sourceOffset?: number;
}

export type ExtensionMessage =
  | { type: "bootstrap"; config: AudioLensConfig; preferences: AudioLensPreferences; metadata: AudioMetadata }
  | { type: "configChanged"; config: AudioLensConfig }
  | { type: "fileChanged"; metadata: AudioMetadata }
  | { type: "chunk"; requestId: number; offset: number; total: number; bytes: ArrayBuffer }
  | { type: "transcodedAudio"; requestId: number; bytes: ArrayBuffer }
  | { type: "transcodeError"; requestId: number; message: string }
  | { type: "selectionWavSaveReady"; requestId: number }
  | { type: "selectionWavSaveCanceled"; requestId: number }
  | { type: "error"; message: string };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "readChunk"; requestId: number; offset: number; length: number }
  | { type: "transcodeAudio"; requestId: number }
  | { type: "downloadAudio" }
  | { type: "requestSelectionWavSave"; requestId: number; fileName: string; saveLabel?: string; title?: string }
  | { type: "writeSelectionWavChunk"; requestId: number; fileName: string; chunkIndex: number; bytesBase64: string; isLast: boolean }
  | { type: "updatePreferences"; preferences: AudioLensPreferences }
  | { type: "showError"; message: string };

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
