export interface AudioFileFacts {
  sampleRate?: number;
}

export function readAudioFileFacts(bytes: Uint8Array, fileName: string): AudioFileFacts {
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension === "wav" || extension === "wave") {
    return { sampleRate: readWavSampleRate(bytes) };
  }
  if (extension === "flac") {
    return { sampleRate: readFlacSampleRate(bytes) };
  }
  return {};
}

function readWavSampleRate(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 28 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WAVE") {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (id === "fmt " && dataOffset + 8 <= bytes.byteLength) {
      const sampleRate = view.getUint32(dataOffset + 4, true);
      return sampleRate > 0 ? sampleRate : undefined;
    }
    offset = dataOffset + size + (size % 2);
  }
  return undefined;
}

function readFlacSampleRate(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 42 || ascii(bytes, 0, 4) !== "fLaC") {
    return undefined;
  }

  const blockType = bytes[4] & 0x7f;
  const length = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  if (blockType !== 0 || length < 34 || bytes.byteLength < 42) {
    return undefined;
  }

  const offset = 8;
  const sampleRate = (bytes[offset + 10] << 12) | (bytes[offset + 11] << 4) | (bytes[offset + 12] >> 4);
  return sampleRate > 0 ? sampleRate : undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}
