import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_CHUNK_SIZE,
  ExtensionMessage,
  WebviewMessage,
  AudioLensConfig,
  AudioLensPreferences
} from "./shared/protocol";
import {
  createStreamedAudioCache,
  disposeStreamedAudioCache,
  readChannelSamples,
  readPackedWindows,
  readWaveformPeaks,
  StreamedAudioCache
} from "./streamedAudioCache";
import { formatBytes, getNonce } from "./util";
import { downloadRemoteAudio, RemoteAudioError } from "./remoteAudio";
import { getRemoteAudioUrl } from "./remoteAudioUri";

const PREFERENCES_KEY = "audiolens.preferences.v1";
const ARK_OFFSET_QUERY_KEY = "arkOffset";
const MAX_MESSAGE_TEXT_LENGTH = 1024;
const MAX_SELECTION_WAV_CHUNK_BYTES = 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 60_000;
const FFMPEG_CACHE_TIMEOUT_MS = 5 * 60_000;
const MAX_STREAMED_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_PCM_CACHE_BYTES = 4 * 1024 * 1024 * 1024 - 2 * 1024 * 1024;
const WINDOW_FUNCTIONS = ["rectangular", "bartlett", "hamming", "hann", "blackman", "blackmanHarris", "welch", "gaussian25", "gaussian35", "gaussian45"] as const;
const FFT_SIZES = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768] as const;
const ZERO_PADDING_FACTORS = [1, 2, 4, 8, 16, 32, 64, 128] as const;
const TRACK_MODES = ["both", "waveform", "spectrogram"] as const;
const FREQUENCY_SCALES = ["linear", "log", "mel", "bark", "erb"] as const;
const SPECTROGRAM_PALETTES = ["rose", "classic", "grayscale", "inverseGrayscale"] as const;

interface ExtensionMessages {
  arkOffsetTitle: string;
  arkOffsetPlaceholder: string;
  arkOffsetPrompt: (fileName: string) => string;
  arkOffsetValidation: string;
  arkOffsetRequired: string;
  arkOpenTitle: string;
  arkOpenPlaceholder: string;
  arkOpenPrompt: string;
  arkInputParseFailed: string;
  arkOffsetInvalid: (offset: number) => string;
  arkOffsetOutOfRange: (offset: number) => string;
  arkOffsetNotWave: (offset: number) => string;
  arkEntrySizeInvalid: (offset: number) => string;
  remoteDownloadTitle: string;
  remoteWaitingForServer: string;
  remoteDownloaded: (progress: string) => string;
  remoteRequiresTrust: string;
  remoteDownloadFailed: (reason: string) => string;
  remoteErrorCanceled: string;
  remoteErrorTimedOut: (seconds: string) => string;
  remoteErrorTooLarge: (limit: string) => string;
  remoteErrorHttpStatus: (status: string) => string;
  remoteErrorRedirects: string;
  remoteErrorScheme: string;
  remoteErrorEmpty: string;
  remoteErrorIncomplete: string;
  remoteErrorInvalidResponse: string;
}

interface AudioLensDocumentSource {
  uri: vscode.Uri;
  offset: number;
  size: number;
  displayName?: string;
  extensionOverride?: string;
  needsArkOffset?: boolean;
  arkOffset?: number;
}

interface PendingSelectionWavWrite {
  destination: vscode.Uri;
  fileName: string;
  chunks: Buffer[];
  nextChunkIndex: number;
  totalBytes: number;
}

class AudioLensDocument implements vscode.CustomDocument {
  public static async create(
    uri: vscode.Uri,
    options: { maxBytes: number; token: vscode.CancellationToken; messages: ExtensionMessages }
  ): Promise<AudioLensDocument> {
    const remoteUrl = getRemoteAudioUrl(uri);
    if (remoteUrl) {
      return AudioLensDocument.createRemote(uri, remoteUrl, options);
    }
    const source = await AudioLensDocument.resolveSource(uri);
    return new AudioLensDocument(uri, source);
  }

  private static async createRemote(
    uri: vscode.Uri,
    remoteUrl: string,
    { maxBytes, token, messages }: { maxBytes: number; token: vscode.CancellationToken; messages: ExtensionMessages }
  ): Promise<AudioLensDocument> {
    if (!vscode.workspace.isTrusted) {
      throw new Error(messages.remoteRequiresTrust);
    }
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: messages.remoteDownloadTitle,
        cancellable: true
      }, async (progress, progressToken) => {
        const cancel = progressToken.onCancellationRequested(() => controller.abort());
        try {
          progress.report({ message: messages.remoteWaitingForServer });
          // 通知进度条不能后退。并发下载回退为单个 GET 时，进度条停在原位，等字节数追上再前进。
          let reportedPercent = 0;
          const downloaded = await downloadRemoteAudio(remoteUrl, maxBytes, {
            signal: controller.signal,
            onProgress: ({ receivedBytes, totalBytes }) => {
              const percent = totalBytes ? Math.min(100, receivedBytes / totalBytes * 100) : undefined;
              const size = totalBytes ? `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}` : formatBytes(receivedBytes);
              const increment = percent !== undefined && percent > reportedPercent ? percent - reportedPercent : undefined;
              progress.report({
                message: messages.remoteDownloaded(`${size}${percent === undefined ? "" : ` (${Math.floor(percent)}%)`}`),
                increment
              });
              if (increment !== undefined) reportedPercent = percent!;
            }
          }).catch((error: unknown) => {
            throw new Error(describeRemoteAudioError(error, messages, maxBytes));
          });
          try {
            return new AudioLensDocument(uri, {
              uri: vscode.Uri.file(downloaded.filePath),
              offset: 0,
              size: downloaded.size,
              displayName: path.posix.basename(uri.path)
            }, downloaded.tempDir);
          } catch (error) {
            await rm(downloaded.tempDir, { recursive: true, force: true });
            throw error;
          }
        } finally {
          cancel.dispose();
        }
      });
    } finally {
      subscription.dispose();
    }
  }

  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly watcher: vscode.FileSystemWatcher;
  private refreshTimer: NodeJS.Timeout | undefined;
  private nonFileBytes: Uint8Array | undefined;

  public readonly onDidChange = this.changeEmitter.event;
  public readonly onDidDispose = this.disposeEmitter.event;

  private constructor(
    public readonly uri: vscode.Uri,
    private source: AudioLensDocumentSource,
    private readonly remoteTempDir?: string
  ) {
    const parentUri = this.source.uri.with({
      path: path.posix.dirname(this.source.uri.path),
      query: "",
      fragment: ""
    });
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parentUri, "*"));
    this.watcher.onDidCreate((uri) => this.scheduleRefresh(uri));
    this.watcher.onDidChange((uri) => this.scheduleRefresh(uri));
    this.watcher.onDidDelete((uri) => this.scheduleRefresh(uri));
  }

  public get size(): number {
    return this.source.size;
  }

  public get sourceUri(): vscode.Uri {
    return this.source.uri;
  }

  public get displayName(): string {
    return this.source.displayName ?? path.basename(this.source.uri.fsPath || this.source.uri.path);
  }

  public get extension(): string {
    return this.source.extensionOverride ?? path.extname(this.displayName).toLowerCase().replace(/^\./, "");
  }

  public get needsArkOffset(): boolean {
    return this.source.needsArkOffset === true;
  }

  public get arkOffset(): number | undefined {
    return this.source.arkOffset;
  }

  /** 网络音频：实际数据在临时下载目录里，源文件目录对用户没有意义。 */
  public get isRemote(): boolean {
    return this.remoteTempDir !== undefined;
  }

  public get isFileSlice(): boolean {
    return this.source.offset > 0 || (!this.remoteTempDir && this.source.uri.toString() !== this.uri.with({ query: "", fragment: "" }).toString());
  }

  public async setArkOffset(offset: number): Promise<void> {
    this.nonFileBytes = undefined;
    this.source = await AudioLensDocument.resolveSource(withArkOffset(this.source.uri, offset));
  }

  public async refresh(): Promise<void> {
    this.nonFileBytes = undefined;
    this.source = await AudioLensDocument.refreshSource(this.source);
  }

  public async readRange(offset: number, length: number): Promise<Uint8Array> {
    const safeOffset = Math.max(0, Math.min(offset, this.source.size));
    const safeLength = Math.max(0, Math.min(length, this.source.size - safeOffset));
    if (safeLength === 0) {
      return new Uint8Array();
    }

    const sourceOffset = this.source.offset + safeOffset;
    if (this.source.uri.scheme === "file") {
      const handle = await open(this.source.uri.fsPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(safeLength);
        const result = await handle.read(buffer, 0, safeLength, sourceOffset);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, result.bytesRead);
      } finally {
        await handle.close();
      }
    }

    const data = this.nonFileBytes ?? await vscode.workspace.fs.readFile(this.source.uri);
    this.nonFileBytes = data;
    return data.slice(sourceOffset, sourceOffset + safeLength);
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.nonFileBytes = undefined;
    this.watcher.dispose();
    this.changeEmitter.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    if (this.remoteTempDir) void rm(this.remoteTempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private scheduleRefresh(uri: vscode.Uri): void {
    if (
      uri.with({ query: "", fragment: "" }).toString() !==
      this.source.uri.with({ query: "", fragment: "" }).toString()
    ) {
      return;
    }
    this.nonFileBytes = undefined;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.changeEmitter.fire(this.uri);
    }, 80);
  }

  private static async stat(uri: vscode.Uri): Promise<number> {
    if (uri.scheme === "untitled") {
      return 0;
    }
    return (await vscode.workspace.fs.stat(uri)).size;
  }

  private static async resolveSource(uri: vscode.Uri): Promise<AudioLensDocumentSource> {
    const normalizedUri = uri.with({ query: "", fragment: "" });
    const offset = parseArkOffsetQuery(uri);
    const extension = path.extname(normalizedUri.fsPath || normalizedUri.path).toLowerCase();
    if (extension === ".ark") {
      if (offset === undefined) {
        return {
          uri: normalizedUri,
          offset: 0,
          size: 0,
          displayName: path.basename(normalizedUri.fsPath || normalizedUri.path),
          extensionOverride: "ark",
          needsArkOffset: true
        };
      }
      const entrySize = await readArkWavEntrySize(normalizedUri, offset);
      return {
        uri: normalizedUri,
        offset,
        size: entrySize,
        displayName: `${path.basename(normalizedUri.fsPath || normalizedUri.path)}:${offset}.wav`,
        extensionOverride: "wav",
        arkOffset: offset
      };
    }

    return {
      uri: normalizedUri,
      offset: 0,
      size: await AudioLensDocument.stat(normalizedUri)
    };
  }

  private static async refreshSource(source: AudioLensDocumentSource): Promise<AudioLensDocumentSource> {
    if (source.needsArkOffset) {
      return source;
    }
    if (source.extensionOverride === "wav" && path.extname(source.uri.fsPath || source.uri.path).toLowerCase() === ".ark") {
      return {
        ...source,
        size: await readArkWavEntrySize(source.uri, source.offset)
      };
    }
    return {
      ...source,
      size: await AudioLensDocument.stat(source.uri)
    };
  }
}

