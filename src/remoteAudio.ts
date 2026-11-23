import { FileHandle, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { get as httpGet, IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import * as os from "node:os";
import * as path from "node:path";

const MIN_SEGMENT_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
// 临时目录名带上所属扩展宿主的 pid，之后的会话据此区分崩溃/被杀留下的目录和其他窗口仍在用的目录。
const TEMP_DIR_PREFIX = "audiolens-url-";
const TEMP_DIR_RE = /^audiolens-url-(\d+)-/;

export interface RemoteAudioFile {
  filePath: string;
  tempDir: string;
  size: number;
}

export interface RemoteAudioProgress {
  receivedBytes: number;
  totalBytes?: number;
}

type ReportProgress = (progress: RemoteAudioProgress) => void;

export type RemoteAudioErrorCode =
  | "unsupportedScheme" | "tooManyRedirects" | "httpStatus" | "tooLarge" | "empty"
  | "incomplete" | "invalidResponse" | "canceled" | "timedOut";

/** 带稳定错误码的下载失败；编辑器按错误码显示本地化文案。 */
export class RemoteAudioError extends Error {
  public constructor(public readonly code: RemoteAudioErrorCode, message: string, public readonly detail?: string) {
    super(message);
    this.name = "RemoteAudioError";
  }
}

async function requestAudio(address: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<{
  response: IncomingMessage;
  url: string;
}> {
  let url = new URL(address);
  for (let redirects = 0; ; redirects++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new RemoteAudioError("unsupportedScheme", "AudioLens only supports HTTP/HTTPS audio URLs.");
    }
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsGet : httpGet)(url, {
        signal,
        headers: { "Accept-Encoding": "identity", ...headers }
      }, incoming => {
        // 打开输出文件期间连接可能已失败，先挂上 error 监听避免未处理异常。
        incoming.on("error", () => undefined);
        resolve(incoming);
      });
      request.on("error", reject);
    });
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new RemoteAudioError("invalidResponse", `AudioLens: HTTP ${status} redirect has no Location header.`);
      if (redirects >= 5) throw new RemoteAudioError("tooManyRedirects", "AudioLens: too many audio URL redirects.");
      url = new URL(location, url);
      continue;
    }
    if (status !== 200 && status !== 206) {
      response.destroy();
      const detail = `${status} ${response.statusMessage ?? ""}`.trim();
      throw new RemoteAudioError("httpStatus", `AudioLens: HTTP ${detail}`, detail);
    }
    return { response, url: url.href };
  }
}

