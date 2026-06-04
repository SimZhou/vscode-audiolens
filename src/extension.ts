import * as vscode from "vscode";
import { AudioLensEditorProvider } from "./audioLensEditor";
import { registerAudioPathLinks } from "./audioPathLinks";

const LANGUAGE_OPTIONS = [
  { value: "auto", label: "跟随 VS Code / Auto", detail: "使用 VS Code 当前显示语言" },
  { value: "zh-CN", label: "中文（简体）", detail: "Simplified Chinese" },
  { value: "zh-TW", label: "中文（繁體）", detail: "Traditional Chinese" },
  { value: "en", label: "English", detail: "English" },
  { value: "ja", label: "日本語", detail: "Japanese" },
  { value: "ko", label: "한국어", detail: "Korean" },
  { value: "fr", label: "Français", detail: "French" },
  { value: "de", label: "Deutsch", detail: "German" },
  { value: "ru", label: "Русский", detail: "Russian" },
  { value: "es", label: "Español", detail: "Spanish" },
  { value: "it", label: "Italiano", detail: "Italian" },
  { value: "pt", label: "Português", detail: "Portuguese" },
  { value: "id", label: "Bahasa Indonesia", detail: "Indonesian" },
  { value: "no", label: "Norsk", detail: "Norwegian" },
  { value: "nl", label: "Nederlands", detail: "Dutch" },
  { value: "pl", label: "Polski", detail: "Polish" },
  { value: "tr", label: "Türkçe", detail: "Turkish" },
  { value: "vi", label: "Tiếng Việt", detail: "Vietnamese" }
] as const;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    AudioLensEditorProvider.register(context),
    registerAudioPathLinks(),
    vscode.commands.registerCommand("audiolens.selectLanguage", async () => {
      const config = vscode.workspace.getConfiguration("audiolens");
      const current = config.get<string>("language", "auto");
      const picked = await vscode.window.showQuickPick(
        LANGUAGE_OPTIONS.map((option) => ({
          label: option.label,
          description: option.value === current ? "当前" : "",
          detail: option.detail,
          value: option.value
        })),
        {
          title: "AudioLens: 选择语言",
          placeHolder: "选择 AudioLens 界面语言"
        }
      );

      if (!picked) {
        return;
      }

      await config.update("language", picked.value, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`AudioLens 语言已切换为 ${picked.label}`);
    })
  );
}

export function deactivate(): void {
  // VS Code 会释放已注册的 disposable，这里保留空实现便于后续扩展原生资源清理。
}
