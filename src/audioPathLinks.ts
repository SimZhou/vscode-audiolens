import * as path from "node:path";
import * as vscode from "vscode";

const AUDIO_LENS_VIEW_TYPE = "audiolens.audioPreview";
const OPEN_AUDIO_PATH_COMMAND = "audiolens.openAudioPathLink";
const OPEN_AUDIO_PATH_AT_CURSOR_COMMAND = "audiolens.openAudioPathAtCursor";
const TOGGLE_AUDIO_PATH_LINKS_COMMAND = "audiolens.toggleAudioPathLinks";
const AUDIO_PATH_LINKS_ENABLED_CONFIG = "audioPathLinks.enabled";
const AUDIO_PATH_LINK_BASE_DIRECTORIES_CONFIG = "audioPathLinks.baseDirectories";
const MAX_LINE_LENGTH_CONFIG = "audioPathLinks.maxLineLength";
const DEFAULT_MAX_LINE_LENGTH = 20_000;
const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "pcm", "raw"] as const;
const EXT_PATTERN = AUDIO_EXTENSIONS.join("|");
const QUOTED_AUDIO_PATH_RE = new RegExp(`(["'\`])([^"'\`\\r\\n]*?\\.(${EXT_PATTERN}))\\1`, "gi");
const UNQUOTED_AUDIO_PATH_RE = new RegExp(`([^\\s"'\\\`<>{}|]+?\\.(${EXT_PATTERN}))(?=$|[\\s"',;:)\\]}|])`, "gi");
const AUDIO_PATH_HINT_RE = new RegExp(`\\.(${EXT_PATTERN})`, "i");
const AUDIO_EXTENSION_RE = new RegExp(`\\.(${EXT_PATTERN})$`, "i");
const FIELD_DELIMITER_RE = /[|]/;
const TRAILING_PUNCTUATION_RE = /[,;:)\]}]+$/;
const GLOB_WILDCARD_RE = /[*?[\]]/;

interface AudioPathLinkArgs {
  text: string;
  documentUri: string;
}

interface AudioPathMessages {
  openInAudioLens: string;
  statusOpen: string;
  statusTooltip: string;
  cannotResolveAudioPath: (pathText: string) => string;
  cannotFindAudioPathAtCursor: string;
  enabled: string;
  disabled: string;
}