export class AudioLensEditorProvider implements vscode.CustomReadonlyEditorProvider<AudioLensDocument> {
  private static readonly viewType = "audiolens.audioPreview";
  private readonly pendingSelectionWavDestinations = new WeakMap<vscode.Webview, Map<number, vscode.Uri>>();
  private readonly pendingSelectionWavWrites = new WeakMap<vscode.Webview, Map<number, PendingSelectionWavWrite>>();
  private readonly streamedAudioCaches = new WeakMap<AudioLensDocument, Promise<StreamedAudioCache>>();
  private activeTranscodeCount = 0;

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AudioLensEditorProvider(context);
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(
        AudioLensEditorProvider.viewType,
        provider,
        {
          supportsMultipleEditorsPerDocument: false,
          webviewOptions: {
            retainContextWhenHidden: true
          }
        }
      ),
      vscode.commands.registerCommand("audiolens.openKaldiWavArk", async () => {
        await provider.openKaldiWavArkFromCommand();
      })
    );
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<AudioLensDocument> {
    const document = await AudioLensDocument.create(uri, {
      maxBytes: this.maxTransferBytes(),
      token: _token,
      messages: this.extensionMessages()
    });
    document.onDidDispose(() => {
      this.invalidateStreamedAudioCache(document);
    });
    return document;
  }

  public async resolveCustomEditor(
    document: AudioLensDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")]
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const postBootstrap = async (): Promise<void> => {
      if (document.needsArkOffset) {
        const messages = this.extensionMessages();
        const offset = await promptForArkOffset(document.sourceUri, messages);
        if (offset === undefined) {
          this.postMessage(webviewPanel.webview, { type: "error", message: messages.arkOffsetRequired });
          return;
        }
        await document.setArkOffset(offset);
      }
      await document.refresh();
      this.postMessage(webviewPanel.webview, {
        type: "bootstrap",
        config: this.readConfig(),
        preferences: this.readPreferences(),
        metadata: this.createMetadata(document)
      });
    };

    const subscriptions: vscode.Disposable[] = [
      document.onDidChange(async () => {
        try {
          this.invalidateStreamedAudioCache(document);
          await document.refresh();
          this.postMessage(webviewPanel.webview, {
            type: "fileChanged",
            metadata: this.createMetadata(document)
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.postMessage(webviewPanel.webview, { type: "error", message });
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("audiolens")) {
          this.postMessage(webviewPanel.webview, {
            type: "configChanged",
            config: this.readConfig()
          });
        }
      }),
      webviewPanel.webview.onDidReceiveMessage(async (rawMessage: unknown) => {
        const message = parseWebviewMessage(rawMessage, this.maxTransferBytes());
        if (!message) {
          this.postMessage(webviewPanel.webview, { type: "error", message: "AudioLens received an invalid Webview message." });
          return;
        }
        await this.handleWebviewMessage(message, document, webviewPanel.webview, postBootstrap);
      })
    ];

    webviewPanel.onDidDispose(() => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    });
  }

  private async handleWebviewMessage(
    message: WebviewMessage,
    document: AudioLensDocument,
    webview: vscode.Webview,
    postBootstrap: () => Promise<void>
  ): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await postBootstrap();
          break;
        case "readChunk": {
          try {
            this.assertTransferAllowed(document);
            const bytes = await document.readRange(message.offset, message.length);
            this.postMessage(webview, {
              type: "chunk",
              requestId: message.requestId,
              offset: message.offset,
              total: document.size,
              bytes: toArrayBuffer(bytes)
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.postMessage(webview, { type: "chunkError", requestId: message.requestId, message: errorMessage });
          }
          break;
        }
        case "updatePreferences":
          await this.context.globalState.update(PREFERENCES_KEY, this.normalizePreferences(message.preferences));
          break;
        case "downloadAudio":
          await this.downloadAudio(document);
          break;
        case "requestSelectionWavSave":
          await this.requestSelectionWavSave(webview, message.requestId, message.fileName, document, message.saveLabel, message.title);
          break;
        case "writeSelectionWavChunk":
          await this.writeSelectionWavChunk(webview, message);
          break;
        case "prepareStreamedAudio":
          await this.prepareStreamedAudio(message.requestId, document, webview);
          break;
        case "readStreamedAudioPeaks":
          await this.readStreamedAudioPeaks(message, document, webview);
          break;
        case "readStreamedAudioSamples":
          await this.readStreamedAudioSamples(message, document, webview);
          break;
        case "readStreamedAudioWindows":
          await this.readStreamedAudioWindows(message, document, webview);
          break;
        case "saveStreamedSelectionWav":
          await this.saveStreamedSelectionWav(message, document, webview);
          break;
        case "showError":
          vscode.window.showErrorMessage(message.message);
          break;
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.postMessage(webview, { type: "error", message: messageText });
    }
  }

  private createMetadata(document: AudioLensDocument) {
    const fileName = document.displayName;
    const extension = document.extension;
    return {
      fileName,
      uri: getRemoteAudioUrl(document.uri) ?? document.uri.toString(),
      size: document.size,
      trusted: vscode.workspace.isTrusted,
      extension,
      kind: extension === "pcm" || extension === "raw" ? "pcm" as const : "encoded" as const,
      sourceKind: document.arkOffset === undefined ? undefined : "ark" as const,
      sourceOffset: document.arkOffset
    };
  }

  private async downloadAudio(document: AudioLensDocument): Promise<void> {
    this.assertTransferAllowed(document);

    const fileName = document.displayName;
    const destination = await vscode.window.showSaveDialog({
      defaultUri: resolveDefaultDownloadUri(document, fileName),
      saveLabel: "Download Audio",
      title: "Download Audio"
    });
    if (!destination) {
      return;
    }

    const bytes = await document.readRange(0, document.size);
    await vscode.workspace.fs.writeFile(destination, bytes);
    vscode.window.showInformationMessage(`AudioLens saved ${fileName}.`);
  }

  private async requestSelectionWavSave(webview: vscode.Webview, requestId: number, fileName: string, document: AudioLensDocument, saveLabel?: string, title?: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Workspace is not trusted; AudioLens will not transfer audio content.");
    }

    const safeFileName = sanitizeSelectionWavFileName(fileName);
    const destination = await vscode.window.showSaveDialog({
      defaultUri: resolveDefaultDownloadUri(document, safeFileName),
      filters: { "WAV audio": ["wav"] },
      saveLabel: saveLabel || "Download Selection",
      title: title || "Download Selection as WAV"
    });
    if (!destination) {
      this.postMessage(webview, { type: "selectionWavSaveCanceled", requestId });
      return;
    }

    let destinations = this.pendingSelectionWavDestinations.get(webview);
    if (!destinations) {
      destinations = new Map();
      this.pendingSelectionWavDestinations.set(webview, destinations);
    }
    destinations.set(requestId, destination);
    this.postMessage(webview, { type: "selectionWavSaveReady", requestId });
  }

  private async writeSelectionWavChunk(
    webview: vscode.Webview,
    message: Extract<WebviewMessage, { type: "writeSelectionWavChunk" }>
  ): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Workspace is not trusted; AudioLens will not transfer audio content.");
    }

    const decodedSize = decodedBase64Size(message.bytesBase64);
    const maxBytes = this.maxTransferBytes();
    let writes = this.pendingSelectionWavWrites.get(webview);
    if (!writes) {
      writes = new Map();
      this.pendingSelectionWavWrites.set(webview, writes);
    }
    let pending = writes.get(message.requestId);
    if (!pending) {
      const destinations = this.pendingSelectionWavDestinations.get(webview);
      const destination = destinations?.get(message.requestId);
      destinations?.delete(message.requestId);
      if (!destination || message.chunkIndex !== 0) {
        return;
      }
      pending = {
        destination,
        fileName: sanitizeSelectionWavFileName(message.fileName),
        chunks: [],
        nextChunkIndex: 0,
        totalBytes: 0
      };
      writes.set(message.requestId, pending);
    }

    if (message.chunkIndex !== pending.nextChunkIndex) {
      writes.delete(message.requestId);
      throw new Error("Selection WAV chunks arrived out of order.");
    }
    if (pending.totalBytes + decodedSize > maxBytes) {
      writes.delete(message.requestId);
      throw new Error(`Selection WAV is too large: ${formatBytes(pending.totalBytes + decodedSize)} / ${formatBytes(maxBytes)}.`);
    }

    pending.chunks.push(Buffer.from(message.bytesBase64, "base64"));
    pending.totalBytes += decodedSize;
    pending.nextChunkIndex += 1;

    if (!message.isLast) {
      return;
    }

    writes.delete(message.requestId);
    await vscode.workspace.fs.writeFile(pending.destination, new Uint8Array(Buffer.concat(pending.chunks, pending.totalBytes)));
    vscode.window.showInformationMessage(`AudioLens saved ${path.basename(pending.destination.fsPath || pending.fileName)}.`);
  }

  private async prepareStreamedAudio(requestId: number, document: AudioLensDocument, webview: vscode.Webview): Promise<void> {
    try {
      const cache = await this.getStreamedAudioCache(document);
      this.postMessage(webview, {
        type: "streamedAudioReady",
        requestId,
        metadata: {
          sampleRate: cache.sampleRate,
          numberOfChannels: cache.numberOfChannels,
          length: cache.length,
          duration: cache.duration,
          channelPeaks: cache.channelPeaks,
          channelRms: cache.channelRms
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage(webview, { type: "streamedAudioError", requestId, message });
    }
  }

  private async readStreamedAudioPeaks(
    message: Extract<WebviewMessage, { type: "readStreamedAudioPeaks" }>,
    document: AudioLensDocument,
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const cache = await this.getStreamedAudioCache(document);
      const peaks = await readWaveformPeaks(cache, message.channel, message.startSample, message.endSample, message.width);
      this.postMessage(webview, {
        type: "streamedAudioPeaks",
        requestId: message.requestId,
        min: toArrayBuffer(peaks.min),
        max: toArrayBuffer(peaks.max)
      });
    } catch (error) {
      this.postStreamedAudioError(webview, message.requestId, error);
    }
  }

  private async readStreamedAudioSamples(
    message: Extract<WebviewMessage, { type: "readStreamedAudioSamples" }>,
    document: AudioLensDocument,
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const cache = await this.getStreamedAudioCache(document);
      const samples = await readChannelSamples(
        cache,
        message.channel,
        message.startSample,
        message.endSample,
        MAX_STREAMED_RESPONSE_BYTES
      );
      this.postMessage(webview, { type: "streamedAudioSamples", requestId: message.requestId, samples: toArrayBuffer(samples) });
    } catch (error) {
      this.postStreamedAudioError(webview, message.requestId, error);
    }
  }

  private async readStreamedAudioWindows(
    message: Extract<WebviewMessage, { type: "readStreamedAudioWindows" }>,
    document: AudioLensDocument,
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const cache = await this.getStreamedAudioCache(document);
      const result = await readPackedWindows(cache, { ...message, maxOutputBytes: MAX_STREAMED_RESPONSE_BYTES });
      this.postMessage(webview, {
        type: "streamedAudioWindows",
        requestId: message.requestId,
        samples: toArrayBuffer(result.samples),
        frameCount: result.frameCount,
        windowSize: result.windowSize
      });
    } catch (error) {
      this.postStreamedAudioError(webview, message.requestId, error);
    }
  }

  private async saveStreamedSelectionWav(
    message: Extract<WebviewMessage, { type: "saveStreamedSelectionWav" }>,
    document: AudioLensDocument,
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const cache = await this.getStreamedAudioCache(document);
      const startTime = Math.max(0, Math.min(message.startTime, cache.duration));
      const endTime = Math.max(startTime, Math.min(message.endTime, cache.duration));
      if (endTime <= startTime) {
        throw new Error("The selected audio range is empty.");
      }
      const safeFileName = sanitizeSelectionWavFileName(message.fileName);
      const destination = await vscode.window.showSaveDialog({
        defaultUri: resolveDefaultDownloadUri(document, safeFileName),
        filters: { "WAV audio": ["wav"] },
        saveLabel: message.saveLabel || "Download Selection",
        title: message.title || "Download Selection as WAV"
      });
      if (!destination) {
        this.postMessage(webview, { type: "streamedSelectionWavCanceled", requestId: message.requestId });
        return;
      }

      if (destination.scheme === "file") {
        await runFfmpegSelection(cache.wavPath, destination.fsPath, startTime, endTime - startTime);
      } else {
        const outputPath = path.join(cache.tempDir, `selection-${message.requestId}.wav`);
        try {
          await runFfmpegSelection(cache.wavPath, outputPath, startTime, endTime - startTime);
          const outputStat = await stat(outputPath);
          if (outputStat.size > this.maxTransferBytes()) {
            throw new Error(`Selection WAV is too large: ${formatBytes(outputStat.size)} / ${formatBytes(this.maxTransferBytes())}.`);
          }
          await vscode.workspace.fs.writeFile(destination, await readFile(outputPath));
        } finally {
          await rm(outputPath, { force: true }).catch(() => undefined);
        }
      }
      this.postMessage(webview, { type: "streamedSelectionWavSaved", requestId: message.requestId });
      vscode.window.showInformationMessage(`AudioLens saved ${path.basename(destination.fsPath || safeFileName)}.`);
    } catch (error) {
      this.postMessage(webview, {
        type: "streamedSelectionWavError",
        requestId: message.requestId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private getStreamedAudioCache(document: AudioLensDocument): Promise<StreamedAudioCache> {
    // 按需读取和导出也能直接创建缓存，复用缓存前同样需要校验。
    this.assertTransferAllowed(document);
    const existing = this.streamedAudioCaches.get(document);
    if (existing) return existing;
    const pending = this.createDocumentStreamedAudioCache(document);
    this.streamedAudioCaches.set(document, pending);
    void pending.catch(() => {
      if (this.streamedAudioCaches.get(document) === pending) this.streamedAudioCaches.delete(document);
    });
    return pending;
  }

  private async createDocumentStreamedAudioCache(document: AudioLensDocument): Promise<StreamedAudioCache> {
    if (this.activeTranscodeCount >= 1) {
      throw new Error("AudioLens is already preparing another PCM cache.");
    }
    this.activeTranscodeCount += 1;
    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "audiolens-cache-"));
      let inputPath = document.sourceUri.fsPath;
      if (document.sourceUri.scheme !== "file" || document.isFileSlice) {
        const extension = document.extension ? `.${document.extension}` : ".audio";
        inputPath = path.join(tempDir, `input${extension}`);
        await writeFile(inputPath, await document.readRange(0, document.size));
      }
      return await createStreamedAudioCache({
        inputPath,
        wavPath: path.join(tempDir, "decoded.wav"),
        tempDir,
        workerPath: path.join(this.context.extensionPath, "dist", "audioCacheWorker.js"),
        maxCacheBytes: Math.min(MAX_PCM_CACHE_BYTES, Math.max(1024 * 1024 * 1024, this.maxTransferBytes() * 8)),
        timeoutMs: FFMPEG_CACHE_TIMEOUT_MS
      });
    } catch (error) {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      this.activeTranscodeCount = Math.max(0, this.activeTranscodeCount - 1);
    }
  }

  private invalidateStreamedAudioCache(document: AudioLensDocument): void {
    const pending = this.streamedAudioCaches.get(document);
    this.streamedAudioCaches.delete(document);
    if (pending) void pending.then(disposeStreamedAudioCache).catch(() => undefined);
  }

  private postStreamedAudioError(webview: vscode.Webview, requestId: number, error: unknown): void {
    this.postMessage(webview, {
      type: "streamedAudioError",
      requestId,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  private readPreferences(): AudioLensPreferences {
    return this.normalizePreferences(this.context.globalState.get<AudioLensPreferences>(PREFERENCES_KEY, {}));
  }

  private normalizePreferences(value: AudioLensPreferences): AudioLensPreferences {
    return {
      windowFunction: oneOf(value.windowFunction, WINDOW_FUNCTIONS),
      fftSize: oneOf(value.fftSize, FFT_SIZES),
      zeroPaddingFactor: oneOf(value.zeroPaddingFactor, ZERO_PADDING_FACTORS),
      defaultTrackMode: oneOf(value.defaultTrackMode, TRACK_MODES),
      defaultTrackRowHeight: finiteNumber(value.defaultTrackRowHeight),
      defaultTrackWaveFr: finiteNumber(value.defaultTrackWaveFr),
      defaultTrackSpecFr: finiteNumber(value.defaultTrackSpecFr),
      frequencyScale: oneOf(value.frequencyScale, FREQUENCY_SCALES),
      palette: oneOf(value.palette, SPECTROGRAM_PALETTES),
      brightnessVersion: oneOf(value.brightnessVersion, [1] as const),
      gainDb: finiteNumber(value.gainDb),
      rangeDb: finiteNumber(value.rangeDb),
      highBoostDb: finiteNumber(value.highBoostDb),
      minDb: finiteNumber(value.minDb),
      maxDb: finiteNumber(value.maxDb),
      spectrogramMinHz: finiteNumber(value.spectrogramMinHz),
      spectrogramMaxHz: finiteNumber(value.spectrogramMaxHz),
      spectrogramMaxFollowsNyquist: booleanValue(value.spectrogramMaxFollowsNyquist),
      autoBrightness: booleanValue(value.autoBrightness),
      amplitudeAuto: booleanValue(value.amplitudeAuto),
      amplitudeMin: finiteNumber(value.amplitudeMin),
      amplitudeMax: finiteNumber(value.amplitudeMax),
      waveformHeight: finiteNumber(value.waveformHeight),
      spectrogramHeight: finiteNumber(value.spectrogramHeight),
      defaultPcmFormat: value.defaultPcmFormat
    };
  }

  private readConfig(): AudioLensConfig {
    const config = vscode.workspace.getConfiguration("audiolens");
    return {
      autoAnalyze: config.get("autoAnalyze", true),
      maxFileSizeMB: this.maxTransferBytes() / (1024 * 1024),
      language: config.get("language", "auto"),
      vscodeLanguage: vscode.env.language,
      profileSpectrogram: config.get("profileSpectrogram", false),
      analysis: {
        windowFunction: config.get("analysis.windowFunction", "hamming"),
        fftSize: config.get("analysis.fftSize", 512),
        zeroPaddingFactor: config.get("analysis.zeroPaddingFactor", 2)
      }
    };
  }

  private maxTransferBytes(): number {
    const config = vscode.workspace.getConfiguration("audiolens");
    const maxFileSizeMB = config.get("maxFileSizeMB", 512);
    const safeMaxFileSizeMB = Number.isFinite(maxFileSizeMB) && maxFileSizeMB >= 16 ? maxFileSizeMB : 512;
    return Math.floor(safeMaxFileSizeMB * 1024 * 1024);
  }

  private assertTransferAllowed(document: AudioLensDocument): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Workspace is not trusted; AudioLens will not transfer audio content.");
    }
    const maxBytes = this.maxTransferBytes();
    if (document.size > maxBytes) {
      throw new Error(`Audio file is too large: ${formatBytes(document.size)} / ${formatBytes(maxBytes)}.`);
    }
  }

  private postMessage(webview: vscode.Webview, message: ExtensionMessage): void {
    webview.postMessage(message);
  }

  private async openKaldiWavArkFromCommand(): Promise<void> {
    try {
      const messages = this.extensionMessages();
      const value = await vscode.window.showInputBox({
        title: messages.arkOpenTitle,
        placeHolder: messages.arkOpenPlaceholder,
        prompt: messages.arkOpenPrompt
      });
      if (!value) {
        return;
      }

      const parsed = await parseArkInput(value);
      if (!parsed) {
        void vscode.window.showWarningMessage(messages.arkInputParseFailed);
        return;
      }
      const offset = parsed.offset ?? await promptForArkOffset(parsed.uri, messages);
      if (offset === undefined) {
        return;
      }

      const target = withArkOffset(parsed.uri, offset);
      await readArkWavEntrySize(parsed.uri, offset);
      await vscode.commands.executeCommand("vscode.openWith", target, AudioLensEditorProvider.viewType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));

    return /* html */ `<!DOCTYPE html>
<html lang="${escapeHtml(this.resolveHtmlLanguage())}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; media-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src blob:; connect-src ${webview.cspSource} blob: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AudioLens</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private resolveHtmlLanguage(): string {
    const config = this.readConfig();
    return config.language === "auto" ? config.vscodeLanguage : config.language;
  }

  private extensionMessages(): ExtensionMessages {
    return resolveExtensionMessages(this.resolveHtmlLanguage());
  }
}

function describeRemoteAudioError(error: unknown, messages: ExtensionMessages, maxBytes: number): string {
  if (!(error instanceof RemoteAudioError)) {
    return messages.remoteDownloadFailed(error instanceof Error ? error.message : String(error));
  }
  const reasons: Record<RemoteAudioError["code"], () => string> = {
    unsupportedScheme: () => messages.remoteErrorScheme,
    tooManyRedirects: () => messages.remoteErrorRedirects,
    httpStatus: () => messages.remoteErrorHttpStatus(error.detail ?? ""),
    tooLarge: () => messages.remoteErrorTooLarge(formatBytes(maxBytes)),
    empty: () => messages.remoteErrorEmpty,
    incomplete: () => messages.remoteErrorIncomplete,
    invalidResponse: () => messages.remoteErrorInvalidResponse,
    canceled: () => messages.remoteErrorCanceled,
    timedOut: () => messages.remoteErrorTimedOut(error.detail ?? "")
  };
  return messages.remoteDownloadFailed(reasons[error.code]());
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    };
    return entities[char] ?? char;
  });
}

function resolveExtensionMessages(locale = vscode.env.language): ExtensionMessages {
  const normalized = normalizeLocale(locale);
  const base: ExtensionMessages = {
    arkOffsetTitle: "AudioLens: Kaldi WAV Ark Offset",
    arkOffsetPlaceholder: "Enter offset",
    arkOffsetPrompt: (fileName) => `${fileName} is an ark file and may be large. Enter the WAV entry offset to read.`,
    arkOffsetValidation: "Enter a non-negative integer offset.",
    arkOffsetRequired: "Enter a Kaldi wav ark offset before opening the audio.",
    arkOpenTitle: "AudioLens: Open Kaldi WAV Ark Entry",
    arkOpenPlaceholder: "/path/to/wav.ark:23252",
    arkOpenPrompt: "Enter a Kaldi wav ark path and offset. If you enter only an .ark path, AudioLens will ask for the offset next.",
    arkInputParseFailed: "Cannot parse the Kaldi wav ark input. Use /path/to/wav.ark:offset.",
    arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} is invalid. Offset must be a non-negative integer.`,
    arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} is outside the file range, so the WAV header cannot be read.`,
    arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} does not point to RIFF/WAVE data.`,
    arkEntrySizeInvalid: (offset) => `The entry at Kaldi wav ark offset ${offset} has an invalid size or exceeds the file range.`,
    remoteDownloadTitle: "AudioLens: Downloading audio",
    remoteWaitingForServer: "Connecting, waiting for the server…",
    remoteDownloaded: (progress) => `Downloaded ${progress}`,
    remoteRequiresTrust: "AudioLens requires a trusted workspace to download remote audio.",
    remoteDownloadFailed: (reason) => `AudioLens cannot download the audio: ${reason}`,
    remoteErrorCanceled: "the download was canceled.",
    remoteErrorTimedOut: (seconds) => `the server sent no data for ${seconds} seconds.`,
    remoteErrorTooLarge: (limit) => `the file exceeds the audiolens.maxFileSizeMB limit (${limit}).`,
    remoteErrorHttpStatus: (status) => `the server returned HTTP ${status}.`,
    remoteErrorRedirects: "too many redirects.",
    remoteErrorScheme: "only HTTP and HTTPS URLs are supported.",
    remoteErrorEmpty: "the server returned an empty file.",
    remoteErrorIncomplete: "the connection ended before the download finished.",
    remoteErrorInvalidResponse: "the server returned an invalid response."
  };
  const overrides: Partial<Record<string, Partial<ExtensionMessages>>> = {
    "zh-CN": {
      arkOffsetPlaceholder: "请输入 offset",
      arkOffsetPrompt: (fileName) => `${fileName} 是 ark 文件，可能很大。请输入要读取的 WAV entry offset。`,
      arkOffsetValidation: "请输入非负整数 offset。",
      arkOffsetRequired: "请输入 Kaldi wav ark offset 后再打开音频。",
      arkOpenPrompt: "输入 Kaldi wav ark 路径和 offset；如果只输入 .ark 路径，下一步会要求输入 offset。",
      arkInputParseFailed: "无法解析 Kaldi wav ark 输入，请使用 /path/to/wav.ark:offset。",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} 无效，offset 必须是非负整数。`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} 超出文件范围，无法读取 WAV 头。`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} 处不是 RIFF/WAVE 数据。`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} 对应的 entry 长度无效或超出文件范围。`,
      remoteDownloadTitle: "AudioLens：正在下载音频",
      remoteWaitingForServer: "正在连接服务器，等待响应…",
      remoteDownloaded: (progress) => `已下载 ${progress}`,
      remoteRequiresTrust: "AudioLens 需要受信任的工作区才能下载网络音频。",
      remoteDownloadFailed: (reason) => `AudioLens 无法下载音频：${reason}`,
      remoteErrorCanceled: "下载已取消。",
      remoteErrorTimedOut: (seconds) => `服务器 ${seconds} 秒内没有返回数据。`,
      remoteErrorTooLarge: (limit) => `文件超过 audiolens.maxFileSizeMB 限制（${limit}）。`,
      remoteErrorHttpStatus: (status) => `服务器返回 HTTP ${status}。`,
      remoteErrorRedirects: "重定向次数过多。",
      remoteErrorScheme: "仅支持 HTTP 和 HTTPS 地址。",
      remoteErrorEmpty: "服务器返回了空文件。",
      remoteErrorIncomplete: "下载完成前连接已中断。",
      remoteErrorInvalidResponse: "服务器响应无效。"
    },
    "zh-TW": {
      arkOffsetPlaceholder: "請輸入 offset",
      arkOffsetPrompt: (fileName) => `${fileName} 是 ark 檔案，可能很大。請輸入要讀取的 WAV entry offset。`,
      arkOffsetValidation: "請輸入非負整數 offset。",
      arkOffsetRequired: "請先輸入 Kaldi wav ark offset 再開啟音訊。",
      arkOpenPrompt: "輸入 Kaldi wav ark 路徑和 offset；如果只輸入 .ark 路徑，下一步會要求輸入 offset。",
      arkInputParseFailed: "無法解析 Kaldi wav ark 輸入，請使用 /path/to/wav.ark:offset。",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} 無效，offset 必須是非負整數。`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} 超出檔案範圍，無法讀取 WAV header。`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} 處不是 RIFF/WAVE 資料。`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} 對應的 entry 長度無效或超出檔案範圍。`,
      remoteDownloadTitle: "AudioLens：正在下載音訊",
      remoteWaitingForServer: "正在連線伺服器，等待回應…",
      remoteDownloaded: (progress) => `已下載 ${progress}`,
      remoteRequiresTrust: "AudioLens 需要受信任的工作區才能下載網路音訊。",
      remoteDownloadFailed: (reason) => `AudioLens 無法下載音訊：${reason}`,
      remoteErrorCanceled: "下載已取消。",
      remoteErrorTimedOut: (seconds) => `伺服器 ${seconds} 秒內沒有回傳資料。`,
      remoteErrorTooLarge: (limit) => `檔案超過 audiolens.maxFileSizeMB 限制（${limit}）。`,
      remoteErrorHttpStatus: (status) => `伺服器回傳 HTTP ${status}。`,
      remoteErrorRedirects: "重新導向次數過多。",
      remoteErrorScheme: "僅支援 HTTP 和 HTTPS 網址。",
      remoteErrorEmpty: "伺服器回傳了空檔案。",
      remoteErrorIncomplete: "下載完成前連線已中斷。",
      remoteErrorInvalidResponse: "伺服器回應無效。"
    },
    ja: {
      arkOffsetPlaceholder: "offset を入力",
      arkOffsetPrompt: (fileName) => `${fileName} は ark ファイルで、大きい可能性があります。読み込む WAV entry の offset を入力してください。`,
      arkOffsetValidation: "0 以上の整数 offset を入力してください。",
      arkOffsetRequired: "音声を開く前に Kaldi wav ark offset を入力してください。",
      arkOpenPrompt: "Kaldi wav ark のパスと offset を入力してください。.ark パスだけを入力した場合は、次に offset を求めます。",
      arkInputParseFailed: "Kaldi wav ark 入力を解析できません。/path/to/wav.ark:offset を使用してください。",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} は無効です。offset は 0 以上の整数である必要があります。`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} はファイル範囲外のため、WAV ヘッダーを読み取れません。`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} は RIFF/WAVE データを指していません。`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} の entry サイズが無効、またはファイル範囲を超えています。`,
      remoteDownloadTitle: "AudioLens: 音声をダウンロード中",
      remoteWaitingForServer: "サーバーに接続し、応答を待っています…",
      remoteDownloaded: (progress) => `ダウンロード済み ${progress}`,
      remoteRequiresTrust: "リモート音声をダウンロードするには、信頼されたワークスペースが必要です。",
      remoteDownloadFailed: (reason) => `AudioLens は音声をダウンロードできません: ${reason}`,
      remoteErrorCanceled: "ダウンロードはキャンセルされました。",
      remoteErrorTimedOut: (seconds) => `サーバーから ${seconds} 秒間データが届きませんでした。`,
      remoteErrorTooLarge: (limit) => `ファイルが audiolens.maxFileSizeMB の上限 (${limit}) を超えています。`,
      remoteErrorHttpStatus: (status) => `サーバーが HTTP ${status} を返しました。`,
      remoteErrorRedirects: "リダイレクトが多すぎます。",
      remoteErrorScheme: "HTTP と HTTPS の URL のみ対応しています。",
      remoteErrorEmpty: "サーバーが空のファイルを返しました。",
      remoteErrorIncomplete: "ダウンロード完了前に接続が切断されました。",
      remoteErrorInvalidResponse: "サーバーの応答が無効です。"
    },
    ko: {
      arkOffsetPlaceholder: "offset 입력",
      arkOffsetPrompt: (fileName) => `${fileName}은 ark 파일이며 클 수 있습니다. 읽을 WAV entry offset을 입력하세요.`,
      arkOffsetValidation: "0 이상의 정수 offset을 입력하세요.",
      arkOffsetRequired: "오디오를 열기 전에 Kaldi wav ark offset을 입력하세요.",
      arkOpenPrompt: "Kaldi wav ark 경로와 offset을 입력하세요. .ark 경로만 입력하면 다음 단계에서 offset을 요청합니다.",
      arkInputParseFailed: "Kaldi wav ark 입력을 해석할 수 없습니다. /path/to/wav.ark:offset 형식을 사용하세요.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset}이 올바르지 않습니다. offset은 0 이상의 정수여야 합니다.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset}이 파일 범위를 벗어나 WAV 헤더를 읽을 수 없습니다.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} 위치가 RIFF/WAVE 데이터가 아닙니다.`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset}의 entry 길이가 올바르지 않거나 파일 범위를 벗어납니다.`,
      remoteDownloadTitle: "AudioLens: 오디오 다운로드 중",
      remoteWaitingForServer: "서버에 연결하여 응답을 기다리는 중…",
      remoteDownloaded: (progress) => `다운로드됨 ${progress}`,
      remoteRequiresTrust: "원격 오디오를 다운로드하려면 신뢰할 수 있는 작업 영역이 필요합니다.",
      remoteDownloadFailed: (reason) => `AudioLens가 오디오를 다운로드할 수 없습니다: ${reason}`,
      remoteErrorCanceled: "다운로드가 취소되었습니다.",
      remoteErrorTimedOut: (seconds) => `서버가 ${seconds}초 동안 데이터를 보내지 않았습니다.`,
      remoteErrorTooLarge: (limit) => `파일이 audiolens.maxFileSizeMB 제한(${limit})을 초과합니다.`,
      remoteErrorHttpStatus: (status) => `서버가 HTTP ${status}을(를) 반환했습니다.`,
      remoteErrorRedirects: "리디렉션이 너무 많습니다.",
      remoteErrorScheme: "HTTP 및 HTTPS URL만 지원합니다.",
      remoteErrorEmpty: "서버가 빈 파일을 반환했습니다.",
      remoteErrorIncomplete: "다운로드가 끝나기 전에 연결이 끊어졌습니다.",
      remoteErrorInvalidResponse: "서버 응답이 올바르지 않습니다."
    },
    fr: {
      arkOffsetPlaceholder: "Saisir l'offset",
      arkOffsetPrompt: (fileName) => `${fileName} est un fichier ark potentiellement volumineux. Saisissez l'offset de l'entrée WAV à lire.`,
      arkOffsetValidation: "Saisissez un offset entier positif ou nul.",
      arkOffsetRequired: "Saisissez un offset Kaldi wav ark avant d'ouvrir l'audio.",
      arkOpenPrompt: "Saisissez un chemin Kaldi wav ark et un offset. Si seul le chemin .ark est saisi, l'offset sera demandé ensuite.",
      arkInputParseFailed: "Impossible d'analyser l'entrée Kaldi wav ark. Utilisez /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `L'offset Kaldi wav ark ${offset} est invalide. Il doit être un entier positif ou nul.`,
      arkOffsetOutOfRange: (offset) => `L'offset Kaldi wav ark ${offset} est hors du fichier ; l'en-tête WAV ne peut pas être lu.`,
      arkOffsetNotWave: (offset) => `L'offset Kaldi wav ark ${offset} ne pointe pas vers des données RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `L'entrée à l'offset Kaldi wav ark ${offset} a une taille invalide ou dépasse le fichier.`,
      remoteDownloadTitle: "AudioLens : téléchargement de l'audio",
      remoteWaitingForServer: "Connexion, en attente du serveur…",
      remoteDownloaded: (progress) => `Téléchargé ${progress}`,
      remoteRequiresTrust: "AudioLens nécessite un espace de travail approuvé pour télécharger un audio distant.",
      remoteDownloadFailed: (reason) => `AudioLens ne peut pas télécharger l'audio : ${reason}`,
      remoteErrorCanceled: "le téléchargement a été annulé.",
      remoteErrorTimedOut: (seconds) => `le serveur n'a envoyé aucune donnée pendant ${seconds} secondes.`,
      remoteErrorTooLarge: (limit) => `le fichier dépasse la limite audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `le serveur a renvoyé HTTP ${status}.`,
      remoteErrorRedirects: "trop de redirections.",
      remoteErrorScheme: "seules les URL HTTP et HTTPS sont prises en charge.",
      remoteErrorEmpty: "le serveur a renvoyé un fichier vide.",
      remoteErrorIncomplete: "la connexion a été interrompue avant la fin du téléchargement.",
      remoteErrorInvalidResponse: "le serveur a renvoyé une réponse invalide."
    },
    de: {
      arkOffsetPlaceholder: "Offset eingeben",
      arkOffsetPrompt: (fileName) => `${fileName} ist eine möglicherweise große ark-Datei. Geben Sie den Offset des zu lesenden WAV-Eintrags ein.`,
      arkOffsetValidation: "Geben Sie einen nicht negativen ganzzahligen Offset ein.",
      arkOffsetRequired: "Geben Sie vor dem Öffnen der Audiodatei einen Kaldi wav ark Offset ein.",
      arkOpenPrompt: "Geben Sie einen Kaldi wav ark Pfad und Offset ein. Bei nur einem .ark Pfad wird der Offset danach abgefragt.",
      arkInputParseFailed: "Kaldi wav ark Eingabe kann nicht analysiert werden. Verwenden Sie /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark Offset ${offset} ist ungültig. Der Offset muss eine nicht negative Ganzzahl sein.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark Offset ${offset} liegt außerhalb der Datei; der WAV-Header kann nicht gelesen werden.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark Offset ${offset} zeigt nicht auf RIFF/WAVE-Daten.`,
      arkEntrySizeInvalid: (offset) => `Der Eintrag bei Kaldi wav ark Offset ${offset} hat eine ungültige Größe oder überschreitet die Datei.`,
      remoteDownloadTitle: "AudioLens: Audio wird heruntergeladen",
      remoteWaitingForServer: "Verbindung wird hergestellt, warte auf den Server…",
      remoteDownloaded: (progress) => `Heruntergeladen ${progress}`,
      remoteRequiresTrust: "AudioLens benötigt einen vertrauenswürdigen Arbeitsbereich, um Remote-Audio herunterzuladen.",
      remoteDownloadFailed: (reason) => `AudioLens kann das Audio nicht herunterladen: ${reason}`,
      remoteErrorCanceled: "Der Download wurde abgebrochen.",
      remoteErrorTimedOut: (seconds) => `Der Server hat ${seconds} Sekunden lang keine Daten gesendet.`,
      remoteErrorTooLarge: (limit) => `Die Datei überschreitet das Limit audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `Der Server hat HTTP ${status} zurückgegeben.`,
      remoteErrorRedirects: "Zu viele Weiterleitungen.",
      remoteErrorScheme: "Nur HTTP- und HTTPS-URLs werden unterstützt.",
      remoteErrorEmpty: "Der Server hat eine leere Datei zurückgegeben.",
      remoteErrorIncomplete: "Die Verbindung wurde vor Abschluss des Downloads beendet.",
      remoteErrorInvalidResponse: "Der Server hat eine ungültige Antwort gesendet."
    },
    ru: {
      arkOffsetPlaceholder: "Введите offset",
      arkOffsetPrompt: (fileName) => `${fileName} — файл ark и может быть большим. Введите offset WAV entry для чтения.`,
      arkOffsetValidation: "Введите неотрицательное целое значение offset.",
      arkOffsetRequired: "Введите Kaldi wav ark offset перед открытием аудио.",
      arkOpenPrompt: "Введите путь Kaldi wav ark и offset. Если указан только путь .ark, offset будет запрошен далее.",
      arkInputParseFailed: "Не удалось разобрать ввод Kaldi wav ark. Используйте /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} недопустим. Offset должен быть неотрицательным целым числом.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} вне диапазона файла, заголовок WAV нельзя прочитать.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} не указывает на данные RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `Entry по Kaldi wav ark offset ${offset} имеет недопустимый размер или выходит за пределы файла.`,
      remoteDownloadTitle: "AudioLens: загрузка аудио",
      remoteWaitingForServer: "Подключение, ожидание ответа сервера…",
      remoteDownloaded: (progress) => `Загружено ${progress}`,
      remoteRequiresTrust: "Для загрузки удалённого аудио AudioLens требуется доверенная рабочая область.",
      remoteDownloadFailed: (reason) => `AudioLens не удаётся загрузить аудио: ${reason}`,
      remoteErrorCanceled: "загрузка отменена.",
      remoteErrorTimedOut: (seconds) => `сервер не передавал данные ${seconds} с.`,
      remoteErrorTooLarge: (limit) => `файл превышает лимит audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `сервер вернул HTTP ${status}.`,
      remoteErrorRedirects: "слишком много перенаправлений.",
      remoteErrorScheme: "поддерживаются только URL HTTP и HTTPS.",
      remoteErrorEmpty: "сервер вернул пустой файл.",
      remoteErrorIncomplete: "соединение прервалось до завершения загрузки.",
      remoteErrorInvalidResponse: "сервер вернул некорректный ответ."
    },
    es: {
      arkOffsetPlaceholder: "Introduce el offset",
      arkOffsetPrompt: (fileName) => `${fileName} es un archivo ark y puede ser grande. Introduce el offset de la entrada WAV que quieres leer.`,
      arkOffsetValidation: "Introduce un offset entero no negativo.",
      arkOffsetRequired: "Introduce un offset Kaldi wav ark antes de abrir el audio.",
      arkOpenPrompt: "Introduce una ruta Kaldi wav ark y un offset. Si introduces solo la ruta .ark, AudioLens pedirá el offset después.",
      arkInputParseFailed: "No se pudo interpretar la entrada Kaldi wav ark. Usa /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `El offset Kaldi wav ark ${offset} no es válido. Debe ser un entero no negativo.`,
      arkOffsetOutOfRange: (offset) => `El offset Kaldi wav ark ${offset} está fuera del archivo y no se puede leer el encabezado WAV.`,
      arkOffsetNotWave: (offset) => `El offset Kaldi wav ark ${offset} no apunta a datos RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `La entrada en el offset Kaldi wav ark ${offset} tiene un tamaño no válido o excede el archivo.`,
      remoteDownloadTitle: "AudioLens: descargando audio",
      remoteWaitingForServer: "Conectando, esperando al servidor…",
      remoteDownloaded: (progress) => `Descargado ${progress}`,
      remoteRequiresTrust: "AudioLens necesita un espacio de trabajo de confianza para descargar audio remoto.",
      remoteDownloadFailed: (reason) => `AudioLens no puede descargar el audio: ${reason}`,
      remoteErrorCanceled: "la descarga se canceló.",
      remoteErrorTimedOut: (seconds) => `el servidor no envió datos durante ${seconds} segundos.`,
      remoteErrorTooLarge: (limit) => `el archivo supera el límite audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `el servidor devolvió HTTP ${status}.`,
      remoteErrorRedirects: "demasiadas redirecciones.",
      remoteErrorScheme: "solo se admiten URL HTTP y HTTPS.",
      remoteErrorEmpty: "el servidor devolvió un archivo vacío.",
      remoteErrorIncomplete: "la conexión se cerró antes de terminar la descarga.",
      remoteErrorInvalidResponse: "el servidor devolvió una respuesta no válida."
    },
    it: {
      arkOffsetPlaceholder: "Inserisci offset",
      arkOffsetPrompt: (fileName) => `${fileName} è un file ark e può essere grande. Inserisci l'offset dell'entry WAV da leggere.`,
      arkOffsetValidation: "Inserisci un offset intero non negativo.",
      arkOffsetRequired: "Inserisci un offset Kaldi wav ark prima di aprire l'audio.",
      arkOpenPrompt: "Inserisci un percorso Kaldi wav ark e un offset. Se inserisci solo il percorso .ark, verrà richiesto l'offset.",
      arkInputParseFailed: "Impossibile analizzare l'input Kaldi wav ark. Usa /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `L'offset Kaldi wav ark ${offset} non è valido. Deve essere un intero non negativo.`,
      arkOffsetOutOfRange: (offset) => `L'offset Kaldi wav ark ${offset} è fuori dal file e l'header WAV non può essere letto.`,
      arkOffsetNotWave: (offset) => `L'offset Kaldi wav ark ${offset} non punta a dati RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `L'entry all'offset Kaldi wav ark ${offset} ha dimensione non valida o supera il file.`,
      remoteDownloadTitle: "AudioLens: download dell'audio",
      remoteWaitingForServer: "Connessione, in attesa del server…",
      remoteDownloaded: (progress) => `Scaricati ${progress}`,
      remoteRequiresTrust: "AudioLens richiede un'area di lavoro attendibile per scaricare audio remoto.",
      remoteDownloadFailed: (reason) => `AudioLens non riesce a scaricare l'audio: ${reason}`,
      remoteErrorCanceled: "il download è stato annullato.",
      remoteErrorTimedOut: (seconds) => `il server non ha inviato dati per ${seconds} secondi.`,
      remoteErrorTooLarge: (limit) => `il file supera il limite audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `il server ha restituito HTTP ${status}.`,
      remoteErrorRedirects: "troppi reindirizzamenti.",
      remoteErrorScheme: "sono supportati solo URL HTTP e HTTPS.",
      remoteErrorEmpty: "il server ha restituito un file vuoto.",
      remoteErrorIncomplete: "la connessione si è interrotta prima del termine del download.",
      remoteErrorInvalidResponse: "il server ha restituito una risposta non valida."
    },
    pt: {
      arkOffsetPlaceholder: "Insira o offset",
      arkOffsetPrompt: (fileName) => `${fileName} é um arquivo ark e pode ser grande. Insira o offset da entrada WAV a ler.`,
      arkOffsetValidation: "Insira um offset inteiro não negativo.",
      arkOffsetRequired: "Insira um offset Kaldi wav ark antes de abrir o áudio.",
      arkOpenPrompt: "Insira um caminho Kaldi wav ark e um offset. Se inserir apenas o caminho .ark, o offset será solicitado em seguida.",
      arkInputParseFailed: "Não foi possível interpretar a entrada Kaldi wav ark. Use /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `O offset Kaldi wav ark ${offset} é inválido. O offset deve ser um inteiro não negativo.`,
      arkOffsetOutOfRange: (offset) => `O offset Kaldi wav ark ${offset} está fora do arquivo; não é possível ler o cabeçalho WAV.`,
      arkOffsetNotWave: (offset) => `O offset Kaldi wav ark ${offset} não aponta para dados RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `A entrada no offset Kaldi wav ark ${offset} tem tamanho inválido ou excede o arquivo.`,
      remoteDownloadTitle: "AudioLens: baixando áudio",
      remoteWaitingForServer: "Conectando, aguardando o servidor…",
      remoteDownloaded: (progress) => `Baixado ${progress}`,
      remoteRequiresTrust: "O AudioLens precisa de um workspace confiável para baixar áudio remoto.",
      remoteDownloadFailed: (reason) => `O AudioLens não consegue baixar o áudio: ${reason}`,
      remoteErrorCanceled: "o download foi cancelado.",
      remoteErrorTimedOut: (seconds) => `o servidor não enviou dados por ${seconds} segundos.`,
      remoteErrorTooLarge: (limit) => `o arquivo excede o limite audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `o servidor retornou HTTP ${status}.`,
      remoteErrorRedirects: "redirecionamentos demais.",
      remoteErrorScheme: "somente URLs HTTP e HTTPS são compatíveis.",
      remoteErrorEmpty: "o servidor retornou um arquivo vazio.",
      remoteErrorIncomplete: "a conexão foi encerrada antes do fim do download.",
      remoteErrorInvalidResponse: "o servidor retornou uma resposta inválida."
    },
    id: {
      arkOffsetPlaceholder: "Masukkan offset",
      arkOffsetPrompt: (fileName) => `${fileName} adalah file ark dan mungkin besar. Masukkan offset entry WAV yang ingin dibaca.`,
      arkOffsetValidation: "Masukkan offset bilangan bulat non-negatif.",
      arkOffsetRequired: "Masukkan offset Kaldi wav ark sebelum membuka audio.",
      arkOpenPrompt: "Masukkan path Kaldi wav ark dan offset. Jika hanya path .ark yang dimasukkan, offset akan diminta berikutnya.",
      arkInputParseFailed: "Tidak dapat mengurai input Kaldi wav ark. Gunakan /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Offset Kaldi wav ark ${offset} tidak valid. Offset harus bilangan bulat non-negatif.`,
      arkOffsetOutOfRange: (offset) => `Offset Kaldi wav ark ${offset} berada di luar rentang file, header WAV tidak dapat dibaca.`,
      arkOffsetNotWave: (offset) => `Offset Kaldi wav ark ${offset} tidak menunjuk ke data RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `Entry pada offset Kaldi wav ark ${offset} memiliki ukuran tidak valid atau melebihi file.`,
      remoteDownloadTitle: "AudioLens: mengunduh audio",
      remoteWaitingForServer: "Menghubungkan, menunggu server…",
      remoteDownloaded: (progress) => `Terunduh ${progress}`,
      remoteRequiresTrust: "AudioLens memerlukan workspace tepercaya untuk mengunduh audio jarak jauh.",
      remoteDownloadFailed: (reason) => `AudioLens tidak dapat mengunduh audio: ${reason}`,
      remoteErrorCanceled: "unduhan dibatalkan.",
      remoteErrorTimedOut: (seconds) => `server tidak mengirim data selama ${seconds} detik.`,
      remoteErrorTooLarge: (limit) => `file melebihi batas audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `server mengembalikan HTTP ${status}.`,
      remoteErrorRedirects: "terlalu banyak pengalihan.",
      remoteErrorScheme: "hanya URL HTTP dan HTTPS yang didukung.",
      remoteErrorEmpty: "server mengembalikan file kosong.",
      remoteErrorIncomplete: "koneksi terputus sebelum unduhan selesai.",
      remoteErrorInvalidResponse: "server mengembalikan respons yang tidak valid."
    },
    no: {
      arkOffsetPlaceholder: "Skriv inn offset",
      arkOffsetPrompt: (fileName) => `${fileName} er en ark-fil og kan være stor. Skriv inn offset for WAV-entryen som skal leses.`,
      arkOffsetValidation: "Skriv inn en ikke-negativ heltalls-offset.",
      arkOffsetRequired: "Skriv inn Kaldi wav ark-offset før du åpner lyden.",
      arkOpenPrompt: "Skriv inn Kaldi wav ark-sti og offset. Hvis du bare skriver inn .ark-stien, blir offset spurt om etterpå.",
      arkInputParseFailed: "Kan ikke tolke Kaldi wav ark-inndata. Bruk /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark-offset ${offset} er ugyldig. Offset må være et ikke-negativt heltall.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark-offset ${offset} er utenfor filområdet, så WAV-headeren kan ikke leses.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark-offset ${offset} peker ikke på RIFF/WAVE-data.`,
      arkEntrySizeInvalid: (offset) => `Entryen ved Kaldi wav ark-offset ${offset} har ugyldig størrelse eller går utenfor filen.`,
      remoteDownloadTitle: "AudioLens: laster ned lyd",
      remoteWaitingForServer: "Kobler til, venter på serveren…",
      remoteDownloaded: (progress) => `Lastet ned ${progress}`,
      remoteRequiresTrust: "AudioLens krever et klarert arbeidsområde for å laste ned ekstern lyd.",
      remoteDownloadFailed: (reason) => `AudioLens kan ikke laste ned lyden: ${reason}`,
      remoteErrorCanceled: "nedlastingen ble avbrutt.",
      remoteErrorTimedOut: (seconds) => `serveren sendte ingen data på ${seconds} sekunder.`,
      remoteErrorTooLarge: (limit) => `filen overskrider grensen audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `serveren returnerte HTTP ${status}.`,
      remoteErrorRedirects: "for mange omdirigeringer.",
      remoteErrorScheme: "bare HTTP- og HTTPS-URL-er støttes.",
      remoteErrorEmpty: "serveren returnerte en tom fil.",
      remoteErrorIncomplete: "tilkoblingen ble brutt før nedlastingen var ferdig.",
      remoteErrorInvalidResponse: "serveren returnerte et ugyldig svar."
    },
    nl: {
      arkOffsetPlaceholder: "Voer offset in",
      arkOffsetPrompt: (fileName) => `${fileName} is een ark-bestand en kan groot zijn. Voer de offset in van de WAV-entry die moet worden gelezen.`,
      arkOffsetValidation: "Voer een niet-negatieve gehele offset in.",
      arkOffsetRequired: "Voer een Kaldi wav ark-offset in voordat je de audio opent.",
      arkOpenPrompt: "Voer een Kaldi wav ark-pad en offset in. Als je alleen een .ark-pad invoert, wordt daarna om de offset gevraagd.",
      arkInputParseFailed: "Kan de Kaldi wav ark-invoer niet lezen. Gebruik /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark-offset ${offset} is ongeldig. Offset moet een niet-negatief geheel getal zijn.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark-offset ${offset} valt buiten het bestand; de WAV-header kan niet worden gelezen.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark-offset ${offset} wijst niet naar RIFF/WAVE-data.`,
      arkEntrySizeInvalid: (offset) => `De entry bij Kaldi wav ark-offset ${offset} heeft een ongeldige grootte of valt buiten het bestand.`,
      remoteDownloadTitle: "AudioLens: audio downloaden",
      remoteWaitingForServer: "Verbinden, wachten op de server…",
      remoteDownloaded: (progress) => `Gedownload ${progress}`,
      remoteRequiresTrust: "AudioLens vereist een vertrouwde werkruimte om externe audio te downloaden.",
      remoteDownloadFailed: (reason) => `AudioLens kan de audio niet downloaden: ${reason}`,
      remoteErrorCanceled: "de download is geannuleerd.",
      remoteErrorTimedOut: (seconds) => `de server heeft ${seconds} seconden geen gegevens verzonden.`,
      remoteErrorTooLarge: (limit) => `het bestand overschrijdt de limiet audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `de server gaf HTTP ${status} terug.`,
      remoteErrorRedirects: "te veel omleidingen.",
      remoteErrorScheme: "alleen HTTP- en HTTPS-URL's worden ondersteund.",
      remoteErrorEmpty: "de server gaf een leeg bestand terug.",
      remoteErrorIncomplete: "de verbinding werd verbroken voordat de download klaar was.",
      remoteErrorInvalidResponse: "de server gaf een ongeldig antwoord."
    },
    pl: {
      arkOffsetPlaceholder: "Wpisz offset",
      arkOffsetPrompt: (fileName) => `${fileName} jest plikiem ark i może być duży. Wpisz offset wpisu WAV do odczytu.`,
      arkOffsetValidation: "Wpisz nieujemny całkowity offset.",
      arkOffsetRequired: "Wpisz offset Kaldi wav ark przed otwarciem audio.",
      arkOpenPrompt: "Wpisz ścieżkę Kaldi wav ark i offset. Jeśli podasz tylko ścieżkę .ark, offset zostanie poproszony później.",
      arkInputParseFailed: "Nie można sparsować wejścia Kaldi wav ark. Użyj /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Offset Kaldi wav ark ${offset} jest nieprawidłowy. Offset musi być nieujemną liczbą całkowitą.`,
      arkOffsetOutOfRange: (offset) => `Offset Kaldi wav ark ${offset} jest poza zakresem pliku, więc nie można odczytać nagłówka WAV.`,
      arkOffsetNotWave: (offset) => `Offset Kaldi wav ark ${offset} nie wskazuje danych RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `Wpis przy offsecie Kaldi wav ark ${offset} ma nieprawidłowy rozmiar lub wykracza poza plik.`,
      remoteDownloadTitle: "AudioLens: pobieranie audio",
      remoteWaitingForServer: "Łączenie, oczekiwanie na serwer…",
      remoteDownloaded: (progress) => `Pobrano ${progress}`,
      remoteRequiresTrust: "AudioLens wymaga zaufanego obszaru roboczego, aby pobrać zdalne audio.",
      remoteDownloadFailed: (reason) => `AudioLens nie może pobrać audio: ${reason}`,
      remoteErrorCanceled: "pobieranie zostało anulowane.",
      remoteErrorTimedOut: (seconds) => `serwer nie przesłał danych przez ${seconds} s.`,
      remoteErrorTooLarge: (limit) => `plik przekracza limit audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `serwer zwrócił HTTP ${status}.`,
      remoteErrorRedirects: "zbyt wiele przekierowań.",
      remoteErrorScheme: "obsługiwane są tylko adresy URL HTTP i HTTPS.",
      remoteErrorEmpty: "serwer zwrócił pusty plik.",
      remoteErrorIncomplete: "połączenie zostało przerwane przed zakończeniem pobierania.",
      remoteErrorInvalidResponse: "serwer zwrócił nieprawidłową odpowiedź."
    },
    tr: {
      arkOffsetPlaceholder: "Offset girin",
      arkOffsetPrompt: (fileName) => `${fileName} bir ark dosyasıdır ve büyük olabilir. Okunacak WAV entry offsetini girin.`,
      arkOffsetValidation: "Negatif olmayan bir tam sayı offset girin.",
      arkOffsetRequired: "Sesi açmadan önce Kaldi wav ark offsetini girin.",
      arkOpenPrompt: "Kaldi wav ark yolu ve offset girin. Yalnızca .ark yolu girerseniz sonraki adımda offset istenir.",
      arkInputParseFailed: "Kaldi wav ark girdisi çözümlenemedi. /path/to/wav.ark:offset kullanın.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offseti ${offset} geçersiz. Offset negatif olmayan bir tam sayı olmalıdır.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offseti ${offset} dosya aralığının dışında, WAV header okunamıyor.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offseti ${offset} RIFF/WAVE verisine işaret etmiyor.`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offseti ${offset} içindeki entry boyutu geçersiz veya dosya aralığını aşıyor.`,
      remoteDownloadTitle: "AudioLens: ses indiriliyor",
      remoteWaitingForServer: "Bağlanılıyor, sunucu bekleniyor…",
      remoteDownloaded: (progress) => `İndirilen ${progress}`,
      remoteRequiresTrust: "AudioLens'in uzak sesi indirebilmesi için güvenilir bir çalışma alanı gerekir.",
      remoteDownloadFailed: (reason) => `AudioLens sesi indiremiyor: ${reason}`,
      remoteErrorCanceled: "indirme iptal edildi.",
      remoteErrorTimedOut: (seconds) => `sunucu ${seconds} saniye boyunca veri göndermedi.`,
      remoteErrorTooLarge: (limit) => `dosya audiolens.maxFileSizeMB sınırını (${limit}) aşıyor.`,
      remoteErrorHttpStatus: (status) => `sunucu HTTP ${status} döndürdü.`,
      remoteErrorRedirects: "çok fazla yönlendirme.",
      remoteErrorScheme: "yalnızca HTTP ve HTTPS URL'leri desteklenir.",
      remoteErrorEmpty: "sunucu boş bir dosya döndürdü.",
      remoteErrorIncomplete: "indirme bitmeden bağlantı kesildi.",
      remoteErrorInvalidResponse: "sunucu geçersiz bir yanıt döndürdü."
    },
    vi: {
      arkOffsetPlaceholder: "Nhập offset",
      arkOffsetPrompt: (fileName) => `${fileName} là file ark và có thể rất lớn. Nhập offset của WAV entry cần đọc.`,
      arkOffsetValidation: "Nhập offset là số nguyên không âm.",
      arkOffsetRequired: "Nhập Kaldi wav ark offset trước khi mở âm thanh.",
      arkOpenPrompt: "Nhập đường dẫn Kaldi wav ark và offset. Nếu chỉ nhập đường dẫn .ark, AudioLens sẽ hỏi offset ở bước tiếp theo.",
      arkInputParseFailed: "Không thể phân tích đầu vào Kaldi wav ark. Hãy dùng /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} không hợp lệ. Offset phải là số nguyên không âm.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} nằm ngoài phạm vi file nên không thể đọc WAV header.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} không trỏ tới dữ liệu RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `Entry tại Kaldi wav ark offset ${offset} có kích thước không hợp lệ hoặc vượt quá phạm vi file.`,
      remoteDownloadTitle: "AudioLens: đang tải âm thanh",
      remoteWaitingForServer: "Đang kết nối, chờ máy chủ phản hồi…",
      remoteDownloaded: (progress) => `Đã tải ${progress}`,
      remoteRequiresTrust: "AudioLens cần workspace tin cậy để tải âm thanh từ xa.",
      remoteDownloadFailed: (reason) => `AudioLens không thể tải âm thanh: ${reason}`,
      remoteErrorCanceled: "đã hủy tải xuống.",
      remoteErrorTimedOut: (seconds) => `máy chủ không gửi dữ liệu trong ${seconds} giây.`,
      remoteErrorTooLarge: (limit) => `tệp vượt quá giới hạn audiolens.maxFileSizeMB (${limit}).`,
      remoteErrorHttpStatus: (status) => `máy chủ trả về HTTP ${status}.`,
      remoteErrorRedirects: "quá nhiều lần chuyển hướng.",
      remoteErrorScheme: "chỉ hỗ trợ URL HTTP và HTTPS.",
      remoteErrorEmpty: "máy chủ trả về tệp rỗng.",
      remoteErrorIncomplete: "kết nối bị ngắt trước khi tải xong.",
      remoteErrorInvalidResponse: "máy chủ trả về phản hồi không hợp lệ."
    }
  };
  return { ...base, ...overrides[normalized] };
}

