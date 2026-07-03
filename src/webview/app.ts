import {
  DEFAULT_CHUNK_SIZE,
  ExtensionMessage,
  AudioLensConfig,
  AudioLensPreferences,
  SpectrogramAlgorithm,
  WebviewMessage,
  WindowFunction
} from "../shared/protocol";
import { resolveWaveDataSize } from "../ffmpegWav";
import {
  createAnalysisCacheKey,
  computeAxisIntervals,
  computeWaveformPeaks,
  formatAxisFrequency,
  FrequencyScale,
  getVisibleRange,
  normalizeDbRange,
  SpectrogramPalette,
  WaveformPeaks,
  zoomRange
} from "../shared/analysis";
import { AnalysisWorkerResult, createAnalysisWorker, SelectionSpectrumResult, SpectrogramResult } from "./analysisWorker";
import { AudioHeaderInfo, readAudioFileFacts, readAudioHeaderInfo } from "./audioFacts";
import { clamp, formatBytes, formatTime, guessMime, resizeCanvas } from "./dom";
import { getMessages, resolveLocale } from "./i18n";
import { LocaleCode, LocaleMessages, LocaleSetting } from "./i18n/types";
import {
  createAudioBufferFromChannels,
  decodePcm,
  pcmEncodingToFormat,
  pcmFormatToEncoding,
  PcmEncoding,
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
  spectrogramMinHz: number;
  spectrogramMaxHz: number;
  spectrogramMaxFollowsNyquist: boolean;
  autoBrightness: boolean;
  amplitudeAuto: boolean;
  amplitudeMin: number;
  amplitudeMax: number;
  timeZoom: number;
  timeOffset: number;
  frequencyScale: FrequencyScale;
  palette: SpectrogramPalette;
  defaultTrackRowHeight: number;
  defaultTrackWaveFr: number;
  defaultTrackSpecFr: number;
}

interface AudioFileMetadata {
  fileName: string;
  uri: string;
  size: number;
  trusted: boolean;
  extension: string;
  kind: "encoded" | "pcm";
  sourceKind?: "ark";
  sourceOffset?: number;
}

type PcmStatusState =
  | { kind: "current"; format: PcmFormat }
  | { kind: "savedDefault"; format: PcmFormat };

interface TimeSelectionState {
  start: number;
  end: number;
}

interface SpectrogramRangeState {
  startSample: number;
  endSample: number;
}

type SpectrogramRequestProfile = {
  channel: number;
  startedAt: number;
  startSample: number;
  endSample: number;
  targetFrames: number;
  outputBins: number;
};

type SpectrogramDrawProfile = {
  totalMs: number;
  setupMs: number;
  bitmapMs: number;
  bitmapDrawMs: number;
  overlayMs: number;
  bitmapCached: boolean;
};

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

interface PendingSelectionWavDownload {
  audioBuffer: AudioBuffer;
  startFrame: number;
  endFrame: number;
  fileName: string;
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
  gainDb: number;
  pan: number;
  freqScaleOverride?: FrequencyScale;
  freqRangeOverride?: { minHz: number; maxHz: number };
  ampRangeOverride?: { min: number; max: number };
  gainSlider: HTMLInputElement;
  panSlider: HTMLInputElement;
  rowHeight: number;
  waveFr: number;
  specFr: number;
}

const MIN_DRAG_PIXELS = 6;
const ENCODED_DECODE_TIMEOUT_MS = 8000;
const SELECTION_WAV_CHUNK_SIZE = 1024 * 1024;
const PLOT_MARGIN = { left: 78, top: 18, right: 18, bottom: 40 };
const TRACK_AXIS_WIDTH = 78;
const AXIS_FONT_SIZE = 13;
const PLOT_HEIGHT_LIMITS = { waveformMin: 160, waveformMax: 520, spectrogramMin: 220, spectrogramMax: 860 };
const TRACK_ROW_DEFAULT_H = 280;
const TRACK_ROW_MIN_H = 132;
const TRACK_WAVE_DEFAULT_FR = 0.38;
const TRACK_SPEC_DEFAULT_FR = 0.62;
const TRACK_WAVE_MIN_PX = 90;
const TRACK_SPEC_MIN_PX = 160;
const TRACK_GAIN_RANGE_DB = 24;
// trackRow 使用 border-box，需要为上下边框各预留 1px。
const TRACK_BOTH_MIN_H = TRACK_WAVE_MIN_PX + TRACK_SPEC_MIN_PX + 2;
const SELECTION_SPECTRUM_DELAY_MS = 80;
const BAND_LIMITS = [
  { labelKey: "frequencyBand0To250", min: 0, max: 250 },
  { labelKey: "frequencyBand250To500", min: 250, max: 500 },
  { labelKey: "frequencyBand500To1k", min: 500, max: 1000 },
  { labelKey: "frequencyBand1To2k", min: 1000, max: 2000 },
  { labelKey: "frequencyBand2To4k", min: 2000, max: 4000 },
  { labelKey: "frequencyBand4To8k", min: 4000, max: 8000 },
  { labelKey: "frequencyBand8kPlus", min: 8000, max: Number.POSITIVE_INFINITY }
] satisfies Array<{ labelKey: keyof LocaleMessages; min: number; max: number }>;

const HEADER_NOTE_EN: Record<string, string> = {
  "文件大小 - 8": "File size - 8",
  "子块 ID": "Subchunk ID",
  "子块数据长度": "Subchunk data length",
  "音频数据区域": "Audio data region",
  "未展开子块": "Unexpanded chunk",
  "fmt 子块过短": "fmt chunk is too short",
  "编码格式": "Audio format",
  "通道数": "Channel count",
  "采样率": "Sample rate",
  "字节率": "Byte rate",
  "每帧字节数": "Bytes per frame",
  "位深": "Bit depth",
  "扩展参数长度": "Extension parameter length",
  "有效位深": "Valid bit depth",
  "声道布局掩码": "Channel layout mask",
  "FLAC 标识": "FLAC marker",
  "元数据块头": "Metadata block header",
  "元数据块长度": "Metadata block length",
  "元数据块内容": "Metadata block payload",
  "最小块大小": "Minimum block size",
  "最大块大小": "Maximum block size",
  "最小帧大小": "Minimum frame size",
  "最大帧大小": "Maximum frame size",
  "总采样数": "Total samples",
  "原始音频 MD5": "Raw audio MD5",
  "Ogg 页标识": "Ogg page marker",
  "流结构版本": "Stream structure version",
  "页类型标志": "Page type flags",
  "绝对位置": "Absolute position",
  "逻辑流序号": "Logical stream serial number",
  "页序号": "Page sequence number",
  "页校验和": "Page checksum",
  "segment 数": "Segment count",
  "segment 长度表": "Segment length table",
  "页数据": "Page payload",
  "Opus 识别头": "Opus identification header",
  "版本": "Version",
  "预跳过采样数": "Pre-skip sample count",
  "输入采样率": "Input sample rate",
  "输出增益": "Output gain",
  "声道映射族": "Channel mapping family",
  "识别头": "Identification header",
  "Vorbis 标识": "Vorbis marker",
  "box 大小": "Box size",
  "box 类型": "Box type",
  "主品牌": "Major brand",
  "次版本": "Minor version",
  "兼容品牌": "Compatible brands",
  "标志": "Flags",
  "时间刻度": "Timescale",
  "时长单位数": "Duration units",
  "处理器类型": "Handler type",
  "样本描述数量": "Sample description count",
  "样本类型": "Sample type",
  "同步字": "Sync word",
  "MPEG 版本": "MPEG version",
  "层": "Layer",
  "CRC 是否省略": "Whether CRC is absent",
  "采样率索引": "Sample rate index",
  "声道配置": "Channel configuration",
  "ADTS 帧长度": "ADTS frame length",
  "缓冲 fullness": "Buffer fullness",
  "原始数据块数量字段": "Raw data block count field",
  "ID3v2 标识": "ID3v2 marker",
  "ID3 版本": "ID3 version",
  "标签长度": "Tag length",
  "帧同步": "Frame sync",
  "MPEG 音频版本": "MPEG audio version",
  "CRC 标志": "CRC flag",
  "码率索引": "Bitrate index",
  "声道模式": "Channel mode"
};

const HEADER_NOTE_ZH_TW: Record<string, string> = {
  "文件大小 - 8": "檔案大小 - 8",
  "子块 ID": "子區塊 ID",
  "子块数据长度": "子區塊資料長度",
  "音频数据区域": "音訊資料區域",
  "未展开子块": "未展開子區塊",
  "fmt 子块过短": "fmt 子區塊過短",
  "编码格式": "編碼格式",
  "通道数": "聲道數",
  "采样率": "取樣率",
  "字节率": "位元組率",
  "每帧字节数": "每幀位元組數",
  "位深": "位元深度",
  "扩展参数长度": "擴充參數長度",
  "有效位深": "有效位元深度",
  "声道布局掩码": "聲道布局遮罩",
  "FLAC 标识": "FLAC 標識",
  "元数据块头": "中繼資料區塊頭",
  "元数据块长度": "中繼資料區塊長度",
  "元数据块内容": "中繼資料區塊內容",
  "最小块大小": "最小區塊大小",
  "最大块大小": "最大區塊大小",
  "最小帧大小": "最小幀大小",
  "最大帧大小": "最大幀大小",
  "总采样数": "總取樣數",
  "原始音频 MD5": "原始音訊 MD5",
  "Ogg 页标识": "Ogg 頁標識",
  "流结构版本": "串流結構版本",
  "页类型标志": "頁類型標誌",
  "绝对位置": "絕對位置",
  "逻辑流序号": "邏輯串流序號",
  "页序号": "頁序號",
  "页校验和": "頁校驗和",
  "segment 数": "segment 數",
  "segment 长度表": "segment 長度表",
  "页数据": "頁資料",
  "Opus 识别头": "Opus 識別頭",
  "版本": "版本",
  "预跳过采样数": "預跳過取樣數",
  "输入采样率": "輸入取樣率",
  "输出增益": "輸出增益",
  "声道映射族": "聲道映射族",
  "识别头": "識別頭",
  "Vorbis 标识": "Vorbis 標識",
  "box 大小": "box 大小",
  "box 类型": "box 類型",
  "主品牌": "主品牌",
  "次版本": "次版本",
  "兼容品牌": "相容品牌",
  "标志": "標誌",
  "时间刻度": "時間刻度",
  "时长单位数": "時長單位數",
  "处理器类型": "處理器類型",
  "样本描述数量": "樣本描述數量",
  "样本类型": "樣本類型",
  "同步字": "同步字",
  "MPEG 版本": "MPEG 版本",
  "层": "層",
  "CRC 是否省略": "CRC 是否省略",
  "采样率索引": "取樣率索引",
  "声道配置": "聲道配置",
  "ADTS 帧长度": "ADTS 幀長度",
  "缓冲 fullness": "緩衝 fullness",
  "原始数据块数量字段": "原始資料區塊數量欄位",
  "ID3v2 标识": "ID3v2 標識",
  "ID3 版本": "ID3 版本",
  "标签长度": "標籤長度",
  "帧同步": "幀同步",
  "MPEG 音频版本": "MPEG 音訊版本",
  "CRC 标志": "CRC 標誌",
  "码率索引": "碼率索引",
  "声道模式": "聲道模式"
};

const HEADER_NOTE_JA: Record<string, string> = {
  "文件大小 - 8": "ファイルサイズ - 8",
  "子块 ID": "サブチャンク ID",
  "子块数据长度": "サブチャンクデータ長",
  "音频数据区域": "音声データ領域",
  "未展开子块": "未展開のサブチャンク",
  "fmt 子块过短": "fmt サブチャンクが短すぎます",
  "编码格式": "エンコード形式",
  "通道数": "チャンネル数",
  "采样率": "サンプルレート",
  "字节率": "バイトレート",
  "每帧字节数": "フレームあたりのバイト数",
  "位深": "ビット深度",
  "扩展参数长度": "拡張パラメータ長",
  "有效位深": "有効ビット深度",
  "声道布局掩码": "チャンネル配置マスク",
  "FLAC 标识": "FLAC マーカー",
  "元数据块头": "メタデータブロックヘッダー",
  "元数据块长度": "メタデータブロック長",
  "元数据块内容": "メタデータブロック内容",
  "最小块大小": "最小ブロックサイズ",
  "最大块大小": "最大ブロックサイズ",
  "最小帧大小": "最小フレームサイズ",
  "最大帧大小": "最大フレームサイズ",
  "总采样数": "総サンプル数",
  "原始音频 MD5": "原音声 MD5",
  "Ogg 页标识": "Ogg ページマーカー",
  "流结构版本": "ストリーム構造バージョン",
  "页类型标志": "ページタイプフラグ",
  "绝对位置": "絶対位置",
  "逻辑流序号": "論理ストリームシリアル番号",
  "页序号": "ページシーケンス番号",
  "页校验和": "ページチェックサム",
  "segment 数": "segment 数",
  "segment 长度表": "segment 長テーブル",
  "页数据": "ページペイロード",
  "Opus 识别头": "Opus 識別ヘッダー",
  "版本": "バージョン",
  "预跳过采样数": "プリスキップサンプル数",
  "输入采样率": "入力サンプルレート",
  "输出增益": "出力ゲイン",
  "声道映射族": "チャンネルマッピングファミリー",
  "识别头": "識別ヘッダー",
  "Vorbis 标识": "Vorbis マーカー",
  "box 大小": "box サイズ",
  "box 类型": "box タイプ",
  "主品牌": "メジャーブランド",
  "次版本": "マイナーバージョン",
  "兼容品牌": "互換ブランド",
  "标志": "フラグ",
  "时间刻度": "タイムスケール",
  "时长单位数": "継続時間単位数",
  "处理器类型": "ハンドラータイプ",
  "样本描述数量": "サンプル記述数",
  "样本类型": "サンプルタイプ",
  "同步字": "同期ワード",
  "MPEG 版本": "MPEG バージョン",
  "层": "レイヤー",
  "CRC 是否省略": "CRC が省略されているか",
  "采样率索引": "サンプルレートインデックス",
  "声道配置": "チャンネル構成",
  "ADTS 帧长度": "ADTS フレーム長",
  "缓冲 fullness": "バッファ fullness",
  "原始数据块数量字段": "生データブロック数フィールド",
  "ID3v2 标识": "ID3v2 マーカー",
  "ID3 版本": "ID3 バージョン",
  "标签长度": "タグ長",
  "帧同步": "フレーム同期",
  "MPEG 音频版本": "MPEG 音声バージョン",
  "CRC 标志": "CRC フラグ",
  "码率索引": "ビットレートインデックス",
  "声道模式": "チャンネルモード"
};

const HEADER_NOTE_KO: Record<string, string> = {
  "文件大小 - 8": "파일 크기 - 8",
  "子块 ID": "서브청크 ID",
  "子块数据长度": "서브청크 데이터 길이",
  "音频数据区域": "오디오 데이터 영역",
  "未展开子块": "펼치지 않은 서브청크",
  "fmt 子块过短": "fmt 서브청크가 너무 짧음",
  "编码格式": "인코딩 형식",
  "通道数": "채널 수",
  "采样率": "샘플레이트",
  "字节率": "바이트 레이트",
  "每帧字节数": "프레임당 바이트 수",
  "位深": "비트 깊이",
  "扩展参数长度": "확장 매개변수 길이",
  "有效位深": "유효 비트 깊이",
  "声道布局掩码": "채널 레이아웃 마스크",
  "FLAC 标识": "FLAC 마커",
  "元数据块头": "메타데이터 블록 헤더",
  "元数据块长度": "메타데이터 블록 길이",
  "元数据块内容": "메타데이터 블록 페이로드",
  "最小块大小": "최소 블록 크기",
  "最大块大小": "최대 블록 크기",
  "最小帧大小": "최소 프레임 크기",
  "最大帧大小": "최대 프레임 크기",
  "总采样数": "총 샘플 수",
  "原始音频 MD5": "원본 오디오 MD5",
  "Ogg 页标识": "Ogg 페이지 마커",
  "流结构版本": "스트림 구조 버전",
  "页类型标志": "페이지 유형 플래그",
  "绝对位置": "절대 위치",
  "逻辑流序号": "논리 스트림 일련번호",
  "页序号": "페이지 시퀀스 번호",
  "页校验和": "페이지 체크섬",
  "segment 数": "segment 수",
  "segment 长度表": "segment 길이 테이블",
  "页数据": "페이지 페이로드",
  "Opus 识别头": "Opus 식별 헤더",
  "版本": "버전",
  "预跳过采样数": "프리스킵 샘플 수",
  "输入采样率": "입력 샘플레이트",
  "输出增益": "출력 게인",
  "声道映射族": "채널 매핑 패밀리",
  "识别头": "식별 헤더",
  "Vorbis 标识": "Vorbis 마커",
  "box 大小": "box 크기",
  "box 类型": "box 유형",
  "主品牌": "주 브랜드",
  "次版本": "마이너 버전",
  "兼容品牌": "호환 브랜드",
  "标志": "플래그",
  "时间刻度": "타임스케일",
  "时长单位数": "지속 시간 단위 수",
  "处理器类型": "핸들러 유형",
  "样本描述数量": "샘플 설명 수",
  "样本类型": "샘플 유형",
  "同步字": "동기 워드",
  "MPEG 版本": "MPEG 버전",
  "层": "레이어",
  "CRC 是否省略": "CRC 생략 여부",
  "采样率索引": "샘플레이트 인덱스",
  "声道配置": "채널 구성",
  "ADTS 帧长度": "ADTS 프레임 길이",
  "缓冲 fullness": "버퍼 fullness",
  "原始数据块数量字段": "원시 데이터 블록 수 필드",
  "ID3v2 标识": "ID3v2 마커",
  "ID3 版本": "ID3 버전",
  "标签长度": "태그 길이",
  "帧同步": "프레임 동기",
  "MPEG 音频版本": "MPEG 오디오 버전",
  "CRC 标志": "CRC 플래그",
  "码率索引": "비트레이트 인덱스",
  "声道模式": "채널 모드"
};

