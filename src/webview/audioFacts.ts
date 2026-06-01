export interface AudioFileFacts {
  sampleRate?: number;
}

export interface AudioHeaderRow {
  offset: number;
  size: number;
  bits?: string;
  depth?: number;
  treePrefix?: string;
  kind?: "box" | "field";
  field: string;
  value: string;
  note?: string;
}

export interface AudioHeaderInfo {
  format: string;
  summary?: {
    tone: "info" | "warning";
    text: string;
    detail?: string;
    kind?: "wavHeader";
    headerSize?: number;
    standard?: boolean;
    missingData?: boolean;
    reasons?: WavHeaderReason[];
  };
  rows: AudioHeaderRow[];
}

export type WavHeaderReason =
  | { type: "fmtExtended"; size: number }
  | { type: "format"; format: number; name: string }
  | { type: "extraChunks"; chunks: string[] }
  | { type: "dataOffset" };

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

export function readAudioHeaderInfo(bytes: Uint8Array, fileName: string): AudioHeaderInfo | undefined {
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension === "wav" || extension === "wave") {
    return readWavHeaderInfo(bytes);
  }
  if (extension === "flac") {
    return readFlacHeaderInfo(bytes);
  }
  if (extension === "ogg" || extension === "opus") {
    return readOggHeaderInfo(bytes);
  }
  if (extension === "m4a" || extension === "mp4") {
    return readMp4HeaderInfo(bytes);
  }
  if (extension === "aac") {
    return readAacHeaderInfo(bytes) ?? readMp4HeaderInfo(bytes);
  }
  if (extension === "mp3") {
    return readMp3HeaderInfo(bytes);
  }
  return undefined;
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

function readWavHeaderInfo(bytes: Uint8Array): AudioHeaderInfo | undefined {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WAVE") {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: AudioHeaderRow[] = [
    { offset: 0, size: 4, field: "ChunkID", value: ascii(bytes, 0, 4), note: "RIFF" },
    { offset: 4, size: 4, field: "ChunkSize", value: `${view.getUint32(4, true)} B`, note: "文件大小 - 8" },
    { offset: 8, size: 4, field: "Format", value: ascii(bytes, 8, 12), note: "WAVE" }
  ];

  let offset = 12;
  let dataPayloadOffset: number | undefined;
  let fmtChunkSize: number | undefined;
  let audioFormat: number | undefined;
  const extraChunksBeforeData: string[] = [];
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(bytes, offset, offset + 4);
    const chunkLabel = chunkId.trimEnd() || chunkId;
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const chunkEnd = Math.min(dataOffset + chunkSize, bytes.byteLength);
    rows.push({ offset, size: 4, field: `${chunkLabel}.ChunkID`, value: chunkId, note: "子块 ID" });
    rows.push({ offset: offset + 4, size: 4, field: `${chunkLabel}.ChunkSize`, value: `${chunkSize} B`, note: "子块数据长度" });

    if (chunkId === "fmt ") {
      fmtChunkSize = chunkSize;
      if (dataOffset + 2 <= chunkEnd) {
        audioFormat = view.getUint16(dataOffset, true);
      }
      appendWavFmtRows(rows, view, dataOffset, chunkEnd);
    } else if (chunkId === "data") {
      dataPayloadOffset = dataOffset;
      rows.push({ offset: dataOffset, size: chunkSize, field: "data.Payload", value: "", note: "音频数据区域" });
    } else if (chunkSize > 0) {
      if (dataPayloadOffset === undefined) {
        extraChunksBeforeData.push(chunkLabel);
      }
      rows.push({ offset: dataOffset, size: chunkSize, field: `${chunkLabel}.Payload`, value: `${chunkSize} B`, note: "未展开子块" });
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return { format: "WAV / RIFF", summary: wavHeaderSummary(dataPayloadOffset, fmtChunkSize, audioFormat, extraChunksBeforeData), rows };
}