function normalizeLocale(locale: string): string {
  const lower = locale.toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(lower)) {
    return "zh-TW";
  }
  if (lower.startsWith("zh")) {
    return "zh-CN";
  }
  return lower.split("-")[0] ?? "en";
}

function toArrayBuffer(bytes: ArrayBufferView): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.buffer instanceof ArrayBuffer && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return buffer;
}

function parseArkOffsetQuery(uri: vscode.Uri): number | undefined {
  const params = new URLSearchParams(uri.query);
  const rawOffset = params.get(ARK_OFFSET_QUERY_KEY);
  if (!rawOffset || !/^\d+$/.test(rawOffset)) {
    return undefined;
  }
  const offset = Number(rawOffset);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function withArkOffset(uri: vscode.Uri, offset: number): vscode.Uri {
  const params = new URLSearchParams(uri.query);
  params.set(ARK_OFFSET_QUERY_KEY, String(offset));
  return uri.with({ query: params.toString(), fragment: "" });
}

async function promptForArkOffset(uri: vscode.Uri, messages = resolveExtensionMessages()): Promise<number | undefined> {
  const picked = await vscode.window.showInputBox({
    title: messages.arkOffsetTitle,
    placeHolder: messages.arkOffsetPlaceholder,
    prompt: messages.arkOffsetPrompt(path.basename(uri.fsPath || uri.path)),
    validateInput: (value) => (/^\d+$/.test(value.trim()) ? undefined : messages.arkOffsetValidation)
  });
  if (picked === undefined) {
    return undefined;
  }
  return Number(picked.trim());
}

async function parseArkInput(value: string): Promise<{ uri: vscode.Uri; offset?: number } | undefined> {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutUtteranceId = trimmed.match(/^\S+\s+(.+)$/)?.[1] ?? trimmed;
  const match = withoutUtteranceId.match(/^(.+):(\d+)$/);
  const filePath = match ? match[1] : withoutUtteranceId;
  const offset = match ? Number(match[2]) : undefined;
  const uri = resolveInputPath(filePath.trim());
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type === vscode.FileType.Directory) {
    return undefined;
  }
  if (path.extname(uri.fsPath || uri.path).toLowerCase() !== ".ark") {
    return undefined;
  }
  return { uri, offset };
}