const HEADER_NOTE_FR: Record<string, string> = {
  "文件大小 - 8": "Taille du fichier - 8",
  "子块 ID": "ID de sous-chunk",
  "子块数据长度": "Longueur des données du sous-chunk",
  "音频数据区域": "Zone de données audio",
  "未展开子块": "Sous-chunk non développé",
  "fmt 子块过短": "Sous-chunk fmt trop court",
  "编码格式": "Format d'encodage",
  "通道数": "Nombre de canaux",
  "采样率": "Fréquence d'échantillonnage",
  "字节率": "Débit en octets",
  "每帧字节数": "Octets par trame",
  "位深": "Profondeur de bits",
  "扩展参数长度": "Longueur des paramètres étendus",
  "有效位深": "Profondeur de bits valide",
  "声道布局掩码": "Masque de disposition des canaux",
  "FLAC 标识": "Marqueur FLAC",
  "元数据块头": "En-tête du bloc de métadonnées",
  "元数据块长度": "Longueur du bloc de métadonnées",
  "元数据块内容": "Contenu du bloc de métadonnées",
  "最小块大小": "Taille minimale de bloc",
  "最大块大小": "Taille maximale de bloc",
  "最小帧大小": "Taille minimale de trame",
  "最大帧大小": "Taille maximale de trame",
  "总采样数": "Nombre total d'échantillons",
  "原始音频 MD5": "MD5 de l'audio brut",
  "Ogg 页标识": "Marqueur de page Ogg",
  "流结构版本": "Version de structure du flux",
  "页类型标志": "Drapeaux de type de page",
  "绝对位置": "Position absolue",
  "逻辑流序号": "Numéro de série du flux logique",
  "页序号": "Numéro de séquence de page",
  "页校验和": "Somme de contrôle de page",
  "segment 数": "Nombre de segments",
  "segment 长度表": "Table des longueurs de segments",
  "页数据": "Données de page",
  "Opus 识别头": "En-tête d'identification Opus",
  "版本": "Version",
  "预跳过采样数": "Nombre d'échantillons pré-sautés",
  "输入采样率": "Fréquence d'échantillonnage d'entrée",
  "输出增益": "Gain de sortie",
  "声道映射族": "Famille de mappage des canaux",
  "识别头": "En-tête d'identification",
  "Vorbis 标识": "Marqueur Vorbis",
  "box 大小": "Taille de box",
  "box 类型": "Type de box",
  "主品牌": "Marque principale",
  "次版本": "Version mineure",
  "兼容品牌": "Marques compatibles",
  "标志": "Drapeaux",
  "时间刻度": "Échelle temporelle",
  "时长单位数": "Unités de durée",
  "处理器类型": "Type de gestionnaire",
  "样本描述数量": "Nombre de descriptions d'échantillon",
  "样本类型": "Type d'échantillon",
  "同步字": "Mot de synchronisation",
  "MPEG 版本": "Version MPEG",
  "层": "Couche",
  "CRC 是否省略": "CRC absent ou non",
  "采样率索引": "Indice de fréquence d'échantillonnage",
  "声道配置": "Configuration des canaux",
  "ADTS 帧长度": "Longueur de trame ADTS",
  "缓冲 fullness": "Remplissage du tampon",
  "原始数据块数量字段": "Champ du nombre de blocs de données brutes",
  "ID3v2 标识": "Marqueur ID3v2",
  "ID3 版本": "Version ID3",
  "标签长度": "Longueur de balise",
  "帧同步": "Synchronisation de trame",
  "MPEG 音频版本": "Version audio MPEG",
  "CRC 标志": "Drapeau CRC",
  "码率索引": "Indice de débit",
  "声道模式": "Mode de canaux"
};

const HEADER_NOTE_DE: Record<string, string> = {
  "文件大小 - 8": "Dateigröße - 8",
  "子块 ID": "Subchunk-ID",
  "子块数据长度": "Subchunk-Datenlänge",
  "音频数据区域": "Audiodatenbereich",
  "未展开子块": "Nicht erweiterter Subchunk",
  "fmt 子块过短": "fmt-Subchunk ist zu kurz",
  "编码格式": "Kodierungsformat",
  "通道数": "Kanalanzahl",
  "采样率": "Abtastrate",
  "字节率": "Byte-Rate",
  "每帧字节数": "Bytes pro Frame",
  "位深": "Bittiefe",
  "扩展参数长度": "Länge der Erweiterungsparameter",
  "有效位深": "Gültige Bittiefe",
  "声道布局掩码": "Kanallayout-Maske",
  "FLAC 标识": "FLAC-Marker",
  "元数据块头": "Metadatenblock-Header",
  "元数据块长度": "Metadatenblock-Länge",
  "元数据块内容": "Metadatenblock-Inhalt",
  "最小块大小": "Minimale Blockgröße",
  "最大块大小": "Maximale Blockgröße",
  "最小帧大小": "Minimale Framegröße",
  "最大帧大小": "Maximale Framegröße",
  "总采样数": "Gesamtzahl der Samples",
  "原始音频 MD5": "MD5 der Roh-Audiodaten",
  "Ogg 页标识": "Ogg-Seitenmarker",
  "流结构版本": "Streamstruktur-Version",
  "页类型标志": "Seitentyp-Flags",
  "绝对位置": "Absolute Position",
  "逻辑流序号": "Seriennummer des logischen Streams",
  "页序号": "Seitensequenznummer",
  "页校验和": "Seitenprüfsumme",
  "segment 数": "Segmentanzahl",
  "segment 长度表": "Segmentlängentabelle",
  "页数据": "Seitendaten",
  "Opus 识别头": "Opus-Identifikationsheader",
  "版本": "Version",
  "预跳过采样数": "Pre-skip-Sampleanzahl",
  "输入采样率": "Eingabe-Abtastrate",
  "输出增益": "Ausgabeverstärkung",
  "声道映射族": "Kanalmapping-Familie",
  "识别头": "Identifikationsheader",
  "Vorbis 标识": "Vorbis-Marker",
  "box 大小": "Box-Größe",
  "box 类型": "Box-Typ",
  "主品牌": "Hauptmarke",
  "次版本": "Nebenversion",
  "兼容品牌": "Kompatible Marken",
  "标志": "Flags",
  "时间刻度": "Zeitskala",
  "时长单位数": "Dauereinheiten",
  "处理器类型": "Handler-Typ",
  "样本描述数量": "Anzahl der Sample-Beschreibungen",
  "样本类型": "Sample-Typ",
  "同步字": "Syncwort",
  "MPEG 版本": "MPEG-Version",
  "层": "Layer",
  "CRC 是否省略": "Ob CRC fehlt",
  "采样率索引": "Abtastratenindex",
  "声道配置": "Kanalkonfiguration",
  "ADTS 帧长度": "ADTS-Frame-Länge",
  "缓冲 fullness": "Pufferfüllstand",
  "原始数据块数量字段": "Feld für Anzahl der Rohdatenblöcke",
  "ID3v2 标识": "ID3v2-Marker",
  "ID3 版本": "ID3-Version",
  "标签长度": "Tag-Länge",
  "帧同步": "Frame-Synchronisation",
  "MPEG 音频版本": "MPEG-Audioversion",
  "CRC 标志": "CRC-Flag",
  "码率索引": "Bitratenindex",
  "声道模式": "Kanalmodus"
};

const HEADER_NOTE_ES: Record<string, string> = {
  "文件大小 - 8": "Tamaño del archivo - 8",
  "子块 ID": "ID de subchunk",
  "子块数据长度": "Longitud de datos del subchunk",
  "音频数据区域": "Región de datos de audio",
  "未展开子块": "Subchunk no expandido",
  "fmt 子块过短": "El subchunk fmt es demasiado corto",
  "编码格式": "Formato de codificación",
  "通道数": "Número de canales",
  "采样率": "Frecuencia de muestreo",
  "字节率": "Tasa de bytes",
  "每帧字节数": "Bytes por trama",
  "位深": "Profundidad de bits",
  "扩展参数长度": "Longitud de parámetros extendidos",
  "有效位深": "Profundidad de bits válida",
  "声道布局掩码": "Máscara de disposición de canales",
  "FLAC 标识": "Marcador FLAC",
  "元数据块头": "Cabecera del bloque de metadatos",
  "元数据块长度": "Longitud del bloque de metadatos",
  "元数据块内容": "Contenido del bloque de metadatos",
  "最小块大小": "Tamaño mínimo de bloque",
  "最大块大小": "Tamaño máximo de bloque",
  "最小帧大小": "Tamaño mínimo de trama",
  "最大帧大小": "Tamaño máximo de trama",
  "总采样数": "Total de muestras",
  "原始音频 MD5": "MD5 del audio sin procesar",
  "Ogg 页标识": "Marcador de página Ogg",
  "流结构版本": "Versión de estructura del flujo",
  "页类型标志": "Banderas de tipo de página",
  "绝对位置": "Posición absoluta",
  "逻辑流序号": "Número de serie del flujo lógico",
  "页序号": "Número de secuencia de página",
  "页校验和": "Suma de comprobación de página",
  "segment 数": "Número de segmentos",
  "segment 长度表": "Tabla de longitudes de segmentos",
  "页数据": "Datos de página",
  "Opus 识别头": "Cabecera de identificación Opus",
  "版本": "Versión",
  "预跳过采样数": "Número de muestras pre-skip",
  "输入采样率": "Frecuencia de muestreo de entrada",
  "输出增益": "Ganancia de salida",
  "声道映射族": "Familia de mapeo de canales",
  "识别头": "Cabecera de identificación",
  "Vorbis 标识": "Marcador Vorbis",
  "box 大小": "Tamaño de box",
  "box 类型": "Tipo de box",
  "主品牌": "Marca principal",
  "次版本": "Versión menor",
  "兼容品牌": "Marcas compatibles",
  "标志": "Banderas",
  "时间刻度": "Escala de tiempo",
  "时长单位数": "Unidades de duración",
  "处理器类型": "Tipo de manejador",
  "样本描述数量": "Número de descripciones de muestra",
  "样本类型": "Tipo de muestra",
  "同步字": "Palabra de sincronización",
  "MPEG 版本": "Versión MPEG",
  "层": "Capa",
  "CRC 是否省略": "Si CRC está ausente",
  "采样率索引": "Índice de frecuencia de muestreo",
  "声道配置": "Configuración de canales",
  "ADTS 帧长度": "Longitud de trama ADTS",
  "缓冲 fullness": "Llenado del búfer",
  "原始数据块数量字段": "Campo de número de bloques de datos sin procesar",
  "ID3v2 标识": "Marcador ID3v2",
  "ID3 版本": "Versión ID3",
  "标签长度": "Longitud de etiqueta",
  "帧同步": "Sincronización de trama",
  "MPEG 音频版本": "Versión de audio MPEG",
  "CRC 标志": "Bandera CRC",
  "码率索引": "Índice de bitrate",
  "声道模式": "Modo de canales"
};

const HEADER_NOTE_IT: Record<string, string> = {
  "文件大小 - 8": "Dimensione file - 8",
  "子块 ID": "ID sotto-blocco",
  "子块数据长度": "Lunghezza dati del sotto-blocco",
  "音频数据区域": "Area dati audio",
  "未展开子块": "Sotto-blocco non espanso",
  "fmt 子块过短": "Sotto-blocco fmt troppo corto",
  "编码格式": "Formato di codifica",
  "通道数": "Numero di canali",
  "采样率": "Frequenza di campionamento",
  "字节率": "Byte rate",
  "每帧字节数": "Byte per frame",
  "位深": "Profondità in bit",
  "扩展参数长度": "Lunghezza parametri estesi",
  "有效位深": "Profondità valida in bit",
  "声道布局掩码": "Maschera layout canali",
  "FLAC 标识": "Marcatore FLAC",
  "元数据块头": "Header blocco metadati",
  "元数据块长度": "Lunghezza blocco metadati",
  "元数据块内容": "Contenuto blocco metadati",
  "最小块大小": "Dimensione minima blocco",
  "最大块大小": "Dimensione massima blocco",
  "最小帧大小": "Dimensione minima frame",
  "最大帧大小": "Dimensione massima frame",
  "总采样数": "Campioni totali",
  "原始音频 MD5": "MD5 audio grezzo",
  "Ogg 页标识": "Marcatore pagina Ogg",
  "流结构版本": "Versione struttura stream",
  "页类型标志": "Flag tipo pagina",
  "绝对位置": "Posizione assoluta",
  "逻辑流序号": "Numero seriale stream logico",
  "页序号": "Numero sequenza pagina",
  "页校验和": "Checksum pagina",
  "segment 数": "Numero segmenti",
  "segment 长度表": "Tabella lunghezze segmenti",
  "页数据": "Payload pagina",
  "Opus 识别头": "Header identificazione Opus",
  "版本": "Versione",
  "预跳过采样数": "Numero campioni pre-skip",
  "输入采样率": "Frequenza di campionamento in ingresso",
  "输出增益": "Guadagno in uscita",
  "声道映射族": "Famiglia mappatura canali",
  "识别头": "Header identificazione",
  "Vorbis 标识": "Marcatore Vorbis",
  "box 大小": "Dimensione box",
  "box 类型": "Tipo box",
  "主品牌": "Brand principale",
  "次版本": "Versione minore",
  "兼容品牌": "Brand compatibili",
  "标志": "Flag",
  "时间刻度": "Scala temporale",
  "时长单位数": "Unità di durata",
  "处理器类型": "Tipo handler",
  "样本描述数量": "Numero descrizioni campione",
  "样本类型": "Tipo campione",
  "同步字": "Parola di sync",
  "MPEG 版本": "Versione MPEG",
  "层": "Layer",
  "CRC 是否省略": "Se CRC è assente",
  "采样率索引": "Indice frequenza di campionamento",
  "声道配置": "Configurazione canali",
  "ADTS 帧长度": "Lunghezza frame ADTS",
  "缓冲 fullness": "Pienezza buffer",
  "原始数据块数量字段": "Campo numero blocchi dati grezzi",
  "ID3v2 标识": "Marcatore ID3v2",
  "ID3 版本": "Versione ID3",
  "标签长度": "Lunghezza tag",
  "帧同步": "Sync frame",
  "MPEG 音频版本": "Versione audio MPEG",
  "CRC 标志": "Flag CRC",
  "码率索引": "Indice bitrate",
  "声道模式": "Modalità canali"
};

const HEADER_NOTE_PT: Record<string, string> = {
  "文件大小 - 8": "Tamanho do arquivo - 8",
  "子块 ID": "ID do subchunk",
  "子块数据长度": "Comprimento dos dados do subchunk",
  "音频数据区域": "Região de dados de áudio",
  "未展开子块": "Subchunk não expandido",
  "fmt 子块过短": "Subchunk fmt curto demais",
  "编码格式": "Formato de codificação",
  "通道数": "Número de canais",
  "采样率": "Taxa de amostragem",
  "字节率": "Taxa de bytes",
  "每帧字节数": "Bytes por quadro",
  "位深": "Profundidade de bits",
  "扩展参数长度": "Comprimento dos parâmetros estendidos",
  "有效位深": "Profundidade de bits válida",
  "声道布局掩码": "Máscara de layout de canais",
  "FLAC 标识": "Marcador FLAC",
  "元数据块头": "Cabeçalho do bloco de metadados",
  "元数据块长度": "Comprimento do bloco de metadados",
  "元数据块内容": "Conteúdo do bloco de metadados",
  "最小块大小": "Tamanho mínimo de bloco",
  "最大块大小": "Tamanho máximo de bloco",
  "最小帧大小": "Tamanho mínimo de quadro",
  "最大帧大小": "Tamanho máximo de quadro",
  "总采样数": "Total de amostras",
  "原始音频 MD5": "MD5 do áudio bruto",
  "Ogg 页标识": "Marcador de página Ogg",
  "流结构版本": "Versão da estrutura do fluxo",
  "页类型标志": "Flags de tipo de página",
  "绝对位置": "Posição absoluta",
  "逻辑流序号": "Número serial do fluxo lógico",
  "页序号": "Número de sequência da página",
  "页校验和": "Checksum da página",
  "segment 数": "Número de segmentos",
  "segment 长度表": "Tabela de comprimentos dos segmentos",
  "页数据": "Payload da página",
  "Opus 识别头": "Cabeçalho de identificação Opus",
  "版本": "Versão",
  "预跳过采样数": "Número de amostras pre-skip",
  "输入采样率": "Taxa de amostragem de entrada",
  "输出增益": "Ganho de saída",
  "声道映射族": "Família de mapeamento de canais",
  "识别头": "Cabeçalho de identificação",
  "Vorbis 标识": "Marcador Vorbis",
  "box 大小": "Tamanho da box",
  "box 类型": "Tipo da box",
  "主品牌": "Marca principal",
  "次版本": "Versão menor",
  "兼容品牌": "Marcas compatíveis",
  "标志": "Flags",
  "时间刻度": "Escala de tempo",
  "时长单位数": "Unidades de duração",
  "处理器类型": "Tipo de handler",
  "样本描述数量": "Número de descrições de amostra",
  "样本类型": "Tipo de amostra",
  "同步字": "Palavra de sincronização",
  "MPEG 版本": "Versão MPEG",
  "层": "Camada",
  "CRC 是否省略": "Se o CRC está ausente",
  "采样率索引": "Índice da taxa de amostragem",
  "声道配置": "Configuração de canais",
  "ADTS 帧长度": "Comprimento do quadro ADTS",
  "缓冲 fullness": "Preenchimento do buffer",
  "原始数据块数量字段": "Campo de número de blocos de dados brutos",
  "ID3v2 标识": "Marcador ID3v2",
  "ID3 版本": "Versão ID3",
  "标签长度": "Comprimento da tag",
  "帧同步": "Sincronização de quadro",
  "MPEG 音频版本": "Versão de áudio MPEG",
  "CRC 标志": "Flag CRC",
  "码率索引": "Índice de bitrate",
  "声道模式": "Modo de canais"
};

const HEADER_NOTE_RU: Record<string, string> = {
  "文件大小 - 8": "Размер файла - 8",
  "子块 ID": "ID подблока",
  "子块数据长度": "Длина данных подблока",
  "音频数据区域": "Область аудиоданных",
  "未展开子块": "Неразвернутый подблок",
  "fmt 子块过短": "Подблок fmt слишком короткий",
  "编码格式": "Формат кодирования",
  "通道数": "Число каналов",
  "采样率": "Частота дискретизации",
  "字节率": "Байтовая скорость",
  "每帧字节数": "Байт на кадр",
  "位深": "Битовая глубина",
  "扩展参数长度": "Длина расширенных параметров",
  "有效位深": "Действительная битовая глубина",
  "声道布局掩码": "Маска раскладки каналов",
  "FLAC 标识": "Маркер FLAC",
  "元数据块头": "Заголовок блока метаданных",
  "元数据块长度": "Длина блока метаданных",
  "元数据块内容": "Содержимое блока метаданных",
  "最小块大小": "Минимальный размер блока",
  "最大块大小": "Максимальный размер блока",
  "最小帧大小": "Минимальный размер кадра",
  "最大帧大小": "Максимальный размер кадра",
  "总采样数": "Всего сэмплов",
  "原始音频 MD5": "MD5 исходного аудио",
  "Ogg 页标识": "Маркер страницы Ogg",
  "流结构版本": "Версия структуры потока",
  "页类型标志": "Флаги типа страницы",
  "绝对位置": "Абсолютная позиция",
  "逻辑流序号": "Серийный номер логического потока",
  "页序号": "Порядковый номер страницы",
  "页校验和": "Контрольная сумма страницы",
  "segment 数": "Число сегментов",
  "segment 长度表": "Таблица длин сегментов",
  "页数据": "Данные страницы",
  "Opus 识别头": "Идентификационный заголовок Opus",
  "版本": "Версия",
  "预跳过采样数": "Число pre-skip сэмплов",
  "输入采样率": "Входная частота дискретизации",
  "输出增益": "Выходное усиление",
  "声道映射族": "Семейство отображения каналов",
  "识别头": "Идентификационный заголовок",
  "Vorbis 标识": "Маркер Vorbis",
  "box 大小": "Размер box",
  "box 类型": "Тип box",
  "主品牌": "Основной бренд",
  "次版本": "Младшая версия",
  "兼容品牌": "Совместимые бренды",
  "标志": "Флаги",
  "时间刻度": "Шкала времени",
  "时长单位数": "Единицы длительности",
  "处理器类型": "Тип обработчика",
  "样本描述数量": "Число описаний сэмплов",
  "样本类型": "Тип сэмпла",
  "同步字": "Синхрослово",
  "MPEG 版本": "Версия MPEG",
  "层": "Слой",
  "CRC 是否省略": "Отсутствует ли CRC",
  "采样率索引": "Индекс частоты дискретизации",
  "声道配置": "Конфигурация каналов",
  "ADTS 帧长度": "Длина кадра ADTS",
  "缓冲 fullness": "Заполненность буфера",
  "原始数据块数量字段": "Поле числа блоков сырых данных",
  "ID3v2 标识": "Маркер ID3v2",
  "ID3 版本": "Версия ID3",
  "标签长度": "Длина тега",
  "帧同步": "Синхронизация кадра",
  "MPEG 音频版本": "Версия аудио MPEG",
  "CRC 标志": "Флаг CRC",
  "码率索引": "Индекс битрейта",
  "声道模式": "Режим каналов"
};

