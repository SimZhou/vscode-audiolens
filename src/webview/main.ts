import { ExtensionMessage } from "../shared/protocol";
import { AudioLensApp } from "./app";
import { injectStyles } from "./styles";
import { renderShell } from "./view";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("AudioLens root element missing");
}

injectStyles();

const vscode = acquireVsCodeApi();

try {
  const app = new AudioLensApp(vscode, renderShell(root));

  window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
    void app.handleMessage(event.data);
  });

  vscode.postMessage({ type: "ready" });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  root.textContent = `AudioLens initialization failed: ${message}`;
  vscode.postMessage({ type: "showError", message: `AudioLens initialization failed: ${message}` });
}