const AUDIO_PATH_MESSAGES: Record<string, AudioPathMessages> = {
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
    openInAudioLens: "在 AudioLens 中打开",
    statusOpen: "AudioLens：打开",
    statusTooltip: "用 AudioLens 打开光标处音频路径",
    cannotResolveAudioPath: (pathText) => `AudioLens 无法解析音频路径：${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens 未在光标处找到音频路径。",
    enabled: "AudioLens 音频路径入口已开启。",
    disabled: "AudioLens 音频路径入口已关闭。"
  },
  "zh-tw": {
    openInAudioLens: "在 AudioLens 中開啟",
    statusOpen: "AudioLens：開啟",
    statusTooltip: "用 AudioLens 開啟游標處音訊路徑",
    cannotResolveAudioPath: (pathText) => `AudioLens 無法解析音訊路徑：${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens 未在游標處找到音訊路徑。",
    enabled: "AudioLens 音訊路徑入口已開啟。",
    disabled: "AudioLens 音訊路徑入口已關閉。"
  },
  ja: {
    openInAudioLens: "AudioLens で開く",
    statusOpen: "AudioLens: 開く",
    statusTooltip: "カーソル位置の音声パスを AudioLens で開く",
    cannotResolveAudioPath: (pathText) => `AudioLens は音声パスを解決できません: ${pathText}`,
    cannotFindAudioPathAtCursor: "カーソル位置に音声パスが見つかりません。",
    enabled: "AudioLens の音声パス操作を有効にしました。",
    disabled: "AudioLens の音声パス操作を無効にしました。"
  },
  ko: {
    openInAudioLens: "AudioLens에서 열기",
    statusOpen: "AudioLens: 열기",
    statusTooltip: "커서 위치의 오디오 경로를 AudioLens로 열기",
    cannotResolveAudioPath: (pathText) => `AudioLens가 오디오 경로를 확인할 수 없습니다: ${pathText}`,
    cannotFindAudioPathAtCursor: "커서 위치에서 오디오 경로를 찾을 수 없습니다.",
    enabled: "AudioLens 오디오 경로 동작이 켜졌습니다.",
    disabled: "AudioLens 오디오 경로 동작이 꺼졌습니다."
  },
  fr: {
    openInAudioLens: "Ouvrir dans AudioLens",
    statusOpen: "AudioLens : ouvrir",
    statusTooltip: "Ouvrir le chemin audio sous le curseur avec AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens ne peut pas résoudre le chemin audio : ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens ne trouve pas de chemin audio sous le curseur.",
    enabled: "Actions de chemin audio AudioLens activées.",
    disabled: "Actions de chemin audio AudioLens désactivées."
  },
  de: {
    openInAudioLens: "In AudioLens öffnen",
    statusOpen: "AudioLens: Öffnen",
    statusTooltip: "Audiopfad am Cursor mit AudioLens öffnen",
    cannotResolveAudioPath: (pathText) => `AudioLens kann den Audiopfad nicht auflösen: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens findet am Cursor keinen Audiopfad.",
    enabled: "AudioLens-Audiopfadaktionen aktiviert.",
    disabled: "AudioLens-Audiopfadaktionen deaktiviert."
  },
  ru: {
    openInAudioLens: "Открыть в AudioLens",
    statusOpen: "AudioLens: открыть",
    statusTooltip: "Открыть аудиопуть под курсором в AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens не может разрешить аудиопуть: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens не нашел аудиопуть под курсором.",
    enabled: "Действия AudioLens для аудиопутей включены.",
    disabled: "Действия AudioLens для аудиопутей отключены."
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
    cannotResolveAudioPath: (pathText) => `AudioLens non può risolvere il percorso audio: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens non trova un percorso audio sotto il cursore.",
    enabled: "Azioni percorso audio di AudioLens attivate.",
    disabled: "Azioni percorso audio di AudioLens disattivate."
  },
  pt: {
    openInAudioLens: "Abrir no AudioLens",
    statusOpen: "AudioLens: abrir",
    statusTooltip: "Abrir o caminho de áudio no cursor com AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens não consegue resolver o caminho de áudio: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens não encontrou um caminho de áudio no cursor.",
    enabled: "Ações de caminho de áudio do AudioLens ativadas.",
    disabled: "Ações de caminho de áudio do AudioLens desativadas."
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
    openInAudioLens: "Åpne i AudioLens",
    statusOpen: "AudioLens: åpne",
    statusTooltip: "Åpne lydstien ved markøren med AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens kan ikke finne lydstien: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens finner ingen lydsti ved markøren.",
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
    openInAudioLens: "Otwórz w AudioLens",
    statusOpen: "AudioLens: otwórz",
    statusTooltip: "Otwórz ścieżkę audio pod kursorem w AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens nie może rozwiązać ścieżki audio: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens nie znalazł ścieżki audio pod kursorem.",
    enabled: "Akcje ścieżek audio AudioLens włączone.",
    disabled: "Akcje ścieżek audio AudioLens wyłączone."
  },
  tr: {
    openInAudioLens: "AudioLens'te aç",
    statusOpen: "AudioLens: aç",
    statusTooltip: "İmleçteki ses yolunu AudioLens ile aç",
    cannotResolveAudioPath: (pathText) => `AudioLens ses yolunu çözemiyor: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens imleçte bir ses yolu bulamadı.",
    enabled: "AudioLens ses yolu eylemleri etkin.",
    disabled: "AudioLens ses yolu eylemleri devre dışı."
  },
  vi: {
    openInAudioLens: "Mở trong AudioLens",
    statusOpen: "AudioLens: mở",
    statusTooltip: "Mở đường dẫn âm thanh tại con trỏ bằng AudioLens",
    cannotResolveAudioPath: (pathText) => `AudioLens không thể phân giải đường dẫn âm thanh: ${pathText}`,
    cannotFindAudioPathAtCursor: "AudioLens không tìm thấy đường dẫn âm thanh tại con trỏ.",
    enabled: "Đã bật thao tác đường dẫn âm thanh của AudioLens.",
    disabled: "Đã tắt thao tác đường dẫn âm thanh của AudioLens."
  }
};

export function registerAudioPathLinks(): vscode.Disposable {
  const statusBar = new AudioPathStatusBarController();
  return vscode.Disposable.from(
    vscode.languages.registerHoverProvider({ scheme: "file" }, new AudioPathHoverProvider()),
    statusBar,
    vscode.window.onDidChangeActiveTextEditor(() => {
      statusBar.update();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        statusBar.update();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("audiolens.audioPathLinks") || event.affectsConfiguration("audiolens.language")) {
        statusBar.update();
      }
    }),
    vscode.commands.registerCommand(OPEN_AUDIO_PATH_COMMAND, async (args?: AudioPathLinkArgs) => {
      await openAudioPathLink(args);
    }),
    vscode.commands.registerCommand(OPEN_AUDIO_PATH_AT_CURSOR_COMMAND, async () => {
      await openAudioPathAtCursor();
    }),
    vscode.commands.registerCommand(TOGGLE_AUDIO_PATH_LINKS_COMMAND, async () => {
      await toggleAudioPathLinks();
    })
  );
}

class AudioPathStatusBarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  public constructor() {
    this.item.command = OPEN_AUDIO_PATH_AT_CURSOR_COMMAND;
    this.update();
  }

  public update(): void {
    const editor = vscode.window.activeTextEditor;
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

  public dispose(): void {
    this.item.dispose();
  }
}

class AudioPathHoverProvider implements vscode.HoverProvider {
  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const options = getAudioPathLinkOptions();
    if (!options.enabled || document.uri.scheme !== "file") {
      return undefined;
    }

    const line = document.lineAt(position.line).text;
    if (line.length > options.maxLineLength || !lineMayContainAudioPath(line)) {
      return undefined;
    }

    const candidate = findAudioPathCandidateAt(line, position.character);
    if (!candidate) {
      return undefined;
    }

    const commandUri = createOpenAudioPathCommandUri({
      text: candidate.text,
      documentUri: document.uri.toString()
    });
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: [OPEN_AUDIO_PATH_COMMAND] };
    markdown.supportThemeIcons = true;
    markdown.appendMarkdown(`[$(play) ${escapeMarkdown(resolveAudioPathMessages().openInAudioLens)}](${commandUri.toString()})`);
    return new vscode.Hover(markdown, new vscode.Range(
      position.line,
      candidate.start,
      position.line,
      candidate.end
    ));
  }
}

function lineMayContainAudioPath(line: string): boolean {
  return AUDIO_PATH_HINT_RE.test(line);
}

function trimAudioPathCandidate(value: string): string {
  return value.trim().replace(TRAILING_PUNCTUATION_RE, "");
}

function shouldLinkAudioPath(value: string): boolean {
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

function findAudioPathCandidateAt(
  line: string,
  character: number
): { text: string; start: number; end: number } | undefined {
  return collectAudioPathCandidatesFromLine(line)
    .find((candidate) => character >= candidate.start && character <= candidate.end);
}

function collectAudioPathCandidatesFromLine(line: string): Array<{ text: string; start: number; end: number }> {
  const candidates: Array<{ text: string; start: number; end: number }> = [];

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

function createOpenAudioPathCommandUri(args: AudioPathLinkArgs): vscode.Uri {
  return vscode.Uri.parse(
    `command:${OPEN_AUDIO_PATH_COMMAND}?${encodeURIComponent(JSON.stringify([args]))}`
  );
}

function findAudioPathCandidateInEditor(
  editor: vscode.TextEditor,
  maxLineLength: number
): { text: string; start?: number; end?: number } | undefined {
  const selected = trimAudioPathCandidate(editor.document.getText(editor.selection));
  if (shouldLinkAudioPath(selected)) {
    return { text: selected };
  }

  const line = editor.document.lineAt(editor.selection.active.line).text;
  if (line.length > maxLineLength || !lineMayContainAudioPath(line)) {
    return undefined;
  }

  return findAudioPathCandidateAt(line, editor.selection.active.character);
}

async function openAudioPathLink(args?: AudioPathLinkArgs): Promise<void> {
  if (!args?.text || !args.documentUri) {
    return;
  }

  const sourceUri = vscode.Uri.parse(args.documentUri);
  const resolved = await resolveAudioPath(args.text, sourceUri);
  if (!resolved) {
    void vscode.window.showWarningMessage(resolveAudioPathMessages().cannotResolveAudioPath(args.text));
    return;
  }

  await vscode.commands.executeCommand("vscode.openWith", resolved, AUDIO_LENS_VIEW_TYPE);
}

async function openAudioPathAtCursor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    return;
  }

  const candidate = findAudioPathCandidateInEditor(editor, getAudioPathLinkOptions().maxLineLength);
  if (!candidate) {
    void vscode.window.showWarningMessage(resolveAudioPathMessages().cannotFindAudioPathAtCursor);
    return;
  }

  await openAudioPathLink({
    text: candidate.text,
    documentUri: editor.document.uri.toString()
  });
}

async function toggleAudioPathLinks(): Promise<void> {
  const config = vscode.workspace.getConfiguration("audiolens");
  const enabled = config.get<boolean>(AUDIO_PATH_LINKS_ENABLED_CONFIG, true);
  const nextEnabled = !enabled;
  await config.update(AUDIO_PATH_LINKS_ENABLED_CONFIG, nextEnabled, vscode.ConfigurationTarget.Global);
  const messages = resolveAudioPathMessages();
  void vscode.window.showInformationMessage(nextEnabled ? messages.enabled : messages.disabled);
}

async function resolveAudioPath(value: string, sourceUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const candidates = buildAudioPathCandidates(value, sourceUri);
  for (const candidate of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(candidate);
      if ((stat.type & vscode.FileType.File) !== 0) {
        return candidate;
      }
    } catch {
      // Try the next deterministic base directory.
    }
  }
  return undefined;
}

function buildAudioPathCandidates(value: string, sourceUri: vscode.Uri): vscode.Uri[] {
  const candidates: vscode.Uri[] = [];
  if (path.isAbsolute(value)) {
    return [vscode.Uri.file(value)];
  }

  addCandidate(candidates, vscode.Uri.file(path.resolve(path.dirname(sourceUri.fsPath), value)));

  const owningWorkspace = vscode.workspace.getWorkspaceFolder(sourceUri);
  if (owningWorkspace?.uri.scheme === "file") {
    addCandidate(candidates, vscode.Uri.file(path.resolve(owningWorkspace.uri.fsPath, value)));
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === "file") {
      addCandidate(candidates, vscode.Uri.file(path.resolve(folder.uri.fsPath, value)));
    }
  }

  for (const base of getConfiguredBaseDirectories()) {
    addCandidate(candidates, vscode.Uri.file(path.resolve(base, value)));
  }

  return candidates;
}

function addCandidate(candidates: vscode.Uri[], uri: vscode.Uri): void {
  if (!candidates.some((existing) => existing.fsPath === uri.fsPath)) {
    candidates.push(uri);
  }
}

function getConfiguredBaseDirectories(): string[] {
  const values = vscode.workspace
    .getConfiguration("audiolens")
    .get<string[]>(AUDIO_PATH_LINK_BASE_DIRECTORIES_CONFIG, []);
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => value.startsWith("~/") ? path.join(process.env.HOME ?? "", value.slice(2)) : value)
    .filter((value) => path.isAbsolute(value));
}

function getAudioPathLinkOptions(): {
  enabled: boolean;
  maxLineLength: number;
} {
  const config = vscode.workspace.getConfiguration("audiolens");
  return {
    enabled: config.get<boolean>(AUDIO_PATH_LINKS_ENABLED_CONFIG, true),
    maxLineLength: getPositiveIntegerConfig(config, MAX_LINE_LENGTH_CONFIG, DEFAULT_MAX_LINE_LENGTH)
  };
}

function getPositiveIntegerConfig(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number
): number {
  const value = config.get<number>(key, fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resolveAudioPathMessages(locale = resolveAudioPathLanguage()): AudioPathMessages {
  const normalized = locale.toLowerCase();
  if (normalized === "zh-cn" || normalized.startsWith("zh-hans")) {
    return AUDIO_PATH_MESSAGES["zh-cn"];
  }
  if (normalized === "zh-tw" || normalized.startsWith("zh-hant")) {
    return AUDIO_PATH_MESSAGES["zh-tw"];
  }
  return AUDIO_PATH_MESSAGES[normalized.split("-")[0]] ?? AUDIO_PATH_MESSAGES.en;
}

function resolveAudioPathLanguage(): string {
  const configured = vscode.workspace.getConfiguration("audiolens").get<string>("language", "auto");
  return configured === "auto" ? vscode.env.language : configured;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\[\]()`]/g, "\\$&");
}