function wavHeaderSummary(
  dataPayloadOffset: number | undefined,
  fmtChunkSize: number | undefined,
  audioFormat: number | undefined,
  extraChunksBeforeData: string[]
): AudioHeaderInfo["summary"] {
  if (dataPayloadOffset === undefined) {
    return { tone: "warning", kind: "wavHeader", missingData: true, text: "未找到 data chunk", detail: "无法判断 WAV 头长度。" };
  }

  const isStandardPcmHeader = dataPayloadOffset === 44 && fmtChunkSize === 16 && audioFormat === 1;
  if (isStandardPcmHeader) {
    return { tone: "info", kind: "wavHeader", headerSize: dataPayloadOffset, standard: true, text: `WAV 头长度 ${dataPayloadOffset} B`, detail: "标准 44 字节 PCM 头。" };
  }

  const reasons = wavHeaderReasons(fmtChunkSize, audioFormat, extraChunksBeforeData);
  return {
    tone: "warning",
    kind: "wavHeader",
    headerSize: dataPayloadOffset,
    standard: false,
    reasons,
    text: `WAV 头长度 ${dataPayloadOffset} B`,
    detail: wavHeaderReasonLabels(reasons).join("；")
  };
}

function wavHeaderReasons(fmtChunkSize: number | undefined, audioFormat: number | undefined, extraChunksBeforeData: string[]): WavHeaderReason[] {
  const reasons: WavHeaderReason[] = [];
  if (fmtChunkSize !== undefined && fmtChunkSize !== 16) {
    reasons.push({ type: "fmtExtended", size: fmtChunkSize });
  }
  if (audioFormat !== undefined && audioFormat !== 1) {
    reasons.push({ type: "format", format: audioFormat, name: wavFormatName(audioFormat) });
  }
  if (extraChunksBeforeData.length > 0) {
    reasons.push({ type: "extraChunks", chunks: extraChunksBeforeData });
  }
  return reasons;
}

function wavHeaderReasonLabels(reasons: WavHeaderReason[]): string[] {
  return reasons.map((reason) => {
    switch (reason.type) {
      case "fmtExtended":
        return `fmt 子块为 ${reason.size} B，包含扩展格式字段`;
      case "format":
        return `编码格式为 ${reason.format} (${reason.name})`;
      case "extraChunks":
        return `data 前有额外子块 ${reason.chunks.join(", ")}`;
      case "dataOffset":
        return "data 起始偏移不是 44 B";
    }
  });
}

function appendWavFmtRows(rows: AudioHeaderRow[], view: DataView, dataOffset: number, chunkEnd: number): void {
  if (dataOffset + 16 > chunkEnd) {
    rows.push({ offset: dataOffset, size: Math.max(0, chunkEnd - dataOffset), field: "fmt.Payload", value: "不完整", note: "fmt 子块过短" });
    return;
  }

  const audioFormat = view.getUint16(dataOffset, true);
  const channels = view.getUint16(dataOffset + 2, true);
  const sampleRate = view.getUint32(dataOffset + 4, true);
  const byteRate = view.getUint32(dataOffset + 8, true);
  const blockAlign = view.getUint16(dataOffset + 12, true);
  const bitsPerSample = view.getUint16(dataOffset + 14, true);
  rows.push({ offset: dataOffset, size: 2, field: "fmt.AudioFormat", value: `${audioFormat} (${wavFormatName(audioFormat)})`, note: "编码格式" });
  rows.push({ offset: dataOffset + 2, size: 2, field: "fmt.NumChannels", value: String(channels), note: "通道数" });
  rows.push({ offset: dataOffset + 4, size: 4, field: "fmt.SampleRate", value: `${sampleRate} Hz`, note: "采样率" });
  rows.push({ offset: dataOffset + 8, size: 4, field: "fmt.ByteRate", value: `${byteRate} B/s`, note: "字节率" });
  rows.push({ offset: dataOffset + 12, size: 2, field: "fmt.BlockAlign", value: `${blockAlign} B`, note: "每帧字节数" });
  rows.push({ offset: dataOffset + 14, size: 2, field: "fmt.BitsPerSample", value: `${bitsPerSample} bit`, note: "位深" });

  if (dataOffset + 18 <= chunkEnd) {
    rows.push({ offset: dataOffset + 16, size: 2, field: "fmt.CbSize", value: `${view.getUint16(dataOffset + 16, true)} B`, note: "扩展参数长度" });
  }
  if (dataOffset + 24 <= chunkEnd && audioFormat === 0xfffe) {
    rows.push({ offset: dataOffset + 18, size: 2, field: "fmt.ValidBitsPerSample", value: `${view.getUint16(dataOffset + 18, true)} bit`, note: "有效位深" });
    rows.push({ offset: dataOffset + 20, size: 4, field: "fmt.ChannelMask", value: `0x${view.getUint32(dataOffset + 20, true).toString(16)}`, note: "声道布局掩码" });
  }
}