function resolveInputPath(filePath: string): vscode.Uri {
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder?.uri.scheme === "file") {
    return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, filePath));
  }
  return vscode.Uri.file(filePath);
}

function resolveDefaultDownloadUri(document: AudioLensDocument, fileName: string): vscode.Uri {
  const safeName = sanitizeSuggestedFileName(fileName) || fileName;
  // 网络音频不使用临时下载目录，直接回退到工作区目录。
  const sourceUri = document.isRemote ? undefined : document.sourceUri;
  if (sourceUri?.scheme === "file") {
    const dir = path.dirname(sourceUri.fsPath);
    if (path.isAbsolute(dir)) {
      return vscode.Uri.file(path.join(dir, safeName));
    }
  }
  const workspaceFolder = (sourceUri && vscode.workspace.getWorkspaceFolder(sourceUri))
    ?? vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder?.uri.scheme === "file") {
    return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, safeName));
  }
  const home = os.homedir();
  if (home) {
    return vscode.Uri.file(path.join(home, safeName));
  }
  return vscode.Uri.file(safeName);
}

async function readArkWavEntrySize(uri: vscode.Uri, offset: number): Promise<number> {
  const messages = resolveExtensionMessages();
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(messages.arkOffsetInvalid(offset));
  }
  const fileSize = (await vscode.workspace.fs.stat(uri)).size;
  if (offset + 12 > fileSize) {
    throw new Error(messages.arkOffsetOutOfRange(offset));
  }
  const header = await readUriRange(uri, offset, 12);
  if (
    header.length < 12 ||
    header[0] !== 0x52 ||
    header[1] !== 0x49 ||
    header[2] !== 0x46 ||
    header[3] !== 0x46 ||
    header[8] !== 0x57 ||
    header[9] !== 0x41 ||
    header[10] !== 0x56 ||
    header[11] !== 0x45
  ) {
    throw new Error(messages.arkOffsetNotWave(offset));
  }
  const chunkSize = header[4] | (header[5] << 8) | (header[6] << 16) | (header[7] << 24);
  const entrySize = (chunkSize >>> 0) + 8;
  if (entrySize <= 8 || offset + entrySize > fileSize) {
    throw new Error(messages.arkEntrySizeInvalid(offset));
  }
  return entrySize;
}

