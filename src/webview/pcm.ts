export type PcmEncoding = "signed-8" | "signed-16" | "signed-24" | "signed-32" | "unsigned-8" | "float-32" | "float-64";
export type PcmSampleFormat = "signed-int" | "unsigned-int" | "float";
export type PcmEndianness = "none" | "little" | "big";

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitDepth: 8 | 16 | 24 | 32 | 64;
  sampleFormat: PcmSampleFormat;
  endianness: PcmEndianness;
  startOffsetBytes?: number;
}

export const PCM_ENCODINGS: readonly PcmEncoding[] = ["signed-8", "signed-16", "signed-24", "signed-32", "unsigned-8", "float-32", "float-64"];
export const MIN_PCM_SAMPLE_RATE = 3_000;
export const MAX_PCM_SAMPLE_RATE = 768_000;
export const MAX_PCM_CHANNELS = 32;

export function isSupportedPcmSampleRate(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= MIN_PCM_SAMPLE_RATE && value <= MAX_PCM_SAMPLE_RATE;
}

export function pcmEncodingToFormat(encoding: PcmEncoding): Pick<PcmFormat, "bitDepth" | "sampleFormat" | "endianness"> {
  switch (encoding) {
    case "signed-8":
      return { bitDepth: 8, sampleFormat: "signed-int", endianness: "none" };
    case "signed-16":
      return { bitDepth: 16, sampleFormat: "signed-int", endianness: "little" };
    case "signed-24":
      return { bitDepth: 24, sampleFormat: "signed-int", endianness: "little" };
    case "signed-32":
      return { bitDepth: 32, sampleFormat: "signed-int", endianness: "little" };
    case "unsigned-8":
      return { bitDepth: 8, sampleFormat: "unsigned-int", endianness: "none" };
    case "float-64":
      return { bitDepth: 64, sampleFormat: "float", endianness: "little" };
    case "float-32":
    default:
      return { bitDepth: 32, sampleFormat: "float", endianness: "little" };
  }
}

export function pcmFormatToEncoding(format: PcmFormat): PcmEncoding {
  if (format.sampleFormat === "float") {
    return format.bitDepth === 64 ? "float-64" : "float-32";
  }
  if (format.sampleFormat === "unsigned-int") {
    return "unsigned-8";
  }
  if (format.bitDepth === 8) {
    return "signed-8";
  }
  if (format.bitDepth === 24) {
    return "signed-24";
  }
  if (format.bitDepth === 32) {
    return "signed-32";
  }
  return "signed-16";
}

export interface DecodedPcmAudio {
  sampleRate: number;
  channels: Float32Array[];
}

// Chromium/Electron 的 AudioContext.createBuffer 仅接受 >= 3000Hz 的采样率，
// 低于此值需先升采样到播放载体，但分析仍用原生采样率。
export const MIN_AUDIO_BUFFER_SAMPLE_RATE = 3_000;

// 几何/分析的唯一样本真值：始终保持原生采样率，不受播放载体升采样影响。
export interface DecodedTrack {
  channels: Float32Array[];
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  duration: number;
}

export function buildDecodedTrack(channels: Float32Array[], sampleRate: number): DecodedTrack {
  const length = channels[0]?.length ?? 0;
  return {
    channels,
    sampleRate,
    length,
    numberOfChannels: channels.length,
    duration: sampleRate > 0 ? length / sampleRate : 0
  };
}

export function trackFromAudioBuffer(buffer: AudioBuffer): DecodedTrack {
  // 引用而非拷贝：普通文件（>=3000Hz）不产生额外内存开销。
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  return {
    channels,
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    duration: buffer.duration
  };
}

export function decodePcm(bytes: Uint8Array, format: PcmFormat): DecodedPcmAudio {
  const normalized = normalizePcmFormat(format);
  const data = pcmPayloadBytes(bytes, normalized);
  const bytesPerSample = getBytesPerSample(normalized);
  const frameSize = getFrameSize(normalized);
  if (bytesPerSample <= 0 || frameSize <= 0 || data.byteLength % frameSize !== 0) {
    throw new Error("PCM parameters do not match the file size.");
  }

  const frames = data.byteLength / frameSize;
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    const frameOffset = frame * frameSize;
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = frameOffset + channel * bytesPerSample;
      channels[channel][frame] = readSample(data, offset, normalized);
    }
  }
  return { sampleRate: format.sampleRate, channels };
}

// 将低于 minRate 的采样率按最小整数倍线性插值升采样，使 createBuffer 可接受。
// 仅用于播放载体；升采样不会在原始 Nyquist 以上凭空造信息，故不损失有效频段。
export function upsampleToMinRate(
  channels: Float32Array[],
  sampleRate: number,
  minRate = MIN_AUDIO_BUFFER_SAMPLE_RATE
): { channels: Float32Array[]; sampleRate: number } {
  if (sampleRate >= minRate || sampleRate <= 0 || channels.length === 0) {
    return { channels, sampleRate };
  }
  const factor = Math.ceil(minRate / sampleRate);
  const targetRate = sampleRate * factor;
  const srcFrames = channels[0]?.length ?? 0;
  // 产出 srcFrames*factor 帧，使播放载体时长与原生精确一致（duration 不变）。
  // 末样本没有后继可插值，其 factor 个样本保持末值。
  const dstFrames = srcFrames * factor;
  const upsampled = channels.map((src) => {
    const dst = new Float32Array(dstFrames);
    for (let i = 0; i < srcFrames; i += 1) {
      const a = src[i];
      const b = i + 1 < srcFrames ? src[i + 1] : a;
      const base = i * factor;
      for (let k = 0; k < factor; k += 1) {
        dst[base + k] = a + ((b - a) * k) / factor;
      }
    }
    return dst;
  });
  return { channels: upsampled, sampleRate: targetRate };
}

