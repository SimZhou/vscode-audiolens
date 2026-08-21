import { spawn } from "node:child_process";
import { open, rm, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";

export interface PeakLevel {
  blockSize: number;
  min: Float32Array[];
  max: Float32Array[];
}

export interface StreamedAudioCache {
  wavPath: string;
  tempDir: string;
  dataOffset: number;
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  duration: number;
  channelPeaks: number[];
  channelRms: number[];
  peakLevels: PeakLevel[];
}

interface CacheWorkerMessage {
  dataOffset: number;
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  duration: number;
  channelPeaks: number[];
  channelRms: number[];
  peakLevels: Array<{ blockSize: number; min: ArrayBuffer[]; max: ArrayBuffer[] }>;
}

const PCM_SCALE = 1 / 32768;
const FINE_WAVEFORM_READ_BYTES = 4 * 1024 * 1024;

export async function createStreamedAudioCache(options: {
  inputPath: string;
  wavPath: string;
  tempDir: string;
  workerPath: string;
  maxCacheBytes: number;
  timeoutMs: number;
}): Promise<StreamedAudioCache> {
  try {
    await runFfmpegToFile(options.inputPath, options.wavPath, options.maxCacheBytes, options.timeoutMs);
    const file = await stat(options.wavPath);
    if (file.size >= options.maxCacheBytes) {
      throw new Error(`FFmpeg PCM cache reached its ${formatBytes(options.maxCacheBytes)} safety limit.`);
    }
    const result = await buildPeakIndex(options.workerPath, options.wavPath, options.timeoutMs);
    return {
      wavPath: options.wavPath,
      tempDir: options.tempDir,
      ...result,
      peakLevels: result.peakLevels.map((level) => ({
        blockSize: level.blockSize,
        min: level.min.map((buffer) => new Float32Array(buffer)),
        max: level.max.map((buffer) => new Float32Array(buffer))
      }))
    };
  } catch (error) {
    await rm(options.tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function disposeStreamedAudioCache(cache: StreamedAudioCache): Promise<void> {
  await rm(cache.tempDir, { recursive: true, force: true });
}

export async function readWaveformPeaks(
  cache: StreamedAudioCache,
  channel: number,
  startSample: number,
  endSample: number,
  width: number
): Promise<{ min: Float32Array; max: Float32Array }> {
  const safeChannel = clampInteger(channel, 0, cache.numberOfChannels - 1);
  const safeStart = clampInteger(startSample, 0, cache.length);
  const safeEnd = clampInteger(endSample, safeStart, cache.length);
  const safeWidth = clampInteger(width, 1, 8192);
  const samplesPerPixel = Math.max(1, (safeEnd - safeStart) / safeWidth);
  let level = cache.peakLevels[0];
  for (const candidate of cache.peakLevels) {
    if (candidate.blockSize > samplesPerPixel) {
      break;
    }
    level = candidate;
  }

  if (samplesPerPixel < level.blockSize) {
    return readFineWaveformPeaks(cache, safeChannel, safeStart, safeEnd, safeWidth);
  }

  const sourceMin = level.min[safeChannel];
  const sourceMax = level.max[safeChannel];
  const min = new Float32Array(safeWidth);
  const max = new Float32Array(safeWidth);
  for (let pixel = 0; pixel < safeWidth; pixel += 1) {
    const pixelStart = safeStart + ((safeEnd - safeStart) * pixel) / safeWidth;
    const pixelEnd = safeStart + ((safeEnd - safeStart) * (pixel + 1)) / safeWidth;
    const firstBin = Math.max(0, Math.floor(pixelStart / level.blockSize));
    const lastBin = Math.min(sourceMin.length - 1, Math.max(firstBin, Math.ceil(pixelEnd / level.blockSize) - 1));
    let lo = 1;
    let hi = -1;
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      lo = Math.min(lo, sourceMin[bin] ?? 0);
      hi = Math.max(hi, sourceMax[bin] ?? 0);
    }
    min[pixel] = lo <= hi ? lo : 0;
    max[pixel] = lo <= hi ? hi : 0;
  }
  return { min, max };
}

async function readFineWaveformPeaks(
  cache: StreamedAudioCache,
  channel: number,
  startSample: number,
  endSample: number,
  width: number
): Promise<{ min: Float32Array; max: Float32Array }> {
  const min = new Float32Array(width);
  const max = new Float32Array(width);
  const sampleCount = endSample - startSample;
  if (sampleCount <= 0) {
    return { min, max };
  }

  const bytesPerFrame = cache.numberOfChannels * 2;
  const maxFramesPerRead = Math.max(1, Math.floor(FINE_WAVEFORM_READ_BYTES / bytesPerFrame));
  const pixelStart = (pixel: number): number => Math.min(
    endSample - 1,
    startSample + Math.floor((pixel * sampleCount) / width)
  );
  const pixelEnd = (pixel: number): number => Math.min(
    endSample,
    Math.max(pixelStart(pixel) + 1, startSample + Math.ceil(((pixel + 1) * sampleCount) / width))
  );

  const handle = await open(cache.wavPath, "r");
  try {
    let firstPixel = 0;
    while (firstPixel < width) {
      const readStart = pixelStart(firstPixel);
      let lastPixel = firstPixel;
      let readEnd = pixelEnd(lastPixel);
      while (lastPixel + 1 < width) {
        const candidateEnd = pixelEnd(lastPixel + 1);
        if (candidateEnd - readStart > maxFramesPerRead) {
          break;
        }
        lastPixel += 1;
        readEnd = candidateEnd;
      }

      const input = Buffer.allocUnsafe((readEnd - readStart) * bytesPerFrame);
      await readFully(handle, input, cache.dataOffset + readStart * bytesPerFrame);
      for (let pixel = firstPixel; pixel <= lastPixel; pixel += 1) {
        const from = pixelStart(pixel) - readStart;
        const to = pixelEnd(pixel) - readStart;
        let lo = 1;
        let hi = -1;
        for (let frame = from; frame < to; frame += 1) {
          const sample = input.readInt16LE((frame * cache.numberOfChannels + channel) * 2) * PCM_SCALE;
          lo = Math.min(lo, sample);
          hi = Math.max(hi, sample);
        }
        min[pixel] = lo <= hi ? lo : 0;
        max[pixel] = lo <= hi ? hi : 0;
      }
      firstPixel = lastPixel + 1;
    }
  } finally {
    await handle.close();
  }
  return { min, max };
}

export async function readChannelSamples(
  cache: StreamedAudioCache,
  channel: number,
  startSample: number,
  endSample: number,
  maxOutputBytes: number
): Promise<Float32Array> {
  const safeChannel = clampInteger(channel, 0, cache.numberOfChannels - 1);
  const safeStart = clampInteger(startSample, 0, cache.length);
  const safeEnd = clampInteger(endSample, safeStart, cache.length);
  const sampleCount = safeEnd - safeStart;
  if (sampleCount * Float32Array.BYTES_PER_ELEMENT > maxOutputBytes) {
    throw new Error(`Requested PCM range is too large: ${formatBytes(sampleCount * 4)} / ${formatBytes(maxOutputBytes)}.`);
  }
  const result = new Float32Array(sampleCount);
  if (sampleCount === 0) {
    return result;
  }
  const bytesPerFrame = cache.numberOfChannels * 2;
  const input = Buffer.allocUnsafe(sampleCount * bytesPerFrame);
  const handle = await open(cache.wavPath, "r");
  try {
    await readFully(handle, input, cache.dataOffset + safeStart * bytesPerFrame);
  } finally {
    await handle.close();
  }
  extractChannel(input, result, safeChannel, cache.numberOfChannels, 0);
  return result;
}

export async function readPackedWindows(
  cache: StreamedAudioCache,
  options: {
    channel: number;
    startSample: number;
    endSample: number;
    windowSize: number;
    hopSize: number;
    maxFrames: number;
    maxOutputBytes: number;
  }
): Promise<{ samples: Float32Array; frameCount: number; windowSize: number }> {
  const channel = clampInteger(options.channel, 0, cache.numberOfChannels - 1);
  const start = clampInteger(options.startSample, 0, cache.length);
  const end = clampInteger(options.endSample, start, cache.length);
  const windowSize = clampInteger(options.windowSize, 8, 32768);
  const hopSize = clampInteger(options.hopSize, 1, Math.max(1, cache.length));
  const available = Math.max(0, end - start);
  const naturalFrames = available <= windowSize ? 1 : Math.floor((available - windowSize) / hopSize) + 1;
  const frameCount = Math.min(clampInteger(options.maxFrames, 1, 8192), Math.max(1, naturalFrames));
  const outputBytes = frameCount * windowSize * Float32Array.BYTES_PER_ELEMENT;
  if (outputBytes > options.maxOutputBytes) {
    throw new Error(`Requested FFT windows are too large: ${formatBytes(outputBytes)} / ${formatBytes(options.maxOutputBytes)}.`);
  }

  const samples = new Float32Array(frameCount * windowSize);
  const bytesPerFrame = cache.numberOfChannels * 2;
  const handle = await open(cache.wavPath, "r");
  try {
    if (hopSize <= windowSize * 2) {
      const lastStart = start + (frameCount - 1) * hopSize;
      const readFrames = Math.min(cache.length - start, lastStart - start + windowSize);
      const input = Buffer.allocUnsafe(Math.max(0, readFrames * bytesPerFrame));
      await readFully(handle, input, cache.dataOffset + start * bytesPerFrame);
      for (let frame = 0; frame < frameCount; frame += 1) {
        extractChannel(input, samples, channel, cache.numberOfChannels, frame * windowSize, frame * hopSize, windowSize);
      }
    } else {
      const input = Buffer.allocUnsafe(windowSize * bytesPerFrame);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const frameStart = start + frame * hopSize;
        const readableFrames = Math.max(0, Math.min(windowSize, cache.length - frameStart));
        input.fill(0);
        if (readableFrames > 0) {
          await readFully(handle, input.subarray(0, readableFrames * bytesPerFrame), cache.dataOffset + frameStart * bytesPerFrame);
        }
        extractChannel(input, samples, channel, cache.numberOfChannels, frame * windowSize, 0, windowSize);
      }
    }
  } finally {
    await handle.close();
  }
  return { samples, frameCount, windowSize };
}

async function runFfmpegToFile(inputPath: string, outputPath: string, maxOutputBytes: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
      "-vn", "-f", "wav", "-acodec", "pcm_s16le", "-fs", String(maxOutputBytes), outputPath
    ]);
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const timeout = setTimeout(() => fail(new Error(`FFmpeg timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < 8192) {
        stderr.push(chunk);
        stderrBytes += chunk.byteLength;
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(error.code === "ENOENT"
        ? new Error("FFmpeg is required to open this encoded audio format, but the ffmpeg command was not found.")
        : error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `FFmpeg exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function buildPeakIndex(workerPath: string, wavPath: string, timeoutMs: number): Promise<CacheWorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { wavPath } });
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("PCM peak indexing timed out.")), timeoutMs);
    const finish = (error?: Error, value?: CacheWorkerMessage): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    worker.once("message", (message: CacheWorkerMessage | { error: string }) => {
      if ("error" in message) finish(new Error(message.error));
      else finish(undefined, message);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`PCM peak index worker exited with code ${code}.`));
    });
  });
}

function extractChannel(
  input: Buffer,
  output: Float32Array,
  channel: number,
  channels: number,
  outputOffset: number,
  inputFrameOffset = 0,
  frameCount = output.length - outputOffset
): void {
  const availableFrames = Math.max(0, Math.floor(input.byteLength / (channels * 2)) - inputFrameOffset);
  const count = Math.min(frameCount, availableFrames, output.length - outputOffset);
  for (let frame = 0; frame < count; frame += 1) {
    output[outputOffset + frame] = input.readInt16LE(((inputFrameOffset + frame) * channels + channel) * 2) * PCM_SCALE;
  }
}

async function readFully(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset < buffer.byteLength) buffer.fill(0, offset);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
