import { closeSync, openSync, readSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const BASE_BLOCK_SIZE = 512;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

interface WorkerInput {
  wavPath: string;
}

try {
  const result = buildIndex((workerData as WorkerInput).wavPath);
  const transfers: ArrayBuffer[] = [];
  for (const level of result.peakLevels) {
    transfers.push(...level.min, ...level.max);
  }
  parentPort?.postMessage(result, transfers);
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
}

function buildIndex(wavPath: string) {
  const fd = openSync(wavPath, "r");
  try {
    const format = parsePcm16Wave(fd);
    const bytesPerFrame = format.numberOfChannels * 2;
    const length = Math.floor(format.dataSize / bytesPerFrame);
    const bins = Math.ceil(length / BASE_BLOCK_SIZE);
    const baseMin = Array.from({ length: format.numberOfChannels }, () => {
      const values = new Float32Array(bins);
      values.fill(1);
      return values;
    });
    const baseMax = Array.from({ length: format.numberOfChannels }, () => {
      const values = new Float32Array(bins);
      values.fill(-1);
      return values;
    });
    const peaks = new Array<number>(format.numberOfChannels).fill(0);
    const sums = new Array<number>(format.numberOfChannels).fill(0);
    const chunkBytes = Math.max(bytesPerFrame, Math.floor(READ_CHUNK_BYTES / bytesPerFrame) * bytesPerFrame);
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let frameOffset = 0;
    while (frameOffset < length) {
      const framesToRead = Math.min(Math.floor(buffer.byteLength / bytesPerFrame), length - frameOffset);
      const bytesRead = readSync(fd, buffer, 0, framesToRead * bytesPerFrame, format.dataOffset + frameOffset * bytesPerFrame);
      const framesRead = Math.floor(bytesRead / bytesPerFrame);
      for (let frame = 0; frame < framesRead; frame += 1) {
        const bin = Math.floor((frameOffset + frame) / BASE_BLOCK_SIZE);
        const sampleBase = frame * format.numberOfChannels;
        for (let channel = 0; channel < format.numberOfChannels; channel += 1) {
          const sample = buffer.readInt16LE((sampleBase + channel) * 2) / 32768;
          if (sample < baseMin[channel][bin]) baseMin[channel][bin] = sample;
          if (sample > baseMax[channel][bin]) baseMax[channel][bin] = sample;
          const absolute = Math.abs(sample);
          if (absolute > peaks[channel]) peaks[channel] = absolute;
          sums[channel] += sample * sample;
        }
      }
      if (framesRead === 0) break;
      frameOffset += framesRead;
    }

    const levels: Array<{ blockSize: number; min: Float32Array[]; max: Float32Array[] }> = [
      { blockSize: BASE_BLOCK_SIZE, min: baseMin, max: baseMax }
    ];
    while (levels[levels.length - 1].min[0].length > 1) {
      const previous = levels[levels.length - 1];
      const nextBins = Math.ceil(previous.min[0].length / 2);
      const nextMin = Array.from({ length: format.numberOfChannels }, () => new Float32Array(nextBins));
      const nextMax = Array.from({ length: format.numberOfChannels }, () => new Float32Array(nextBins));
      for (let channel = 0; channel < format.numberOfChannels; channel += 1) {
        for (let bin = 0; bin < nextBins; bin += 1) {
          const left = bin * 2;
          const right = Math.min(left + 1, previous.min[channel].length - 1);
          nextMin[channel][bin] = Math.min(previous.min[channel][left], previous.min[channel][right]);
          nextMax[channel][bin] = Math.max(previous.max[channel][left], previous.max[channel][right]);
        }
      }
      levels.push({ blockSize: previous.blockSize * 2, min: nextMin, max: nextMax });
    }

    return {
      dataOffset: format.dataOffset,
      sampleRate: format.sampleRate,
      numberOfChannels: format.numberOfChannels,
      length,
      duration: length / format.sampleRate,
      channelPeaks: peaks,
      channelRms: sums.map((sum) => Math.sqrt(sum / Math.max(1, length))),
      peakLevels: levels.map((level) => ({
        blockSize: level.blockSize,
        min: level.min.map(toArrayBuffer),
        max: level.max.map(toArrayBuffer)
      }))
    };
  } finally {
    closeSync(fd);
  }
}

function parsePcm16Wave(fd: number): { dataOffset: number; dataSize: number; sampleRate: number; numberOfChannels: number } {
  const header = Buffer.alloc(1024 * 1024);
  const bytesRead = readSync(fd, header, 0, header.byteLength, 0);
  if (bytesRead < 12 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("FFmpeg did not produce a supported RIFF/WAVE cache.");
  }
  let offset = 12;
  let sampleRate = 0;
  let numberOfChannels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  while (offset + 8 <= bytesRead) {
    const id = header.toString("ascii", offset, offset + 4);
    const size = header.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === "fmt " && size >= 16 && payload + 16 <= bytesRead) {
      audioFormat = header.readUInt16LE(payload);
      numberOfChannels = header.readUInt16LE(payload + 2);
      sampleRate = header.readUInt32LE(payload + 4);
      bitsPerSample = header.readUInt16LE(payload + 14);
    } else if (id === "data") {
      if (audioFormat !== 1 || bitsPerSample !== 16 || numberOfChannels < 1 || sampleRate < 1) {
        throw new Error("FFmpeg PCM cache must be 16-bit little-endian PCM WAV.");
      }
      return { dataOffset: payload, dataSize: size, sampleRate, numberOfChannels };
    }
    offset = payload + size + (size & 1);
  }
  throw new Error("Cannot find the PCM data chunk in the FFmpeg WAV cache.");
}

function toArrayBuffer(values: Float32Array): ArrayBuffer {
  return values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength) as ArrayBuffer;
}