const HEADER_NOTE_NL: Record<string, string> = {
  "文件大小 - 8": "Bestandsgrootte - 8",
  "子块 ID": "Subchunk-ID",
  "子块数据长度": "Gegevenslengte van subchunk",
  "音频数据区域": "Audiogegevensgebied",
  "未展开子块": "Niet-uitgevouwen subchunk",
  "fmt 子块过短": "fmt-subchunk is te kort",
  "编码格式": "Coderingsformaat",
  "通道数": "Aantal kanalen",
  "采样率": "Samplefrequentie",
  "字节率": "Bytefrequentie",
  "每帧字节数": "Bytes per frame",
  "位深": "Bitdiepte",
  "扩展参数长度": "Lengte van uitbreidingsparameters",
  "有效位深": "Geldige bitdiepte",
  "声道布局掩码": "Kanaalindelingsmasker",
  "FLAC 标识": "FLAC-markering",
  "元数据块头": "Header van metadatablok",
  "元数据块长度": "Lengte van metadatablok",
  "元数据块内容": "Inhoud van metadatablok",
  "最小块大小": "Minimale blokgrootte",
  "最大块大小": "Maximale blokgrootte",
  "最小帧大小": "Minimale framegrootte",
  "最大帧大小": "Maximale framegrootte",
  "总采样数": "Totaal aantal samples",
  "原始音频 MD5": "MD5 van ruwe audio",
  "Ogg 页标识": "Ogg-paginamarkering",
  "流结构版本": "Versie van streamstructuur",
  "页类型标志": "Paginatypevlaggen",
  "绝对位置": "Absolute positie",
  "逻辑流序号": "Serienummer van logische stream",
  "页序号": "Paginavolgnummer",
  "页校验和": "Paginacontrolesom",
  "segment 数": "Aantal segmenten",
  "segment 长度表": "Segmentlengtetabel",
  "页数据": "Paginagegevens",
  "Opus 识别头": "Opus-identificatieheader",
  "版本": "Versie",
  "预跳过采样数": "Aantal pre-skip samples",
  "输入采样率": "Invoersamplefrequentie",
  "输出增益": "Uitvoerversterking",
  "声道映射族": "Kanaaltoewijzingsfamilie",
  "识别头": "Identificatieheader",
  "Vorbis 标识": "Vorbis-markering",
  "box 大小": "Boxgrootte",
  "box 类型": "Boxtype",
  "主品牌": "Hoofdmerk",
  "次版本": "Minorversie",
  "兼容品牌": "Compatibele merken",
  "标志": "Vlaggen",
  "时间刻度": "Tijdschaal",
  "时长单位数": "Duur-eenheden",
  "处理器类型": "Handlertype",
  "样本描述数量": "Aantal samplebeschrijvingen",
  "样本类型": "Sampletype",
  "同步字": "Synchronisatiewoord",
  "MPEG 版本": "MPEG-versie",
  "层": "Laag",
  "CRC 是否省略": "Of CRC ontbreekt",
  "采样率索引": "Samplefrequentie-index",
  "声道配置": "Kanaalconfiguratie",
  "ADTS 帧长度": "ADTS-framelengte",
  "缓冲 fullness": "Buffervulling",
  "原始数据块数量字段": "Veld voor aantal ruwe datablokken",
  "ID3v2 标识": "ID3v2-markering",
  "ID3 版本": "ID3-versie",
  "标签长度": "Taglengte",
  "帧同步": "Framesynchronisatie",
  "MPEG 音频版本": "MPEG-audioversie",
  "CRC 标志": "CRC-vlag",
  "码率索引": "Bitrate-index",
  "声道模式": "Kanaalmodus"
};

const HEADER_NOTE_PL: Record<string, string> = {
  "文件大小 - 8": "Rozmiar pliku - 8",
  "子块 ID": "ID podbloku",
  "子块数据长度": "Długość danych podbloku",
  "音频数据区域": "Obszar danych audio",
  "未展开子块": "Nierozwinięty podblok",
  "fmt 子块过短": "Podblok fmt jest zbyt krótki",
  "编码格式": "Format kodowania",
  "通道数": "Liczba kanałów",
  "采样率": "Częstotliwość próbkowania",
  "字节率": "Szybkość bajtowa",
  "每帧字节数": "Bajtów na ramkę",
  "位深": "Głębia bitowa",
  "扩展参数长度": "Długość parametrów rozszerzenia",
  "有效位深": "Prawidłowa głębia bitowa",
  "声道布局掩码": "Maska układu kanałów",
  "FLAC 标识": "Znacznik FLAC",
  "元数据块头": "Nagłówek bloku metadanych",
  "元数据块长度": "Długość bloku metadanych",
  "元数据块内容": "Zawartość bloku metadanych",
  "最小块大小": "Minimalny rozmiar bloku",
  "最大块大小": "Maksymalny rozmiar bloku",
  "最小帧大小": "Minimalny rozmiar ramki",
  "最大帧大小": "Maksymalny rozmiar ramki",
  "总采样数": "Łączna liczba próbek",
  "原始音频 MD5": "MD5 surowego audio",
  "Ogg 页标识": "Znacznik strony Ogg",
  "流结构版本": "Wersja struktury strumienia",
  "页类型标志": "Flagi typu strony",
  "绝对位置": "Pozycja bezwzględna",
  "逻辑流序号": "Numer seryjny strumienia logicznego",
  "页序号": "Numer sekwencji strony",
  "页校验和": "Suma kontrolna strony",
  "segment 数": "Liczba segmentów",
  "segment 长度表": "Tabela długości segmentów",
  "页数据": "Dane strony",
  "Opus 识别头": "Nagłówek identyfikacyjny Opus",
  "版本": "Wersja",
  "预跳过采样数": "Liczba próbek pre-skip",
  "输入采样率": "Wejściowa częstotliwość próbkowania",
  "输出增益": "Wzmocnienie wyjściowe",
  "声道映射族": "Rodzina mapowania kanałów",
  "识别头": "Nagłówek identyfikacyjny",
  "Vorbis 标识": "Znacznik Vorbis",
  "box 大小": "Rozmiar box",
  "box 类型": "Typ box",
  "主品牌": "Główna marka",
  "次版本": "Wersja podrzędna",
  "兼容品牌": "Zgodne marki",
  "标志": "Flagi",
  "时间刻度": "Skala czasu",
  "时长单位数": "Jednostki czasu trwania",
  "处理器类型": "Typ handlera",
  "样本描述数量": "Liczba opisów próbek",
  "样本类型": "Typ próbki",
  "同步字": "Słowo synchronizacji",
  "MPEG 版本": "Wersja MPEG",
  "层": "Warstwa",
  "CRC 是否省略": "Czy CRC jest pominięte",
  "采样率索引": "Indeks częstotliwości próbkowania",
  "声道配置": "Konfiguracja kanałów",
  "ADTS 帧长度": "Długość ramki ADTS",
  "缓冲 fullness": "Wypełnienie bufora",
  "原始数据块数量字段": "Pole liczby bloków surowych danych",
  "ID3v2 标识": "Znacznik ID3v2",
  "ID3 版本": "Wersja ID3",
  "标签长度": "Długość tagu",
  "帧同步": "Synchronizacja ramki",
  "MPEG 音频版本": "Wersja audio MPEG",
  "CRC 标志": "Flaga CRC",
  "码率索引": "Indeks bitrate",
  "声道模式": "Tryb kanałów"
};

const HEADER_NOTE_TR: Record<string, string> = {
  "文件大小 - 8": "Dosya boyutu - 8",
  "子块 ID": "Alt parça ID",
  "子块数据长度": "Alt parça veri uzunluğu",
  "音频数据区域": "Ses veri bölgesi",
  "未展开子块": "Genişletilmemiş alt parça",
  "fmt 子块过短": "fmt alt parçası çok kısa",
  "编码格式": "Kodlama formatı",
  "通道数": "Kanal sayısı",
  "采样率": "Örnekleme hızı",
  "字节率": "Bayt hızı",
  "每帧字节数": "Kare başına bayt",
  "位深": "Bit derinliği",
  "扩展参数长度": "Genişletme parametresi uzunluğu",
  "有效位深": "Geçerli bit derinliği",
  "声道布局掩码": "Kanal düzeni maskesi",
  "FLAC 标识": "FLAC işareti",
  "元数据块头": "Meta veri blok başlığı",
  "元数据块长度": "Meta veri blok uzunluğu",
  "元数据块内容": "Meta veri blok içeriği",
  "最小块大小": "En küçük blok boyutu",
  "最大块大小": "En büyük blok boyutu",
  "最小帧大小": "En küçük kare boyutu",
  "最大帧大小": "En büyük kare boyutu",
  "总采样数": "Toplam örnek sayısı",
  "原始音频 MD5": "Ham ses MD5",
  "Ogg 页标识": "Ogg sayfa işareti",
  "流结构版本": "Akış yapısı sürümü",
  "页类型标志": "Sayfa türü bayrakları",
  "绝对位置": "Mutlak konum",
  "逻辑流序号": "Mantıksal akış seri numarası",
  "页序号": "Sayfa sıra numarası",
  "页校验和": "Sayfa sağlama toplamı",
  "segment 数": "Segment sayısı",
  "segment 长度表": "Segment uzunluk tablosu",
  "页数据": "Sayfa verisi",
  "Opus 识别头": "Opus tanımlama başlığı",
  "版本": "Sürüm",
  "预跳过采样数": "Pre-skip örnek sayısı",
  "输入采样率": "Giriş örnekleme hızı",
  "输出增益": "Çıkış kazancı",
  "声道映射族": "Kanal eşleme ailesi",
  "识别头": "Tanımlama başlığı",
  "Vorbis 标识": "Vorbis işareti",
  "box 大小": "Box boyutu",
  "box 类型": "Box türü",
  "主品牌": "Ana marka",
  "次版本": "Alt sürüm",
  "兼容品牌": "Uyumlu markalar",
  "标志": "Bayraklar",
  "时间刻度": "Zaman ölçeği",
  "时长单位数": "Süre birimleri",
  "处理器类型": "Handler türü",
  "样本描述数量": "Örnek açıklaması sayısı",
  "样本类型": "Örnek türü",
  "同步字": "Senkronizasyon sözcüğü",
  "MPEG 版本": "MPEG sürümü",
  "层": "Katman",
  "CRC 是否省略": "CRC yok mu",
  "采样率索引": "Örnekleme hızı indeksi",
  "声道配置": "Kanal yapılandırması",
  "ADTS 帧长度": "ADTS kare uzunluğu",
  "缓冲 fullness": "Tampon doluluğu",
  "原始数据块数量字段": "Ham veri bloğu sayısı alanı",
  "ID3v2 标识": "ID3v2 işareti",
  "ID3 版本": "ID3 sürümü",
  "标签长度": "Etiket uzunluğu",
  "帧同步": "Kare senkronizasyonu",
  "MPEG 音频版本": "MPEG ses sürümü",
  "CRC 标志": "CRC bayrağı",
  "码率索引": "Bitrate indeksi",
  "声道模式": "Kanal modu"
};

const HEADER_NOTE_ID: Record<string, string> = {
  "文件大小 - 8": "Ukuran file - 8",
  "子块 ID": "ID subchunk",
  "子块数据长度": "Panjang data subchunk",
  "音频数据区域": "Area data audio",
  "未展开子块": "Subchunk yang belum dibuka",
  "fmt 子块过短": "Subchunk fmt terlalu pendek",
  "编码格式": "Format pengodean",
  "通道数": "Jumlah kanal",
  "采样率": "Laju sampel",
  "字节率": "Laju byte",
  "每帧字节数": "Byte per frame",
  "位深": "Kedalaman bit",
  "扩展参数长度": "Panjang parameter ekstensi",
  "有效位深": "Kedalaman bit valid",
  "声道布局掩码": "Mask layout kanal",
  "FLAC 标识": "Penanda FLAC",
  "元数据块头": "Header blok metadata",
  "元数据块长度": "Panjang blok metadata",
  "元数据块内容": "Isi blok metadata",
  "最小块大小": "Ukuran blok minimum",
  "最大块大小": "Ukuran blok maksimum",
  "最小帧大小": "Ukuran frame minimum",
  "最大帧大小": "Ukuran frame maksimum",
  "总采样数": "Total sampel",
  "原始音频 MD5": "MD5 audio mentah",
  "Ogg 页标识": "Penanda halaman Ogg",
  "流结构版本": "Versi struktur stream",
  "页类型标志": "Flag tipe halaman",
  "绝对位置": "Posisi absolut",
  "逻辑流序号": "Nomor seri stream logis",
  "页序号": "Nomor urut halaman",
  "页校验和": "Checksum halaman",
  "segment 数": "Jumlah segment",
  "segment 长度表": "Tabel panjang segment",
  "页数据": "Payload halaman",
  "Opus 识别头": "Header identifikasi Opus",
  "版本": "Versi",
  "预跳过采样数": "Jumlah sampel pre-skip",
  "输入采样率": "Laju sampel input",
  "输出增益": "Gain output",
  "声道映射族": "Keluarga pemetaan kanal",
  "识别头": "Header identifikasi",
  "Vorbis 标识": "Penanda Vorbis",
  "box 大小": "Ukuran box",
  "box 类型": "Tipe box",
  "主品牌": "Brand utama",
  "次版本": "Versi minor",
  "兼容品牌": "Brand kompatibel",
  "标志": "Flag",
  "时间刻度": "Skala waktu",
  "时长单位数": "Unit durasi",
  "处理器类型": "Tipe handler",
  "样本描述数量": "Jumlah deskripsi sampel",
  "样本类型": "Tipe sampel",
  "同步字": "Kata sinkronisasi",
  "MPEG 版本": "Versi MPEG",
  "层": "Layer",
  "CRC 是否省略": "Apakah CRC tidak ada",
  "采样率索引": "Indeks laju sampel",
  "声道配置": "Konfigurasi kanal",
  "ADTS 帧长度": "Panjang frame ADTS",
  "缓冲 fullness": "Kepenuhan buffer",
  "原始数据块数量字段": "Kolom jumlah blok data mentah",
  "ID3v2 标识": "Penanda ID3v2",
  "ID3 版本": "Versi ID3",
  "标签长度": "Panjang tag",
  "帧同步": "Sinkronisasi frame",
  "MPEG 音频版本": "Versi audio MPEG",
  "CRC 标志": "Flag CRC",
  "码率索引": "Indeks bitrate",
  "声道模式": "Mode kanal"
};

const HEADER_NOTE_NO: Record<string, string> = {
  "文件大小 - 8": "Filstørrelse - 8",
  "子块 ID": "Subchunk-ID",
  "子块数据长度": "Datalengde for subchunk",
  "音频数据区域": "Lyddataområde",
  "未展开子块": "Ikke-utvidet subchunk",
  "fmt 子块过短": "fmt-subchunk er for kort",
  "编码格式": "Kodingsformat",
  "通道数": "Antall kanaler",
  "采样率": "Samplingsrate",
  "字节率": "Byterate",
  "每帧字节数": "Byte per frame",
  "位深": "Bitdybde",
  "扩展参数长度": "Lengde på utvidelsesparametere",
  "有效位深": "Gyldig bitdybde",
  "声道布局掩码": "Kanallayoutmaske",
  "FLAC 标识": "FLAC-markør",
  "元数据块头": "Metadata-blokkhode",
  "元数据块长度": "Metadata-blokklengde",
  "元数据块内容": "Metadata-blokkinnhold",
  "最小块大小": "Minste blokkstørrelse",
  "最大块大小": "Største blokkstørrelse",
  "最小帧大小": "Minste framestørrelse",
  "最大帧大小": "Største framestørrelse",
  "总采样数": "Totalt antall samples",
  "原始音频 MD5": "MD5 for rå lyd",
  "Ogg 页标识": "Ogg-sidemarkør",
  "流结构版本": "Streamstrukturversjon",
  "页类型标志": "Sidetypeflagg",
  "绝对位置": "Absolutt posisjon",
  "逻辑流序号": "Serienummer for logisk stream",
  "页序号": "Sidesekvensnummer",
  "页校验和": "Sidekontrollsum",
  "segment 数": "Antall segmenter",
  "segment 长度表": "Segmentlengdetabell",
  "页数据": "Sidedata",
  "Opus 识别头": "Opus-identifikasjonshode",
  "版本": "Versjon",
  "预跳过采样数": "Antall pre-skip samples",
  "输入采样率": "Inngangssamplingsrate",
  "输出增益": "Utgangsforsterkning",
  "声道映射族": "Kanaltilordningsfamilie",
  "识别头": "Identifikasjonshode",
  "Vorbis 标识": "Vorbis-markør",
  "box 大小": "Box-størrelse",
  "box 类型": "Box-type",
  "主品牌": "Hovedmerke",
  "次版本": "Underversjon",
  "兼容品牌": "Kompatible merker",
  "标志": "Flagg",
  "时间刻度": "Tidsskala",
  "时长单位数": "Varighetsenheter",
  "处理器类型": "Handlertype",
  "样本描述数量": "Antall samplebeskrivelser",
  "样本类型": "Sampletype",
  "同步字": "Synkroniseringsord",
  "MPEG 版本": "MPEG-versjon",
  "层": "Lag",
  "CRC 是否省略": "Om CRC mangler",
  "采样率索引": "Samplingsrateindeks",
  "声道配置": "Kanalkonfigurasjon",
  "ADTS 帧长度": "ADTS-framelengde",
  "缓冲 fullness": "Bufferfylling",
  "原始数据块数量字段": "Felt for antall rådatablokker",
  "ID3v2 标识": "ID3v2-markør",
  "ID3 版本": "ID3-versjon",
  "标签长度": "Tagglengde",
  "帧同步": "Framesynkronisering",
  "MPEG 音频版本": "MPEG-lydversjon",
  "CRC 标志": "CRC-flagg",
  "码率索引": "Bitrateindeks",
  "声道模式": "Kanalmodus"
};

