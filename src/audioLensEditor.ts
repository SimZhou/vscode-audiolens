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
import { getNonce } from "./util";

const PREFERENCES_KEY = "audiolens.preferences.v1";

class AudioLensDocument implements vscode.CustomDocument {
  public static async create(uri: vscode.Uri): Promise<AudioLensDocument> {
    return new AudioLensDocument(uri, await AudioLensDocument.stat(uri));
  }

  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private readonly watcher: vscode.FileSystemWatcher;

  public readonly onDidChange = this.changeEmitter.event;
  public readonly onDidDispose = this.disposeEmitter.event;

  private constructor(
    public readonly uri: vscode.Uri,
    private fileSize: number
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(uri.fsPath, true, false, true);
    this.watcher.onDidChange(async () => {
      this.fileSize = await AudioLensDocument.stat(this.uri);
      this.changeEmitter.fire(this.uri);
    });
  }

  public get size(): number {
    return this.fileSize;
  }

  public async refresh(): Promise<void> {
    this.fileSize = await AudioLensDocument.stat(this.uri);
  }

  public async readRange(offset: number, length: number): Promise<Uint8Array> {
    const safeOffset = Math.max(0, Math.min(offset, this.fileSize));
    const safeLength = Math.max(0, Math.min(length, this.fileSize - safeOffset));
    if (safeLength === 0) {
      return new Uint8Array();
    }

    if (this.uri.scheme === "file") {
      const handle = await open(this.uri.fsPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(safeLength);
        const result = await handle.read(buffer, 0, safeLength, safeOffset);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, result.bytesRead);
      } finally {
        await handle.close();
      }
    }

    const data = await vscode.workspace.fs.readFile(this.uri);
    return data.slice(safeOffset, safeOffset + safeLength);
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
}

export class AudioLensEditorProvider implements vscode.CustomReadonlyEditorProvider<AudioLensDocument> {
  private static readonly viewType = "audiolens.audioPreview";

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      AudioLensEditorProvider.viewType,
      new AudioLensEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
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
        if (event.affectsConfiguration("audiolens.language")) {
          this.postMessage(webviewPanel.webview, {
            type: "configChanged",
            config: this.readConfig()
          });
        }
      }),
      webviewPanel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
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
          if (!vscode.workspace.isTrusted) {
            throw new Error("Workspace is not trusted; AudioLens will not transfer audio content.");
          }
          const length = Math.min(message.length, DEFAULT_CHUNK_SIZE);
          const bytes = await document.readRange(message.offset, length);
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
    const fileName = path.basename(document.uri.fsPath || document.uri.path);
    const extension = path.extname(fileName).toLowerCase().replace(/^\./, "");
    return {
      fileName,
      uri: document.uri.toString(),
      size: document.size,
      trusted: vscode.workspace.isTrusted,
      extension,
      kind: extension === "pcm" || extension === "raw" ? "pcm" as const : "encoded" as const
    };
  }

  private async downloadAudio(document: AudioLensDocument): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Workspace is not trusted; AudioLens will not transfer audio content.");
    }

    const fileName = path.basename(document.uri.fsPath || document.uri.path);
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(fileName),
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

  private async transcodeAudio(requestId: number, document: AudioLensDocument, webview: vscode.Webview): Promise<void> {
    try {
      if (!vscode.workspace.isTrusted) {
        throw new Error("Workspace is not trusted; AudioLens will not transfer audio content.");
      }
      const bytes = await this.transcodeDocumentToWav(document);
      this.postMessage(webview, { type: "transcodedAudio", requestId, bytes: toArrayBuffer(bytes) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage(webview, { type: "transcodeError", requestId, message });
    }
  }

  private async transcodeDocumentToWav(document: AudioLensDocument): Promise<Uint8Array> {
    if (document.uri.scheme === "file") {
      return runFfmpegToWav(document.uri.fsPath);
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "audiolens-"));
    const extension = path.extname(document.uri.path || document.uri.fsPath) || ".audio";
    const inputPath = path.join(tempDir, `input${extension}`);
    try {
      await writeFile(inputPath, await document.readRange(0, document.size));
      return await runFfmpegToWav(inputPath);
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
      frequencyScale: value.frequencyScale,
      palette: value.palette,
      minDb: value.minDb,
      maxDb: value.maxDb,
      autoBrightness: value.autoBrightness,
      amplitudeZoom: value.amplitudeZoom,
      waveformHeight: value.waveformHeight,
      spectrogramHeight: value.spectrogramHeight,
      playbackGain: value.playbackGain,
      defaultPcmFormat: value.defaultPcmFormat
    };
  }

  private readConfig(): AudioLensConfig {
    const config = vscode.workspace.getConfiguration("audiolens");
    return {
      autoAnalyze: config.get("autoAnalyze", true),
      maxFileSizeMB: config.get("maxFileSizeMB", 512),
      language: config.get("language", "auto"),
      vscodeLanguage: vscode.env.language,
      analysis: {
        windowFunction: config.get("analysis.windowFunction", "hamming"),
        fftSize: config.get("analysis.fftSize", 512),
        zeroPaddingFactor: config.get("analysis.zeroPaddingFactor", 2)
      }
    };
  }

  private postMessage(webview: vscode.Webview, message: ExtensionMessage): void {
    webview.postMessage(message);
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function runFfmpegToWav(inputPath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
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

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).byteLength < 8192) {
        stderr.push(chunk);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error("FFmpeg is required to open this encoded audio format, but the ffmpeg command was not found."));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(new Uint8Array(Buffer.concat(stdout)));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(detail || `FFmpeg exited with code ${code ?? "unknown"}.`));
    });
  });
}