function responseSize(response: IncomingMessage, maxBytes: number): number | undefined {
  const size = Number(response.headers["content-length"]);
  if (size > maxBytes) throw new RemoteAudioError("tooLarge", "AudioLens: remote audio exceeds audiolens.maxFileSizeMB.");
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

async function writeResponse(
  response: IncomingMessage, file: FileHandle, start: number, limit: number,
  reportBytes: (count: number) => void, prefixOnly = false
): Promise<number> {
  let received = 0;
  for await (const chunk of response) {
    const bytes = chunk as Buffer;
    if (!prefixOnly && received + bytes.length > limit) {
      throw new RemoteAudioError("tooLarge", "AudioLens: remote audio exceeds its expected size or audiolens.maxFileSizeMB.");
    }
    const count = Math.min(bytes.length, limit - received);
    // 按位置写入，保证并发分段互不重叠；同时处理磁盘短写。
    for (let written = 0; written < count;) {
      const result = await file.write(bytes, written, count - written, start + received + written);
      if (!result.bytesWritten) throw new Error("AudioLens: could not write downloaded audio.");
      written += result.bytesWritten;
    }
    received += count;
    reportBytes(count);
    // 首个 GET 直接作为第一段，不额外发 HEAD 探测，也不重复下载开头；break 会销毁剩余响应。
    if (prefixOnly && received === limit) break;
  }
  return received;
}

async function downloadSegments(
  initial: IncomingMessage, url: string, file: FileHandle, size: number,
  etag: string, signal: AbortSignal, reportBytes: (count: number) => void
): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const count = Math.min(MAX_CONNECTIONS, Math.floor(size / MIN_SEGMENT_BYTES));
  const segmentSize = Math.ceil(size / count);
  const tasks = Array.from({ length: count }, async (_, index) => {
    const start = index * segmentSize;
    const end = Math.min(size, start + segmentSize) - 1;
    let response: IncomingMessage | undefined;
    try {
      response = index === 0 ? initial : (await requestAudio(url, controller.signal, {
        Range: `bytes=${start}-${end}`, "If-Range": etag
      })).response;
      if (index !== 0 && (response.statusCode !== 206
        || response.headers["content-range"] !== `bytes ${start}-${end}/${size}`
        || response.headers.etag !== etag
        || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")
        || (response.headers["content-length"] !== undefined && responseSize(response, size) !== end - start + 1))) {
        throw new RemoteAudioError("invalidResponse", "AudioLens: server returned an inconsistent audio range.");
      }
      const received = await writeResponse(response, file, start, end - start + 1, reportBytes, index === 0);
      if (received !== end - start + 1) throw new RemoteAudioError("incomplete", "AudioLens: incomplete audio range.");
    } catch (error) {
      // 截断或复用输出文件前，先停止所有并发分段请求。
      response?.destroy();
      initial.destroy();
      controller.abort();
      throw error;
    }
  });
  try {
    const results = await Promise.allSettled(tasks);
    if (signal.aborted) throw new RemoteAudioError("canceled", "AudioLens: audio download canceled.");
    return results.every(result => result.status === "fulfilled");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function downloadRemoteAudio(
  address: string,
  maxBytes: number,
  options: {
    signal?: AbortSignal;
    /** 超过该时长没有收到响应或数据才失败；持续有数据的慢速下载不会超时。 */
    idleTimeoutMs?: number;
    onProgress?: ReportProgress;
    /** 下载目录的父目录，默认是系统临时目录。 */
    tempRoot?: string;
  } = {}
): Promise<RemoteAudioFile> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  // 每收到一个响应或数据块调用一次；refresh() 重启同一个计时器。
  const touch = () => { timer.refresh(); };
  let tempDir: string | undefined;
  let response: IncomingMessage | undefined;
  let file: FileHandle | undefined;
  try {
    const initial = await requestAudio(address, controller.signal);
    touch();
    response = initial.response;
    if (response.statusCode !== 200) throw new RemoteAudioError("invalidResponse", "AudioLens: unexpected partial audio response.");
    let totalBytes = responseSize(response, maxBytes);
    tempDir = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), `${TEMP_DIR_PREFIX}${process.pid}-`));
    const filePath = path.join(tempDir, `audio${path.posix.extname(new URL(address).pathname)}`);
    file = await open(filePath, "wx");
    let size = 0;
    let lastReportedAt = Date.now();
    const reportBytes = (count: number) => {
      touch();
      size += count;
      const now = Date.now();
      if (now - lastReportedAt >= 200) {
        options.onProgress?.({ receivedBytes: size, totalBytes });
        lastReportedAt = now;
      }
    };
    options.onProgress?.({ receivedBytes: 0, totalBytes });
    const etag = response.headers.etag;
    const canSplit = totalBytes !== undefined && totalBytes >= MIN_SEGMENT_BYTES * 2
      && response.headers["accept-ranges"]?.toLowerCase() === "bytes"
      && etag !== undefined && /^"[^"]*"$/.test(etag)
      && (!response.headers["content-encoding"] || response.headers["content-encoding"] === "identity");
    let complete = false;
    if (canSplit) {
      complete = await downloadSegments(response, initial.url, file, totalBytes!, etag!, controller.signal, reportBytes);
      if (!complete) {
        // 只回退一次完整 GET：绝不把不同版本的分段数据拼进同一个文件。
        await file.truncate(0);
        size = 0;
        response = (await requestAudio(address, controller.signal)).response;
        touch();
        if (response.statusCode !== 200) throw new RemoteAudioError("invalidResponse", "AudioLens: unexpected partial audio response.");
        totalBytes = responseSize(response, maxBytes);
        options.onProgress?.({ receivedBytes: 0, totalBytes });
      }
    }
    if (!complete) {
      await writeResponse(response, file, 0, totalBytes ?? maxBytes, reportBytes);
    }
    if (totalBytes !== undefined && size !== totalBytes) throw new RemoteAudioError("incomplete", "AudioLens: incomplete audio download.");
    if (size === 0) throw new RemoteAudioError("empty", "AudioLens: remote audio is empty.");
    if (controller.signal.aborted) throw new RemoteAudioError("canceled", "AudioLens: audio download canceled.");
    await file.close();
    file = undefined;
    options.onProgress?.({ receivedBytes: size, totalBytes });
    return { filePath, tempDir, size };
  } catch (error) {
    response?.destroy();
    await file?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    if (timedOut) {
      const seconds = String(Math.round((options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) / 1000));
      throw new RemoteAudioError("timedOut", "AudioLens: audio download timed out.", seconds);
    }
    if (controller.signal.aborted) throw new RemoteAudioError("canceled", "AudioLens: audio download canceled.");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/**
 * 清理已退出的扩展宿主留下的下载目录；仍在运行的进程（如其他 VS Code 窗口）的目录保留。
 */
export async function cleanupStaleRemoteAudio(tempRoot = os.tmpdir()): Promise<void> {
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const pid = Number(TEMP_DIR_RE.exec(entry.name)?.[1]);
    if (!entry.isDirectory() || !pid || pid === process.pid || isProcessAlive(pid)) return;
    await rm(path.join(tempRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
  }));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在，但属于其他用户。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
