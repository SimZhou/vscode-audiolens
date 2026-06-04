import * as path from "node:path";
import * as vscode from "vscode";

const AUDIO_LENS_VIEW_TYPE = "audiolens.audioPreview";
const OPEN_AUDIO_PATH_COMMAND = "audiolens.openAudioPathLink";
const TOGGLE_AUDIO_PATH_LINKS_COMMAND = "audiolens.toggleAudioPathLinks";
const CONFIGURE_AUDIO_PATH_LINKS_COMMAND = "audiolens.configureAudioPathLinks";
const AUDIO_PATH_LINKS_ENABLED_CONFIG = "audioPathLinks.enabled";
const AUDIO_PATH_LINK_BASE_DIRECTORIES_CONFIG = "audioPathLinks.baseDirectories";
const MAX_SCAN_LINES_CONFIG = "audioPathLinks.maxScanLines";
const MAX_LINE_LENGTH_CONFIG = "audioPathLinks.maxLineLength";
const MAX_LINKS_PER_DOCUMENT_CONFIG = "audioPathLinks.maxLinksPerDocument";
const DEFAULT_MAX_SCAN_LINES = 150_000;
const DEFAULT_MAX_LINE_LENGTH = 20_000;
const DEFAULT_MAX_LINKS_PER_DOCUMENT = 20_000;
const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "pcm", "raw"] as const;
const EXT_PATTERN = AUDIO_EXTENSIONS.join("|");
const QUOTED_AUDIO_PATH_RE = new RegExp(`(["'\`])([^"'\`\\r\\n]*?\\.(${EXT_PATTERN}))\\1`, "gi");
const UNQUOTED_AUDIO_PATH_RE = new RegExp(`([^\\s"'\\\`<>{}]+?\\.(${EXT_PATTERN}))(?=$|[\\s"',;:)\\]}])`, "gi");
const AUDIO_EXTENSION_RE = new RegExp(`\\.(${EXT_PATTERN})$`, "i");
const TRAILING_PUNCTUATION_RE = /[,;:)\]}]+$/;
const linkLimitNotifiedDocuments = new Set<string>();

interface AudioPathLinkArgs {
  text: string;
  documentUri: string;
}

export function registerAudioPathLinks(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.languages.registerDocumentLinkProvider({ scheme: "file" }, new AudioPathDocumentLinkProvider()),
    vscode.commands.registerCommand(OPEN_AUDIO_PATH_COMMAND, async (args?: AudioPathLinkArgs) => {
      await openAudioPathLink(args);
    }),
    vscode.commands.registerCommand(TOGGLE_AUDIO_PATH_LINKS_COMMAND, async () => {
      await toggleAudioPathLinks();
    }),
    vscode.commands.registerCommand(CONFIGURE_AUDIO_PATH_LINKS_COMMAND, async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "audiolens.audioPathLinks");
    })
  );
}

class AudioPathDocumentLinkProvider implements vscode.DocumentLinkProvider {
  public provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.DocumentLink[] {
    const options = getAudioPathLinkOptions();
    if (!options.enabled || document.uri.scheme !== "file") {
      return [];
    }

    const links: vscode.DocumentLink[] = [];
    const linesToScan = Math.min(document.lineCount, options.maxScanLines);
    for (let lineIndex = 0; lineIndex < linesToScan; lineIndex += 1) {
      if (token.isCancellationRequested) {
        return [];
      }

      const line = document.lineAt(lineIndex).text;
      if (line.length > options.maxLineLength) {
        continue;
      }
      if (!lineMayContainAudioPath(line)) {
        continue;
      }

      collectQuotedLinks(document, line, lineIndex, links, options.maxLinksPerDocument);
      collectUnquotedLinks(document, line, lineIndex, links, options.maxLinksPerDocument);
      if (links.length >= options.maxLinksPerDocument) {
        notifyLinkLimitReached(document, options.maxLinksPerDocument);
        return links;
      }
    }
    if (document.lineCount > options.maxScanLines) {
      notifyScanLineLimitReached(document, options.maxScanLines);
    }
    return links;
  }
}

function lineMayContainAudioPath(line: string): boolean {
  const lower = line.toLowerCase();
  return AUDIO_EXTENSIONS.some((extension) => lower.includes(`.${extension}`));
}

function collectQuotedLinks(
  document: vscode.TextDocument,
  line: string,
  lineIndex: number,
  links: vscode.DocumentLink[],
  maxLinks: number
): void {
  QUOTED_AUDIO_PATH_RE.lastIndex = 0;
  for (let match = QUOTED_AUDIO_PATH_RE.exec(line); match; match = QUOTED_AUDIO_PATH_RE.exec(line)) {
    const text = trimAudioPathCandidate(match[2]);
    if (!shouldLinkAudioPath(text)) {
      continue;
    }

    const start = (match.index ?? 0) + 1;
    addAudioPathLink(document, lineIndex, start, text, links, maxLinks);
  }
}

