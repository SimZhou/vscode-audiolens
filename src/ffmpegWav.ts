const RIFF_HEADER_SIZE = 12;
const CHUNK_HEADER_SIZE = 8;
const UNKNOWN_WAV_SIZE = 0xffff_ffff;

/**
 * FFmpeg 向不可 seek 的 stdout 输出 WAV 时，不同版本会把 RIFF 和 data
 * 长度写成 0 或 0xffffffff。数据收集完成后按实际字节数回填，避免
 * Web Audio 和 PCM 解析器拒绝该文件或创建零帧 AudioBuffer。
 */
export function normalizePipedWavSizes(bytes: Uint8Array): void {
  if (
    bytes.byteLength < RIFF_HEADER_SIZE ||
    asciiAt(bytes, 0) !== "RIFF" ||
    asciiAt(bytes, 8) !== "WAVE" ||
    bytes.byteLength - 8 > UNKNOWN_WAV_SIZE
  ) {
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(4, bytes.byteLength - 8, true);

  let offset = RIFF_HEADER_SIZE;
  while (offset + CHUNK_HEADER_SIZE <= bytes.byteLength) {
    const chunkId = asciiAt(bytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadOffset = offset + CHUNK_HEADER_SIZE;

    if (chunkId === "data") {
      const remainingBytes = bytes.byteLength - payloadOffset;
      const normalizedSize = resolveWaveDataSize(chunkSize, remainingBytes);
      if (normalizedSize !== chunkSize) {
        view.setUint32(offset + 4, normalizedSize, true);
      }
      return;
    }

    const nextOffset = payloadOffset + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset || nextOffset > bytes.byteLength) {
      return;
    }
    offset = nextOffset;
  }
}

export function resolveWaveDataSize(chunkSize: number, remainingBytes: number): number {
  if ((chunkSize === 0 && remainingBytes > 0) || chunkSize === UNKNOWN_WAV_SIZE || chunkSize > remainingBytes) {
    return remainingBytes;
  }
  return chunkSize;
}

function asciiAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}