async function readUriRange(uri: vscode.Uri, offset: number, length: number): Promise<Uint8Array> {
  if (uri.scheme === "file") {
    const handle = await open(uri.fsPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, result.bytesRead);
    } finally {
      await handle.close();
    }
  }

  const data = await vscode.workspace.fs.readFile(uri);
  return data.slice(offset, offset + length);
}

async function runFfmpegSelection(inputPath: string, outputPath: string, startTime: number, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(startTime),
      "-i",
      inputPath,
      "-t",
      String(duration),
      "-vn",
      "-f",
      "wav",
      "-acodec",
      "pcm_s16le",
      outputPath
    ]);
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const timeout = setTimeout(() => {
      fail(new Error(`FFmpeg timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 1000)} seconds.`));
    }, FFMPEG_TIMEOUT_MS);

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
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
      if (error.code === "ENOENT") {
        fail(new Error("FFmpeg is required to open this encoded audio format, but the ffmpeg command was not found."));
      } else {
        fail(error);
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(detail || `FFmpeg exited with code ${code ?? "unknown"}.`));
    });
  });
}

function parseWebviewMessage(value: unknown, maxTransferBytes: number): WebviewMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  switch (value.type) {
    case "ready":
    case "downloadAudio":
      return { type: value.type };
    case "readChunk":
      if (isSafeRequestId(value.requestId) && isSafeOffset(value.offset) && isChunkLength(value.length)) {
        return { type: "readChunk", requestId: value.requestId, offset: value.offset, length: value.length };
      }
      return undefined;
    case "prepareStreamedAudio":
      if (isSafeRequestId(value.requestId)) {
        return { type: "prepareStreamedAudio", requestId: value.requestId };
      }
      return undefined;
    case "readStreamedAudioPeaks":
      if (
        isSafeRequestId(value.requestId) && isSafeChannel(value.channel) &&
        isSafeOffset(value.startSample) && isSafeOffset(value.endSample) && value.endSample >= value.startSample &&
        isIntegerInRange(value.width, 1, 8192)
      ) {
        return { type: value.type, requestId: value.requestId, channel: value.channel, startSample: value.startSample, endSample: value.endSample, width: value.width };
      }
      return undefined;
    case "readStreamedAudioSamples":
      if (
        isSafeRequestId(value.requestId) && isSafeChannel(value.channel) &&
        isSafeOffset(value.startSample) && isSafeOffset(value.endSample) && value.endSample >= value.startSample
      ) {
        return { type: value.type, requestId: value.requestId, channel: value.channel, startSample: value.startSample, endSample: value.endSample };
      }
      return undefined;
    case "readStreamedAudioWindows": {
      const windowSize = oneOf(value.windowSize, FFT_SIZES);
      if (
        isSafeRequestId(value.requestId) && isSafeChannel(value.channel) &&
        isSafeOffset(value.startSample) && isSafeOffset(value.endSample) && value.endSample >= value.startSample &&
        windowSize !== undefined && isIntegerInRange(value.hopSize, 1, Number.MAX_SAFE_INTEGER) &&
        isIntegerInRange(value.maxFrames, 1, 8192)
      ) {
        return {
          type: value.type,
          requestId: value.requestId,
          channel: value.channel,
          startSample: value.startSample,
          endSample: value.endSample,
          windowSize,
          hopSize: value.hopSize,
          maxFrames: value.maxFrames
        };
      }
      return undefined;
    }
    case "saveStreamedSelectionWav":
      if (
        isSafeRequestId(value.requestId) && isBoundedString(value.fileName) &&
        isNonNegativeFinite(value.startTime) && isNonNegativeFinite(value.endTime) && value.endTime > value.startTime &&
        isOptionalBoundedString(value.saveLabel) && isOptionalBoundedString(value.title)
      ) {
        return { type: value.type, requestId: value.requestId, fileName: value.fileName, startTime: value.startTime, endTime: value.endTime, saveLabel: value.saveLabel, title: value.title };
      }
      return undefined;
    case "requestSelectionWavSave":
      if (
        isSafeRequestId(value.requestId) &&
        isBoundedString(value.fileName) &&
        isOptionalBoundedString(value.saveLabel) &&
        isOptionalBoundedString(value.title)
      ) {
        return {
          type: "requestSelectionWavSave",
          requestId: value.requestId,
          fileName: value.fileName,
          saveLabel: value.saveLabel,
          title: value.title
        };
      }
      return undefined;
    case "writeSelectionWavChunk":
      if (
        isSafeRequestId(value.requestId) &&
        isBoundedString(value.fileName) &&
        isSafeChunkIndex(value.chunkIndex) &&
        isBase64Payload(value.bytesBase64, Math.min(maxTransferBytes, MAX_SELECTION_WAV_CHUNK_BYTES))
      ) {
        return {
          type: "writeSelectionWavChunk",
          requestId: value.requestId,
          fileName: value.fileName,
          chunkIndex: value.chunkIndex,
          bytesBase64: value.bytesBase64,
          isLast: value.isLast === true
        };
      }
      return undefined;
    case "updatePreferences":
      if (isRecord(value.preferences)) {
        return { type: "updatePreferences", preferences: value.preferences as AudioLensPreferences };
      }
      return undefined;
    case "showError":
      if (isBoundedString(value.message)) {
        return { type: "showError", message: value.message };
      }
      return undefined;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? value as T : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isSafeRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeChannel(value: unknown): value is number {
  return isIntegerInRange(value, 0, 31);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isChunkLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= DEFAULT_CHUNK_SIZE;
}

function isSafeChunkIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MESSAGE_TEXT_LENGTH;
}

function isOptionalBoundedString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= MAX_MESSAGE_TEXT_LENGTH);
}

function isBase64Payload(value: unknown, maxDecodedBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length % 4 === 0 &&
    decodedBase64Size(value) <= maxDecodedBytes &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}

function decodedBase64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function sanitizeSuggestedFileName(fileName: string): string {
  return path.basename(fileName || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
}

function sanitizeSelectionWavFileName(fileName: string): string {
  const normalized = sanitizeSuggestedFileName(fileName) || "audiolens_selection.wav";
  return normalized.toLowerCase().endsWith(".wav") ? normalized : `${normalized}.wav`;
}
