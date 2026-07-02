"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode3 = __toESM(require("vscode"));

// src/audioLensEditor.ts
var import_node_child_process = require("node:child_process");
var import_promises = require("node:fs/promises");
var os = __toESM(require("node:os"));
var path = __toESM(require("node:path"));
var vscode = __toESM(require("vscode"));

// src/shared/protocol.ts
var DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

// src/ffmpegWav.ts
var RIFF_HEADER_SIZE = 12;
var CHUNK_HEADER_SIZE = 8;
var UNKNOWN_WAV_SIZE = 4294967295;
function normalizePipedWavSizes(bytes) {
  if (bytes.byteLength < RIFF_HEADER_SIZE || asciiAt(bytes, 0) !== "RIFF" || asciiAt(bytes, 8) !== "WAVE" || bytes.byteLength - 8 > UNKNOWN_WAV_SIZE) {
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
    const nextOffset = payloadOffset + chunkSize + chunkSize % 2;
    if (nextOffset <= offset || nextOffset > bytes.byteLength) {
      return;
    }
    offset = nextOffset;
  }
}
function resolveWaveDataSize(chunkSize, remainingBytes) {
  if (chunkSize === 0 && remainingBytes > 0 || chunkSize === UNKNOWN_WAV_SIZE || chunkSize > remainingBytes) {
    return remainingBytes;
  }
  return chunkSize;
}
function asciiAt(bytes, offset) {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

// src/util.ts
var import_node_crypto = require("node:crypto");
function getNonce() {
  return (0, import_node_crypto.randomBytes)(16).toString("base64");
}
function formatBytes(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

// src/audioLensEditor.ts
var PREFERENCES_KEY = "audiolens.preferences.v1";
var ARK_OFFSET_QUERY_KEY = "arkOffset";
var MAX_MESSAGE_TEXT_LENGTH = 1024;
var FFMPEG_TIMEOUT_MS = 6e4;
var AudioLensDocument = class _AudioLensDocument {
  constructor(uri, source) {
    this.uri = uri;
    this.source = source;
    this.watcher = vscode.workspace.createFileSystemWatcher(this.source.uri.fsPath, true, false, true);
    this.watcher.onDidChange(async () => {
      this.source = await _AudioLensDocument.refreshSource(this.source);
      this.changeEmitter.fire(this.uri);
    });
  }
  static async create(uri) {
    const source = await _AudioLensDocument.resolveSource(uri);
    return new _AudioLensDocument(uri, source);
  }
  changeEmitter = new vscode.EventEmitter();
  disposeEmitter = new vscode.EventEmitter();
  watcher;
  onDidChange = this.changeEmitter.event;
  onDidDispose = this.disposeEmitter.event;
  get size() {
    return this.source.size;
  }
  get sourceUri() {
    return this.source.uri;
  }
  get displayName() {
    return this.source.displayName ?? path.basename(this.source.uri.fsPath || this.source.uri.path);
  }
  get extension() {
    return this.source.extensionOverride ?? path.extname(this.displayName).toLowerCase().replace(/^\./, "");
  }
  get needsArkOffset() {
    return this.source.needsArkOffset === true;
  }
  get arkOffset() {
    return this.source.arkOffset;
  }
  get isFileSlice() {
    return this.source.offset > 0 || this.source.uri.toString() !== this.uri.with({ query: "", fragment: "" }).toString();
  }
  async setArkOffset(offset) {
    this.source = await _AudioLensDocument.resolveSource(withArkOffset(this.source.uri, offset));
  }
  async refresh() {
    this.source = await _AudioLensDocument.refreshSource(this.source);
  }
  async readRange(offset, length) {
    const safeOffset = Math.max(0, Math.min(offset, this.source.size));
    const safeLength = Math.max(0, Math.min(length, this.source.size - safeOffset));
    if (safeLength === 0) {
      return new Uint8Array();
    }
    const sourceOffset = this.source.offset + safeOffset;
    if (this.source.uri.scheme === "file") {
      const handle = await (0, import_promises.open)(this.source.uri.fsPath, "r");
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
  dispose() {
    this.watcher.dispose();
    this.changeEmitter.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }
  static async stat(uri) {
    if (uri.scheme === "untitled") {
      return 0;
    }
    return (await vscode.workspace.fs.stat(uri)).size;
  }
  static async resolveSource(uri) {
    const normalizedUri = uri.with({ query: "", fragment: "" });
    const offset = parseArkOffsetQuery(uri);
    const extension = path.extname(normalizedUri.fsPath || normalizedUri.path).toLowerCase();
    if (extension === ".ark") {
      if (offset === void 0) {
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
      size: await _AudioLensDocument.stat(normalizedUri)
    };
  }
  static async refreshSource(source) {
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
      size: await _AudioLensDocument.stat(source.uri)
    };
  }
};
var AudioLensEditorProvider = class _AudioLensEditorProvider {
  constructor(context) {
    this.context = context;
  }
  static viewType = "audiolens.audioPreview";
  pendingSelectionWavDestinations = /* @__PURE__ */ new WeakMap();
  pendingSelectionWavWrites = /* @__PURE__ */ new WeakMap();
  activeTranscodes = /* @__PURE__ */ new WeakSet();
  static register(context) {
    const provider = new _AudioLensEditorProvider(context);
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(
        _AudioLensEditorProvider.viewType,
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
  async openCustomDocument(uri, _openContext, _token) {
    return AudioLensDocument.create(uri);
  }
  async resolveCustomEditor(document, webviewPanel, _token) {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")]
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
    const postBootstrap = async () => {
      if (document.needsArkOffset) {
        const messages = this.extensionMessages();
        const offset = await promptForArkOffset(document.sourceUri, messages);
        if (offset === void 0) {
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
    const subscriptions = [
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
      webviewPanel.webview.onDidReceiveMessage(async (rawMessage) => {
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
  async handleWebviewMessage(message, document, webview, postBootstrap) {
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
  createMetadata(document) {
    const fileName = document.displayName;
    const extension = document.extension;
    return {
      fileName,
      uri: document.uri.toString(),
      size: document.size,
      trusted: vscode.workspace.isTrusted,
      extension,
      kind: extension === "pcm" || extension === "raw" ? "pcm" : "encoded",
      sourceKind: document.arkOffset === void 0 ? void 0 : "ark",
      sourceOffset: document.arkOffset
    };
  }
  async downloadAudio(document) {
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
  async requestSelectionWavSave(webview, requestId, fileName, document, saveLabel, title) {
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
      destinations = /* @__PURE__ */ new Map();
      this.pendingSelectionWavDestinations.set(webview, destinations);
    }
    destinations.set(requestId, destination);
    this.postMessage(webview, { type: "selectionWavSaveReady", requestId });
  }
  async writeSelectionWavChunk(webview, message) {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Workspace is not trusted; AudioLens will not transfer audio content.");
    }
    const decodedSize = decodedBase64Size(message.bytesBase64);
    const maxBytes = this.maxTransferBytes();
    let writes = this.pendingSelectionWavWrites.get(webview);
    if (!writes) {
      writes = /* @__PURE__ */ new Map();
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
  async transcodeAudio(requestId, document, webview) {
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
  async transcodeDocumentToWav(document) {
    if (document.sourceUri.scheme === "file" && !document.isFileSlice) {
      return runFfmpegToWav(document.sourceUri.fsPath, this.maxTransferBytes());
    }
    const tempDir = await (0, import_promises.mkdtemp)(path.join(os.tmpdir(), "audiolens-"));
    const extension = document.extension ? `.${document.extension}` : ".audio";
    const inputPath = path.join(tempDir, `input${extension}`);
    try {
      await (0, import_promises.writeFile)(inputPath, await document.readRange(0, document.size));
      return await runFfmpegToWav(inputPath, this.maxTransferBytes());
    } finally {
      await (0, import_promises.rm)(tempDir, { recursive: true, force: true });
    }
  }
  readPreferences() {
    return this.normalizePreferences(this.context.globalState.get(PREFERENCES_KEY, {}));
  }
  normalizePreferences(value) {
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
      defaultPcmFormat: value.defaultPcmFormat
    };
  }
  readConfig() {
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
  maxTransferBytes() {
    const config = vscode.workspace.getConfiguration("audiolens");
    const maxFileSizeMB = config.get("maxFileSizeMB", 512);
    const safeMaxFileSizeMB = Number.isFinite(maxFileSizeMB) && maxFileSizeMB >= 16 ? maxFileSizeMB : 512;
    return Math.floor(safeMaxFileSizeMB * 1024 * 1024);
  }
  assertTransferAllowed(document) {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Workspace is not trusted; AudioLens will not transfer audio content.");
    }
    const maxBytes = this.maxTransferBytes();
    if (document.size > maxBytes) {
      throw new Error(`Audio file is too large: ${formatBytes(document.size)} / ${formatBytes(maxBytes)}.`);
    }
  }
  postMessage(webview, message) {
    webview.postMessage(message);
  }
  async openKaldiWavArkFromCommand() {
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
      if (offset === void 0) {
        return;
      }
      const target = withArkOffset(parsed.uri, offset);
      await readArkWavEntrySize(parsed.uri, offset);
      await vscode.commands.executeCommand("vscode.openWith", target, _AudioLensEditorProvider.viewType);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(message);
    }
  }
  getHtml(webview) {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    return (
      /* html */
      `<!DOCTYPE html>
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
</html>`
    );
  }
  resolveHtmlLanguage() {
    const config = this.readConfig();
    return config.language === "auto" ? config.vscodeLanguage : config.language;
  }
  extensionMessages() {
    return resolveExtensionMessages(this.resolveHtmlLanguage());
  }
};
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char] ?? char;
  });
}
function resolveExtensionMessages(locale = vscode.env.language) {
  const normalized = normalizeLocale(locale);
  const base = {
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
  const overrides = {
    "zh-CN": {
      arkOffsetPlaceholder: "\u8BF7\u8F93\u5165 offset",
      arkOffsetPrompt: (fileName) => `${fileName} \u662F ark \u6587\u4EF6\uFF0C\u53EF\u80FD\u5F88\u5927\u3002\u8BF7\u8F93\u5165\u8981\u8BFB\u53D6\u7684 WAV entry offset\u3002`,
      arkOffsetValidation: "\u8BF7\u8F93\u5165\u975E\u8D1F\u6574\u6570 offset\u3002",
      arkOffsetRequired: "\u8BF7\u8F93\u5165 Kaldi wav ark offset \u540E\u518D\u6253\u5F00\u97F3\u9891\u3002",
      arkOpenPrompt: "\u8F93\u5165 Kaldi wav ark \u8DEF\u5F84\u548C offset\uFF1B\u5982\u679C\u53EA\u8F93\u5165 .ark \u8DEF\u5F84\uFF0C\u4E0B\u4E00\u6B65\u4F1A\u8981\u6C42\u8F93\u5165 offset\u3002",
      arkInputParseFailed: "\u65E0\u6CD5\u89E3\u6790 Kaldi wav ark \u8F93\u5165\uFF0C\u8BF7\u4F7F\u7528 /path/to/wav.ark:offset\u3002",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} \u65E0\u6548\uFF0Coffset \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570\u3002`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} \u8D85\u51FA\u6587\u4EF6\u8303\u56F4\uFF0C\u65E0\u6CD5\u8BFB\u53D6 WAV \u5934\u3002`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} \u5904\u4E0D\u662F RIFF/WAVE \u6570\u636E\u3002`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} \u5BF9\u5E94\u7684 entry \u957F\u5EA6\u65E0\u6548\u6216\u8D85\u51FA\u6587\u4EF6\u8303\u56F4\u3002`
    },
    "zh-TW": {
      arkOffsetPlaceholder: "\u8ACB\u8F38\u5165 offset",
      arkOffsetPrompt: (fileName) => `${fileName} \u662F ark \u6A94\u6848\uFF0C\u53EF\u80FD\u5F88\u5927\u3002\u8ACB\u8F38\u5165\u8981\u8B80\u53D6\u7684 WAV entry offset\u3002`,
      arkOffsetValidation: "\u8ACB\u8F38\u5165\u975E\u8CA0\u6574\u6578 offset\u3002",
      arkOffsetRequired: "\u8ACB\u5148\u8F38\u5165 Kaldi wav ark offset \u518D\u958B\u555F\u97F3\u8A0A\u3002",
      arkOpenPrompt: "\u8F38\u5165 Kaldi wav ark \u8DEF\u5F91\u548C offset\uFF1B\u5982\u679C\u53EA\u8F38\u5165 .ark \u8DEF\u5F91\uFF0C\u4E0B\u4E00\u6B65\u6703\u8981\u6C42\u8F38\u5165 offset\u3002",
      arkInputParseFailed: "\u7121\u6CD5\u89E3\u6790 Kaldi wav ark \u8F38\u5165\uFF0C\u8ACB\u4F7F\u7528 /path/to/wav.ark:offset\u3002",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} \u7121\u6548\uFF0Coffset \u5FC5\u9808\u662F\u975E\u8CA0\u6574\u6578\u3002`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} \u8D85\u51FA\u6A94\u6848\u7BC4\u570D\uFF0C\u7121\u6CD5\u8B80\u53D6 WAV header\u3002`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} \u8655\u4E0D\u662F RIFF/WAVE \u8CC7\u6599\u3002`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} \u5C0D\u61C9\u7684 entry \u9577\u5EA6\u7121\u6548\u6216\u8D85\u51FA\u6A94\u6848\u7BC4\u570D\u3002`
    },
    ja: {
      arkOffsetPlaceholder: "offset \u3092\u5165\u529B",
      arkOffsetPrompt: (fileName) => `${fileName} \u306F ark \u30D5\u30A1\u30A4\u30EB\u3067\u3001\u5927\u304D\u3044\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002\u8AAD\u307F\u8FBC\u3080 WAV entry \u306E offset \u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002`,
      arkOffsetValidation: "0 \u4EE5\u4E0A\u306E\u6574\u6570 offset \u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
      arkOffsetRequired: "\u97F3\u58F0\u3092\u958B\u304F\u524D\u306B Kaldi wav ark offset \u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
      arkOpenPrompt: "Kaldi wav ark \u306E\u30D1\u30B9\u3068 offset \u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002.ark \u30D1\u30B9\u3060\u3051\u3092\u5165\u529B\u3057\u305F\u5834\u5408\u306F\u3001\u6B21\u306B offset \u3092\u6C42\u3081\u307E\u3059\u3002",
      arkInputParseFailed: "Kaldi wav ark \u5165\u529B\u3092\u89E3\u6790\u3067\u304D\u307E\u305B\u3093\u3002/path/to/wav.ark:offset \u3092\u4F7F\u7528\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} \u306F\u7121\u52B9\u3067\u3059\u3002offset \u306F 0 \u4EE5\u4E0A\u306E\u6574\u6570\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059\u3002`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} \u306F\u30D5\u30A1\u30A4\u30EB\u7BC4\u56F2\u5916\u306E\u305F\u3081\u3001WAV \u30D8\u30C3\u30C0\u30FC\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3002`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} \u306F RIFF/WAVE \u30C7\u30FC\u30BF\u3092\u6307\u3057\u3066\u3044\u307E\u305B\u3093\u3002`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset} \u306E entry \u30B5\u30A4\u30BA\u304C\u7121\u52B9\u3001\u307E\u305F\u306F\u30D5\u30A1\u30A4\u30EB\u7BC4\u56F2\u3092\u8D85\u3048\u3066\u3044\u307E\u3059\u3002`
    },
    ko: {
      arkOffsetPlaceholder: "offset \uC785\uB825",
      arkOffsetPrompt: (fileName) => `${fileName}\uC740 ark \uD30C\uC77C\uC774\uBA70 \uD074 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uC77D\uC744 WAV entry offset\uC744 \uC785\uB825\uD558\uC138\uC694.`,
      arkOffsetValidation: "0 \uC774\uC0C1\uC758 \uC815\uC218 offset\uC744 \uC785\uB825\uD558\uC138\uC694.",
      arkOffsetRequired: "\uC624\uB514\uC624\uB97C \uC5F4\uAE30 \uC804\uC5D0 Kaldi wav ark offset\uC744 \uC785\uB825\uD558\uC138\uC694.",
      arkOpenPrompt: "Kaldi wav ark \uACBD\uB85C\uC640 offset\uC744 \uC785\uB825\uD558\uC138\uC694. .ark \uACBD\uB85C\uB9CC \uC785\uB825\uD558\uBA74 \uB2E4\uC74C \uB2E8\uACC4\uC5D0\uC11C offset\uC744 \uC694\uCCAD\uD569\uB2C8\uB2E4.",
      arkInputParseFailed: "Kaldi wav ark \uC785\uB825\uC744 \uD574\uC11D\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. /path/to/wav.ark:offset \uD615\uC2DD\uC744 \uC0AC\uC6A9\uD558\uC138\uC694.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset}\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. offset\uC740 0 \uC774\uC0C1\uC758 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset}\uC774 \uD30C\uC77C \uBC94\uC704\uB97C \uBC97\uC5B4\uB098 WAV \uD5E4\uB354\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} \uC704\uCE58\uAC00 RIFF/WAVE \uB370\uC774\uD130\uAC00 \uC544\uB2D9\uB2C8\uB2E4.`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offset ${offset}\uC758 entry \uAE38\uC774\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uAC70\uB098 \uD30C\uC77C \uBC94\uC704\uB97C \uBC97\uC5B4\uB0A9\uB2C8\uB2E4.`
    },
    fr: {
      arkOffsetPlaceholder: "Saisir l'offset",
      arkOffsetPrompt: (fileName) => `${fileName} est un fichier ark potentiellement volumineux. Saisissez l'offset de l'entr\xE9e WAV \xE0 lire.`,
      arkOffsetValidation: "Saisissez un offset entier positif ou nul.",
      arkOffsetRequired: "Saisissez un offset Kaldi wav ark avant d'ouvrir l'audio.",
      arkOpenPrompt: "Saisissez un chemin Kaldi wav ark et un offset. Si seul le chemin .ark est saisi, l'offset sera demand\xE9 ensuite.",
      arkInputParseFailed: "Impossible d'analyser l'entr\xE9e Kaldi wav ark. Utilisez /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `L'offset Kaldi wav ark ${offset} est invalide. Il doit \xEAtre un entier positif ou nul.`,
      arkOffsetOutOfRange: (offset) => `L'offset Kaldi wav ark ${offset} est hors du fichier ; l'en-t\xEAte WAV ne peut pas \xEAtre lu.`,
      arkOffsetNotWave: (offset) => `L'offset Kaldi wav ark ${offset} ne pointe pas vers des donn\xE9es RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `L'entr\xE9e \xE0 l'offset Kaldi wav ark ${offset} a une taille invalide ou d\xE9passe le fichier.`
    },
    de: {
      arkOffsetPlaceholder: "Offset eingeben",
      arkOffsetPrompt: (fileName) => `${fileName} ist eine m\xF6glicherweise gro\xDFe ark-Datei. Geben Sie den Offset des zu lesenden WAV-Eintrags ein.`,
      arkOffsetValidation: "Geben Sie einen nicht negativen ganzzahligen Offset ein.",
      arkOffsetRequired: "Geben Sie vor dem \xD6ffnen der Audiodatei einen Kaldi wav ark Offset ein.",
      arkOpenPrompt: "Geben Sie einen Kaldi wav ark Pfad und Offset ein. Bei nur einem .ark Pfad wird der Offset danach abgefragt.",
      arkInputParseFailed: "Kaldi wav ark Eingabe kann nicht analysiert werden. Verwenden Sie /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark Offset ${offset} ist ung\xFCltig. Der Offset muss eine nicht negative Ganzzahl sein.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark Offset ${offset} liegt au\xDFerhalb der Datei; der WAV-Header kann nicht gelesen werden.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark Offset ${offset} zeigt nicht auf RIFF/WAVE-Daten.`,
      arkEntrySizeInvalid: (offset) => `Der Eintrag bei Kaldi wav ark Offset ${offset} hat eine ung\xFCltige Gr\xF6\xDFe oder \xFCberschreitet die Datei.`
    },
    ru: {
      arkOffsetPlaceholder: "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 offset",
      arkOffsetPrompt: (fileName) => `${fileName} \u2014 \u0444\u0430\u0439\u043B ark \u0438 \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u0431\u043E\u043B\u044C\u0448\u0438\u043C. \u0412\u0432\u0435\u0434\u0438\u0442\u0435 offset WAV entry \u0434\u043B\u044F \u0447\u0442\u0435\u043D\u0438\u044F.`,
      arkOffsetValidation: "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043D\u0435\u043E\u0442\u0440\u0438\u0446\u0430\u0442\u0435\u043B\u044C\u043D\u043E\u0435 \u0446\u0435\u043B\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 offset.",
      arkOffsetRequired: "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 Kaldi wav ark offset \u043F\u0435\u0440\u0435\u0434 \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u0435\u043C \u0430\u0443\u0434\u0438\u043E.",
      arkOpenPrompt: "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043F\u0443\u0442\u044C Kaldi wav ark \u0438 offset. \u0415\u0441\u043B\u0438 \u0443\u043A\u0430\u0437\u0430\u043D \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u0443\u0442\u044C .ark, offset \u0431\u0443\u0434\u0435\u0442 \u0437\u0430\u043F\u0440\u043E\u0448\u0435\u043D \u0434\u0430\u043B\u0435\u0435.",
      arkInputParseFailed: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0440\u0430\u0437\u043E\u0431\u0440\u0430\u0442\u044C \u0432\u0432\u043E\u0434 Kaldi wav ark. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} \u043D\u0435\u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C. Offset \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435\u043E\u0442\u0440\u0438\u0446\u0430\u0442\u0435\u043B\u044C\u043D\u044B\u043C \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} \u0432\u043D\u0435 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430 \u0444\u0430\u0439\u043B\u0430, \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A WAV \u043D\u0435\u043B\u044C\u0437\u044F \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} \u043D\u0435 \u0443\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u043D\u0430 \u0434\u0430\u043D\u043D\u044B\u0435 RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `Entry \u043F\u043E Kaldi wav ark offset ${offset} \u0438\u043C\u0435\u0435\u0442 \u043D\u0435\u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B\u0439 \u0440\u0430\u0437\u043C\u0435\u0440 \u0438\u043B\u0438 \u0432\u044B\u0445\u043E\u0434\u0438\u0442 \u0437\u0430 \u043F\u0440\u0435\u0434\u0435\u043B\u044B \u0444\u0430\u0439\u043B\u0430.`
    },
    es: {
      arkOffsetPlaceholder: "Introduce el offset",
      arkOffsetPrompt: (fileName) => `${fileName} es un archivo ark y puede ser grande. Introduce el offset de la entrada WAV que quieres leer.`,
      arkOffsetValidation: "Introduce un offset entero no negativo.",
      arkOffsetRequired: "Introduce un offset Kaldi wav ark antes de abrir el audio.",
      arkOpenPrompt: "Introduce una ruta Kaldi wav ark y un offset. Si introduces solo la ruta .ark, AudioLens pedir\xE1 el offset despu\xE9s.",
      arkInputParseFailed: "No se pudo interpretar la entrada Kaldi wav ark. Usa /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `El offset Kaldi wav ark ${offset} no es v\xE1lido. Debe ser un entero no negativo.`,
      arkOffsetOutOfRange: (offset) => `El offset Kaldi wav ark ${offset} est\xE1 fuera del archivo y no se puede leer el encabezado WAV.`,
      arkOffsetNotWave: (offset) => `El offset Kaldi wav ark ${offset} no apunta a datos RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `La entrada en el offset Kaldi wav ark ${offset} tiene un tama\xF1o no v\xE1lido o excede el archivo.`
    },
    it: {
      arkOffsetPlaceholder: "Inserisci offset",
      arkOffsetPrompt: (fileName) => `${fileName} \xE8 un file ark e pu\xF2 essere grande. Inserisci l'offset dell'entry WAV da leggere.`,
      arkOffsetValidation: "Inserisci un offset intero non negativo.",
      arkOffsetRequired: "Inserisci un offset Kaldi wav ark prima di aprire l'audio.",
      arkOpenPrompt: "Inserisci un percorso Kaldi wav ark e un offset. Se inserisci solo il percorso .ark, verr\xE0 richiesto l'offset.",
      arkInputParseFailed: "Impossibile analizzare l'input Kaldi wav ark. Usa /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `L'offset Kaldi wav ark ${offset} non \xE8 valido. Deve essere un intero non negativo.`,
      arkOffsetOutOfRange: (offset) => `L'offset Kaldi wav ark ${offset} \xE8 fuori dal file e l'header WAV non pu\xF2 essere letto.`,
      arkOffsetNotWave: (offset) => `L'offset Kaldi wav ark ${offset} non punta a dati RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `L'entry all'offset Kaldi wav ark ${offset} ha dimensione non valida o supera il file.`
    },
    pt: {
      arkOffsetPlaceholder: "Insira o offset",
      arkOffsetPrompt: (fileName) => `${fileName} \xE9 um arquivo ark e pode ser grande. Insira o offset da entrada WAV a ler.`,
      arkOffsetValidation: "Insira um offset inteiro n\xE3o negativo.",
      arkOffsetRequired: "Insira um offset Kaldi wav ark antes de abrir o \xE1udio.",
      arkOpenPrompt: "Insira um caminho Kaldi wav ark e um offset. Se inserir apenas o caminho .ark, o offset ser\xE1 solicitado em seguida.",
      arkInputParseFailed: "N\xE3o foi poss\xEDvel interpretar a entrada Kaldi wav ark. Use /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `O offset Kaldi wav ark ${offset} \xE9 inv\xE1lido. O offset deve ser um inteiro n\xE3o negativo.`,
      arkOffsetOutOfRange: (offset) => `O offset Kaldi wav ark ${offset} est\xE1 fora do arquivo; n\xE3o \xE9 poss\xEDvel ler o cabe\xE7alho WAV.`,
      arkOffsetNotWave: (offset) => `O offset Kaldi wav ark ${offset} n\xE3o aponta para dados RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `A entrada no offset Kaldi wav ark ${offset} tem tamanho inv\xE1lido ou excede o arquivo.`
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
      arkOffsetPrompt: (fileName) => `${fileName} er en ark-fil og kan v\xE6re stor. Skriv inn offset for WAV-entryen som skal leses.`,
      arkOffsetValidation: "Skriv inn en ikke-negativ heltalls-offset.",
      arkOffsetRequired: "Skriv inn Kaldi wav ark-offset f\xF8r du \xE5pner lyden.",
      arkOpenPrompt: "Skriv inn Kaldi wav ark-sti og offset. Hvis du bare skriver inn .ark-stien, blir offset spurt om etterp\xE5.",
      arkInputParseFailed: "Kan ikke tolke Kaldi wav ark-inndata. Bruk /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark-offset ${offset} er ugyldig. Offset m\xE5 v\xE6re et ikke-negativt heltall.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark-offset ${offset} er utenfor filomr\xE5det, s\xE5 WAV-headeren kan ikke leses.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark-offset ${offset} peker ikke p\xE5 RIFF/WAVE-data.`,
      arkEntrySizeInvalid: (offset) => `Entryen ved Kaldi wav ark-offset ${offset} har ugyldig st\xF8rrelse eller g\xE5r utenfor filen.`
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
      arkOffsetPrompt: (fileName) => `${fileName} jest plikiem ark i mo\u017Ce by\u0107 du\u017Cy. Wpisz offset wpisu WAV do odczytu.`,
      arkOffsetValidation: "Wpisz nieujemny ca\u0142kowity offset.",
      arkOffsetRequired: "Wpisz offset Kaldi wav ark przed otwarciem audio.",
      arkOpenPrompt: "Wpisz \u015Bcie\u017Ck\u0119 Kaldi wav ark i offset. Je\u015Bli podasz tylko \u015Bcie\u017Ck\u0119 .ark, offset zostanie poproszony p\xF3\u017Aniej.",
      arkInputParseFailed: "Nie mo\u017Cna sparsowa\u0107 wej\u015Bcia Kaldi wav ark. U\u017Cyj /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Offset Kaldi wav ark ${offset} jest nieprawid\u0142owy. Offset musi by\u0107 nieujemn\u0105 liczb\u0105 ca\u0142kowit\u0105.`,
      arkOffsetOutOfRange: (offset) => `Offset Kaldi wav ark ${offset} jest poza zakresem pliku, wi\u0119c nie mo\u017Cna odczyta\u0107 nag\u0142\xF3wka WAV.`,
      arkOffsetNotWave: (offset) => `Offset Kaldi wav ark ${offset} nie wskazuje danych RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `Wpis przy offsecie Kaldi wav ark ${offset} ma nieprawid\u0142owy rozmiar lub wykracza poza plik.`
    },
    tr: {
      arkOffsetPlaceholder: "Offset girin",
      arkOffsetPrompt: (fileName) => `${fileName} bir ark dosyas\u0131d\u0131r ve b\xFCy\xFCk olabilir. Okunacak WAV entry offsetini girin.`,
      arkOffsetValidation: "Negatif olmayan bir tam say\u0131 offset girin.",
      arkOffsetRequired: "Sesi a\xE7madan \xF6nce Kaldi wav ark offsetini girin.",
      arkOpenPrompt: "Kaldi wav ark yolu ve offset girin. Yaln\u0131zca .ark yolu girerseniz sonraki ad\u0131mda offset istenir.",
      arkInputParseFailed: "Kaldi wav ark girdisi \xE7\xF6z\xFCmlenemedi. /path/to/wav.ark:offset kullan\u0131n.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offseti ${offset} ge\xE7ersiz. Offset negatif olmayan bir tam say\u0131 olmal\u0131d\u0131r.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offseti ${offset} dosya aral\u0131\u011F\u0131n\u0131n d\u0131\u015F\u0131nda, WAV header okunam\u0131yor.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offseti ${offset} RIFF/WAVE verisine i\u015Faret etmiyor.`,
      arkEntrySizeInvalid: (offset) => `Kaldi wav ark offseti ${offset} i\xE7indeki entry boyutu ge\xE7ersiz veya dosya aral\u0131\u011F\u0131n\u0131 a\u015F\u0131yor.`
    },
    vi: {
      arkOffsetPlaceholder: "Nh\u1EADp offset",
      arkOffsetPrompt: (fileName) => `${fileName} l\xE0 file ark v\xE0 c\xF3 th\u1EC3 r\u1EA5t l\u1EDBn. Nh\u1EADp offset c\u1EE7a WAV entry c\u1EA7n \u0111\u1ECDc.`,
      arkOffsetValidation: "Nh\u1EADp offset l\xE0 s\u1ED1 nguy\xEAn kh\xF4ng \xE2m.",
      arkOffsetRequired: "Nh\u1EADp Kaldi wav ark offset tr\u01B0\u1EDBc khi m\u1EDF \xE2m thanh.",
      arkOpenPrompt: "Nh\u1EADp \u0111\u01B0\u1EDDng d\u1EABn Kaldi wav ark v\xE0 offset. N\u1EBFu ch\u1EC9 nh\u1EADp \u0111\u01B0\u1EDDng d\u1EABn .ark, AudioLens s\u1EBD h\u1ECFi offset \u1EDF b\u01B0\u1EDBc ti\u1EBFp theo.",
      arkInputParseFailed: "Kh\xF4ng th\u1EC3 ph\xE2n t\xEDch \u0111\u1EA7u v\xE0o Kaldi wav ark. H\xE3y d\xF9ng /path/to/wav.ark:offset.",
      arkOffsetInvalid: (offset) => `Kaldi wav ark offset ${offset} kh\xF4ng h\u1EE3p l\u1EC7. Offset ph\u1EA3i l\xE0 s\u1ED1 nguy\xEAn kh\xF4ng \xE2m.`,
      arkOffsetOutOfRange: (offset) => `Kaldi wav ark offset ${offset} n\u1EB1m ngo\xE0i ph\u1EA1m vi file n\xEAn kh\xF4ng th\u1EC3 \u0111\u1ECDc WAV header.`,
      arkOffsetNotWave: (offset) => `Kaldi wav ark offset ${offset} kh\xF4ng tr\u1ECF t\u1EDBi d\u1EEF li\u1EC7u RIFF/WAVE.`,
      arkEntrySizeInvalid: (offset) => `Entry t\u1EA1i Kaldi wav ark offset ${offset} c\xF3 k\xEDch th\u01B0\u1EDBc kh\xF4ng h\u1EE3p l\u1EC7 ho\u1EB7c v\u01B0\u1EE3t qu\xE1 ph\u1EA1m vi file.`
    }
  };
  return { ...base, ...overrides[normalized] };
}
function normalizeLocale(locale) {
  const lower = locale.toLowerCase();
  if (lower.startsWith("zh-tw") || lower.startsWith("zh-hk")) {
    return "zh-TW";
  }
  if (lower.startsWith("zh")) {
    return "zh-CN";
  }
  return lower.split("-")[0] ?? "en";
}
function toArrayBuffer(bytes) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
function parseArkOffsetQuery(uri) {
  const params = new URLSearchParams(uri.query);
  const rawOffset = params.get(ARK_OFFSET_QUERY_KEY);
  if (!rawOffset || !/^\d+$/.test(rawOffset)) {
    return void 0;
  }
  const offset = Number(rawOffset);
  return Number.isSafeInteger(offset) ? offset : void 0;
}
function withArkOffset(uri, offset) {
  const params = new URLSearchParams(uri.query);
  params.set(ARK_OFFSET_QUERY_KEY, String(offset));
  return uri.with({ query: params.toString(), fragment: "" });
}
async function promptForArkOffset(uri, messages = resolveExtensionMessages()) {
  const picked = await vscode.window.showInputBox({
    title: messages.arkOffsetTitle,
    placeHolder: messages.arkOffsetPlaceholder,
    prompt: messages.arkOffsetPrompt(path.basename(uri.fsPath || uri.path)),
    validateInput: (value) => /^\d+$/.test(value.trim()) ? void 0 : messages.arkOffsetValidation
  });
  if (picked === void 0) {
    return void 0;
  }
  return Number(picked.trim());
}
async function parseArkInput(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return void 0;
  }
  const withoutUtteranceId = trimmed.match(/^\S+\s+(.+)$/)?.[1] ?? trimmed;
  const match = withoutUtteranceId.match(/^(.+):(\d+)$/);
  const filePath = match ? match[1] : withoutUtteranceId;
  const offset = match ? Number(match[2]) : void 0;
  const uri = resolveInputPath(filePath.trim());
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type === vscode.FileType.Directory) {
    return void 0;
  }
  if (path.extname(uri.fsPath || uri.path).toLowerCase() !== ".ark") {
    return void 0;
  }
  return { uri, offset };
}
function resolveInputPath(filePath) {
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder?.uri.scheme === "file") {
    return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, filePath));
  }
  return vscode.Uri.file(filePath);
}
function resolveDefaultDownloadUri(document, fileName) {
  const safeName = sanitizeSuggestedFileName(fileName) || fileName;
  const sourceUri = document.sourceUri;
  if (sourceUri.scheme === "file") {
    const dir = path.dirname(sourceUri.fsPath);
    if (path.isAbsolute(dir)) {
      return vscode.Uri.file(path.join(dir, safeName));
    }
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(sourceUri) ?? vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder?.uri.scheme === "file") {
    return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, safeName));
  }
  const home = os.homedir();
  if (home) {
    return vscode.Uri.file(path.join(home, safeName));
  }
  return vscode.Uri.file(safeName);
}
async function readArkWavEntrySize(uri, offset) {
  const messages = resolveExtensionMessages();
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(messages.arkOffsetInvalid(offset));
  }
  const fileSize = (await vscode.workspace.fs.stat(uri)).size;
  if (offset + 12 > fileSize) {
    throw new Error(messages.arkOffsetOutOfRange(offset));
  }
  const header = await readUriRange(uri, offset, 12);
  if (header.length < 12 || header[0] !== 82 || header[1] !== 73 || header[2] !== 70 || header[3] !== 70 || header[8] !== 87 || header[9] !== 65 || header[10] !== 86 || header[11] !== 69) {
    throw new Error(messages.arkOffsetNotWave(offset));
  }
  const chunkSize = header[4] | header[5] << 8 | header[6] << 16 | header[7] << 24;
  const entrySize = (chunkSize >>> 0) + 8;
  if (entrySize <= 8 || offset + entrySize > fileSize) {
    throw new Error(messages.arkEntrySizeInvalid(offset));
  }
  return entrySize;
}
async function readUriRange(uri, offset, length) {
  if (uri.scheme === "file") {
    const handle = await (0, import_promises.open)(uri.fsPath, "r");
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
async function runFfmpegToWav(inputPath, maxOutputBytes) {
  return new Promise((resolve2, reject) => {
    let settled = false;
    const child = (0, import_node_child_process.spawn)("ffmpeg", [
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
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timeout = setTimeout(() => {
      fail(new Error(`FFmpeg timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 1e3)} seconds.`));
    }, FFMPEG_TIMEOUT_MS);
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        fail(new Error(`FFmpeg output is too large: ${formatBytes(stdoutBytes)} / ${formatBytes(maxOutputBytes)}.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < 8192) {
        stderr.push(chunk);
        stderrBytes += chunk.byteLength;
      }
    });
    child.on("error", (error) => {
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
        resolve2(new Uint8Array(output));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(detail || `FFmpeg exited with code ${code ?? "unknown"}.`));
    });
  });
}
function parseWebviewMessage(value, maxTransferBytes) {
  if (!isRecord(value) || typeof value.type !== "string") {
    return void 0;
  }
  switch (value.type) {
    case "ready":
    case "downloadAudio":
      return { type: value.type };
    case "readChunk":
      if (isSafeRequestId(value.requestId) && isSafeOffset(value.offset) && isChunkLength(value.length)) {
        return { type: "readChunk", requestId: value.requestId, offset: value.offset, length: value.length };
      }
      return void 0;
    case "transcodeAudio":
      if (isSafeRequestId(value.requestId)) {
        return { type: "transcodeAudio", requestId: value.requestId };
      }
      return void 0;
    case "requestSelectionWavSave":
      if (isSafeRequestId(value.requestId) && isBoundedString(value.fileName) && isOptionalBoundedString(value.saveLabel) && isOptionalBoundedString(value.title)) {
        return {
          type: "requestSelectionWavSave",
          requestId: value.requestId,
          fileName: value.fileName,
          saveLabel: value.saveLabel,
          title: value.title
        };
      }
      return void 0;
    case "writeSelectionWavChunk":
      if (isSafeRequestId(value.requestId) && isBoundedString(value.fileName) && isSafeChunkIndex(value.chunkIndex) && isBase64Payload(value.bytesBase64, maxTransferBytes)) {
        return {
          type: "writeSelectionWavChunk",
          requestId: value.requestId,
          fileName: value.fileName,
          chunkIndex: value.chunkIndex,
          bytesBase64: value.bytesBase64,
          isLast: value.isLast === true
        };
      }
      return void 0;
    case "updatePreferences":
      if (isRecord(value.preferences)) {
        return { type: "updatePreferences", preferences: value.preferences };
      }
      return void 0;
    case "showError":
      if (isBoundedString(value.message)) {
        return { type: "showError", message: value.message };
      }
      return void 0;
    default:
      return void 0;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isSafeRequestId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isSafeOffset(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isChunkLength(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= DEFAULT_CHUNK_SIZE;
}
function isSafeChunkIndex(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isBoundedString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MESSAGE_TEXT_LENGTH;
}
function isOptionalBoundedString(value) {
  return value === void 0 || typeof value === "string" && value.length <= MAX_MESSAGE_TEXT_LENGTH;
}
function isBase64Payload(value, maxDecodedBytes) {
  return typeof value === "string" && value.length % 4 === 0 && decodedBase64Size(value) <= maxDecodedBytes && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
function decodedBase64Size(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}
function sanitizeSuggestedFileName(fileName) {
  const normalized = path.basename(fileName || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  if (!normalized) {
    return "";
  }
  return normalized.toLowerCase().endsWith(".wav") ? normalized : `${normalized}.wav`;
}

// src/audioPathLinks.ts
var path2 = __toESM(require("node:path"));
var vscode2 = __toESM(require("vscode"));
var AUDIO_LENS_VIEW_TYPE = "audiolens.audioPreview";
var OPEN_AUDIO_PATH_COMMAND = "audiolens.openAudioPathLink";
var OPEN_AUDIO_PATH_AT_CURSOR_COMMAND = "audiolens.openAudioPathAtCursor";
var TOGGLE_AUDIO_PATH_LINKS_COMMAND = "audiolens.toggleAudioPathLinks";
var AUDIO_PATH_LINKS_ENABLED_CONFIG = "audioPathLinks.enabled";
var AUDIO_PATH_LINK_BASE_DIRECTORIES_CONFIG = "audioPathLinks.baseDirectories";
var MAX_LINE_LENGTH_CONFIG = "audioPathLinks.maxLineLength";
var DEFAULT_MAX_LINE_LENGTH = 2e4;
var AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "pcm", "raw"];
var EXT_PATTERN = AUDIO_EXTENSIONS.join("|");
var QUOTED_AUDIO_PATH_RE = new RegExp(`(["'\`])([^"'\`\\r\\n]*?\\.(${EXT_PATTERN}))\\1`, "gi");
var UNQUOTED_AUDIO_PATH_RE = new RegExp(`([^\\s"'\\\`<>{}|]+?\\.(${EXT_PATTERN}))(?=$|[\\s"',;:)\\]}|])`, "gi");
var AUDIO_PATH_HINT_RE = new RegExp(`\\.(${EXT_PATTERN})`, "i");
var AUDIO_EXTENSION_RE = new RegExp(`\\.(${EXT_PATTERN})$`, "i");
var FIELD_DELIMITER_RE = /[|]/;
var TRAILING_PUNCTUATION_RE = /[,;:)\]}]+$/;
var GLOB_WILDCARD_RE = /[*?[\]]/;
var AUDIO_PATH_MESSAGES = {
  en: {
    openInAudioLens: "Open in AudioLens",
    statusOpen: "AudioLens: Open",
    statusTooltip: "Open audio path at cursor with AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens cannot resolve audio path: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens cannot find an audio path at the cursor.",
    enabled: "AudioLens audio path actions enabled.",
    disabled: "AudioLens audio path actions disabled."
  },
  "zh-cn": {
    openInAudioLens: "\u5728 AudioLens \u4E2D\u6253\u5F00",
    statusOpen: "AudioLens\uFF1A\u6253\u5F00",
    statusTooltip: "\u7528 AudioLens \u6253\u5F00\u5149\u6807\u5904\u97F3\u9891\u8DEF\u5F84",
    cannotResolveAudioPath: (pathText) => `AudioLens \u65E0\u6CD5\u89E3\u6790\u97F3\u9891\u8DEF\u5F84\uFF1A${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens \u672A\u5728\u5149\u6807\u5904\u627E\u5230\u97F3\u9891\u8DEF\u5F84\u3002",
    enabled: "AudioLens \u97F3\u9891\u8DEF\u5F84\u5165\u53E3\u5DF2\u5F00\u542F\u3002",
    disabled: "AudioLens \u97F3\u9891\u8DEF\u5F84\u5165\u53E3\u5DF2\u5173\u95ED\u3002"
  },
  "zh-tw": {
    openInAudioLens: "\u5728 AudioLens \u4E2D\u958B\u555F",
    statusOpen: "AudioLens\uFF1A\u958B\u555F",
    statusTooltip: "\u7528 AudioLens \u958B\u555F\u6E38\u6A19\u8655\u97F3\u8A0A\u8DEF\u5F91",
    cannotResolveAudioPath: (pathText) => `AudioLens \u7121\u6CD5\u89E3\u6790\u97F3\u8A0A\u8DEF\u5F91\uFF1A${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens \u672A\u5728\u6E38\u6A19\u8655\u627E\u5230\u97F3\u8A0A\u8DEF\u5F91\u3002",
    enabled: "AudioLens \u97F3\u8A0A\u8DEF\u5F91\u5165\u53E3\u5DF2\u958B\u555F\u3002",
    disabled: "AudioLens \u97F3\u8A0A\u8DEF\u5F91\u5165\u53E3\u5DF2\u95DC\u9589\u3002"
  },
  ja: {
    openInAudioLens: "AudioLens \u3067\u958B\u304F",
    statusOpen: "AudioLens: \u958B\u304F",
    statusTooltip: "\u30AB\u30FC\u30BD\u30EB\u4F4D\u7F6E\u306E\u97F3\u58F0\u30D1\u30B9\u3092 AudioLens \u3067\u958B\u304F",
    cannotResolveAudioPath: (pathText) => `AudioLens \u306F\u97F3\u58F0\u30D1\u30B9\u3092\u89E3\u6C7A\u3067\u304D\u307E\u305B\u3093: ${pathText}`,
    cannotFindAudioPathAtCursor: "\u30AB\u30FC\u30BD\u30EB\u4F4D\u7F6E\u306B\u97F3\u58F0\u30D1\u30B9\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002",
    enabled: "AudioLens \u306E\u97F3\u58F0\u30D1\u30B9\u64CD\u4F5C\u3092\u6709\u52B9\u306B\u3057\u307E\u3057\u305F\u3002",
    disabled: "AudioLens \u306E\u97F3\u58F0\u30D1\u30B9\u64CD\u4F5C\u3092\u7121\u52B9\u306B\u3057\u307E\u3057\u305F\u3002"
  },
  ko: {
    openInAudioLens: "AudioLens\uC5D0\uC11C \uC5F4\uAE30",
    statusOpen: "AudioLens: \uC5F4\uAE30",
    statusTooltip: "\uCEE4\uC11C \uC704\uCE58\uC758 \uC624\uB514\uC624 \uACBD\uB85C\uB97C AudioLens\uB85C \uC5F4\uAE30",
    cannotResolveAudioPath: (pathText) => `AudioLens\uAC00 \uC624\uB514\uC624 \uACBD\uB85C\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${pathText}`,
    cannotFindAudioPathAtCursor: "\uCEE4\uC11C \uC704\uCE58\uC5D0\uC11C \uC624\uB514\uC624 \uACBD\uB85C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
    enabled: "AudioLens \uC624\uB514\uC624 \uACBD\uB85C \uB3D9\uC791\uC774 \uCF1C\uC84C\uC2B5\uB2C8\uB2E4.",
    disabled: "AudioLens \uC624\uB514\uC624 \uACBD\uB85C \uB3D9\uC791\uC774 \uAEBC\uC84C\uC2B5\uB2C8\uB2E4."
  },
  fr: {
    openInAudioLens: "Ouvrir dans AudioLens",
    statusOpen: "AudioLens : ouvrir",
    statusTooltip: "Ouvrir le chemin audio sous le curseur avec AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens ne peut pas r\xE9soudre le chemin audio : ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens ne trouve pas de chemin audio sous le curseur.",
    enabled: "Actions de chemin audio AudioLens activ\xE9es.",
    disabled: "Actions de chemin audio AudioLens d\xE9sactiv\xE9es."
  },
  de: {
    openInAudioLens: "In AudioLens \xF6ffnen",
    statusOpen: "AudioLens: \xD6ffnen",
    statusTooltip: "Audiopfad am Cursor mit AudioLens \xF6ffnen",
    cannotResolveAudioPath: (pathText) => `AudioLens kann den Audiopfad nicht aufl\xF6sen: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens findet am Cursor keinen Audiopfad.",
    enabled: "AudioLens-Audiopfadaktionen aktiviert.",
    disabled: "AudioLens-Audiopfadaktionen deaktiviert."
  },
  ru: {
    openInAudioLens: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0432 AudioLens",
    statusOpen: "AudioLens: \u043E\u0442\u043A\u0440\u044B\u0442\u044C",
    statusTooltip: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0430\u0443\u0434\u0438\u043E\u043F\u0443\u0442\u044C \u043F\u043E\u0434 \u043A\u0443\u0440\u0441\u043E\u0440\u043E\u043C \u0432 AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u0440\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044C \u0430\u0443\u0434\u0438\u043E\u043F\u0443\u0442\u044C: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens \u043D\u0435 \u043D\u0430\u0448\u0435\u043B \u0430\u0443\u0434\u0438\u043E\u043F\u0443\u0442\u044C \u043F\u043E\u0434 \u043A\u0443\u0440\u0441\u043E\u0440\u043E\u043C.",
    enabled: "\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044F AudioLens \u0434\u043B\u044F \u0430\u0443\u0434\u0438\u043E\u043F\u0443\u0442\u0435\u0439 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u044B.",
    disabled: "\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044F AudioLens \u0434\u043B\u044F \u0430\u0443\u0434\u0438\u043E\u043F\u0443\u0442\u0435\u0439 \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u044B."
  },
  es: {
    openInAudioLens: "Abrir en AudioLens",
    statusOpen: "AudioLens: abrir",
    statusTooltip: "Abrir la ruta de audio bajo el cursor con AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens no puede resolver la ruta de audio: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens no encuentra una ruta de audio bajo el cursor.",
    enabled: "Acciones de rutas de audio de AudioLens activadas.",
    disabled: "Acciones de rutas de audio de AudioLens desactivadas."
  },
  it: {
    openInAudioLens: "Apri in AudioLens",
    statusOpen: "AudioLens: apri",
    statusTooltip: "Apri con AudioLens il percorso audio sotto il cursore",
    cannotResolveAudioPath: (pathText) => `AudioLens non pu\xF2 risolvere il percorso audio: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens non trova un percorso audio sotto il cursore.",
    enabled: "Azioni percorso audio di AudioLens attivate.",
    disabled: "Azioni percorso audio di AudioLens disattivate."
  },
  pt: {
    openInAudioLens: "Abrir no AudioLens",
    statusOpen: "AudioLens: abrir",
    statusTooltip: "Abrir o caminho de \xE1udio no cursor com AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens n\xE3o consegue resolver o caminho de \xE1udio: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens n\xE3o encontrou um caminho de \xE1udio no cursor.",
    enabled: "A\xE7\xF5es de caminho de \xE1udio do AudioLens ativadas.",
    disabled: "A\xE7\xF5es de caminho de \xE1udio do AudioLens desativadas."
  },
  id: {
    openInAudioLens: "Buka di AudioLens",
    statusOpen: "AudioLens: buka",
    statusTooltip: "Buka jalur audio di kursor dengan AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens tidak dapat menyelesaikan jalur audio: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens tidak menemukan jalur audio di kursor.",
    enabled: "Aksi jalur audio AudioLens diaktifkan.",
    disabled: "Aksi jalur audio AudioLens dinonaktifkan."
  },
  no: {
    openInAudioLens: "\xC5pne i AudioLens",
    statusOpen: "AudioLens: \xE5pne",
    statusTooltip: "\xC5pne lydstien ved mark\xF8ren med AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens kan ikke finne lydstien: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens finner ingen lydsti ved mark\xF8ren.",
    enabled: "AudioLens-handlinger for lydstier er aktivert.",
    disabled: "AudioLens-handlinger for lydstier er deaktivert."
  },
  nl: {
    openInAudioLens: "Openen in AudioLens",
    statusOpen: "AudioLens: openen",
    statusTooltip: "Audiopad bij de cursor openen met AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens kan het audiopad niet oplossen: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens vindt geen audiopad bij de cursor.",
    enabled: "AudioLens-acties voor audiopaden ingeschakeld.",
    disabled: "AudioLens-acties voor audiopaden uitgeschakeld."
  },
  pl: {
    openInAudioLens: "Otw\xF3rz w AudioLens",
    statusOpen: "AudioLens: otw\xF3rz",
    statusTooltip: "Otw\xF3rz \u015Bcie\u017Ck\u0119 audio pod kursorem w AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens nie mo\u017Ce rozwi\u0105za\u0107 \u015Bcie\u017Cki audio: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens nie znalaz\u0142 \u015Bcie\u017Cki audio pod kursorem.",
    enabled: "Akcje \u015Bcie\u017Cek audio AudioLens w\u0142\u0105czone.",
    disabled: "Akcje \u015Bcie\u017Cek audio AudioLens wy\u0142\u0105czone."
  },
  tr: {
    openInAudioLens: "AudioLens'te a\xE7",
    statusOpen: "AudioLens: a\xE7",
    statusTooltip: "\u0130mle\xE7teki ses yolunu AudioLens ile a\xE7",
    cannotResolveAudioPath: (pathText) => `AudioLens ses yolunu \xE7\xF6zemiyor: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens imle\xE7te bir ses yolu bulamad\u0131.",
    enabled: "AudioLens ses yolu eylemleri etkin.",
    disabled: "AudioLens ses yolu eylemleri devre d\u0131\u015F\u0131."
  },
  vi: {
    openInAudioLens: "M\u1EDF trong AudioLens",
    statusOpen: "AudioLens: m\u1EDF",
    statusTooltip: "M\u1EDF \u0111\u01B0\u1EDDng d\u1EABn \xE2m thanh t\u1EA1i con tr\u1ECF b\u1EB1ng AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens kh\xF4ng th\u1EC3 ph\xE2n gi\u1EA3i \u0111\u01B0\u1EDDng d\u1EABn \xE2m thanh: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens kh\xF4ng t\xECm th\u1EA5y \u0111\u01B0\u1EDDng d\u1EABn \xE2m thanh t\u1EA1i con tr\u1ECF.",
    enabled: "\u0110\xE3 b\u1EADt thao t\xE1c \u0111\u01B0\u1EDDng d\u1EABn \xE2m thanh c\u1EE7a AudioLens.",
    disabled: "\u0110\xE3 t\u1EAFt thao t\xE1c \u0111\u01B0\u1EDDng d\u1EABn \xE2m thanh c\u1EE7a AudioLens."
  }
};
function registerAudioPathLinks() {
  const statusBar = new AudioPathStatusBarController();
  return vscode2.Disposable.from(
    vscode2.languages.registerHoverProvider({ scheme: "file" }, new AudioPathHoverProvider()),
    statusBar,
    vscode2.window.onDidChangeActiveTextEditor(() => {
      statusBar.update();
    }),
    vscode2.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode2.window.activeTextEditor) {
        statusBar.update();
      }
    }),
    vscode2.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("audiolens.audioPathLinks") || event.affectsConfiguration("audiolens.language")) {
        statusBar.update();
      }
    }),
    vscode2.commands.registerCommand(OPEN_AUDIO_PATH_COMMAND, async (args) => {
      await openAudioPathLink(args);
    }),
    vscode2.commands.registerCommand(OPEN_AUDIO_PATH_AT_CURSOR_COMMAND, async () => {
      await openAudioPathAtCursor();
    }),
    vscode2.commands.registerCommand(TOGGLE_AUDIO_PATH_LINKS_COMMAND, async () => {
      await toggleAudioPathLinks();
    })
  );
}
var AudioPathStatusBarController = class {
  item = vscode2.window.createStatusBarItem(vscode2.StatusBarAlignment.Right, 100);
  constructor() {
    this.item.command = OPEN_AUDIO_PATH_AT_CURSOR_COMMAND;
    this.update();
  }
  update() {
    const editor = vscode2.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      this.item.hide();
      return;
    }
    const options = getAudioPathLinkOptions();
    if (!options.enabled || !findAudioPathCandidateInEditor(editor, options.maxLineLength)) {
      this.item.hide();
      return;
    }
    const messages = resolveAudioPathMessages();
    this.item.text = `$(play) ${messages.statusOpen}`;
    this.item.tooltip = messages.statusTooltip;
    this.item.show();
  }
  dispose() {
    this.item.dispose();
  }
};
var AudioPathHoverProvider = class {
  provideHover(document, position) {
    const options = getAudioPathLinkOptions();
    if (!options.enabled || document.uri.scheme !== "file") {
      return void 0;
    }
    const line = document.lineAt(position.line).text;
    if (line.length > options.maxLineLength || !lineMayContainAudioPath(line)) {
      return void 0;
    }
    const candidate = findAudioPathCandidateAt(line, position.character);
    if (!candidate) {
      return void 0;
    }
    const commandUri = createOpenAudioPathCommandUri({
      text: candidate.text,
      documentUri: document.uri.toString()
    });
    const markdown = new vscode2.MarkdownString(void 0, true);
    markdown.isTrusted = { enabledCommands: [OPEN_AUDIO_PATH_COMMAND] };
    markdown.supportThemeIcons = true;
    markdown.appendMarkdown(`[$(play) ${escapeMarkdown(resolveAudioPathMessages().openInAudioLens)}](${commandUri.toString()})`);
    return new vscode2.Hover(markdown, new vscode2.Range(
      position.line,
      candidate.start,
      position.line,
      candidate.end
    ));
  }
};
function lineMayContainAudioPath(line) {
  return AUDIO_PATH_HINT_RE.test(line);
}
function trimAudioPathCandidate(value) {
  return value.trim().replace(TRAILING_PUNCTUATION_RE, "");
}
function shouldLinkAudioPath(value) {
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }
  if (GLOB_WILDCARD_RE.test(value)) {
    return false;
  }
  if (FIELD_DELIMITER_RE.test(value)) {
    return false;
  }
  return AUDIO_EXTENSION_RE.test(value);
}
function findAudioPathCandidateAt(line, character) {
  return collectAudioPathCandidatesFromLine(line).find((candidate) => character >= candidate.start && character <= candidate.end);
}
function collectAudioPathCandidatesFromLine(line) {
  const candidates = [];
  QUOTED_AUDIO_PATH_RE.lastIndex = 0;
  for (let match = QUOTED_AUDIO_PATH_RE.exec(line); match; match = QUOTED_AUDIO_PATH_RE.exec(line)) {
    const text = trimAudioPathCandidate(match[2]);
    if (!shouldLinkAudioPath(text)) {
      continue;
    }
    const start = (match.index ?? 0) + 1;
    candidates.push({ text, start, end: start + text.length });
  }
  UNQUOTED_AUDIO_PATH_RE.lastIndex = 0;
  for (let match = UNQUOTED_AUDIO_PATH_RE.exec(line); match; match = UNQUOTED_AUDIO_PATH_RE.exec(line)) {
    const text = trimAudioPathCandidate(match[1]);
    if (!shouldLinkAudioPath(text)) {
      continue;
    }
    const start = match.index ?? 0;
    candidates.push({ text, start, end: start + text.length });
  }
  return candidates;
}
function createOpenAudioPathCommandUri(args) {
  return vscode2.Uri.parse(
    `command:${OPEN_AUDIO_PATH_COMMAND}?${encodeURIComponent(JSON.stringify([args]))}`
  );
}
function findAudioPathCandidateInEditor(editor, maxLineLength) {
  const selected = trimAudioPathCandidate(editor.document.getText(editor.selection));
  if (shouldLinkAudioPath(selected)) {
    return { text: selected };
  }
  const line = editor.document.lineAt(editor.selection.active.line).text;
  if (line.length > maxLineLength || !lineMayContainAudioPath(line)) {
    return void 0;
  }
  return findAudioPathCandidateAt(line, editor.selection.active.character);
}
async function openAudioPathLink(args) {
  if (!args?.text || !args.documentUri) {
    return;
  }
  const sourceUri = vscode2.Uri.parse(args.documentUri);
  const resolved = await resolveAudioPath(args.text, sourceUri);
  if (!resolved) {
    void vscode2.window.showWarningMessage(resolveAudioPathMessages().cannotResolveAudioPath(args.text));
    return;
  }
  await vscode2.commands.executeCommand("vscode.openWith", resolved, AUDIO_LENS_VIEW_TYPE);
}
async function openAudioPathAtCursor() {
  const editor = vscode2.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return;
  }
  const candidate = findAudioPathCandidateInEditor(editor, getAudioPathLinkOptions().maxLineLength);
  if (!candidate) {
    void vscode2.window.showWarningMessage(resolveAudioPathMessages().cannotFindAudioPathAtCursor);
    return;
  }
  await openAudioPathLink({
    text: candidate.text,
    documentUri: editor.document.uri.toString()
  });
}
async function toggleAudioPathLinks() {
  const config = vscode2.workspace.getConfiguration("audiolens");
  const enabled = config.get(AUDIO_PATH_LINKS_ENABLED_CONFIG, true);
  const nextEnabled = !enabled;
  await config.update(AUDIO_PATH_LINKS_ENABLED_CONFIG, nextEnabled, vscode2.ConfigurationTarget.Global);
  const messages = resolveAudioPathMessages();
  void vscode2.window.showInformationMessage(nextEnabled ? messages.enabled : messages.disabled);
}
async function resolveAudioPath(value, sourceUri) {
  const candidates = buildAudioPathCandidates(value, sourceUri);
  for (const candidate of candidates) {
    try {
      const stat = await vscode2.workspace.fs.stat(candidate);
      if ((stat.type & vscode2.FileType.File) !== 0) {
        return candidate;
      }
    } catch {
    }
  }
  return void 0;
}
function buildAudioPathCandidates(value, sourceUri) {
  const candidates = [];
  if (path2.isAbsolute(value)) {
    return [vscode2.Uri.file(value)];
  }
  addCandidate(candidates, vscode2.Uri.file(path2.resolve(path2.dirname(sourceUri.fsPath), value)));
  const owningWorkspace = vscode2.workspace.getWorkspaceFolder(sourceUri);
  if (owningWorkspace?.uri.scheme === "file") {
    addCandidate(candidates, vscode2.Uri.file(path2.resolve(owningWorkspace.uri.fsPath, value)));
  }
  for (const folder of vscode2.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === "file") {
      addCandidate(candidates, vscode2.Uri.file(path2.resolve(folder.uri.fsPath, value)));
    }
  }
  for (const base of getConfiguredBaseDirectories()) {
    addCandidate(candidates, vscode2.Uri.file(path2.resolve(base, value)));
  }
  return candidates;
}
function addCandidate(candidates, uri) {
  if (!candidates.some((existing) => existing.fsPath === uri.fsPath)) {
    candidates.push(uri);
  }
}
function getConfiguredBaseDirectories() {
  const values = vscode2.workspace.getConfiguration("audiolens").get(AUDIO_PATH_LINK_BASE_DIRECTORIES_CONFIG, []);
  return values.map((value) => value.trim()).filter((value) => value.length > 0).map((value) => value.startsWith("~/") ? path2.join(process.env.HOME ?? "", value.slice(2)) : value).filter((value) => path2.isAbsolute(value));
}
function getAudioPathLinkOptions() {
  const config = vscode2.workspace.getConfiguration("audiolens");
  return {
    enabled: config.get(AUDIO_PATH_LINKS_ENABLED_CONFIG, true),
    maxLineLength: getPositiveIntegerConfig(config, MAX_LINE_LENGTH_CONFIG, DEFAULT_MAX_LINE_LENGTH)
  };
}
function getPositiveIntegerConfig(config, key, fallback) {
  const value = config.get(key, fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function resolveAudioPathMessages(locale = resolveAudioPathLanguage()) {
  const normalized = locale.toLowerCase();
  if (normalized === "zh-cn" || normalized.startsWith("zh-hans")) {
    return AUDIO_PATH_MESSAGES["zh-cn"];
  }
  if (normalized === "zh-tw" || normalized.startsWith("zh-hant")) {
    return AUDIO_PATH_MESSAGES["zh-tw"];
  }
  return AUDIO_PATH_MESSAGES[normalized.split("-")[0]] ?? AUDIO_PATH_MESSAGES.en;
}
function resolveAudioPathLanguage() {
  const configured = vscode2.workspace.getConfiguration("audiolens").get("language", "auto");
  return configured === "auto" ? vscode2.env.language : configured;
}
function escapeMarkdown(value) {
  return value.replace(/[\\[\]()`]/g, "\\$&");
}

// src/extension.ts
var LANGUAGE_OPTIONS = [
  { value: "auto", label: "\u8DDF\u968F VS Code / Auto", detail: "\u4F7F\u7528 VS Code \u5F53\u524D\u663E\u793A\u8BED\u8A00" },
  { value: "zh-CN", label: "\u4E2D\u6587\uFF08\u7B80\u4F53\uFF09", detail: "Simplified Chinese" },
  { value: "zh-TW", label: "\u4E2D\u6587\uFF08\u7E41\u9AD4\uFF09", detail: "Traditional Chinese" },
  { value: "en", label: "English", detail: "English" },
  { value: "ja", label: "\u65E5\u672C\u8A9E", detail: "Japanese" },
  { value: "ko", label: "\uD55C\uAD6D\uC5B4", detail: "Korean" },
  { value: "fr", label: "Fran\xE7ais", detail: "French" },
  { value: "de", label: "Deutsch", detail: "German" },
  { value: "ru", label: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439", detail: "Russian" },
  { value: "es", label: "Espa\xF1ol", detail: "Spanish" },
  { value: "it", label: "Italiano", detail: "Italian" },
  { value: "pt", label: "Portugu\xEAs", detail: "Portuguese" },
  { value: "id", label: "Bahasa Indonesia", detail: "Indonesian" },
  { value: "no", label: "Norsk", detail: "Norwegian" },
  { value: "nl", label: "Nederlands", detail: "Dutch" },
  { value: "pl", label: "Polski", detail: "Polish" },
  { value: "tr", label: "T\xFCrk\xE7e", detail: "Turkish" },
  { value: "vi", label: "Ti\u1EBFng Vi\u1EC7t", detail: "Vietnamese" }
];
function activate(context) {
  context.subscriptions.push(
    AudioLensEditorProvider.register(context),
    registerAudioPathLinks(),
    vscode3.commands.registerCommand("audiolens.selectLanguage", async () => {
      const config = vscode3.workspace.getConfiguration("audiolens");
      const current = config.get("language", "auto");
      const picked = await vscode3.window.showQuickPick(
        LANGUAGE_OPTIONS.map((option) => ({
          label: option.label,
          description: option.value === current ? "\u5F53\u524D" : "",
          detail: option.detail,
          value: option.value
        })),
        {
          title: "AudioLens: \u9009\u62E9\u8BED\u8A00",
          placeHolder: "\u9009\u62E9 AudioLens \u754C\u9762\u8BED\u8A00"
        }
      );
      if (!picked) {
        return;
      }
      await config.update("language", picked.value, vscode3.ConfigurationTarget.Global);
      void vscode3.window.showInformationMessage(`AudioLens \u8BED\u8A00\u5DF2\u5207\u6362\u4E3A ${picked.label}`);
    })
  );
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
