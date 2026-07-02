import { spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
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
import { normalizePipedWavSizes } from "./ffmpegWav";
import { formatBytes, getNonce } from "./util";

const PREFERENCES_KEY = "audiolens.preferences.v1";
const ARK_OFFSET_QUERY_KEY = "arkOffset";
const MAX_MESSAGE_TEXT_LENGTH = 1024;
const FFMPEG_TIMEOUT_MS = 60_000;

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
  public static async create(uri: vscode.Uri): Promise<AudioLensDocument> {
    const source = await AudioLensDocument.resolveSource(uri);
    return new AudioLensDocument(uri, source);
  }

  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly watcher: vscode.FileSystemWatcher;

  public readonly onDidChange = this.changeEmitter.event;
  public readonly onDidDispose = this.disposeEmitter.event;

  private constructor(
    public readonly uri: vscode.Uri,
    private source: AudioLensDocumentSource
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(this.source.uri.fsPath, true, false, true);
    this.watcher.onDidChange(async () => {
      this.source = await AudioLensDocument.refreshSource(this.source);
      this.changeEmitter.fire(this.uri);
    });
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

  public get isFileSlice(): boolean {
    return this.source.offset > 0 || this.source.uri.toString() !== this.uri.with({ query: "", fragment: "" }).toString();
  }

  public async setArkOffset(offset: number): Promise<void> {
    this.source = await AudioLensDocument.resolveSource(withArkOffset(this.source.uri, offset));
  }

  public async refresh(): Promise<void> {
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

    const data = await vscode.workspace.fs.readFile(this.source.uri);
    return data.slice(sourceOffset, sourceOffset + safeLength);
  }

  public dispose(): void {
    this.watcher.dispose();
    this.changeEmitter.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
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
  private readonly activeTranscodes = new WeakSet<AudioLensDocument>();

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
    return AudioLensDocument.create(uri);
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
        await document.refresh();
        this.postMessage(webviewPanel.webview, {
          type: "fileChanged",
          metadata: this.createMetadata(document)
        });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("audiolens.language") || event.affectsConfiguration("audiolens.profileSpectrogram")) {
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
          this.assertTransferAllowed(document);
          const bytes = await document.readRange(message.offset, message.length);
          this.postMessage(webview, {
            type: "chunk",
            requestId: message.requestId,
            offset: message.offset,
            total: document.size,
            bytes: toArrayBuffer(bytes)
          });
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
        case "transcodeAudio":
          await this.transcodeAudio(message.requestId, document, webview);
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
      uri: document.uri.toString(),
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

    const safeFileName = sanitizeSuggestedFileName(fileName) || "audiolens_selection.wav";
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
        fileName: sanitizeSuggestedFileName(message.fileName) || "audiolens_selection.wav",
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

  private async transcodeAudio(requestId: number, document: AudioLensDocument, webview: vscode.Webview): Promise<void> {
    let transcodeStarted = false;
    try {
      this.assertTransferAllowed(document);
      if (this.activeTranscodes.has(document)) {
        throw new Error("AudioLens is already transcoding this audio file.");
      }
      this.activeTranscodes.add(document);
      transcodeStarted = true;
      const bytes = await this.transcodeDocumentToWav(document);
      this.postMessage(webview, { type: "transcodedAudio", requestId, bytes: toArrayBuffer(bytes) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage(webview, { type: "transcodeError", requestId, message });
    } finally {
      if (transcodeStarted) {
        this.activeTranscodes.delete(document);
      }
    }
  }

  private async transcodeDocumentToWav(document: AudioLensDocument): Promise<Uint8Array> {
    if (document.sourceUri.scheme === "file" && !document.isFileSlice) {
      return runFfmpegToWav(document.sourceUri.fsPath, this.maxTransferBytes());
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "audiolens-"));
    const extension = document.extension ? `.${document.extension}` : ".audio";
    const inputPath = path.join(tempDir, `input${extension}`);
    try {
      await writeFile(inputPath, await document.readRange(0, document.size));
      return await runFfmpegToWav(inputPath, this.maxTransferBytes());
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private readPreferences(): AudioLensPreferences {
    return this.normalizePreferences(this.context.globalState.get<AudioLensPreferences>(PREFERENCES_KEY, {}));
  }

  private normalizePreferences(value: AudioLensPreferences): AudioLensPreferences {
    return {
      algorithm: value.algorithm,
      windowFunction: value.windowFunction,
      fftSize: value.fftSize,
      zeroPaddingFactor: value.zeroPaddingFactor,
      defaultTrackMode: value.defaultTrackMode,
      defaultTrackRowHeight: value.defaultTrackRowHeight,
      defaultTrackWaveFr: value.defaultTrackWaveFr,
      defaultTrackSpecFr: value.defaultTrackSpecFr,
      frequencyScale: value.frequencyScale,
      palette: value.palette,
      minDb: value.minDb,
      maxDb: value.maxDb,
      spectrogramMinHz: value.spectrogramMinHz,
      spectrogramMaxHz: value.spectrogramMaxHz,
      spectrogramMaxFollowsNyquist: value.spectrogramMaxFollowsNyquist,
      autoBrightness: value.autoBrightness,
      amplitudeZoom: value.amplitudeZoom,
      waveformHeight: value.waveformHeight,
      spectrogramHeight: value.spectrogramHeight,
      playbackGain: value.playbackGain,
      playbackRoutingMode: value.playbackRoutingMode,
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
    arkEntrySizeInvalid: (offset) => `The entry at Kaldi wav ark offset ${offset} has an invalid size or exceeds the file range.`
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
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} 对应的 entry 长度无效或超出文件范围。`
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
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} 對應的 entry 長度無效或超出檔案範圍。`
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
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} の entry サイズが無効、またはファイル範囲を超えています。`
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
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset}의 entry 길이가 올바르지 않거나 파일 범위를 벗어납니다.`
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
      arkEntrySizeInvalid: (offset) => `L'entrée à l'offset Kaldi wav ark ${offset} a une taille invalide ou dépasse le fichier.`
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
      arkEntrySizeInvalid: (offset) => `Der Eintrag bei Kaldi wav ark Offset ${offset} hat eine ungültige Größe oder überschreitet die Datei.`
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
      arkEntrySizeInvalid: (offset) => `Entry по Kaldi wav ark offset ${offset} имеет недопустимый размер или выходит за пределы файла.`
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
      arkEntrySizeInvalid: (offset) => `La entrada en el offset Kaldi wav ark ${offset} tiene un tamaño no válido o excede el archivo.`
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
      arkEntrySizeInvalid: (offset) => `L'entry all'offset Kaldi wav ark ${offset} ha dimensione non valida o supera il file.`
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
      arkEntrySizeInvalid: (offset) => `A entrada no offset Kaldi wav ark ${offset} tem tamanho inválido ou excede o arquivo.`
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
      arkEntrySizeInvalid: (offset) => `Entry pada offset Kaldi wav ark ${offset} memiliki ukuran tidak valid atau melebihi file.`
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
      arkEntrySizeInvalid: (offset) => `Entryen ved Kaldi wav ark-offset ${offset} har ugyldig størrelse eller går utenfor filen.`
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
      arkEntrySizeInvalid: (offset) => `De entry bij Kaldi wav ark-offset ${offset} heeft een ongeldige grootte of valt buiten het bestand.`
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
      arkEntrySizeInvalid: (offset) => `Wpis przy offsecie Kaldi wav ark ${offset} ma nieprawidłowy rozmiar lub wykracza poza plik.`
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
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offseti ${offset} içindeki entry boyutu geçersiz veya dosya aralığını aşıyor.`
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
      arkEntrySizeInvalid: (offset) => `Entry tại Kaldi wav ark offset ${offset} có kích thước không hợp lệ hoặc vượt quá phạm vi file.`
    }
  };
  return { ...base, ...overrides[normalized] };
}

function normalizeLocale(locale: string): string {
  const lower = locale.toLowerCase();
  if (lower.startsWith("zh-tw") || lower.startsWith("zh-hk")) {
    return "zh-TW";
  }
  if (lower.startsWith("zh")) {
    return "zh-CN";
  }
  return lower.split("-")[0] ?? "en";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
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
  const sourceUri = document.sourceUri;
  if (sourceUri.scheme === "file") {
    const dir = path.dirname(sourceUri.fsPath);
    if (path.isAbsolute(dir)) {
      return vscode.Uri.file(path.join(dir, safeName));
    }
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(sourceUri)
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

async function runFfmpegToWav(inputPath: string, maxOutputBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-f",
      "wav",
      "-acodec",
      "pcm_s16le",
      "pipe:1"
    ]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        fail(new Error(`FFmpeg output is too large: ${formatBytes(stdoutBytes)} / ${formatBytes(maxOutputBytes)}.`));
        return;
      }
      stdout.push(chunk);
    });
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
        const output = Buffer.concat(stdout);
        normalizePipedWavSizes(output);
        resolve(new Uint8Array(output));
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
    case "transcodeAudio":
      if (isSafeRequestId(value.requestId)) {
        return { type: "transcodeAudio", requestId: value.requestId };
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
        isBase64Payload(value.bytesBase64, maxTransferBytes)
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

function isSafeRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
  const normalized = path.basename(fileName || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  if (!normalized) {
    return "";
  }
  return normalized.toLowerCase().endsWith(".wav") ? normalized : `${normalized}.wav`;
}