const HEADER_NOTE_VI: Record<string, string> = {
  "文件大小 - 8": "Kích thước tệp - 8",
  "子块 ID": "ID subchunk",
  "子块数据长度": "Độ dài dữ liệu subchunk",
  "音频数据区域": "Vùng dữ liệu âm thanh",
  "未展开子块": "Subchunk chưa mở rộng",
  "fmt 子块过短": "Subchunk fmt quá ngắn",
  "编码格式": "Định dạng mã hóa",
  "通道数": "Số kênh",
  "采样率": "Tần số lấy mẫu",
  "字节率": "Tốc độ byte",
  "每帧字节数": "Byte mỗi frame",
  "位深": "Độ sâu bit",
  "扩展参数长度": "Độ dài tham số mở rộng",
  "有效位深": "Độ sâu bit hợp lệ",
  "声道布局掩码": "Mặt nạ bố cục kênh",
  "FLAC 标识": "Dấu FLAC",
  "元数据块头": "Header khối metadata",
  "元数据块长度": "Độ dài khối metadata",
  "元数据块内容": "Nội dung khối metadata",
  "最小块大小": "Kích thước khối nhỏ nhất",
  "最大块大小": "Kích thước khối lớn nhất",
  "最小帧大小": "Kích thước frame nhỏ nhất",
  "最大帧大小": "Kích thước frame lớn nhất",
  "总采样数": "Tổng số mẫu",
  "原始音频 MD5": "MD5 âm thanh thô",
  "Ogg 页标识": "Dấu trang Ogg",
  "流结构版本": "Phiên bản cấu trúc stream",
  "页类型标志": "Cờ loại trang",
  "绝对位置": "Vị trí tuyệt đối",
  "逻辑流序号": "Số sê-ri stream logic",
  "页序号": "Số thứ tự trang",
  "页校验和": "Checksum trang",
  "segment 数": "Số segment",
  "segment 长度表": "Bảng độ dài segment",
  "页数据": "Payload trang",
  "Opus 识别头": "Header nhận dạng Opus",
  "版本": "Phiên bản",
  "预跳过采样数": "Số mẫu pre-skip",
  "输入采样率": "Tần số lấy mẫu đầu vào",
  "输出增益": "Gain đầu ra",
  "声道映射族": "Họ ánh xạ kênh",
  "识别头": "Header nhận dạng",
  "Vorbis 标识": "Dấu Vorbis",
  "box 大小": "Kích thước box",
  "box 类型": "Loại box",
  "主品牌": "Brand chính",
  "次版本": "Phiên bản phụ",
  "兼容品牌": "Brand tương thích",
  "标志": "Cờ",
  "时间刻度": "Thang thời gian",
  "时长单位数": "Đơn vị thời lượng",
  "处理器类型": "Loại handler",
  "样本描述数量": "Số mô tả mẫu",
  "样本类型": "Loại mẫu",
  "同步字": "Từ đồng bộ",
  "MPEG 版本": "Phiên bản MPEG",
  "层": "Lớp",
  "CRC 是否省略": "CRC có bị thiếu không",
  "采样率索引": "Chỉ mục tần số lấy mẫu",
  "声道配置": "Cấu hình kênh",
  "ADTS 帧长度": "Độ dài frame ADTS",
  "缓冲 fullness": "Độ đầy buffer",
  "原始数据块数量字段": "Trường số khối dữ liệu thô",
  "ID3v2 标识": "Dấu ID3v2",
  "ID3 版本": "Phiên bản ID3",
  "标签长度": "Độ dài tag",
  "帧同步": "Đồng bộ frame",
  "MPEG 音频版本": "Phiên bản âm thanh MPEG",
  "CRC 标志": "Cờ CRC",
  "码率索引": "Chỉ mục bitrate",
  "声道模式": "Chế độ kênh"
};

const HEADER_NOTES_BY_LOCALE: Partial<Record<LocaleCode, Record<string, string>>> = {
  "zh-TW": HEADER_NOTE_ZH_TW,
  en: HEADER_NOTE_EN,
  ja: HEADER_NOTE_JA,
  ko: HEADER_NOTE_KO,
  fr: HEADER_NOTE_FR,
  de: HEADER_NOTE_DE,
  es: HEADER_NOTE_ES,
  it: HEADER_NOTE_IT,
  pt: HEADER_NOTE_PT,
  ru: HEADER_NOTE_RU,
  nl: HEADER_NOTE_NL,
  pl: HEADER_NOTE_PL,
  tr: HEADER_NOTE_TR,
  id: HEADER_NOTE_ID,
  no: HEADER_NOTE_NO,
  vi: HEADER_NOTE_VI
};