function collectUnquotedLinks(
  document: vscode.TextDocument,
  line: string,
  lineIndex: number,
  links: vscode.DocumentLink[],
  maxLinks: number
): void {
  UNQUOTED_AUDIO_PATH_RE.lastIndex = 0;
  for (let match = UNQUOTED_AUDIO_PATH_RE.exec(line); match; match = UNQUOTED_AUDIO_PATH_RE.exec(line)) {
    const text = trimAudioPathCandidate(match[1]);
    if (!shouldLinkAudioPath(text)) {
      continue;
    }

    addAudioPathLink(document, lineIndex, match.index ?? 0, text, links, maxLinks);
  }
}

function trimAudioPathCandidate(value: string): string {
  return value.trim().replace(TRAILING_PUNCTUATION_RE, "");
}

function shouldLinkAudioPath(value: string): boolean {
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }
  return AUDIO_EXTENSION_RE.test(value);
}

function addAudioPathLink(
  document: vscode.TextDocument,
  lineIndex: number,
  startCharacter: number,
  text: string,
  links: vscode.DocumentLink[],
  maxLinks: number
): void {
  const range = new vscode.Range(
    lineIndex,
    startCharacter,
    lineIndex,
    startCharacter + text.length
  );
  if (links.length >= maxLinks) {
    return;
  }
  if (links.some((link) => link.range.isEqual(range))) {
    return;
  }

  const args: AudioPathLinkArgs = {
    text,
    documentUri: document.uri.toString()
  };
  const target = vscode.Uri.parse(
    `command:${OPEN_AUDIO_PATH_COMMAND}?${encodeURIComponent(JSON.stringify([args]))}`
  );
  const link = new vscode.DocumentLink(range, target);
  link.tooltip = "Open with AudioLens";
  links.push(link);
}

async function openAudioPathLink(args?: AudioPathLinkArgs): Promise<void> {
  if (!args?.text || !args.documentUri) {
    return;
  }

  const sourceUri = vscode.Uri.parse(args.documentUri);
  const resolved = await resolveAudioPath(args.text, sourceUri);
  if (!resolved) {
    void vscode.window.showWarningMessage(`AudioLens cannot resolve audio path: ${args.text}`);
    return;
  }

  await vscode.commands.executeCommand("vscode.openWith", resolved, AUDIO_LENS_VIEW_TYPE);
}

async function toggleAudioPathLinks(): Promise<void> {
  const config = vscode.workspace.getConfiguration("audiolens");
  const enabled = config.get<boolean>(AUDIO_PATH_LINKS_ENABLED_CONFIG, true);
  const nextEnabled = !enabled;
  await config.update(AUDIO_PATH_LINKS_ENABLED_CONFIG, nextEnabled, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    nextEnabled ? resolveToggleMessage().enabled : resolveToggleMessage().disabled
  );
}

async function resolveAudioPath(value: string, sourceUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const candidates = buildAudioPathCandidates(value, sourceUri);
  for (const candidate of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(candidate);
      if (stat.type === vscode.FileType.File) {
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
  maxScanLines: number;
  maxLineLength: number;
  maxLinksPerDocument: number;
} {
  const config = vscode.workspace.getConfiguration("audiolens");
  return {
    enabled: config.get<boolean>(AUDIO_PATH_LINKS_ENABLED_CONFIG, true),
    maxScanLines: getPositiveIntegerConfig(config, MAX_SCAN_LINES_CONFIG, DEFAULT_MAX_SCAN_LINES),
    maxLineLength: getPositiveIntegerConfig(config, MAX_LINE_LENGTH_CONFIG, DEFAULT_MAX_LINE_LENGTH),
    maxLinksPerDocument: getPositiveIntegerConfig(
      config,
      MAX_LINKS_PER_DOCUMENT_CONFIG,
      DEFAULT_MAX_LINKS_PER_DOCUMENT
    )
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

function resolveToggleMessage(): { enabled: string; disabled: string } {
  const language = vscode.env.language.toLowerCase();
  if (language === "zh-cn" || language.startsWith("zh-hans")) {
    return {
      enabled: "AudioLens 音频路径链接已开启。",
      disabled: "AudioLens 音频路径链接已关闭。"
    };
  }
  if (language === "zh-tw" || language.startsWith("zh-hant")) {
    return {
      enabled: "AudioLens 音訊路徑連結已開啟。",
      disabled: "AudioLens 音訊路徑連結已關閉。"
    };
  }
  return {
    enabled: "AudioLens audio path links enabled.",
    disabled: "AudioLens audio path links disabled."
  };
}

function notifyLinkLimitReached(document: vscode.TextDocument, limit: number): void {
  const key = `${document.uri.toString()}#${limit}`;
  if (linkLimitNotifiedDocuments.has(key)) {
    return;
  }

  linkLimitNotifiedDocuments.add(key);
  vscode.window.setStatusBarMessage(
    `AudioLens limited audio path links to ${limit}. Adjust audiolens.audioPathLinks.maxLinksPerDocument to show more.`,
    8000
  );
}

function notifyScanLineLimitReached(document: vscode.TextDocument, limit: number): void {
  const key = `${document.uri.toString()}#scan#${limit}`;
  if (linkLimitNotifiedDocuments.has(key)) {
    return;
  }

  linkLimitNotifiedDocuments.add(key);
  vscode.window.setStatusBarMessage(
    `AudioLens scanned the first ${limit} lines for audio path links. Adjust audiolens.audioPathLinks.maxScanLines to scan more.`,
    8000
  );
}