function wavFormatName(format: number): string {
  switch (format) {
    case 1:
      return "PCM";
    case 3:
      return "IEEE Float";
    case 6:
      return "A-law";
    case 7:
      return "Mu-law";
    case 0xfffe:
      return "Extensible";
    default:
      return "Unknown";
  }
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

function readFlacHeaderInfo(bytes: Uint8Array): AudioHeaderInfo | undefined {
  if (bytes.byteLength < 4 || ascii(bytes, 0, 4) !== "fLaC") {
    return undefined;
  }

  const rows: AudioHeaderRow[] = [
    { offset: 0, size: 4, field: "Marker", value: "fLaC", note: "FLAC 标识" }
  ];
  let offset = 4;
  while (offset + 4 <= bytes.byteLength) {
    const header = bytes[offset] ?? 0;
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const length = readUint24BE(bytes, offset + 1);
    const dataOffset = offset + 4;
    const blockName = flacBlockTypeName(blockType);
    rows.push({ offset, size: 1, field: `${blockName}.Header`, value: `last=${isLast}, type=${blockType}`, note: "元数据块头" });
    rows.push({ offset: offset + 1, size: 3, field: `${blockName}.Length`, value: `${length} B`, note: "元数据块长度" });

    if (blockType === 0 && dataOffset + 34 <= bytes.byteLength) {
      appendFlacStreamInfoRows(rows, bytes, dataOffset);
    } else if (length > 0) {
      rows.push({ offset: dataOffset, size: length, field: `${blockName}.Payload`, value: `${length} B`, note: "元数据块内容" });
    }

    offset = dataOffset + length;
    if (isLast) {
      break;
    }
  }
  return { format: "FLAC", rows };
}

function appendFlacStreamInfoRows(rows: AudioHeaderRow[], bytes: Uint8Array, offset: number): void {
  const minBlockSize = readUint16BE(bytes, offset);
  const maxBlockSize = readUint16BE(bytes, offset + 2);
  const minFrameSize = readUint24BE(bytes, offset + 4);
  const maxFrameSize = readUint24BE(bytes, offset + 7);
  const sampleRate = (bytes[offset + 10] << 12) | (bytes[offset + 11] << 4) | (bytes[offset + 12] >> 4);
  const channels = ((bytes[offset + 12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((bytes[offset + 12] & 0x01) << 4) | (bytes[offset + 13] >> 4)) + 1;
  const totalSamples = (
    (BigInt(bytes[offset + 13] & 0x0f) << 32n) |
    (BigInt(bytes[offset + 14]) << 24n) |
    (BigInt(bytes[offset + 15]) << 16n) |
    (BigInt(bytes[offset + 16]) << 8n) |
    BigInt(bytes[offset + 17])
  ).toString();
  rows.push({ offset, size: 2, field: "STREAMINFO.MinBlockSize", value: String(minBlockSize), note: "最小块大小" });
  rows.push({ offset: offset + 2, size: 2, field: "STREAMINFO.MaxBlockSize", value: String(maxBlockSize), note: "最大块大小" });
  rows.push({ offset: offset + 4, size: 3, field: "STREAMINFO.MinFrameSize", value: `${minFrameSize} B`, note: "最小帧大小" });
  rows.push({ offset: offset + 7, size: 3, field: "STREAMINFO.MaxFrameSize", value: `${maxFrameSize} B`, note: "最大帧大小" });
  rows.push({ offset: offset + 10, size: 3, bits: "80-99 (20 bit)", field: "STREAMINFO.SampleRate", value: `${sampleRate} Hz`, note: "采样率" });
  rows.push({ offset: offset + 12, size: 1, bits: "100-102 (3 bit)", field: "STREAMINFO.Channels", value: String(channels), note: "通道数" });
  rows.push({ offset: offset + 12, size: 2, bits: "103-107 (5 bit)", field: "STREAMINFO.BitsPerSample", value: `${bitsPerSample} bit`, note: "位深" });
  rows.push({ offset: offset + 13, size: 5, bits: "108-143 (36 bit)", field: "STREAMINFO.TotalSamples", value: totalSamples, note: "总采样数" });
  rows.push({ offset: offset + 18, size: 16, field: "STREAMINFO.MD5", value: hex(bytes, offset + 18, offset + 34), note: "原始音频 MD5" });
}

function readOggHeaderInfo(bytes: Uint8Array): AudioHeaderInfo | undefined {
  if (bytes.byteLength < 27 || ascii(bytes, 0, 4) !== "OggS") {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: AudioHeaderRow[] = [];
  let offset = 0;
  let pageIndex = 0;
  while (offset + 27 <= bytes.byteLength && pageIndex < 4 && ascii(bytes, offset, offset + 4) === "OggS") {
    const segmentCount = bytes[offset + 26] ?? 0;
    if (offset + 27 + segmentCount > bytes.byteLength) {
      break;
    }
    const payloadSize = sumBytes(bytes, offset + 27, offset + 27 + segmentCount);
    const page = `Page${pageIndex}`;
    rows.push({ offset, size: 4, field: `${page}.CapturePattern`, value: "OggS", note: "Ogg 页标识" });
    rows.push({ offset: offset + 4, size: 1, field: `${page}.Version`, value: String(bytes[offset + 4] ?? 0), note: "流结构版本" });
    rows.push({ offset: offset + 5, size: 1, field: `${page}.HeaderType`, value: oggHeaderType(bytes[offset + 5] ?? 0), note: "页类型标志" });
    rows.push({ offset: offset + 6, size: 8, field: `${page}.GranulePosition`, value: view.getBigUint64(offset + 6, true).toString(), note: "绝对位置" });
    rows.push({ offset: offset + 14, size: 4, field: `${page}.BitstreamSerialNumber`, value: String(view.getUint32(offset + 14, true)), note: "逻辑流序号" });
    rows.push({ offset: offset + 18, size: 4, field: `${page}.PageSequenceNumber`, value: String(view.getUint32(offset + 18, true)), note: "页序号" });
    rows.push({ offset: offset + 22, size: 4, field: `${page}.Checksum`, value: `0x${view.getUint32(offset + 22, true).toString(16)}`, note: "页校验和" });
    rows.push({ offset: offset + 26, size: 1, field: `${page}.PageSegments`, value: String(segmentCount), note: "segment 数" });
    rows.push({ offset: offset + 27, size: segmentCount, field: `${page}.SegmentTable`, value: `${segmentCount} B`, note: "segment 长度表" });
    rows.push({ offset: offset + 27 + segmentCount, size: payloadSize, field: `${page}.Payload`, value: `${payloadSize} B`, note: "页数据" });
    if (pageIndex === 0) {
      appendOggCodecRows(rows, bytes, offset + 27 + segmentCount, payloadSize);
    }
    offset += 27 + segmentCount + payloadSize;
    pageIndex += 1;
  }
  return { format: "OGG", rows };
}

function appendOggCodecRows(rows: AudioHeaderRow[], bytes: Uint8Array, offset: number, size: number): void {
  if (size >= 19 && ascii(bytes, offset, offset + 8) === "OpusHead") {
    rows.push({ offset, size: 8, field: "OpusHead.Magic", value: "OpusHead", note: "Opus 识别头" });
    rows.push({ offset: offset + 8, size: 1, field: "OpusHead.Version", value: String(bytes[offset + 8] ?? 0), note: "版本" });
    rows.push({ offset: offset + 9, size: 1, field: "OpusHead.ChannelCount", value: String(bytes[offset + 9] ?? 0), note: "通道数" });
    rows.push({ offset: offset + 10, size: 2, field: "OpusHead.PreSkip", value: String(readUint16LE(bytes, offset + 10)), note: "预跳过采样数" });
    rows.push({ offset: offset + 12, size: 4, field: "OpusHead.InputSampleRate", value: `${readUint32LE(bytes, offset + 12)} Hz`, note: "输入采样率" });
    rows.push({ offset: offset + 16, size: 2, field: "OpusHead.OutputGain", value: String(readInt16LE(bytes, offset + 16)), note: "输出增益" });
    rows.push({ offset: offset + 18, size: 1, field: "OpusHead.ChannelMappingFamily", value: String(bytes[offset + 18] ?? 0), note: "声道映射族" });
    return;
  }
  if (size >= 30 && bytes[offset] === 1 && ascii(bytes, offset + 1, offset + 7) === "vorbis") {
    rows.push({ offset, size: 1, field: "Vorbis.PacketType", value: "1", note: "识别头" });
    rows.push({ offset: offset + 1, size: 6, field: "Vorbis.Magic", value: "vorbis", note: "Vorbis 标识" });
    rows.push({ offset: offset + 7, size: 4, field: "Vorbis.Version", value: String(readUint32LE(bytes, offset + 7)), note: "版本" });
    rows.push({ offset: offset + 11, size: 1, field: "Vorbis.Channels", value: String(bytes[offset + 11] ?? 0), note: "通道数" });
    rows.push({ offset: offset + 12, size: 4, field: "Vorbis.SampleRate", value: `${readUint32LE(bytes, offset + 12)} Hz`, note: "采样率" });
  }
}

function readMp4HeaderInfo(bytes: Uint8Array): AudioHeaderInfo | undefined {
  if (bytes.byteLength < 8) {
    return undefined;
  }

  const rows: AudioHeaderRow[] = [];
  appendMp4Boxes(rows, bytes, 0, bytes.byteLength, 0);
  return rows.length > 0 ? { format: "M4A / MP4", rows } : undefined;
}

function appendMp4Boxes(rows: AudioHeaderRow[], bytes: Uint8Array, start: number, end: number, depth: number): void {
  const boxes = collectMp4Boxes(bytes, start, end);
  boxes.forEach((box, index) => {
    if (rows.length >= 420) {
      return;
    }
    const isLast = index === boxes.length - 1;
    rows.push({ offset: box.offset, size: box.boxSize, depth, treePrefix: isLast ? "└─" : "├─", kind: "box", field: box.type, value: "", note: "box 类型" });
    const payloadOffset = box.offset + box.headerSize;
    const payloadEnd = box.offset + box.boxSize;
    appendKnownMp4BoxRows(rows, bytes, box.type, payloadOffset, payloadEnd, depth + 1, isLast);
    if (isMp4ContainerBox(box.type)) {
      const childStart = box.type === "meta" ? payloadOffset + 4 : payloadOffset;
      if (childStart <= payloadEnd) {
        appendMp4Boxes(rows, bytes, childStart, payloadEnd, depth + 1);
      }
    }
  });
}

function collectMp4Boxes(bytes: Uint8Array, start: number, end: number): Array<{ offset: number; type: string; boxSize: number; headerSize: number }> {
  const boxes: Array<{ offset: number; type: string; boxSize: number; headerSize: number }> = [];
  let offset = start;
  while (offset + 8 <= end && boxes.length < 420) {
    const size32 = readUint32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    if (!isMp4BoxType(type)) {
      break;
    }
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1 && offset + 16 <= end) {
      boxSize = Number(readUint64BE(bytes, offset + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = end - offset;
    }
    if (boxSize < headerSize || offset + boxSize > end) {
      break;
    }
    boxes.push({ offset, type, boxSize, headerSize });
    offset += boxSize;
  }
  return boxes;
}

function appendKnownMp4BoxRows(rows: AudioHeaderRow[], bytes: Uint8Array, type: string, offset: number, end: number, depth: number, parentIsLast: boolean): void {
  const branch = parentIsLast ? "  ├─" : "│ ├─";
  if (type === "ftyp" && offset + 8 <= end) {
    rows.push({ offset, size: 4, depth, treePrefix: branch, kind: "field", field: "MajorBrand", value: ascii(bytes, offset, offset + 4), note: "主品牌" });
    rows.push({ offset: offset + 4, size: 4, depth, treePrefix: branch, kind: "field", field: "MinorVersion", value: String(readUint32BE(bytes, offset + 4)), note: "次版本" });
    if (offset + 8 < end) {
      rows.push({ offset: offset + 8, size: end - offset - 8, depth, treePrefix: branch, kind: "field", field: "CompatibleBrands", value: readBrands(bytes, offset + 8, end), note: "兼容品牌" });
    }
    return;
  }
  if ((type === "mvhd" || type === "mdhd") && offset + 20 <= end) {
    const version = bytes[offset] ?? 0;
    rows.push({ offset, size: 1, depth, treePrefix: branch, kind: "field", field: "Version", value: String(version), note: "版本" });
    rows.push({ offset: offset + 1, size: 3, depth, treePrefix: branch, kind: "field", field: "Flags", value: `0x${hex(bytes, offset + 1, offset + 4)}`, note: "标志" });
    if (version === 1 && offset + 32 <= end) {
      rows.push({ offset: offset + 20, size: 4, depth, treePrefix: branch, kind: "field", field: "Timescale", value: String(readUint32BE(bytes, offset + 20)), note: "时间刻度" });
      rows.push({ offset: offset + 24, size: 8, depth, treePrefix: branch, kind: "field", field: "Duration", value: readUint64BE(bytes, offset + 24).toString(), note: "时长单位数" });
    } else if (offset + 20 <= end) {
      rows.push({ offset: offset + 12, size: 4, depth, treePrefix: branch, kind: "field", field: "Timescale", value: String(readUint32BE(bytes, offset + 12)), note: "时间刻度" });
      rows.push({ offset: offset + 16, size: 4, depth, treePrefix: branch, kind: "field", field: "Duration", value: String(readUint32BE(bytes, offset + 16)), note: "时长单位数" });
    }
    return;
  }
  if (type === "hdlr" && offset + 12 <= end) {
    rows.push({ offset, size: 1, depth, treePrefix: branch, kind: "field", field: "Version", value: String(bytes[offset] ?? 0), note: "版本" });
    rows.push({ offset: offset + 8, size: 4, depth, treePrefix: branch, kind: "field", field: "HandlerType", value: ascii(bytes, offset + 8, offset + 12), note: "处理器类型" });
    return;
  }
  if (type === "stsd" && offset + 16 <= end) {
    rows.push({ offset, size: 1, depth, treePrefix: branch, kind: "field", field: "Version", value: String(bytes[offset] ?? 0), note: "版本" });
    rows.push({ offset: offset + 4, size: 4, depth, treePrefix: branch, kind: "field", field: "EntryCount", value: String(readUint32BE(bytes, offset + 4)), note: "样本描述数量" });
    rows.push({ offset: offset + 12, size: 4, depth, treePrefix: branch, kind: "field", field: "SampleEntryType", value: ascii(bytes, offset + 12, offset + 16), note: "样本类型" });
  }
}

function readAacHeaderInfo(bytes: Uint8Array): AudioHeaderInfo | undefined {
  if (bytes.byteLength < 7 || bytes[0] !== 0xff || ((bytes[1] ?? 0) & 0xf0) !== 0xf0) {
    return undefined;
  }

  const protectionAbsent = bytes[1] & 0x01;
  const profile = (bytes[2] >> 6) & 0x03;
  const sampleRateIndex = (bytes[2] >> 2) & 0x0f;
  const channelConfig = ((bytes[2] & 0x01) << 2) | ((bytes[3] >> 6) & 0x03);
  const frameLength = ((bytes[3] & 0x03) << 11) | (bytes[4] << 3) | ((bytes[5] >> 5) & 0x07);
  const bufferFullness = ((bytes[5] & 0x1f) << 6) | ((bytes[6] >> 2) & 0x3f);
  const frameCount = bytes[6] & 0x03;
  const rows: AudioHeaderRow[] = [
    { offset: 0, size: 2, bits: "0-11 (12 bit)", field: "ADTS.Syncword", value: "0xfff", note: "同步字" },
    { offset: 1, size: 1, bits: "12 (1 bit)", field: "ADTS.MpegVersion", value: ((bytes[1] >> 3) & 0x01) === 0 ? "MPEG-4" : "MPEG-2", note: "MPEG 版本" },
    { offset: 1, size: 1, bits: "13-14 (2 bit)", field: "ADTS.Layer", value: String((bytes[1] >> 1) & 0x03), note: "层" },
    { offset: 1, size: 1, bits: "15 (1 bit)", field: "ADTS.ProtectionAbsent", value: String(protectionAbsent), note: "CRC 是否省略" },
    { offset: 2, size: 1, bits: "16-17 (2 bit)", field: "ADTS.Profile", value: `${profile} (${aacProfileName(profile)})`, note: "AAC profile" },
    { offset: 2, size: 1, bits: "18-21 (4 bit)", field: "ADTS.SamplingFrequencyIndex", value: `${sampleRateIndex} (${aacSampleRate(sampleRateIndex)})`, note: "采样率索引" },
    { offset: 2, size: 2, bits: "23-25 (3 bit)", field: "ADTS.ChannelConfiguration", value: String(channelConfig), note: "声道配置" },
    { offset: 3, size: 3, bits: "30-42 (13 bit)", field: "ADTS.FrameLength", value: `${frameLength} B`, note: "ADTS 帧长度" },
    { offset: 5, size: 2, bits: "43-53 (11 bit)", field: "ADTS.BufferFullness", value: String(bufferFullness), note: "缓冲 fullness" },
    { offset: 6, size: 1, bits: "54-55 (2 bit)", field: "ADTS.RawDataBlocks", value: String(frameCount), note: "原始数据块数量字段" }
  ];
  return { format: "AAC / ADTS", rows };
}

function readMp3HeaderInfo(bytes: Uint8Array): AudioHeaderInfo | undefined {
  const rows: AudioHeaderRow[] = [];
  let offset = 0;
  if (bytes.byteLength >= 10 && ascii(bytes, 0, 3) === "ID3") {
    const tagSize = readSynchsafeUint32(bytes, 6);
    rows.push({ offset: 0, size: 3, field: "ID3.Identifier", value: "ID3", note: "ID3v2 标识" });
    rows.push({ offset: 3, size: 2, field: "ID3.Version", value: `${bytes[3] ?? 0}.${bytes[4] ?? 0}`, note: "ID3 版本" });
    rows.push({ offset: 5, size: 1, field: "ID3.Flags", value: `0x${(bytes[5] ?? 0).toString(16)}`, note: "标志" });
    rows.push({ offset: 6, size: 4, field: "ID3.Size", value: `${tagSize} B`, note: "标签长度" });
    offset = 10 + tagSize;
  }
  while (offset + 4 <= bytes.byteLength && !(bytes[offset] === 0xff && ((bytes[offset + 1] ?? 0) & 0xe0) === 0xe0)) {
    offset += 1;
  }
  if (offset + 4 > bytes.byteLength) {
    return rows.length > 0 ? { format: "MP3", rows } : undefined;
  }

  rows.push({ offset, size: 2, bits: "frame 0-10 (11 bit)", field: "MPEG.Sync", value: "0x7ff", note: "帧同步" });
  rows.push({ offset: offset + 1, size: 1, bits: "frame 11-12 (2 bit)", field: "MPEG.Version", value: mp3VersionName((bytes[offset + 1] >> 3) & 0x03), note: "MPEG 音频版本" });
  rows.push({ offset: offset + 1, size: 1, bits: "frame 13-14 (2 bit)", field: "MPEG.Layer", value: mp3LayerName((bytes[offset + 1] >> 1) & 0x03), note: "Layer" });
  rows.push({ offset: offset + 1, size: 1, bits: "frame 15 (1 bit)", field: "MPEG.ProtectionBit", value: String(bytes[offset + 1] & 0x01), note: "CRC 标志" });
  rows.push({ offset: offset + 2, size: 1, bits: "frame 16-19 (4 bit)", field: "MPEG.BitrateIndex", value: String((bytes[offset + 2] >> 4) & 0x0f), note: "码率索引" });
  rows.push({ offset: offset + 2, size: 1, bits: "frame 20-21 (2 bit)", field: "MPEG.SamplingRateIndex", value: String((bytes[offset + 2] >> 2) & 0x03), note: "采样率索引" });
  rows.push({ offset: offset + 3, size: 1, bits: "frame 24-25 (2 bit)", field: "MPEG.ChannelMode", value: mp3ChannelModeName((bytes[offset + 3] >> 6) & 0x03), note: "声道模式" });
  return { format: "MP3", rows };
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function hex(bytes: Uint8Array, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end; index += 1) {
    value += (bytes[index] ?? 0).toString(16).padStart(2, "0");
  }
  return value;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readInt16LE(bytes: Uint8Array, offset: number): number {
  const value = readUint16LE(bytes, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function readUint24BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) * 0x1000000) + (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) * 0x1000000);
}

function readUint64BE(bytes: Uint8Array, offset: number): bigint {
  return (
    (BigInt(bytes[offset] ?? 0) << 56n) |
    (BigInt(bytes[offset + 1] ?? 0) << 48n) |
    (BigInt(bytes[offset + 2] ?? 0) << 40n) |
    (BigInt(bytes[offset + 3] ?? 0) << 32n) |
    (BigInt(bytes[offset + 4] ?? 0) << 24n) |
    (BigInt(bytes[offset + 5] ?? 0) << 16n) |
    (BigInt(bytes[offset + 6] ?? 0) << 8n) |
    BigInt(bytes[offset + 7] ?? 0)
  );
}

function readSynchsafeUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function sumBytes(bytes: Uint8Array, start: number, end: number): number {
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    sum += bytes[index] ?? 0;
  }
  return sum;
}

function flacBlockTypeName(type: number): string {
  return ["STREAMINFO", "PADDING", "APPLICATION", "SEEKTABLE", "VORBIS_COMMENT", "CUESHEET", "PICTURE"][type] ?? `BLOCK_${type}`;
}

function oggHeaderType(value: number): string {
  const flags = [];
  if ((value & 0x01) !== 0) flags.push("continued");
  if ((value & 0x02) !== 0) flags.push("first");
  if ((value & 0x04) !== 0) flags.push("last");
  return flags.length ? `${value} (${flags.join(", ")})` : String(value);
}

function isMp4BoxType(type: string): boolean {
  return /^[A-Za-z0-9 _-]{4}$/.test(type);
}

function isMp4ContainerBox(type: string): boolean {
  return ["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "meta", "ilst"].includes(type);
}

function readBrands(bytes: Uint8Array, start: number, end: number): string {
  const brands: string[] = [];
  for (let offset = start; offset + 4 <= end; offset += 4) {
    brands.push(ascii(bytes, offset, offset + 4));
  }
  return brands.join(", ");
}

function aacProfileName(profile: number): string {
  return ["Main", "LC", "SSR", "Reserved"][profile] ?? "Unknown";
}

function aacSampleRate(index: number): string {
  return [
    "96000 Hz",
    "88200 Hz",
    "64000 Hz",
    "48000 Hz",
    "44100 Hz",
    "32000 Hz",
    "24000 Hz",
    "22050 Hz",
    "16000 Hz",
    "12000 Hz",
    "11025 Hz",
    "8000 Hz",
    "7350 Hz"
  ][index] ?? "reserved";
}

function mp3VersionName(value: number): string {
  return ["MPEG 2.5", "reserved", "MPEG 2", "MPEG 1"][value] ?? "unknown";
}

function mp3LayerName(value: number): string {
  return ["reserved", "Layer III", "Layer II", "Layer I"][value] ?? "unknown";
}

function mp3ChannelModeName(value: number): string {
  return ["Stereo", "Joint stereo", "Dual channel", "Single channel"][value] ?? "unknown";
}