export class AudioLensApp {
  private config: AudioLensConfig | undefined;
  private audioBuffer: AudioBuffer | undefined;
  private audioBytes: Uint8Array | undefined;
  private trackViews: TrackView[] = [];
  private defaultPcmFormat: PcmFormat | undefined;
  private currentFileName = "";
  private currentSourceLabel = "";
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
  private playbackSourceNode: AudioNode | undefined;
  private playbackMediaSourceNode: MediaElementAudioSourceNode | undefined;
  private playbackBufferSourceNode: AudioBufferSourceNode | undefined;
  private bufferPlaybackPaused = true;
  private bufferPlaybackOffset = 0;
  private bufferPlaybackStartedAt = 0;
  private playbackSplitterNode: ChannelSplitterNode | undefined;
  private playbackMergerNode: ChannelMergerNode | undefined;
  private playbackChannelGains: Array<{ left: GainNode; right: GainNode }> = [];
  private readonly pendingChunks = new Map<number, (message: Extract<ExtensionMessage, { type: "chunk" }>) => void>();
  private readonly pendingTranscodes = new Map<number, {
    resolve: (message: Extract<ExtensionMessage, { type: "transcodedAudio" }>) => void;
    reject: (error: Error) => void;
  }>();
  private readonly pendingAnalysisTargets = new Map<string, number>();
  private readonly pendingAnalysisProfiles = new Map<string, SpectrogramRequestProfile>();
  private readonly spectrogramCache = new Map<string, SpectrogramResult>();
  private readonly spectrogramBitmapCache = new Map<string, HTMLCanvasElement>();
  private readonly spectrogramRangeCache = new Map<string, SpectrogramRangeState>();
  private readonly lastSpectrogramByChannel = new Map<number, SpectrogramResult>();
  private readonly waveformCache = new Map<string, WaveformPeaks>();
  private readonly channelPeakCache = new Map<number, number>();
  private readonly pcmStatusStates = new WeakMap<HTMLElement, PcmStatusState>();
  private worker = createAnalysisWorker();
  private selectionWorker = createAnalysisWorker();
  private selectionSpectrumTimer: number | undefined;
  private selectionSpectrumRequestSeq = 0;
  private currentSelectionSpectrumRequestId: string | undefined;
  private selectionSpectrumRunning = false;
  private selectionWavDownloadRequestSeq = 0;
  private readonly pendingSelectionWavDownloads = new Map<number, PendingSelectionWavDownload>();
  private currentLocale: LocaleCode = "en";
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
    spectrogramMinHz: 0,
    spectrogramMaxHz: 8000,
    spectrogramMaxFollowsNyquist: true,
    autoBrightness: true,
    amplitudeAuto: true,
    amplitudeMin: -1,
    amplitudeMax: 1,
    timeZoom: 1,
    timeOffset: 0,
    frequencyScale: "linear",
    palette: "rose",
    defaultTrackRowHeight: TRACK_ROW_DEFAULT_H,
    defaultTrackWaveFr: TRACK_WAVE_DEFAULT_FR,
    defaultTrackSpecFr: TRACK_SPEC_DEFAULT_FR
  };

  public constructor(
    private readonly vscode: VsCodeApi,
    private readonly elements: ViewElements
  ) {
    this.syncPlatformShortcuts();
    this.bindUi();
    this.bindAnalysisWorker();
    this.bindSelectionWorker();
    this.updateSelectionAnalysis();
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
      case "selectionWavSaveReady":
        this.writePendingSelectionWav(message.requestId);
        break;
      case "selectionWavSaveCanceled":
        this.pendingSelectionWavDownloads.delete(message.requestId);
        break;
      case "error":
        this.setStatus(message.message, "warning");
        break;
    }
  }

  private bindAnalysisWorker(): void {
    this.worker.addEventListener("message", (event: MessageEvent<AnalysisWorkerResult>) => {
      if (event.data.type === "spectrogram") {
        this.drawSpectrogramResult(event.data);
      }
    });
  }

  private bindSelectionWorker(): void {
    this.selectionWorker.addEventListener("message", (event: MessageEvent<AnalysisWorkerResult>) => {
      if (event.data.type === "selectionSpectrum") {
        this.applySelectionSpectrumResult(event.data);
      }
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
    this.currentLocale = locale;
    this.messages = getMessages(locale);
    applyLocale(document, this.messages);
    if (!this.elements.headerInfoPanel.hidden) {
      this.renderHeaderInfo();
      this.positionHeaderInfoPanel();
    }
    this.refreshPcmStatusTexts();
    this.updateResetViewButtonState();
    this.updateTrackLabels();
    this.redrawVisuals();
  }

  private resetAnalysisWorker(): void {
    this.worker.terminate();
    this.worker = createAnalysisWorker();
    this.bindAnalysisWorker();
  }

  private resetSelectionWorker(): void {
    this.selectionWorker.terminate();
    this.selectionWorker = createAnalysisWorker();
    this.bindSelectionWorker();
  }

  private cancelSelectionSpectrumAnalysis(): void {
    if (this.selectionSpectrumTimer !== undefined) {
      window.clearTimeout(this.selectionSpectrumTimer);
      this.selectionSpectrumTimer = undefined;
    }
    this.selectionSpectrumRequestSeq += 1;
    this.currentSelectionSpectrumRequestId = undefined;
    if (this.selectionSpectrumRunning) {
      this.selectionSpectrumRunning = false;
      this.resetSelectionWorker();
    }
  }

  private clearDecodedAudio(): void {
    this.cancelSelectionSpectrumAnalysis();
    this.pendingSelectionWavDownloads.clear();
    this.audioBuffer = undefined;
    this.sourceSampleRate = undefined;
    this.clearAudioElement();
    this.spectrogramCache.clear();
    this.spectrogramBitmapCache.clear();
    this.spectrogramRangeCache.clear();
    this.lastSpectrogramByChannel.clear();
    this.waveformCache.clear();
    this.channelPeakCache.clear();
    this.pendingAnalysisKeys.clear();
    this.pendingAnalysisTargets.clear();
    this.trackViews = [];
    this.elements.trackList.replaceChildren();
    this.elements.figures.classList.remove("isFirstTrackSelectedAtTop");
    this.elements.seek.value = "0";
    this.updateClock();
  }

  private clearAudioElement(): void {
    this.stopBufferSource();
    this.bufferPlaybackPaused = true;
    this.bufferPlaybackOffset = 0;
    this.bufferPlaybackStartedAt = 0;
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
    this.currentSourceLabel = metadata.sourceKind === "ark" && metadata.sourceOffset !== undefined ? ` · ${this.messages.arkOffsetLabel} ${metadata.sourceOffset}` : "";
    const fileMetaText = `${metadata.fileName} · ${formatBytes(metadata.size)}${this.currentSourceLabel}`;
    this.elements.fileMeta.textContent = fileMetaText;
    this.elements.fileMeta.title = fileMetaText;

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
    if (isEmptyWaveFile(this.audioBytes)) {
      this.clearDecodedAudio();
      this.setStatus(`${this.messages.encodedPlaybackOnly} ${this.messages.emptyWavNoAudio}`, "error");
      return;
    }
    this.setStatus(metadata.kind === "pcm" ? this.messages.waitingPcmParams : this.messages.decodingAudio);
    this.elements.pcmReveal.hidden = metadata.kind === "pcm" || metadata.extension !== "wav" || metadata.sourceKind === "ark";
    this.elements.headerInfo.hidden = !this.audioHasHeaderInfo(metadata);
    this.elements.headerInfoPanel.hidden = true;
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
    this.focusDefaultPlot();
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
    if (fileName.toLowerCase().endsWith(".wav") && await this.tryLoadWavePcmDirectly(fileName)) {
      return;
    }

    const audioContext = facts.sampleRate ? new AudioContext({ sampleRate: facts.sampleRate }) : new AudioContext();
    try {
      this.audioBuffer = await decodeAudioDataWithTimeout(audioContext, this.audioBytes, ENCODED_DECODE_TIMEOUT_MS);
      this.sourceSampleRate = facts.sampleRate ?? this.audioBuffer.sampleRate;
      this.installAudioElementFromBytes(fileName);
    } catch (error) {
      console.warn("AudioLens encoded decode fallback:", error);
      await audioContext.close().catch(() => undefined);
      if (await this.tryLoadWavePcmDirectly(fileName)) {
        return;
      }
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
        try {
          this.audioBuffer = await decodeAudioDataWithTimeout(audioContext, bytes, ENCODED_DECODE_TIMEOUT_MS);
          this.sourceSampleRate = this.audioBuffer.sampleRate;
        } catch (decodeError) {
          console.warn("AudioLens FFmpeg WAV decode fallback:", decodeError);
          if (!this.loadWavePcmBytes(bytes, audioContext)) {
            throw decodeError;
          }
        }
      } finally {
        await audioContext.close().catch(() => undefined);
      }
      this.installAudioElementFromBuffer(`${fileName}.wav`);
    } catch (error) {
      console.warn("AudioLens FFmpeg fallback failed:", error);
      this.clearDecodedAudio();
      const detail = error instanceof Error ? error.message : String(error);
      this.setStatus(`${this.messages.encodedPlaybackOnly} ${detail}`);
    }
  }

  private async tryLoadWavePcmDirectly(fileName: string): Promise<boolean> {
    if (!this.audioBytes) {
      return false;
    }

    try {
      const audioContext = new AudioContext();
      try {
        if (!this.loadWavePcmBytes(this.audioBytes, audioContext)) {
          return false;
        }
      } finally {
        await audioContext.close().catch(() => undefined);
      }
      this.installAudioElementFromBuffer(fileName);
      return true;
    } catch (error) {
      console.warn("AudioLens direct WAV PCM decode failed:", error);
      this.clearDecodedAudio();
      return false;
    }
  }

  private loadWavePcmBytes(bytes: Uint8Array, audioContext: BaseAudioContext): boolean {
    const parsed = parseWavePcmFormat(bytes);
    if (!parsed || parsed.bytes.byteLength === 0) {
      return false;
    }

    const decoded = decodePcm(parsed.bytes, parsed.format);
    this.audioBuffer = createAudioBufferFromChannels(audioContext, decoded);
    this.sourceSampleRate = decoded.sampleRate;
    return true;
  }

  private async loadPcm(_metadata: AudioFileMetadata): Promise<boolean> {
    if (!this.audioBytes) {
      return false;
    }
    this.elements.pcmPanel.hidden = false;
    this.elements.pcmReveal.hidden = true;
    this.elements.wavPcmPanel.hidden = true;
    this.clearDecodedAudio();
    this.setPcmPanelCollapsed(false);
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
    this.elements.audio.addEventListener("error", () => {
      const detail = this.elements.audio.error?.message || this.messages.audioCannotPlay;
      if (this.audioBuffer) {
        this.setStatus(`${this.messages.playbackFailed}: ${detail}`, "error");
        return;
      }
      this.reportPlaybackError(detail);
    });
    this.elements.audio.addEventListener("timeupdate", () => {
      this.syncPlaybackState({ redraw: this.playbackFrameId === undefined });
    });
    this.elements.seek.addEventListener("input", () => {
      const duration = this.audioBuffer?.duration ?? this.elements.audio.duration;
      if (!Number.isNaN(duration)) {
        this.selectionPlaybackEnd = undefined;
        this.setPlaybackPosition((Number(this.elements.seek.value) / 1000) * duration);
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
    this.elements.headerInfo.addEventListener("click", () => {
      this.toggleHeaderInfoPanel();
    });
    this.elements.headerInfoClose.addEventListener("click", () => {
      this.hideHeaderInfoPanel();
    });
    this.elements.wavPcmApply.addEventListener("click", () => {
      void this.applyWavPcmFormat();
    });
    this.elements.wavPcmCancel.addEventListener("click", () => {
      this.hideWavPcmPanel();
    });
    this.elements.pcmPanel.addEventListener("keydown", (event) => {
      this.handlePcmPanelEnter(event, () => this.applyPcmFormat(this.readPcmControls()));
    });
    this.elements.pcmEdit.addEventListener("click", () => {
      this.setPcmPanelCollapsed(false);
    });
    this.elements.wavPcmPanel.addEventListener("keydown", (event) => {
      this.handlePcmPanelEnter(event, () => this.applyWavPcmFormat());
    });
    this.elements.selectionContextMenu.addEventListener("click", (event) => {
      this.handleSelectionContextMenuClick(event);
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
    this.elements.pcmEncoding.addEventListener("change", () => {
      this.syncPcmEndiannessControl(this.elements.pcmEncoding, this.elements.pcmEndianness);
    });
    this.elements.wavPcmEncoding.addEventListener("change", () => {
      this.syncPcmEndiannessControl(this.elements.wavPcmEncoding, this.elements.wavPcmEndianness);
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
    this.elements.spectrogramMaxFollowsNyquist.addEventListener("change", () => {
      this.settings.spectrogramMaxFollowsNyquist = this.elements.spectrogramMaxFollowsNyquist.checked;
      if (this.settings.spectrogramMaxFollowsNyquist) {
        this.settings.spectrogramMaxHz = Math.round(this.nyquistFrequency());
        this.elements.spectrogramMaxHz.value = String(this.settings.spectrogramMaxHz);
      }
      this.updateSpectrogramFrequencySettings({ syncDisplay: true });
    });
    this.elements.spectrogramMinHz.addEventListener("input", () => this.updateSpectrogramFrequencySettings({ source: "min" }));
    this.elements.spectrogramMaxHz.addEventListener("input", () => this.updateSpectrogramFrequencySettings({ source: "max" }));
    this.elements.spectrogramMinHz.addEventListener("blur", () => this.syncControls());
    this.elements.spectrogramMaxHz.addEventListener("blur", () => this.syncControls());
    this.elements.spectrogramMinHz.addEventListener("dblclick", () => this.resetSpectrogramFrequencyRange());
    this.elements.spectrogramMaxHz.addEventListener("dblclick", () => this.resetSpectrogramFrequencyRange());
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
    this.elements.trackList.addEventListener("scroll", () => this.updateTimelineBoundaryState());
    this.bindFigureInteraction(this.elements.waveform);
    this.bindFigureInteraction(this.elements.spectrogram);
    this.bindPlotResizer(this.elements.waveformResize, this.elements.waveformPane, "--waveform-height", PLOT_HEIGHT_LIMITS.waveformMin, PLOT_HEIGHT_LIMITS.waveformMax);
    this.bindPlotResizer(this.elements.spectrogramResize, this.elements.spectrogramPane, "--spectrogram-height", PLOT_HEIGHT_LIMITS.spectrogramMin, PLOT_HEIGHT_LIMITS.spectrogramMax);
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("resize", () => {
      if (!this.elements.wavPcmPanel.hidden) {
        this.positionWavPcmPanel();
      }
      if (!this.elements.headerInfoPanel.hidden) {
        this.positionHeaderInfoPanel();
      }
      this.positionPcmStatusTooltip();
      this.redrawVisuals();
      this.scheduleAnalyze();
    });
  }

  private async togglePlayback(): Promise<void> {
    if (this.audioBuffer) {
      await this.toggleBufferPlayback();
      return;
    }
    if (!this.elements.audio.src) {
      this.reportPlaybackError(this.messages.audioNotReady);
      return;
    }

    try {
      if (this.elements.audio.paused) {
        this.ensurePlaybackGraph();
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

  private async toggleBufferPlayback(): Promise<void> {
    if (!this.audioBuffer) {
      this.reportPlaybackError(this.messages.audioNotReady);
      return;
    }

    try {
      if (this.bufferPlaybackPaused) {
        this.prepareBufferPlaybackStart();
        await this.startBufferPlayback();
      } else {
        this.selectionPlaybackEnd = undefined;
        this.pauseBufferPlayback();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.reportPlaybackError(message);
    }
  }

  private prepareBufferPlaybackStart(): void {
    if (!this.audioBuffer) {
      return;
    }
    if (this.selection) {
      this.playheadTime = this.selection.start;
      this.selectionPlaybackEnd = this.selection.end;
      this.bufferPlaybackOffset = this.selection.start;
      this.redrawVisuals();
      return;
    }
    const nextTime = this.playheadTime === undefined ? 0 : clamp(this.playheadTime, 0, this.audioBuffer.duration);
    this.playheadTime = nextTime;
    this.bufferPlaybackOffset = nextTime;
    this.redrawVisuals();
  }

  private async startBufferPlayback(): Promise<void> {
    if (!this.audioBuffer) {
      return;
    }
    if (!this.playbackAudioContext) {
      this.playbackAudioContext = new AudioContext();
    }
    if (this.playbackAudioContext.state === "suspended") {
      await this.playbackAudioContext.resume();
    }

    this.stopBufferSource();
    const source = this.playbackAudioContext.createBufferSource();
    source.buffer = this.audioBuffer;
    source.onended = () => {
      if (this.playbackBufferSourceNode === source) {
        this.finishBufferPlayback();
      }
    };
    this.playbackBufferSourceNode = source;
    this.playbackSourceNode = source;
    this.bufferPlaybackStartedAt = this.playbackAudioContext.currentTime;
    this.bufferPlaybackPaused = false;
    this.ensurePlaybackGraph();
    source.start(0, this.bufferPlaybackOffset);
    this.elements.play.textContent = "⏸";
    this.startPlaybackTicker();
  }

  private pauseBufferPlayback(): void {
    const currentTime = this.currentPlaybackTime();
    this.stopBufferSource();
    this.bufferPlaybackPaused = true;
    this.bufferPlaybackOffset = currentTime;
    this.playheadTime = currentTime;
    this.elements.play.textContent = "▶";
    this.stopPlaybackTicker();
    this.syncPlaybackState({ redraw: true });
  }

  private finishBufferPlayback(): void {
    if (!this.audioBuffer) {
      return;
    }
    const endTime = this.selectionPlaybackEnd ?? this.audioBuffer.duration;
    this.playbackBufferSourceNode = undefined;
    this.playbackSourceNode = undefined;
    this.bufferPlaybackPaused = true;
    this.selectionPlaybackEnd = undefined;
    this.bufferPlaybackOffset = clamp(endTime, 0, this.audioBuffer.duration);
    this.playheadTime = this.bufferPlaybackOffset;
    this.elements.play.textContent = "▶";
    this.stopPlaybackTicker();
    this.syncPlaybackState({ redraw: true });
  }

  private stopBufferSource(): void {
    const source = this.playbackBufferSourceNode;
    if (!source) {
      return;
    }
    source.onended = null;
    this.playbackBufferSourceNode = undefined;
    if (this.playbackSourceNode === source) {
      this.playbackSourceNode = undefined;
    }
    try {
      source.stop();
    } catch {
      // Source may already have ended.
    }
    source.disconnect();
  }

  private startPlaybackTicker(): void {
    if (this.playbackFrameId !== undefined) {
      return;
    }

    const tick = () => {
      this.syncPlaybackState({ redraw: true });
      if (!this.isPlaybackPaused()) {
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
    const currentTime = this.currentPlaybackTime();
    const duration = this.audioBuffer?.duration ?? audio.duration;
    if (this.selectionPlaybackEnd !== undefined && currentTime >= this.selectionPlaybackEnd) {
      const end = this.selectionPlaybackEnd;
      this.selectionPlaybackEnd = undefined;
      if (this.audioBuffer) {
        this.stopBufferSource();
        this.bufferPlaybackPaused = true;
        this.bufferPlaybackOffset = end;
        this.elements.play.textContent = "▶";
      } else {
        audio.pause();
        audio.currentTime = end;
      }
      this.playheadTime = end;
    } else {
      this.playheadTime = currentTime;
    }

    this.updateClock();
    if (!Number.isNaN(duration) && duration > 0) {
      this.elements.seek.value = String((this.currentPlaybackTime() / duration) * 1000);
    }
    this.followPlayheadDuringPlayback();
    if (options.redraw) {
      this.redrawVisuals();
    }
  }

  private followPlayheadDuringPlayback(): void {
    if (!this.audioBuffer || this.playheadTime === undefined || this.isPlaybackPaused()) {
      return;
    }
    const range = this.visibleRange();
    const duration = this.audioBuffer.duration;
    const viewDuration = range.endTime - range.startTime;
    if (viewDuration <= 0 || viewDuration >= duration) {
      return;
    }
    const margin = viewDuration * 0.12;
    if (this.selectionPlaybackEnd !== undefined && this.playheadTime >= range.startTime && this.playheadTime <= range.endTime) {
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
    const targetStart = clamp(this.playheadTime - viewDuration * 0.78, 0, maxStart);
    this.settings.timeOffset = maxStart === 0 ? 0 : targetStart / maxStart;
    this.syncControls();
    this.scheduleAnalyze(0);
  }

  private onKeyDown(event: KeyboardEvent): void {
    // 音轨侧栏的静音/独奏/视图/增益/声道平衡控件获得焦点后,空格仍应控制播放,
    // 而不是触发控件默认行为(滚动、重复开关、展开下拉)。Enter/方向键等不在此拦截,保留控件本身操作。
    if (isEditableTarget(event.target) && !this.isTrackSidebarControl(event.target)) {
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

  private isTrackSidebarControl(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && target.closest(".trackSidebar") !== null;
  }

  private handleEscape(): void {
    if (!this.elements.selectionContextMenu.hidden) {
      this.hideSelectionContextMenu();
      return;
    }
    if (!this.elements.settingsPanel.hidden) {
      this.elements.settingsPanel.hidden = true;
      this.elements.settingsToggle.focus();
      return;
    }
    if (!this.elements.headerInfoPanel.hidden) {
      this.hideHeaderInfoPanel();
      this.elements.headerInfo.focus();
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
    if (this.audioBuffer) {
      this.pauseBufferPlayback();
    } else {
      this.elements.audio.pause();
      this.elements.audio.currentTime = 0;
    }
    this.playheadTime = undefined;
    this.bufferPlaybackOffset = 0;
    this.dragPlayheadTime = undefined;
    this.selectionPlaybackEnd = undefined;
    this.elements.seek.value = "0";
    this.updateClock();
    this.redrawVisuals();
  }

  private handlePcmPanelEnter(event: KeyboardEvent, action: () => Promise<unknown>): void {
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
      return;
    }
    event.preventDefault();
    void action();
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
    if (!this.elements.selectionContextMenu.hidden && !this.elements.selectionContextMenu.contains(target)) {
      this.hideSelectionContextMenu();
    }
    if (
      !this.elements.headerInfoPanel.hidden &&
      !this.elements.headerInfoPanel.contains(target) &&
      !this.elements.headerInfo.contains(target)
    ) {
      this.hideHeaderInfoPanel();
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

  private toggleHeaderInfoPanel(): void {
    if (this.elements.headerInfo.hidden) {
      this.hideHeaderInfoPanel();
      return;
    }
    if (this.elements.headerInfoPanel.hidden) {
      this.showHeaderInfoPanel();
      return;
    }
    this.hideHeaderInfoPanel();
  }

  private audioHasHeaderInfo(metadata: AudioFileMetadata): boolean {
    const extension = metadata.extension.toLowerCase();
    return metadata.kind !== "pcm" && extension !== "pcm" && extension !== "raw";
  }

  private showHeaderInfoPanel(): void {
    this.elements.settingsPanel.hidden = true;
    this.helpMenuElement().open = false;
    this.elements.wavPcmPanel.hidden = true;
    this.renderHeaderInfo();
    this.elements.headerInfoPanel.hidden = false;
    this.positionHeaderInfoPanel();
  }

  private hideHeaderInfoPanel(): void {
    this.elements.headerInfoPanel.hidden = true;
  }

  private renderHeaderInfo(): void {
    this.elements.headerInfoTitle.textContent = `${this.messages.headerInfoTitle} · ${this.currentFileName || "--"}`;
    this.elements.headerInfoBody.replaceChildren();
    if (!this.audioBytes) {
      this.elements.headerInfoBody.append(this.createHeaderInfoEmpty(this.messages.headerInfoAudioUnread));
      return;
    }

    const info = readAudioHeaderInfo(this.audioBytes, this.currentFileName);
    if (!info) {
      this.elements.headerInfoBody.append(this.createHeaderInfoEmpty(this.messages.headerInfoUnsupported));
      return;
    }
    this.elements.headerInfoTitle.textContent = `${this.messages.headerInfoTitle} · ${info.format}`;
    if (info.summary) {
      this.elements.headerInfoBody.append(this.createHeaderInfoSummary(info.summary));
    }
    this.elements.headerInfoBody.append(this.createHeaderInfoTable(info));
  }

  private createHeaderInfoEmpty(message: string): HTMLElement {
    const element = document.createElement("div");
    element.className = "headerInfoEmpty";
    element.textContent = message;
    return element;
  }

  private createHeaderInfoSummary(summary: NonNullable<AudioHeaderInfo["summary"]>): HTMLElement {
    const element = document.createElement("div");
    element.className = `headerInfoSummary is-${summary.tone}`;
    const text = document.createElement("strong");
    const localized = this.localizeHeaderSummary(summary);
    text.textContent = localized.text;
    element.append(text);
    if (localized.detail) {
      const detail = document.createElement("span");
      detail.textContent = localized.detail;
      element.append(detail);
    }
    return element;
  }

  private localizeHeaderSummary(summary: NonNullable<AudioHeaderInfo["summary"]>): { text: string; detail?: string } {
    if (summary.kind !== "wavHeader") {
      return { text: summary.text, detail: summary.detail };
    }
    if (summary.missingData) {
      return { text: this.messages.headerInfoWavMissingData, detail: this.messages.headerInfoWavCannotDetermine };
    }
    const size = summary.headerSize ?? 0;
    const text = this.messages.headerInfoWavHeaderLength.replace("{size}", String(size));
    if (summary.standard) {
      return { text, detail: this.messages.headerInfoWavStandardPcm };
    }
    const reasons = summary.reasons?.map((reason) => {
      switch (reason.type) {
        case "fmtExtended":
          return this.messages.headerInfoWavFmtExtended.replace("{size}", String(reason.size));
        case "format":
          return this.messages.headerInfoWavFormat.replace("{format}", String(reason.format)).replace("{name}", reason.name);
        case "extraChunks":
          return this.messages.headerInfoWavExtraChunks.replace("{chunks}", reason.chunks.join(", "));
        case "dataOffset":
          return this.messages.headerInfoWavDataOffsetNon44;
      }
    }) ?? [];
    const detail = reasons.length > 0 ? `${this.messages.headerInfoWavNonStandardPrefix}: ${reasons.join(this.messages.headerInfoReasonSeparator)}` : `${this.messages.headerInfoWavNonStandardPrefix}: ${this.messages.headerInfoWavDataOffsetNon44}`;
    return { text, detail };
  }

  private createHeaderInfoTable(info: AudioHeaderInfo): HTMLTableElement {
    const hasBits = info.rows.some((row) => row.bits);
    const table = document.createElement("table");
    table.className = "headerInfoTable";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    const columns = hasBits ? [
      [this.messages.headerInfoByteOffset, "offsetColumn"],
      [this.messages.headerInfoBits, "bitsColumn"],
      [this.messages.headerInfoField, "fieldColumn"],
      [this.messages.headerInfoValue, "valueColumn"],
      [this.messages.headerInfoDescription, "noteColumn"]
    ] : [
      [this.messages.headerInfoOffset, "offsetColumn"],
      [this.messages.headerInfoSize, "sizeColumn"],
      [this.messages.headerInfoField, "fieldColumn"],
      [this.messages.headerInfoValue, "valueColumn"],
      [this.messages.headerInfoDescription, "noteColumn"]
    ];
    for (const [label, className] of columns) {
      const cell = document.createElement("th");
      cell.className = className;
      cell.textContent = label;
      headerRow.append(cell);
    }
    thead.append(headerRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const row of info.rows) {
      const tr = document.createElement("tr");
      if (row.kind) {
        tr.dataset.kind = row.kind;
      }
      const values = hasBits ? [
        `0x${row.offset.toString(16).toUpperCase().padStart(8, "0")}`,
        row.bits ?? `${row.size * 8} bit`,
        `${row.treePrefix ? `${row.treePrefix} ` : ""}${row.field}`,
        row.value,
        this.localizeHeaderNote(row.note ?? "")
      ] : [
        `0x${row.offset.toString(16).toUpperCase().padStart(8, "0")}`,
        `${row.size} B`,
        `${row.treePrefix ? `${row.treePrefix} ` : ""}${row.field}`,
        row.value,
        this.localizeHeaderNote(row.note ?? "")
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        tr.append(cell);
      }
      const fieldCell = tr.children[hasBits ? 2 : 2] as HTMLElement | undefined;
      if (fieldCell && row.depth !== undefined) {
        fieldCell.style.setProperty("--header-field-depth", String(row.depth));
      }
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  private localizeHeaderNote(note: string): string {
    if (!note) {
      return "";
    }
    if (this.currentLocale === "zh-CN") {
      return note;
    }
    const notes = HEADER_NOTES_BY_LOCALE[this.currentLocale] ?? HEADER_NOTE_EN;
    return notes[note] ?? HEADER_NOTE_EN[note] ?? note;
  }

  private positionHeaderInfoPanel(): void {
    const anchor = this.elements.headerInfo.getBoundingClientRect();
    const panel = this.elements.headerInfoPanel;
    const margin = 12;
    const panelWidth = Math.min(680, window.innerWidth - margin * 2);
    const left = clamp(anchor.right - panelWidth, margin, Math.max(margin, window.innerWidth - panelWidth - margin));
    panel.style.width = `${panelWidth}px`;
    panel.style.left = `${left}px`;
    panel.style.top = `${anchor.bottom + 8}px`;
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
    this.setStatus(detail, "error");
    this.vscode.postMessage({ type: "showError", message: detail });
  }

  private downloadCurrentAudio(): void {
    if (!this.currentFileName) {
      this.reportPlaybackError(this.messages.audioNotReady);
      return;
    }
    this.vscode.postMessage({ type: "downloadAudio" });
  }

  private downloadSelectionAsWav(): void {
    if (!this.audioBuffer || !this.selection) {
      this.reportPlaybackError(this.messages.noSelectionToDownload);
      return;
    }

    const audioBuffer = this.audioBuffer;
    const startFrame = clamp(Math.floor(this.selection.start * audioBuffer.sampleRate), 0, audioBuffer.length);
    const endFrame = clamp(Math.ceil(this.selection.end * audioBuffer.sampleRate), startFrame, audioBuffer.length);
    if (endFrame <= startFrame) {
      this.reportPlaybackError(this.messages.noSelectionToDownload);
      return;
    }

    const fileName = this.selectionWavFileName(this.selection.start, this.selection.end);
    const requestId = this.selectionWavDownloadRequestSeq + 1;
    this.selectionWavDownloadRequestSeq = requestId;
    this.pendingSelectionWavDownloads.set(requestId, { audioBuffer, startFrame, endFrame, fileName });
    this.vscode.postMessage({
      type: "requestSelectionWavSave",
      requestId,
      fileName,
      saveLabel: this.messages.downloadSelection,
      title: this.messages.downloadSelectionWav
    });
  }

  private writePendingSelectionWav(requestId: number): void {
    const pending = this.pendingSelectionWavDownloads.get(requestId);
    if (!pending) {
      return;
    }
    window.setTimeout(() => {
      const current = this.pendingSelectionWavDownloads.get(requestId);
      if (!current) {
        return;
      }
      this.pendingSelectionWavDownloads.delete(requestId);
      void this.encodeAndWriteSelectionWav(requestId, current);
    }, 0);
  }

  private async encodeAndWriteSelectionWav(requestId: number, pending: PendingSelectionWavDownload): Promise<void> {
    const bytes = await encodeWavAsync(pending.audioBuffer, pending.startFrame, pending.endFrame);
    const view = new Uint8Array(bytes);
    const chunkCount = Math.max(1, Math.ceil(view.byteLength / SELECTION_WAV_CHUNK_SIZE));
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const offset = chunkIndex * SELECTION_WAV_CHUNK_SIZE;
      const chunk = view.subarray(offset, Math.min(view.byteLength, offset + SELECTION_WAV_CHUNK_SIZE));
      this.vscode.postMessage({
        type: "writeSelectionWavChunk",
        requestId,
        fileName: pending.fileName,
        chunkIndex,
        bytesBase64: await bytesToBase64Async(chunk),
        isLast: chunkIndex === chunkCount - 1
      });
      await yieldToBrowser();
    }
  }

  private selectionWavFileName(start: number, end: number): string {
    const base = sanitizeFileNameBase(this.currentFileName || "audio");
    return `${base}_selection_${formatSelectionTime(start)}s-${formatSelectionTime(end)}s.wav`;
  }

  private clearSelection(): void {
    this.selection = undefined;
    this.selectionPlaybackEnd = undefined;
    this.updateSelectionAnalysis();
    this.redrawVisuals();
  }

  private syncControls(): void {
    this.elements.algorithm.value = this.settings.algorithm;
    this.elements.defaultTrackMode.value = this.settings.defaultTrackMode;
    this.elements.windowFunction.value = this.settings.windowFunction;
    this.elements.fftSize.value = String(this.settings.fftSize);
    this.elements.zeroPaddingFactor.value = String(this.settings.zeroPaddingFactor);
    this.elements.timeZoom.value = String(this.settings.timeZoom);
    this.elements.timeOffset.value = String(this.settings.timeOffset);
    this.elements.minDb.value = String(this.settings.minDb);
    this.elements.maxDb.value = String(this.settings.maxDb);
    const frequencyRange = this.spectrogramFrequencyRange();
    this.elements.spectrogramMinHz.value = String(Math.round(frequencyRange.minHz));
    this.elements.spectrogramMaxHz.value = String(Math.round(frequencyRange.maxHz));
    this.elements.spectrogramMaxFollowsNyquist.checked = this.settings.spectrogramMaxFollowsNyquist;
    this.elements.autoBrightness.checked = this.settings.autoBrightness;
    this.elements.frequencyScale.value = this.settings.frequencyScale;
    this.elements.palette.value = this.settings.palette;
    this.updateResetViewButtonState();
  }

  private analysisInputs(): HTMLInputElement[] {
    return [
      this.elements.timeZoom,
      this.elements.timeOffset,
      this.elements.minDb,
      this.elements.maxDb
    ];
  }

  private updateAnalysisSettings(): void {
    this.settings.timeZoom = clamp(Number(this.elements.timeZoom.value), 1, 64);
    this.settings.timeOffset = clamp(Number(this.elements.timeOffset.value), 0, 1);
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
    this.updateSpectrogramFrequencySettings();
  }

  private updateSpectrogramFrequencySettings(options: { source?: "min" | "max"; syncDisplay?: boolean } = {}): void {
    if (options.source === "max") {
      this.settings.spectrogramMaxFollowsNyquist = false;
      this.elements.spectrogramMaxFollowsNyquist.checked = false;
    }
    const nyquist = this.nyquistFrequency();
    const minText = this.elements.spectrogramMinHz.value.trim();
    const maxText = this.elements.spectrogramMaxHz.value.trim();
    const minHzRaw = Number(minText);
    const maxHzRaw = Number(maxText);
    const previousRange = this.spectrogramFrequencyRange();
    const minHz = minText !== "" && Number.isFinite(minHzRaw) ? minHzRaw : previousRange.minHz;
    const maxHz = maxText !== "" && Number.isFinite(maxHzRaw) ? maxHzRaw : previousRange.maxHz;
    const range = normalizeFrequencyRange(minHz, maxHz, this.settings.spectrogramMaxFollowsNyquist, nyquist);
    this.settings.spectrogramMinHz = range.minHz;
    this.settings.spectrogramMaxHz = range.storedMaxHz;
    this.savePreferencesSoon();
    if (options.syncDisplay) {
      this.syncControls();
    } else {
      this.elements.spectrogramMaxFollowsNyquist.checked = this.settings.spectrogramMaxFollowsNyquist;
    }
    this.redrawVisuals();
    this.analyze();
  }

  private resetSpectrogramFrequencyRange(): void {
    this.settings.spectrogramMinHz = 0;
    this.settings.spectrogramMaxHz = Math.round(this.nyquistFrequency());
    this.settings.spectrogramMaxFollowsNyquist = true;
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
    if (preferences.spectrogramMaxFollowsNyquist !== undefined) {
      this.settings.spectrogramMaxFollowsNyquist = preferences.spectrogramMaxFollowsNyquist;
    }
    if (preferences.spectrogramMinHz !== undefined) {
      this.settings.spectrogramMinHz = preferences.spectrogramMinHz;
    }
    if (preferences.spectrogramMaxHz !== undefined) {
      this.settings.spectrogramMaxHz = preferences.spectrogramMaxHz;
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
    if (preferences.defaultTrackRowHeight !== undefined) {
      this.settings.defaultTrackRowHeight = preferences.defaultTrackRowHeight;
    }
    if (preferences.defaultTrackWaveFr !== undefined) {
      this.settings.defaultTrackWaveFr = preferences.defaultTrackWaveFr;
    }
    if (preferences.defaultTrackSpecFr !== undefined) {
      this.settings.defaultTrackSpecFr = preferences.defaultTrackSpecFr;
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
      spectrogramMinHz: this.settings.spectrogramMinHz,
      spectrogramMaxHz: this.settings.spectrogramMaxHz,
      spectrogramMaxFollowsNyquist: this.settings.spectrogramMaxFollowsNyquist,
      autoBrightness: this.settings.autoBrightness,
      defaultTrackRowHeight: this.settings.defaultTrackRowHeight,
      defaultTrackWaveFr: this.settings.defaultTrackWaveFr,
      defaultTrackSpecFr: this.settings.defaultTrackSpecFr,
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

  private resetView(): void {
    this.settings.timeZoom = 1;
    this.settings.timeOffset = 0;
    this.settings.amplitudeAuto = true;
    for (const view of this.trackViews) {
      view.ampRangeOverride = undefined;
    }
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
      this.objectUrl = undefined;
    }
    this.stopBufferSource();
    this.bufferPlaybackPaused = true;
    this.bufferPlaybackOffset = 0;
    this.elements.audio.removeAttribute("src");
    this.elements.seek.value = "0";
    this.updateClock();
    const fileMetaText = `${fileName} · ${this.audioBuffer.numberOfChannels}ch · ${this.audioBuffer.sampleRate} Hz${this.currentSourceLabel}`;
    this.elements.fileMeta.textContent = fileMetaText;
    this.elements.fileMeta.title = fileMetaText;
    this.setStatus(this.messages.audioLoaded);
  }

  private async applyPcmFormat(format: PcmFormat, statusElement = this.elements.pcmStatus): Promise<boolean> {
    if (!this.audioBytes) {
      return false;
    }
    const error = validatePcmFormat(this.audioBytes, format);
    if (error) {
      this.setPcmStatus(statusElement, error);
      if (statusElement === this.elements.pcmStatus) {
        this.setPcmPanelCollapsed(false);
      }
      this.setStatus(error);
      return false;
    }
    this.writePcmControls(format);
    const decoded = decodePcm(this.audioBytes, format);
    const audioContext = new AudioContext({ sampleRate: decoded.sampleRate });
    this.audioBuffer = createAudioBufferFromChannels(audioContext, decoded);
    this.sourceSampleRate = decoded.sampleRate;
    await audioContext.close();
    this.settings.channel = 0;
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
    this.setPcmStatus(statusElement, this.formatPcmStatus({ kind: "current", format }), { kind: "current", format });
    if (statusElement === this.elements.pcmStatus) {
      this.setPcmPanelCollapsed(true);
    }
    this.setStatus(this.messages.ready);
    return true;
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
    const loaded = await this.applyPcmFormat(this.readWavPcmControls(), this.elements.wavPcmStatus);
    if (loaded) {
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
    this.setPcmStatus(this.elements.pcmStatus, this.formatPcmStatus({ kind: "savedDefault", format }), { kind: "savedDefault", format });
    this.setPcmPanelCollapsed(true);
  }

  private setPcmStatus(element: HTMLElement, message: string, state?: PcmStatusState): void {
    if (state) {
      this.pcmStatusStates.set(element, state);
    } else {
      this.pcmStatusStates.delete(element);
    }
    if (element === this.elements.pcmStatus) {
      this.elements.pcmStatusText.textContent = message;
      this.positionPcmStatusTooltip();
    } else {
      element.textContent = message;
    }
    element.dataset.tooltip = message;
  }

  private setPcmPanelCollapsed(collapsed: boolean): void {
    if (collapsed && !this.pcmStatusStates.get(this.elements.pcmStatus)) {
      collapsed = false;
    }
    this.elements.pcmPanel.dataset.collapsed = String(collapsed);
    this.elements.pcmEdit.hidden = !collapsed;
  }

  private refreshPcmStatusTexts(): void {
    for (const element of [this.elements.pcmStatus, this.elements.wavPcmStatus]) {
      const state = this.pcmStatusStates.get(element);
      if (state) {
        this.setPcmStatus(element, this.formatPcmStatus(state), state);
      }
    }
  }

  private formatPcmStatus(state: PcmStatusState): string {
    const prefix = state.kind === "current" ? this.messages.currentPcmFormat : this.messages.savedDefaultPcmFormat;
    return `${prefix}: ${formatPcmFormat(state.format)}`;
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
    const encoding = this.elements.pcmEncoding.value as PcmEncoding;
    const encodingFormat = pcmEncodingToFormat(encoding);
    const endianness = encodingFormat.bitDepth === 8 ? "none" : this.elements.pcmEndianness.value === "none" ? "little" : this.elements.pcmEndianness.value as PcmEndianness;
    return {
      sampleRate: Math.max(1, Math.floor(Number(this.elements.pcmSampleRate.value) || 16000)),
      channels: Math.max(1, Math.floor(Number(this.elements.pcmChannels.value) || 1)),
      ...encodingFormat,
      endianness,
      startOffsetBytes: Math.max(0, Math.floor(Number(this.elements.pcmStartOffset.value) || 0))
    };
  }

  private writePcmControls(format: PcmFormat): void {
    this.elements.pcmSampleRate.value = String(format.sampleRate);
    this.elements.pcmChannels.value = String(format.channels);
    this.elements.pcmStartOffset.value = String(format.startOffsetBytes ?? 0);
    this.elements.pcmEncoding.value = pcmFormatToEncoding(format);
    this.elements.pcmEndianness.value = format.endianness;
    this.syncPcmEndiannessControl(this.elements.pcmEncoding, this.elements.pcmEndianness);
  }

  private readWavPcmControls(): PcmFormat {
    const encoding = this.elements.wavPcmEncoding.value as PcmEncoding;
    const encodingFormat = pcmEncodingToFormat(encoding);
    const endianness = encodingFormat.bitDepth === 8 ? "none" : this.elements.wavPcmEndianness.value === "none" ? "little" : this.elements.wavPcmEndianness.value as PcmEndianness;
    return {
      sampleRate: Math.max(1, Math.floor(Number(this.elements.wavPcmSampleRate.value) || 16000)),
      channels: Math.max(1, Math.floor(Number(this.elements.wavPcmChannels.value) || 1)),
      ...encodingFormat,
      endianness,
      startOffsetBytes: Math.max(0, Math.floor(Number(this.elements.wavPcmStartOffset.value) || 0))
    };
  }

  private writeWavPcmControls(format: PcmFormat): void {
    this.elements.wavPcmSampleRate.value = String(format.sampleRate);
    this.elements.wavPcmChannels.value = String(format.channels);
    this.elements.wavPcmStartOffset.value = String(format.startOffsetBytes ?? 0);
    this.elements.wavPcmEncoding.value = pcmFormatToEncoding(format);
    this.elements.wavPcmEndianness.value = format.endianness;
    this.syncPcmEndiannessControl(this.elements.wavPcmEncoding, this.elements.wavPcmEndianness);
  }

  private syncPcmEndiannessControl(encodingSelect: HTMLSelectElement, endiannessSelect: HTMLSelectElement): void {
    const encodingFormat = pcmEncodingToFormat(encodingSelect.value as PcmEncoding);
    if (encodingFormat.bitDepth === 8) {
      endiannessSelect.value = "none";
      endiannessSelect.disabled = true;
      return;
    }
    endiannessSelect.disabled = false;
    if (endiannessSelect.value === "none") {
      endiannessSelect.value = "little";
    }
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
    const gainSlider = this.createTrackSlider("gain");
    const panSlider = this.createTrackSlider("pan");
    sidebar.append(title, mute, solo, mode, gainSlider.control, panSlider.control);

    const body = document.createElement("div");
    body.className = "trackBody";
    const waveformWrap = document.createElement("div");
    waveformWrap.className = "trackCanvasWrap trackWaveformWrap";
    const waveform = document.createElement("canvas");
    waveform.className = "trackWaveform";
    waveform.dataset.channel = String(channel);
    waveform.tabIndex = 0;
    waveformWrap.append(waveform);
    const spectrogramWrap = document.createElement("div");
    spectrogramWrap.className = "trackCanvasWrap trackSpectrogramWrap";
    const spectrogram = document.createElement("canvas");
    spectrogram.className = "trackSpectrogram";
    spectrogram.dataset.channel = String(channel);
    spectrogram.tabIndex = 0;
    const splitHandle = document.createElement("div");
    splitHandle.className = "trackSplitHandle";
    spectrogramWrap.append(spectrogram, splitHandle);
    body.append(waveformWrap, spectrogramWrap);
    const rowHandle = document.createElement("div");
    rowHandle.className = "trackRowHandle";
    row.append(sidebar, body, rowHandle);

    const view: TrackView = {
      channel,
      row,
      waveform,
      spectrogram,
      mode: this.settings.defaultTrackMode,
      muted: false,
      solo: false,
      gainDb: 0,
      pan: 0,
      gainSlider: gainSlider.input,
      panSlider: panSlider.input,
      rowHeight: this.settings.defaultTrackRowHeight,
      waveFr: this.settings.defaultTrackWaveFr,
      specFr: this.settings.defaultTrackSpecFr
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
    this.bindTrackSlider(view, gainSlider, {
      read: () => clamp(Number(gainSlider.input.value), -TRACK_GAIN_RANGE_DB, TRACK_GAIN_RANGE_DB),
      apply: (value) => {
        view.gainDb = value;
      }
    });
    this.bindTrackSlider(view, panSlider, {
      read: () => clamp(Number(panSlider.input.value), -100, 100) / 100,
      apply: (value) => {
        view.pan = value;
      }
    });
    this.syncTrackSliderHints(view);
    this.bindFigureInteraction(waveform);
    this.bindFigureInteraction(spectrogram);
    this.elements.trackList.append(row);
    this.trackViews.push(view);
    this.applyTrackMode(view);
    this.applyTrackLayout(view);
    this.bindTrackRowHandle(rowHandle, view);
    this.bindTrackSplitHandle(splitHandle, view);
  }

  private applyTrackLayout(view: TrackView): void {
    const { row } = view;
    row.style.setProperty("--track-row-h", `${view.rowHeight}px`);
    row.style.setProperty("--track-wave-fr", `${view.waveFr}fr`);
    row.style.setProperty("--track-spec-fr", `${view.specFr}fr`);
  }

  private bindTrackRowHandle(handle: HTMLElement, view: TrackView): void {
    let startY = 0;
    let startHeight = 0;
    let frameId: number | undefined;

    const redraw = (): void => {
      frameId = undefined;
      this.redrawVisuals();
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      startY = event.clientY;
      startHeight = view.rowHeight;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("is-resizing");
    });

    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) {
        return;
      }
      // both 模式下 trackBody 内波形/频谱各有 minmax 下限，需保留两者最小高度之和；单视图模式用通用下限。
      const minH = view.mode === "both" ? TRACK_BOTH_MIN_H : TRACK_ROW_MIN_H;
      const next = Math.max(minH, startHeight + event.clientY - startY);
      if (next === view.rowHeight) {
        return;
      }
      view.rowHeight = next;
      this.applyTrackLayout(view);
      if (frameId === undefined) {
        frameId = requestAnimationFrame(redraw);
      }
    });

    handle.addEventListener("pointerup", (event) => {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      document.body.classList.remove("is-resizing");
      if (frameId !== undefined) {
        cancelAnimationFrame(frameId);
        frameId = undefined;
      }
      this.redrawVisuals();
      this.analyze();
    });
    handle.addEventListener("dblclick", () => this.resetTrackLayout(view));
  }

  private bindTrackSplitHandle(handle: HTMLElement, view: TrackView): void {
    let bodyTop = 0;
    let bodyHeight = 0;
    let frameId: number | undefined;

    const redraw = (): void => {
      frameId = undefined;
      this.redrawVisuals();
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const body = view.row.querySelector<HTMLElement>(".trackBody");
      if (!body) {
        return;
      }
      const rect = body.getBoundingClientRect();
      bodyTop = rect.top;
      bodyHeight = rect.height;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("is-resizing");
    });

    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId) || bodyHeight <= 0) {
        return;
      }
      // 指针相对于 trackBody 顶部的位置 = 波形目标像素高度；两端各保留 minmax 下限。
      const wavePx = Math.min(
        Math.max(TRACK_WAVE_MIN_PX, event.clientY - bodyTop),
        bodyHeight - TRACK_SPEC_MIN_PX
      );
      const waveFr = wavePx / bodyHeight;
      const specFr = 1 - waveFr;
      if (waveFr === view.waveFr) {
        return;
      }
      view.waveFr = waveFr;
      view.specFr = specFr;
      this.applyTrackLayout(view);
      if (frameId === undefined) {
        frameId = requestAnimationFrame(redraw);
      }
    });

    handle.addEventListener("pointerup", (event) => {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      document.body.classList.remove("is-resizing");
      if (frameId !== undefined) {
        cancelAnimationFrame(frameId);
        frameId = undefined;
      }
      this.redrawVisuals();
      this.analyze();
    });
    handle.addEventListener("dblclick", () => this.resetTrackLayout(view));
  }

  private resetTrackLayout(view: TrackView): void {
    view.rowHeight = this.settings.defaultTrackRowHeight;
    view.waveFr = this.settings.defaultTrackWaveFr;
    view.specFr = this.settings.defaultTrackSpecFr;
    this.applyTrackLayout(view);
    this.redrawVisuals();
    this.analyze();
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
      this.syncTrackSliderHints(view);
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

  private createTrackSlider(kind: "gain" | "pan"): { control: HTMLDivElement; input: HTMLInputElement } {
    const control = document.createElement("div");
    control.className = `trackSliderControl ${kind === "gain" ? "trackGainControl" : "trackPanControl"}`;
    const minLabel = document.createElement("span");
    minLabel.className = "trackSliderEnd trackSliderEndMin";
    const maxLabel = document.createElement("span");
    maxLabel.className = "trackSliderEnd trackSliderEndMax";
    const trackWrap = document.createElement("span");
    trackWrap.className = "trackSliderTrack";
    const ticks = document.createElement("span");
    ticks.className = "trackSliderTicks";
    const input = document.createElement("input");
    input.type = "range";
    input.className = "trackSlider";
    const range = kind === "gain" ? TRACK_GAIN_RANGE_DB : 100;
    input.min = String(-range);
    input.max = String(range);
    input.step = "1";
    input.value = "0";
    if (kind === "gain") {
      minLabel.textContent = "−";
      maxLabel.textContent = "+";
    }
    trackWrap.append(ticks, input);
    control.append(minLabel, trackWrap, maxLabel);
    return { control, input };
  }

  private bindTrackSlider(
    view: TrackView,
    slider: { control: HTMLDivElement; input: HTMLInputElement },
    options: { read: () => number; apply: (value: number) => void }
  ): void {
    const { control, input } = slider;
    const showTip = () => this.showTrackSliderTip(control);
    input.addEventListener("input", () => {
      options.apply(options.read());
      this.syncTrackSliderHints(view);
      this.updatePlaybackChannelGains();
      showTip();
    });
    input.addEventListener("dblclick", () => {
      input.value = "0";
      options.apply(0);
      this.syncTrackSliderHints(view);
      this.updatePlaybackChannelGains();
      showTip();
    });
    input.addEventListener("pointerenter", showTip);
    input.addEventListener("pointerleave", () => {
      if (!input.matches(":active")) {
        this.hideFloatingTooltip();
      }
    });
    input.addEventListener("pointerup", () => {
      if (!control.matches(":hover")) {
        this.hideFloatingTooltip();
      }
    });
    input.addEventListener("pointercancel", () => this.hideFloatingTooltip());
    input.addEventListener("blur", () => this.hideFloatingTooltip());
  }

  private syncTrackSliderHints(view: TrackView): void {
    this.applyTrackSliderHint(view.gainSlider, this.messages.trackGain, this.formatTrackGain(view.gainDb));
    this.applyTrackSliderHint(view.panSlider, this.messages.trackPan, this.formatTrackPan(view.pan));
    const panControl = view.panSlider.closest<HTMLElement>(".trackSliderControl");
    if (panControl) {
      const minLabel = panControl.querySelector<HTMLElement>(".trackSliderEndMin");
      const maxLabel = panControl.querySelector<HTMLElement>(".trackSliderEndMax");
      if (minLabel) {
        minLabel.textContent = this.messages.panLeft;
      }
      if (maxLabel) {
        maxLabel.textContent = this.messages.panRight;
      }
    }
  }

  private applyTrackSliderHint(input: HTMLInputElement, label: string, valueText: string): void {
    const control = input.closest<HTMLElement>(".trackSliderControl");
    if (control) {
      control.dataset.tooltip = `${label} ${valueText}`;
    }
    input.setAttribute("aria-label", label);
    input.setAttribute("aria-valuetext", valueText);
  }

  private formatTrackGain(gainDb: number): string {
    return `${gainDb > 0 ? "+" : ""}${gainDb} dB`;
  }

  private formatTrackPan(pan: number): string {
    if (pan === 0) {
      return this.messages.panCenter;
    }
    return pan < 0
      ? `${this.messages.panLeft} ${Math.round(-pan * 100)}%`
      : `${this.messages.panRight} ${Math.round(pan * 100)}%`;
  }

  private showTrackSliderTip(anchor: HTMLElement): void {
    const text = anchor.dataset.tooltip;
    if (!text) {
      return;
    }
    const tooltip = this.elements.floatingTooltip;
    // 主值行醒目,操作提示另起一行并弱化,避免喧宾夺主。
    const valueLine = document.createElement("span");
    valueLine.className = "sliderTipValue";
    valueLine.textContent = text;
    const hintLine = document.createElement("span");
    hintLine.className = "sliderTipHint";
    hintLine.textContent = this.messages.doubleClickReset;
    tooltip.replaceChildren(valueLine, hintLine);
    tooltip.hidden = false;
    tooltip.style.width = "max-content";
    const margin = 8;
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = clamp(
      anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2,
      margin,
      Math.max(margin, window.innerWidth - tooltipRect.width - margin)
    );
    const top = Math.max(margin, anchorRect.top - tooltipRect.height - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
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
    this.updateTimelineBoundaryState();
  }

  private updateTimelineBoundaryState(): void {
    const firstTrackSelectedAtTop = this.settings.channel === 0 && this.elements.trackList.scrollTop <= 0.5;
    this.elements.figures.classList.toggle("isFirstTrackSelectedAtTop", firstTrackSelectedAtTop);
  }

  private applyTrackMode(view: TrackView): void {
    view.row.dataset.mode = view.mode;
    if (view.mode === "both" && view.rowHeight < TRACK_BOTH_MIN_H) {
      view.rowHeight = TRACK_BOTH_MIN_H;
      this.applyTrackLayout(view);
    }
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

  private focusDefaultPlot(): void {
    const view = this.trackViews.find((item) => item.channel === this.settings.channel) ?? this.trackViews[0];
    if (!view) {
      return;
    }
    const canvas = view.mode === "waveform" ? view.waveform : view.spectrogram;
    requestAnimationFrame(() => {
      canvas.focus({ preventScroll: true });
    });
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
    const rect = this.getTimelinePlotRect(canvas);

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
    this.drawWaveformAxis(context, rect, channel);
    const peaks = this.getWaveformPeaks(channel, range.startSample, range.endSample, Math.max(1, Math.floor(rect.width)));
    const channelRange = this.effectiveAmplitudeRange(channel);
    const span = Math.max(1e-6, channelRange.max - channelRange.min);
    const yOf = (v: number) => clamp(rect.bottom - ((v - channelRange.min) / span) * rect.height, rect.top, rect.bottom);
    context.strokeStyle = "#8cc8ff";
    context.lineWidth = deviceLineWidth();
    context.beginPath();
    for (let i = 0; i < peaks.min.length; i += 1) {
      const min = peaks.min[i] ?? 0;
      const max = peaks.max[i] ?? 0;
      const x = rect.left + i;
      context.moveTo(x, yOf(min));
      context.lineTo(x, yOf(max));
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
    this.drawFrequencyAxis(context, rect, Number(canvas.dataset.channel ?? 0));
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
      this.pendingAnalysisProfiles.clear();
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
    resizeCanvas(view.spectrogram);
    const spectrogramRect = this.getPlotRect(view.spectrogram);
    const targetFrames = Math.max(360, Math.min(1800, Math.floor(spectrogramRect.width / (window.devicePixelRatio || 1))));
    const outputBins = Math.max(192, Math.min(900, Math.floor(spectrogramRect.height / (window.devicePixelRatio || 1))));
    const cacheKey = this.createSpectrogramCacheKey(view.channel, view.spectrogram, outputBins, targetFrames);
    const frequencyRange = this.effectiveFrequencyRange(view.channel);
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
    if (this.shouldProfileSpectrogram()) {
      this.pendingAnalysisProfiles.set(cacheKey, {
        channel: view.channel,
        startedAt: performance.now(),
        startSample,
        endSample,
        targetFrames,
        outputBins
      });
    }
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
          minFrequencyHz: frequencyRange.minHz,
          maxFrequencyHz: frequencyRange.maxHz,
          frequencyScale: this.effectiveFrequencyScale(view.channel),
          palette: this.settings.palette,
          profile: this.shouldProfileSpectrogram()
        }
      },
      [source.buffer]
    );
    this.elements.analysisMeta.textContent = `${formatAlgorithm(this.settings.algorithm, this.messages)} · ${formatWindowFunction(this.settings.windowFunction, this.messages)} · ${this.settings.fftSize} · ${this.messages.pad} ${this.settings.zeroPaddingFactor} · ${this.settings.frequencyScale} · ${this.messages.hop} ${hopSize}`;
  }

  private createSpectrogramCacheKey(channel: number, canvas: HTMLCanvasElement, outputBins?: number, targetFrames?: number): string {
    resizeCanvas(canvas);
    const rect = this.getPlotRect(canvas);
    const bins = outputBins ?? Math.max(192, Math.min(900, Math.floor(rect.height / (window.devicePixelRatio || 1))));
    const frames = targetFrames ?? Math.max(360, Math.min(1800, Math.floor(rect.width / (window.devicePixelRatio || 1))));
    const { startSample, endSample } = this.visibleRange();
    const frequencyRange = this.effectiveFrequencyRange(channel);
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
      spectrogramMinHz: frequencyRange.minHz,
      spectrogramMaxHz: frequencyRange.maxHz,
      frequencyScale: this.effectiveFrequencyScale(channel),
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
    const requestProfile = this.pendingAnalysisProfiles.get(result.requestId);
    this.pendingAnalysisProfiles.delete(result.requestId);
    for (const view of this.trackViews) {
      const key = this.createSpectrogramCacheKey(view.channel, view.spectrogram);
      if (key === result.requestId || view.channel === targetChannel) {
        this.lastSpectrogramByChannel.set(view.channel, result);
        if (view.mode !== "waveform") {
          const drawProfile = this.drawSpectrogramCanvas(view.spectrogram, result);
          this.logSpectrogramProfile(result, drawProfile, requestProfile);
        }
      }
    }
    if (this.pendingAnalysisKeys.size === 0) {
      this.setStatus(this.messages.ready);
    }
  }

  private drawSpectrogramCanvas(canvas: HTMLCanvasElement, result: SpectrogramResult): SpectrogramDrawProfile | undefined {
    const profile = this.shouldProfileSpectrogram();
    const start = profile ? performance.now() : 0;
    const context = resizeCanvas(canvas);
    const rect = this.getPlotRect(canvas);
    const setupEnd = profile ? performance.now() : 0;
    const bitmapCached = this.spectrogramBitmapCache.has(result.requestId);
    const bitmapStart = profile ? performance.now() : 0;
    const bitmap = this.spectrogramBitmapForResult(result);
    const bitmapEnd = profile ? performance.now() : 0;
    if (!bitmap) {
      return undefined;
    }
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = canvasBackgroundColor();
    context.fillRect(0, 0, canvas.width, canvas.height);
    const drawStart = profile ? performance.now() : 0;
    this.drawSpectrogramBitmap(context, bitmap, rect, result);
    const drawEnd = profile ? performance.now() : 0;
    this.drawPlotFrame(context, rect);
    this.drawFrequencyAxis(context, rect, Number(canvas.dataset.channel ?? 0));
    const range = this.visibleRange();
    this.drawSelectionOverlay(context, rect, range);
    this.drawPlayheadOverlay(context, rect, range);
    if (!profile) {
      return undefined;
    }
    const end = performance.now();
    return {
      totalMs: end - start,
      setupMs: setupEnd - start,
      bitmapMs: bitmapEnd - bitmapStart,
      bitmapDrawMs: drawEnd - drawStart,
      overlayMs: end - drawEnd,
      bitmapCached
    };
  }

  private shouldProfileSpectrogram(): boolean {
    return this.config?.profileSpectrogram === true;
  }

  private logSpectrogramProfile(result: SpectrogramResult, drawProfile: SpectrogramDrawProfile | undefined, requestProfile: SpectrogramRequestProfile | undefined): void {
    if (!this.shouldProfileSpectrogram() || (!result.profile && !drawProfile && !requestProfile)) {
      return;
    }
    const worker = result.profile;
    const roundTripMs = requestProfile ? performance.now() - requestProfile.startedAt : undefined;
    console.groupCollapsed(
      `[AudioLens] Spectrogram profile${requestProfile ? ` ch ${requestProfile.channel + 1}` : ""} ${result.width}x${result.height}`
    );
    console.table({
      "request round trip": formatProfileMs(roundTripMs),
      "worker total": formatProfileMs(worker?.totalMs),
      "worker setup": formatProfileMs(worker?.setupMs),
      "worker fft": formatProfileMs(worker?.fftMs),
      "worker rasterize": formatProfileMs(worker?.rasterizeMs),
      "main draw total": formatProfileMs(drawProfile?.totalMs),
      "main canvas setup": formatProfileMs(drawProfile?.setupMs),
      "main bitmap upload": formatProfileMs(drawProfile?.bitmapMs),
      "main bitmap draw": formatProfileMs(drawProfile?.bitmapDrawMs),
      "main axes/overlays": formatProfileMs(drawProfile?.overlayMs),
      "bitmap cached": drawProfile?.bitmapCached ?? false,
      frames: worker?.frames ?? result.width,
      bins: worker?.bins ?? result.height,
      "fft size": worker?.fftSize ?? this.settings.fftSize,
      "window size": worker?.windowSize ?? this.settings.fftSize,
      "hop size": worker?.hopSize ?? "n/a",
      samples: worker?.sampleCount ?? (requestProfile ? requestProfile.endSample - requestProfile.startSample : "n/a"),
      "target frames": requestProfile?.targetFrames ?? "n/a",
      "output bins": requestProfile?.outputBins ?? "n/a"
    });
    console.groupEnd();
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
    const rawDuration = this.audioBuffer?.duration ?? this.elements.audio.duration;
    const current = formatTime(this.currentPlaybackTime());
    const duration = formatTime(Number.isFinite(rawDuration) ? rawDuration : 0);
    this.elements.clock.textContent = `${current} / ${duration}`;
  }

  private currentPlaybackTime(): number {
    if (this.audioBuffer) {
      if (!this.bufferPlaybackPaused && this.playbackAudioContext) {
        return clamp(
          this.bufferPlaybackOffset + this.playbackAudioContext.currentTime - this.bufferPlaybackStartedAt,
          0,
          this.audioBuffer.duration
        );
      }
      return clamp(this.playheadTime ?? this.bufferPlaybackOffset, 0, this.audioBuffer.duration);
    }
    return this.elements.audio.currentTime || 0;
  }

  private isPlaybackPaused(): boolean {
    return this.audioBuffer ? this.bufferPlaybackPaused : this.elements.audio.paused;
  }

  private setPlaybackPosition(time: number): void {
    if (this.audioBuffer) {
      const nextTime = clamp(time, 0, this.audioBuffer.duration);
      const wasPlaying = !this.bufferPlaybackPaused;
      this.stopBufferSource();
      this.bufferPlaybackPaused = !wasPlaying;
      this.bufferPlaybackOffset = nextTime;
      this.playheadTime = nextTime;
      if (wasPlaying) {
        void this.startBufferPlayback();
      }
      return;
    }
    this.elements.audio.currentTime = time;
  }

  private setStatus(message: string, tone: "info" | "warning" | "error" = "info"): void {
    this.elements.status.textContent = message;
    this.elements.status.classList.toggle("isWarning", tone === "warning");
    this.elements.status.classList.toggle("isError", tone === "error");
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
      !this.settings.amplitudeAuto ||
      this.trackViews.some((v) => v.ampRangeOverride) ||
      Boolean(this.selection);
    this.elements.resetView.classList.toggle("isProminent", isDirty);
  }

  private ensurePlaybackGraph(): void {
    if (!this.playbackAudioContext) {
      this.playbackAudioContext = new AudioContext();
    }
    if (!this.audioBuffer && !this.playbackMediaSourceNode) {
      this.playbackMediaSourceNode = this.playbackAudioContext.createMediaElementSource(this.elements.audio);
      this.playbackSourceNode = this.playbackMediaSourceNode;
    }
    this.rebuildPlaybackChannelGraph();
    this.updatePlaybackChannelGains(true);
  }

  private rebuildPlaybackChannelGraph(): void {
    if (!this.playbackAudioContext || !this.playbackSourceNode) {
      return;
    }
    this.playbackSourceNode.disconnect();
    this.playbackSplitterNode?.disconnect();
    this.playbackMergerNode?.disconnect();
    for (const pair of this.playbackChannelGains) {
      pair.left.disconnect();
      pair.right.disconnect();
    }
    if (!this.audioBuffer) {
      this.playbackSourceNode.connect(this.playbackAudioContext.destination);
      this.playbackChannelGains = [];
      this.playbackSplitterNode = undefined;
      this.playbackMergerNode = undefined;
      return;
    }
    const channels = this.audioBuffer.numberOfChannels;
    this.playbackSplitterNode = this.playbackAudioContext.createChannelSplitter(channels);
    this.playbackMergerNode = this.playbackAudioContext.createChannelMerger(2);
    this.playbackChannelGains = Array.from({ length: channels }, () => ({
      left: this.playbackAudioContext!.createGain(),
      right: this.playbackAudioContext!.createGain()
    }));
    this.playbackSourceNode.connect(this.playbackSplitterNode);
    this.playbackChannelGains.forEach((pair, channel) => {
      this.playbackSplitterNode?.connect(pair.left, channel);
      this.playbackSplitterNode?.connect(pair.right, channel);
      pair.left.connect(this.playbackMergerNode!, 0, 0);
      pair.right.connect(this.playbackMergerNode!, 0, 1);
    });
    this.playbackMergerNode.connect(this.playbackAudioContext.destination);
  }

  private updatePlaybackChannelGains(immediate = false): void {
    const hasSolo = this.trackViews.some((view) => view.solo);
    const enabledChannels = this.trackViews.length > 0
      ? this.trackViews.filter((view) => (hasSolo ? view.solo : !view.muted)).length
      : this.playbackChannelGains.length;
    const channelGain = enabledChannels > 0 ? 1 / enabledChannels : 0;
    this.playbackChannelGains.forEach((pair, channel) => {
      const view = this.trackViews.find((item) => item.channel === channel);
      const enabled = view ? (hasSolo ? view.solo : !view.muted) : true;
      const gainDb = view?.gainDb ?? 0;
      const pan = view?.pan ?? 0;
      // 平衡律：居中时两侧均为 1（保持既有下混响度），偏向一侧只衰减另一侧。
      const base = enabled ? channelGain * Math.pow(10, gainDb / 20) : 0;
      this.setPlaybackGainValue(pair.left, base * Math.min(1, 1 - pan), immediate);
      this.setPlaybackGainValue(pair.right, base * Math.min(1, 1 + pan), immediate);
    });
  }

  private setPlaybackGainValue(node: GainNode, value: number, immediate: boolean): void {
    const context = this.playbackAudioContext;
    if (!context) {
      node.gain.value = value;
      return;
    }
    node.gain.cancelScheduledValues(context.currentTime);
    if (immediate || this.bufferPlaybackPaused) {
      node.gain.value = value;
    } else {
      // 播放中做短时间常数平滑，避免拖动滑块时出现台阶噪声。
      node.gain.setTargetAtTime(value, context.currentTime, 0.02);
    }
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
    let activePointerId: number | undefined;
    const cleanupDragListeners = () => {
      window.removeEventListener("pointermove", handleDragMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", cancelDrag);
    };
    const cancelDrag = () => {
      if (!isDragging) {
        return;
      }
      isDragging = false;
      activePointerId = undefined;
      cleanupDragListeners();
      this.isDraggingSelection = false;
      this.dragPlayheadTime = undefined;
      this.hideSelectionBox();
      this.redrawVisuals();
    };
    const handleDragMove = (event: PointerEvent) => {
      if (!isDragging || event.pointerId !== activePointerId) {
        return;
      }
      this.updateSelectionBox(canvas, startX, event.clientX);
    };
    const finishDrag = (event: PointerEvent) => {
      if (!isDragging || event.pointerId !== activePointerId) {
        return;
      }
      isDragging = false;
      activePointerId = undefined;
      cleanupDragListeners();
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      this.isDraggingSelection = false;
      this.hideSelectionBox();
      if (Math.abs(startX - event.clientX) < MIN_DRAG_PIXELS) {
        this.setPlayheadFromPointer(canvas, event.clientX);
      } else {
        this.setSelectionFromPointer(canvas, startX, event.clientX);
      }
      this.dragPlayheadTime = undefined;
      this.drawTimeline();
    };

    canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (this.selection) {
        if (this.isPointerInsideSelection(canvas, event.clientX)) {
          this.showSelectionContextMenu(event.clientX, event.clientY);
        } else {
          this.clearSelection();
        }
        return;
      }
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
      cancelDrag();
      isDragging = true;
      activePointerId = event.pointerId;
      this.isDraggingSelection = true;
      this.selectionPlaybackEnd = undefined;
      startX = event.clientX;
      this.setDragPlayheadFromPointer(canvas, startX);
      canvas.setPointerCapture(event.pointerId);
      this.updateSelectionBox(canvas, startX, event.clientX);
      window.addEventListener("pointermove", handleDragMove);
      window.addEventListener("pointerup", finishDrag);
      window.addEventListener("pointercancel", cancelDrag);
    });
    window.addEventListener("blur", cancelDrag);
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

    if (event.altKey && canvas.classList.contains("trackWaveform")) {
      event.preventDefault();
      const channel = Number(canvas.dataset.channel ?? 0);
      const view = this.trackViews.find((v) => v.channel === channel);
      if (view) {
        const b = this.amplitudeBound(channel);
        const factor = event.deltaY < 0 ? 0.8 : 1.25;
        view.ampRangeOverride = zoomRange(
          this.effectiveAmplitudeRange(channel),
          this.axisAmplitudeFromClientY(channel, canvas, event.clientY),
          factor,
          -b,
          b
        );
        this.redrawVisuals();
      }
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
    this.setPlaybackPosition(this.playheadTime);
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
    if (this.isPlaybackPaused()) {
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
    this.hideSelectionContextMenu();
    this.playheadTime = selection.start;
    this.dragPlayheadTime = undefined;
    this.selectionPlaybackEnd = this.isPlaybackPaused() ? undefined : selection.end;
    this.setPlaybackPosition(selection.start);
    this.updateClock();
    this.updateSelectionAnalysis();
    this.redrawVisuals();
  }

  private showSelectionContextMenu(clientX: number, clientY: number): void {
    const menu = this.elements.selectionContextMenu;
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const left = clamp(clientX, margin, Math.max(margin, window.innerWidth - rect.width - margin));
    const top = clamp(clientY, margin, Math.max(margin, window.innerHeight - rect.height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector<HTMLElement>("button")?.focus();
  }

  private isPointerInsideSelection(canvas: HTMLCanvasElement, clientX: number): boolean {
    if (!this.selection || !this.audioBuffer) {
      return false;
    }
    const time = clamp(this.timeFromCanvasX(canvas, clientX), 0, this.audioBuffer.duration);
    return time >= this.selection.start && time <= this.selection.end;
  }

  private hideSelectionContextMenu(): void {
    this.elements.selectionContextMenu.hidden = true;
  }

  private handleSelectionContextMenuClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.closest<HTMLButtonElement>("button[data-action]")?.dataset.action;
    if (!action) {
      return;
    }
    this.hideSelectionContextMenu();
    if (action === "download-selection") {
      this.downloadSelectionAsWav();
      return;
    }
    if (action === "clear-selection") {
      this.clearSelection();
    }
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
    const viewport = this.elements.trackList.getBoundingClientRect();
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
        const top = Math.max(canvasRect.top + plot.top, viewport.top);
        const bottom = Math.min(canvasRect.top + plot.bottom, viewport.bottom);
        if (bottom > top) {
          rects.push({ top, bottom });
        }
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
      this.cancelSelectionSpectrumAnalysis();
      this.elements.analysisStart.closest<HTMLElement>(".selectionAnalysisPane")?.setAttribute("hidden", "");
      this.setAnalysisValue(this.elements.analysisStart, "--");
      this.setAnalysisValue(this.elements.analysisEnd, "--");
      this.setAnalysisValue(this.elements.analysisDuration, "--");
      this.setAnalysisValue(this.elements.analysisRms, "--");
      this.setAnalysisValue(this.elements.analysisPeak, "--");
      this.setAnalysisValue(this.elements.analysisDominant, "--");
      this.setAnalysisValue(this.elements.analysisCrest, "--");
      this.setAnalysisValue(this.elements.analysisClipping, "--");
      this.setAnalysisValue(this.elements.analysisNoiseFloor, "--");
      this.setAnalysisValue(this.elements.analysisCentroid, "--");
      this.setAnalysisValue(this.elements.analysisZcr, "--");
      this.renderFrequencyRows([]);
      return;
    }
    this.elements.analysisStart.closest<HTMLElement>(".selectionAnalysisPane")?.removeAttribute("hidden");

    const samples = this.samplesForActiveTrack();
    if (!samples) {
      this.cancelSelectionSpectrumAnalysis();
      return;
    }
    const startSample = Math.floor(this.selection.start * this.audioBuffer.sampleRate);
    const endSample = Math.min(samples.length, Math.ceil(this.selection.end * this.audioBuffer.sampleRate));
    const timeMetrics = computeTimeSelectionMetrics(samples, startSample, endSample, this.audioBuffer.sampleRate);
    this.setAnalysisValue(this.elements.analysisStart, `${this.selection.start.toFixed(3)}s`);
    this.setAnalysisValue(this.elements.analysisEnd, `${this.selection.end.toFixed(3)}s`);
    this.setAnalysisValue(this.elements.analysisDuration, `${(this.selection.end - this.selection.start).toFixed(3)}s`);
    this.setAnalysisValue(this.elements.analysisRms, formatDb(amplitudeToDb(timeMetrics.rms)));
    this.setAnalysisValue(this.elements.analysisPeak, formatDb(amplitudeToDb(timeMetrics.peak)));
    this.setAnalysisValue(this.elements.analysisDominant, this.selectionAnalysisCalculatingText(), true);
    this.setAnalysisValue(this.elements.analysisCrest, Number.isFinite(timeMetrics.crestDb) ? `${timeMetrics.crestDb.toFixed(1)} dB` : "--");
    this.setAnalysisValue(this.elements.analysisClipping, `${timeMetrics.clippingPercent.toFixed(3)}%`);
    this.setAnalysisValue(this.elements.analysisNoiseFloor, formatDb(timeMetrics.noiseFloorDb));
    this.setAnalysisValue(this.elements.analysisCentroid, this.selectionAnalysisCalculatingText(), true);
    this.setAnalysisValue(this.elements.analysisZcr, `${timeMetrics.zeroCrossingRate.toFixed(1)}/s`);
    this.renderFrequencyRows(BAND_LIMITS.map((band) => ({ label: this.messages[band.labelKey], percent: Number.NaN })), true);
    this.scheduleSelectionSpectrumAnalysis(samples, startSample, endSample);
  }

  private setAnalysisValue(element: HTMLElement, value: string, loading = false): void {
    element.textContent = value;
    element.classList.toggle("analysisValueLoading", loading);
  }

  private selectionAnalysisCalculatingText(): string {
    return this.messages.selectionAnalysisCalculating ?? this.messages.analyzingSpectrogram;
  }

  private scheduleSelectionSpectrumAnalysis(samples: Float32Array, startSample: number, endSample: number): void {
    if (this.selectionSpectrumTimer !== undefined) {
      window.clearTimeout(this.selectionSpectrumTimer);
      this.selectionSpectrumTimer = undefined;
    }
    if (this.selectionSpectrumRunning) {
      this.selectionSpectrumRunning = false;
      this.resetSelectionWorker();
    }
    this.selectionSpectrumRequestSeq += 1;
    const requestId = `selection-spectrum-${this.selectionSpectrumRequestSeq}`;
    this.currentSelectionSpectrumRequestId = requestId;
    this.selectionSpectrumTimer = window.setTimeout(() => {
      this.selectionSpectrumTimer = undefined;
      if (!this.selection || this.currentSelectionSpectrumRequestId !== requestId) {
        return;
      }
      const selectedSamples = samples.slice(startSample, endSample);
      if (this.currentSelectionSpectrumRequestId !== requestId) {
        return;
      }
      this.selectionSpectrumRunning = true;
      this.selectionWorker.postMessage(
        {
          type: "selectionSpectrum",
          requestId,
          samples: selectedSamples.buffer,
          sampleRate: this.analysisSampleRate(),
          fftSize: this.settings.fftSize,
          windowFunction: this.settings.windowFunction,
          bandLimits: BAND_LIMITS.map((band) => ({ min: band.min, max: band.max }))
        },
        [selectedSamples.buffer]
      );
    }, SELECTION_SPECTRUM_DELAY_MS);
  }

  private applySelectionSpectrumResult(result: SelectionSpectrumResult): void {
    if (!this.selection || this.currentSelectionSpectrumRequestId !== result.requestId) {
      return;
    }
    this.selectionSpectrumRunning = false;
    this.currentSelectionSpectrumRequestId = undefined;
    this.setAnalysisValue(this.elements.analysisDominant, formatHz(result.dominantHz));
    this.setAnalysisValue(this.elements.analysisCentroid, formatHz(result.centroidHz));
    this.renderFrequencyRows(BAND_LIMITS.map((band, index) => ({
      label: this.messages[band.labelKey],
      percent: result.bandPercents[index] ?? 0
    })));
  }

  private renderFrequencyRows(bands: Array<{ label: string; percent: number }>, loading = false): void {
    this.elements.analysisBands.replaceChildren();
    const rows = bands.length > 0 ? bands : [{ label: this.messages.bands, percent: Number.NaN }];
    for (const band of rows) {
      const row = document.createElement("tr");
      const name = document.createElement("th");
      const value = document.createElement("td");
      name.textContent = band.label;
      value.textContent = loading ? this.selectionAnalysisCalculatingText() : Number.isFinite(band.percent) ? `${band.percent.toFixed(1)}%` : "--";
      value.classList.toggle("analysisValueLoading", loading);
      row.append(name, value);
      this.elements.analysisBands.appendChild(row);
    }
  }

  private analysisSampleRate(): number {
    return this.sourceSampleRate ?? this.audioBuffer?.sampleRate ?? 1;
  }

  private nyquistFrequency(): number {
    return Math.max(1, this.analysisSampleRate() / 2);
  }

  private spectrogramFrequencyRange(): { minHz: number; maxHz: number; storedMaxHz: number } {
    return normalizeFrequencyRange(
      this.settings.spectrogramMinHz,
      this.settings.spectrogramMaxHz,
      this.settings.spectrogramMaxFollowsNyquist,
      this.nyquistFrequency()
    );
  }

  private effectiveFrequencyScale(channel: number): FrequencyScale {
    const view = this.trackViews.find((v) => v.channel === channel);
    return view?.freqScaleOverride ?? this.settings.frequencyScale;
  }

  private effectiveFrequencyRange(channel: number): { minHz: number; maxHz: number } {
    const view = this.trackViews.find((v) => v.channel === channel);
    if (view?.freqRangeOverride) {
      return view.freqRangeOverride;
    }
    const range = this.spectrogramFrequencyRange();
    return { minHz: range.minHz, maxHz: range.maxHz };
  }

  private channelPeak(channel: number): number {
    const cached = this.channelPeakCache.get(channel);
    if (cached !== undefined) {
      return cached;
    }
    const samples = this.samplesForChannel(channel);
    let peak = 0;
    if (samples) {
      const stride = Math.max(1, Math.ceil(samples.length / 1_000_000));
      for (let i = 0; i < samples.length; i += stride) {
        peak = Math.max(peak, Math.abs(samples[i] ?? 0));
      }
    }
    this.channelPeakCache.set(channel, peak);
    return peak;
  }

  private autoAmplitudeRange(channel: number): { min: number; max: number } {
    const p = this.channelPeak(channel);
    const m = clamp(p <= 1e-6 ? 1 : p / 0.9, 1e-3, 1e6);
    return { min: -m, max: m };
  }

  private effectiveAmplitudeRange(channel: number): { min: number; max: number } {
    const view = this.trackViews.find((v) => v.channel === channel);
    if (view?.ampRangeOverride) {
      return view.ampRangeOverride;
    }
    if (this.settings.amplitudeAuto) {
      return this.autoAmplitudeRange(channel);
    }
    return { min: this.settings.amplitudeMin, max: this.settings.amplitudeMax };
  }

  private amplitudeBound(channel: number): number {
    return Math.max(1, this.channelPeak(channel) * 1.05);
  }

  private axisAmplitudeFromClientY(channel: number, canvas: HTMLCanvasElement, clientY: number): number {
    const rect = this.getPlotRect(canvas);
    const bounds = canvas.getBoundingClientRect();
    const y = (clientY - bounds.top) * (canvas.height / Math.max(1, bounds.height));
    const ratio = clamp((rect.bottom - y) / Math.max(1, rect.height), 0, 1);
    const { min, max } = this.effectiveAmplitudeRange(channel);
    return min + ratio * (max - min);
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

  private drawWaveformAxis(context: CanvasRenderingContext2D, rect: PlotRect, channel: number): void {
    context.save();
    context.fillStyle = axisTextColor();
    context.strokeStyle = axisGridColor();
    context.font = axisFont();
    context.textAlign = "right";
    const { min: lo, max: hi } = this.effectiveAmplitudeRange(channel);
    const heightCss = rect.height / (window.devicePixelRatio || 1);
    const intervals = computeAxisIntervals(heightCss, { even: true });
    for (let index = 0; index <= intervals; index += 1) {
      const ratio = index / intervals;
      const value = hi - ratio * (hi - lo);
      const y = rect.top + ratio * rect.height;
      context.beginPath();
      context.moveTo(rect.left, y);
      context.lineTo(rect.right, y);
      context.stroke();
      if (index === 0) {
        context.textBaseline = "top";
        context.fillText(formatAmplitudeAxis(value), rect.left - devicePx(6), rect.top + devicePx(2));
      } else if (index === intervals) {
        context.textBaseline = "bottom";
        context.fillText(formatAmplitudeAxis(value), rect.left - devicePx(6), rect.bottom - devicePx(2));
      } else {
        context.textBaseline = "middle";
        context.fillText(formatAmplitudeAxis(value), rect.left - devicePx(6), y);
      }
    }
    context.restore();
  }

  private drawFrequencyAxis(context: CanvasRenderingContext2D, rect: PlotRect, channel: number): void {
    if (!this.audioBuffer) {
      return;
    }
    context.save();
    context.fillStyle = axisTextColor();
    context.strokeStyle = axisGridColor();
    context.font = axisFont();
    context.textAlign = "right";
    const frequencyRange = this.effectiveFrequencyRange(channel);
    const heightCss = rect.height / (window.devicePixelRatio || 1);
    const ticks = computeAxisIntervals(heightCss);
    for (let index = 0; index <= ticks; index += 1) {
      const ratio = index / ticks;
      const frequency = frequencyFromRatio(ratio, this.effectiveFrequencyScale(channel), frequencyRange.minHz, frequencyRange.maxHz);
      const y = rect.bottom - ratio * rect.height;
      context.beginPath();
      context.moveTo(rect.left, y);
      context.lineTo(rect.right, y);
      context.stroke();
      if (index === ticks) {
        context.textBaseline = "top";
        context.fillText(formatAxisFrequency(frequency), rect.left - devicePx(6), rect.top + devicePx(2));
      } else if (index === 0) {
        context.textBaseline = "bottom";
        context.fillText(formatAxisFrequency(frequency), rect.left - devicePx(6), rect.bottom - devicePx(2));
      } else {
        context.textBaseline = "middle";
        context.fillText(formatAxisFrequency(frequency), rect.left - devicePx(6), y);
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

  private getTimelinePlotRect(canvas: HTMLCanvasElement): PlotRect {
    const ratio = window.devicePixelRatio || 1;
    const left = TRACK_AXIS_WIDTH * ratio;
    const top = 0;
    const right = Math.max(left + 1, canvas.width);
    const bottom = Math.max(top + 1, canvas.height);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
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

async function encodeWavAsync(audioBuffer: AudioBuffer, startFrame = 0, endFrame = audioBuffer.length): Promise<ArrayBuffer> {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const start = clamp(Math.floor(startFrame), 0, audioBuffer.length);
  const end = clamp(Math.ceil(endFrame), start, audioBuffer.length);
  const frames = end - start;
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
  const chunkFrames = 262_144;
  for (let frame = 0; frame < frames; frame += 1) {
    const sourceFrame = start + frame;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = clamp(channelData[channel][sourceFrame] ?? 0, -1, 1);
      view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
      offset += bytesPerSample;
    }
    if (frame > 0 && frame % chunkFrames === 0) {
      await yieldToBrowser();
    }
  }
  return buffer;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function sanitizeFileNameBase(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^/.\\]+$/, "");
  const sanitized = withoutExtension.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "audio";
}

function formatSelectionTime(time: number): string {
  return Math.max(0, time).toFixed(3);
}

async function bytesToBase64Async(bytes: Uint8Array): Promise<string> {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
    if (offset > 0 && offset % (chunkSize * 128) === 0) {
      await yieldToBrowser();
    }
  }
  return btoa(binary);
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
  const encoding = {
    "signed-8": "Signed 8-bit PCM",
    "signed-16": "Signed 16-bit PCM",
    "signed-24": "Signed 24-bit PCM",
    "signed-32": "Signed 32-bit PCM",
    "unsigned-8": "Unsigned 8-bit PCM",
    "float-32": "32-bit float",
    "float-64": "64-bit float"
  }[pcmFormatToEncoding(format)];
  const endian = format.endianness === "none" ? "no endian" : format.endianness === "little" ? "little-endian" : "big-endian";
  const offset = format.startOffsetBytes ? ` · offset ${format.startOffsetBytes}B` : "";
  return `${format.sampleRate} Hz · ${format.channels}ch · ${encoding} · ${endian}${offset}`;
}

function parseWavePcmFormat(bytes: Uint8Array): { bytes: Uint8Array; format: PcmFormat } | undefined {
  if (bytes.byteLength < 44 || asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "WAVE") {
    return undefined;
  }

  let offset = 12;
  let fmtOffset: number | undefined;
  let fmtSize = 0;
  let dataOffset: number | undefined;
  let dataSize = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = asciiAt(bytes, offset, 4);
    const chunkSize = readUint32Le(bytes, offset + 4);
    const payloadOffset = offset + 8;
    if (chunkId === "data") {
      dataOffset = payloadOffset;
      dataSize = resolveWaveDataSize(chunkSize, bytes.byteLength - payloadOffset);
      break;
    }
    if (payloadOffset + chunkSize > bytes.byteLength) {
      return undefined;
    }
    if (chunkId === "fmt ") {
      fmtOffset = payloadOffset;
      fmtSize = chunkSize;
    }
    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  if (fmtOffset === undefined || dataOffset === undefined || fmtSize < 16) {
    return undefined;
  }

  let audioFormat = readUint16Le(bytes, fmtOffset);
  const channels = readUint16Le(bytes, fmtOffset + 2);
  const sampleRate = readUint32Le(bytes, fmtOffset + 4);
  const blockAlign = readUint16Le(bytes, fmtOffset + 12);
  const bitsPerSample = readUint16Le(bytes, fmtOffset + 14);
  if (audioFormat === 0xfffe) {
    if (fmtSize < 40) {
      return undefined;
    }
    audioFormat = readUint16Le(bytes, fmtOffset + 24);
  }

  const sampleFormat = waveAudioFormatToPcmSampleFormat(audioFormat, bitsPerSample);
  if (
    !sampleFormat ||
    ![8, 16, 24, 32, 64].includes(bitsPerSample) ||
    (sampleFormat === "float" && bitsPerSample !== 32 && bitsPerSample !== 64) ||
    (sampleFormat === "unsigned-int" && bitsPerSample !== 8) ||
    channels <= 0 ||
    sampleRate <= 0 ||
    blockAlign !== channels * (bitsPerSample / 8)
  ) {
    return undefined;
  }

  const payloadBytes = bytes.subarray(dataOffset, dataOffset + dataSize);

  return {
    bytes: payloadBytes,
    format: {
      sampleRate,
      channels,
      bitDepth: bitsPerSample as PcmFormat["bitDepth"],
      sampleFormat,
      endianness: bitsPerSample === 8 ? "none" : "little",
      startOffsetBytes: 0
    }
  };
}

function isEmptyWaveFile(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44 || asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "WAVE") {
    return false;
  }

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = asciiAt(bytes, offset, 4);
    const chunkSize = readUint32Le(bytes, offset + 4);
    const payloadOffset = offset + 8;
    if (chunkId === "data") {
      return resolveWaveDataSize(chunkSize, bytes.byteLength - payloadOffset) === 0;
    }
    const nextOffset = payloadOffset + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset || nextOffset > bytes.byteLength) {
      return false;
    }
    offset = nextOffset;
  }
  return false;
}

function waveAudioFormatToPcmSampleFormat(audioFormat: number, bitsPerSample: number): PcmSampleFormat | undefined {
  if (audioFormat === 1) {
    return bitsPerSample === 8 ? "unsigned-int" : "signed-int";
  }
  if (audioFormat === 3) {
    return "float";
  }
  return undefined;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return value;
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function frequencyFromRatio(ratio: number, scale: FrequencyScale, minHz: number, maxHz: number): number {
  const r = clamp(ratio, 0, 1);
  const bottom = Math.max(0, Math.min(minHz, maxHz - 1));
  const top = Math.max(bottom + 1, maxHz);
  if (scale === "log") {
    if (top <= 20) {
      return bottom + r * (top - bottom);
    }
    const low = 20;
    if (bottom <= 0 && r <= 0) {
      return 0;
    }
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

function normalizeFrequencyRange(minHz: number, maxHz: number, followsNyquist: boolean, nyquist: number): { minHz: number; maxHz: number; storedMaxHz: number } {
  const top = Math.max(1, Math.floor(nyquist));
  const safeMin = clamp(Number.isFinite(minHz) ? Math.floor(minHz) : 0, 0, Math.max(0, top - 1));
  const storedMaxHz = Math.max(1, Math.floor(Number.isFinite(maxHz) ? maxHz : top));
  const effectiveMax = followsNyquist ? top : clamp(storedMaxHz, safeMin + 1, top);
  return {
    minHz: Math.min(safeMin, effectiveMax - 1),
    maxHz: effectiveMax,
    storedMaxHz
  };
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

function formatProfileMs(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toFixed(2)} ms`;
}
