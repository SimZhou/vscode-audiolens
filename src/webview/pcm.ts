export type PcmSampleFormat = "signed-int" | "float";
export type PcmEndianness = "little" | "big";

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitDepth: 8 | 16 | 24 | 32;
  sampleFormat: PcmSampleFormat;
  endianness: PcmEndianness;
  startOffsetBytes?: number;
}

export interface DecodedPcmAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export function decodePcm(bytes: Uint8Array, format: PcmFormat): DecodedPcmAudio {
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

export function createAudioBufferFromChannels(audioContext: BaseAudioContext, decoded: DecodedPcmAudio): AudioBuffer {
  const frames = decoded.channels[0]?.length ?? 0;
  const audioBuffer = audioContext.createBuffer(decoded.channels.length, frames, decoded.sampleRate);
  decoded.channels.forEach((samples, channel) => audioBuffer.getChannelData(channel).set(samples));
  return audioBuffer;
}

export function validatePcmFormat(bytes: Uint8Array, format: PcmFormat): string | undefined {
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
  return undefined;
}

function pcmPayloadBytes(bytes: Uint8Array, format: PcmFormat): Uint8Array {
  return bytes.subarray(format.startOffsetBytes ?? 0);
}

function readSample(bytes: Uint8Array, offset: number, format: PcmFormat): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, getBytesPerSample(format));
  if (format.sampleFormat === "float") {
    return clamp(view.getFloat32(0, format.endianness === "little"), -1, 1);
  }
  if (format.bitDepth === 8) {
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
  return format.sampleFormat === "float" ? 4 : format.bitDepth / 8;
}

function getFrameSize(format: PcmFormat): number {
  return getBytesPerSample(format) * format.channels;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
