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

// src/audioLensEditor.ts
var import_promises = require("node:fs/promises");
var path = __toESM(require("node:path"));
var vscode = __toESM(require("vscode"));

// src/shared/protocol.ts
var DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

// src/util.ts
function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

// src/audioLensEditor.ts
var PREFERENCES_KEY = "audiolens.preferences.v1";
var AudioLensDocument = class _AudioLensDocument {
  constructor(uri, fileSize) {
    this.uri = uri;
    this.fileSize = fileSize;
    this.watcher = vscode.workspace.createFileSystemWatcher(uri.fsPath, true, false, true);
    this.watcher.onDidChange(async () => {
      this.fileSize = await _AudioLensDocument.stat(this.uri);
      this.changeEmitter.fire(this.uri);
    });
  }
  static async create(uri) {
    return new _AudioLensDocument(uri, await _AudioLensDocument.stat(uri));
  }
  changeEmitter = new vscode.EventEmitter();
  disposeEmitter = new vscode.EventEmitter();
  watcher;
  onDidChange = this.changeEmitter.event;
  onDidDispose = this.disposeEmitter.event;
  get size() {
    return this.fileSize;
  }
  async refresh() {
    this.fileSize = await _AudioLensDocument.stat(this.uri);
  }
  async readRange(offset, length) {
    const safeOffset = Math.max(0, Math.min(offset, this.fileSize));
    const safeLength = Math.max(0, Math.min(length, this.fileSize - safeOffset));
    if (safeLength === 0) {
      return new Uint8Array();
    }
    if (this.uri.scheme === "file") {
      const handle = await (0, import_promises.open)(this.uri.fsPath, "r");
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
};
var AudioLensEditorProvider = class _AudioLensEditorProvider {
  constructor(context) {
    this.context = context;
  }
  static viewType = "audiolens.audioPreview";
  static register(context) {
    return vscode.window.registerCustomEditorProvider(
      _AudioLensEditorProvider.viewType,
      new _AudioLensEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
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
      webviewPanel.webview.onDidReceiveMessage(async (message) => {
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
          if (!vscode.workspace.isTrusted) {
            throw new Error("\u5F53\u524D\u5DE5\u4F5C\u533A\u672A\u53D7\u4FE1\u4EFB\uFF0CAudioLens \u4E0D\u4F1A\u4F20\u8F93\u97F3\u9891\u5185\u5BB9\u3002");
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
    return {
      fileName: path.basename(document.uri.fsPath || document.uri.path),
      uri: document.uri.toString(),
      size: document.size,
      trusted: vscode.workspace.isTrusted
    };
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
      frequencyScale: value.frequencyScale,
      palette: value.palette,
      minDb: value.minDb,
      maxDb: value.maxDb,
      amplitudeZoom: value.amplitudeZoom,
      waveformHeight: value.waveformHeight,
      spectrogramHeight: value.spectrogramHeight
    };
  }
  readConfig() {
    const config = vscode.workspace.getConfiguration("audiolens");
    return {
      autoAnalyze: config.get("autoAnalyze", true),
      maxFileSizeMB: config.get("maxFileSizeMB", 512),
      analysis: {
        windowFunction: config.get("analysis.windowFunction", "hamming"),
        fftSize: config.get("analysis.fftSize", 512),
        zeroPaddingFactor: config.get("analysis.zeroPaddingFactor", 2)
      }
    };
  }
  postMessage(webview, message) {
    webview.postMessage(message);
  }
  getHtml(webview) {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    return (
      /* html */
      `<!DOCTYPE html>
<html lang="zh-CN">
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
};
function toArrayBuffer(bytes) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

// src/extension.ts
function activate(context) {
  context.subscriptions.push(AudioLensEditorProvider.register(context));
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