// 构造播放专用 AudioBuffer：原生采样率 >= 3000Hz 直接用，否则升采样后再建。
export function buildPlaybackBuffer(audioContext: BaseAudioContext, track: DecodedTrack): AudioBuffer {
  const playable = upsampleToMinRate(track.channels, track.sampleRate);
  const frames = playable.channels[0]?.length ?? 0;
  const audioBuffer = audioContext.createBuffer(Math.max(1, playable.channels.length), Math.max(1, frames), playable.sampleRate);
  playable.channels.forEach((samples, channel) => audioBuffer.getChannelData(channel).set(samples));
  return audioBuffer;
}

export function validatePcmFormat(bytes: Uint8Array, format: PcmFormat): string | undefined {
  const normalized = normalizePcmFormat(format);
  const startOffsetBytes = format.startOffsetBytes ?? 0;
  if (!isSupportedPcmSampleRate(format.sampleRate)) {
    return `PCM sample rate must be between ${MIN_PCM_SAMPLE_RATE} and ${MAX_PCM_SAMPLE_RATE} Hz.`;
  }
  if (!Number.isInteger(format.channels) || format.channels <= 0 || format.channels > MAX_PCM_CHANNELS) {
    return `PCM channel count must be between 1 and ${MAX_PCM_CHANNELS}.`;
  }
  if (![8, 16, 24, 32, 64].includes(normalized.bitDepth)) {
    return "PCM encoding must be Signed 8/16/24/32-bit PCM, Unsigned 8-bit PCM, 32-bit float, or 64-bit float.";
  }
  if (normalized.sampleFormat === "float" && normalized.bitDepth !== 32 && normalized.bitDepth !== 64) {
    return "Float PCM supports 32-bit or 64-bit only.";
  }
  if (normalized.sampleFormat === "unsigned-int" && normalized.bitDepth !== 8) {
    return "Unsigned PCM currently supports 8-bit only.";
  }
  if (normalized.bitDepth > 8 && normalized.endianness === "none") {
    return "Byte order is required for multi-byte PCM encodings.";
  }
  if (!Number.isInteger(startOffsetBytes) || startOffsetBytes < 0) {
    return "PCM start offset must be a non-negative integer.";
  }
  if (startOffsetBytes >= bytes.byteLength) {
    return `PCM start offset ${startOffsetBytes} bytes exceeds the file size.`;
  }
  const dataBytes = bytes.byteLength - startOffsetBytes;
  const frameSize = getFrameSize(normalized);
  if (frameSize <= 0 || dataBytes % frameSize !== 0) {
    return `Data size after offset (${dataBytes} bytes) is not aligned to the current PCM parameters.`;
  }
  return undefined;
}

function pcmPayloadBytes(bytes: Uint8Array, format: PcmFormat): Uint8Array {
  return bytes.subarray(format.startOffsetBytes ?? 0);
}

function readSample(bytes: Uint8Array, offset: number, format: PcmFormat): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, getBytesPerSample(format));
  if (format.sampleFormat === "float") {
    const little = format.endianness === "little";
    return clamp(format.bitDepth === 64 ? view.getFloat64(0, little) : view.getFloat32(0, little), -1, 1);
  }
  if (format.bitDepth === 8) {
    if (format.sampleFormat === "unsigned-int") {
      return (view.getUint8(0) - 128) / 128;
    }
    return view.getInt8(0) / 128;
  }
  if (format.bitDepth === 16) {
    return view.getInt16(0, format.endianness === "little") / 32768;
  }
  if (format.bitDepth === 24) {
    const little = format.endianness === "little";
    const raw = little
      ? view.getUint8(0) | (view.getUint8(1) << 8) | (view.getUint8(2) << 16)
      : view.getUint8(2) | (view.getUint8(1) << 8) | (view.getUint8(0) << 16);
    return signExtend24(raw) / 8_388_608;
  }
  return view.getInt32(0, format.endianness === "little") / 2_147_483_648;
}

function signExtend24(value: number): number {
  return value & 0x80_0000 ? value | ~0xff_ffff : value;
}

function getBytesPerSample(format: PcmFormat): number {
  return format.bitDepth / 8;
}

function getFrameSize(format: PcmFormat): number {
  return getBytesPerSample(format) * format.channels;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizePcmFormat(format: PcmFormat): PcmFormat {
  const encoding = pcmFormatToEncoding(format);
  const encodingFormat = pcmEncodingToFormat(encoding);
  const endianness = encodingFormat.bitDepth === 8 ? "none" : format.endianness === "none" ? encodingFormat.endianness : format.endianness;
  return {
    ...format,
    ...encodingFormat,
    endianness
  };
}
