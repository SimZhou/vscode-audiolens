import * as vscode from "vscode";
import {
  detectFfmpegInstallCommand,
  FfmpegCandidate,
  FfmpegInstallCommand,
  FfmpegInstallError,
  findFfmpeg,
  installManagedFfmpeg,
  listFfmpegCandidates,
  managedFfmpegBuildKey,
  readFfmpegVersion,
  usableFfmpegPath
} from "./ffmpegRuntime";
import { RemoteAudioError, remoteAudioErrorReason, RemoteAudioMessages } from "./remoteAudio";
import { formatBytes } from "./util";

const GUIDE_URL = "https://ffmpeg.org/download.html";
const TERMINAL_POLL_MS = 3_000;
const TERMINAL_WATCH_MS = 30 * 60_000;
const SETTING_SECTION = "audiolens";
const SETTING_KEY = "ffmpegPath";

export interface FfmpegMessages {
  ffmpegNotFound: string;
  ffmpegMissing: string;
  ffmpegSuggestCommand: (command: string) => string;
  ffmpegSuggestDownload: string;
  ffmpegSuggestManual: string;
  ffmpegActionTerminal: (manager: string) => string;
  ffmpegActionDownload: string;
  ffmpegActionGuide: string;
  ffmpegDownloadTitle: string;
  ffmpegVerifying: string;
  ffmpegReady: (location: string) => string;
  ffmpegInstallFailed: (reason: string) => string;
  ffmpegErrorUnsupported: string;
  ffmpegErrorIntegrity: string;
  ffmpegErrorVerify: (detail: string) => string;
  ffmpegSelectPlaceholder: (current: string) => string;
  ffmpegSelectNoneFound: string;
  ffmpegAutoDetect: string;
  ffmpegAutoDetectDescription: string;
  ffmpegSourceManaged: string;
  ffmpegSourceCustom: string;
  ffmpegBrowse: string;
  ffmpegInvalidSelection: (detail: string) => string;
}

type SelectItem = vscode.QuickPickItem & { run?: () => Promise<void> | void };

type SetupMessages = FfmpegMessages & RemoteAudioMessages;

/**
 * FFmpeg 的选择与安装引导。用户可在 "AudioLens: Select FFmpeg" 里选定某个 ffmpeg（存入设置 audiolens.ffmpegPath），
 * 未设置时自动检测。缺少 FFmpeg 时按当前环境推荐包管理器命令（在终端里执行），
 * 或一键下载托管静态版到扩展全局存储目录（仅当前用户，无需管理员权限）。
 * ffmpeg 变得可用或换了一个后触发 onDidBecomeAvailable，编辑器据此重新加载失败的音频。
 */
export class FfmpegSetup implements vscode.Disposable {
  // 用普通回调集合而不是 vscode.EventEmitter：构造时不依赖 vscode API。
  private readonly availableListeners = new Set<() => void>();
  private prompting = false;
  private installing = false;
  private terminalWatch: vscode.Disposable | undefined;

  /** `managedRoot` 是扩展全局存储目录；缺少时不提供一键安装。 */
  public constructor(private readonly managedRoot: string | undefined, private readonly messages: () => SetupMessages) {}

  public onDidBecomeAvailable(listener: () => void): vscode.Disposable {
    this.availableListeners.add(listener);
    return { dispose: () => this.availableListeners.delete(listener) };
  }

  /** 返回传给 spawn 的 ffmpeg 命令：设置里的路径可用时用它，否则自动检测；都找不到时返回 "ffmpeg"，由 spawn 报 ENOENT。 */
  public async resolveCommand(): Promise<string> {
    return await usableFfmpegPath(configuredFfmpegPath())
      ?? (await findFfmpeg(this.managedRoot))?.command
      ?? "ffmpeg";
  }

  /** 解码因缺少 FFmpeg 失败后调用；提示仍未处理、正在安装或正在等终端时不重复弹出。 */
  public async promptInstall(): Promise<void> {
    if (this.prompting || this.installing || this.terminalWatch) return;
    this.prompting = true;
    try {
      await this.showInstallOptions();
    } finally {
      this.prompting = false;
    }
  }

  /**
   * 命令面板入口 "AudioLens: Select FFmpeg"：列出找到的 ffmpeg（版本、来源、路径）并标出当前使用的，
   * 另有自动检测、手动指定和安装选项；一个都没找到时只剩安装和手动指定。
   */
  public async selectFfmpeg(): Promise<void> {
    const messages = this.messages();
    const pick = vscode.window.createQuickPick<SelectItem>();
    // 先订阅：列表加载期间用户就可能关闭选择框。
    const chosen = new Promise<SelectItem | undefined>((resolve) => {
      pick.onDidAccept(() => {
        resolve(pick.selectedItems[0]);
        pick.hide();
      });
      pick.onDidHide(() => resolve(undefined));
    });
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    pick.busy = true;
    pick.show();
    try {
      const { items, placeholder, active } = await this.selectionItems(messages);
      pick.items = items;
      pick.placeholder = placeholder;
      if (active) pick.activeItems = [active];
    } finally {
      pick.busy = false;
    }
    const item = await chosen;
    pick.dispose();
    await item?.run?.();
  }

  public dispose(): void {
    this.terminalWatch?.dispose();
    this.availableListeners.clear();
  }

  private async selectionItems(messages: SetupMessages): Promise<{ items: SelectItem[]; placeholder: string; active?: SelectItem }> {
    const [candidates, auto, suggestion] = await Promise.all([
      listFfmpegCandidates(this.managedRoot, configuredFfmpegPath()),
      findFfmpeg(this.managedRoot),
      detectFfmpegInstallCommand()
    ]);
    const selected = candidates.find((candidate) => candidate.configured);
    const autoCandidate = candidates.find((candidate) => candidate.path === auto?.path);
    const describe = (candidate: FfmpegCandidate) => `FFmpeg ${candidate.version} · ${candidate.path}`;
    const current = (on: boolean, label: string) => `${on ? "$(check)" : "$(blank)"} ${label}`;
    const autoItem: SelectItem = {
      label: current(!selected, `$(sparkle) ${messages.ffmpegAutoDetect}`),
      description: messages.ffmpegAutoDetectDescription,
      detail: autoCandidate ? `→ ${describe(autoCandidate)}` : undefined,
      run: () => this.applySelection(undefined)
    };
    const candidateItems = candidates.map((candidate): SelectItem => ({
      label: current(candidate.configured, `FFmpeg ${candidate.version}`),
      description: candidate.source === "managed" ? messages.ffmpegSourceManaged
        : candidate.source === "custom" ? messages.ffmpegSourceCustom : candidate.source,
      detail: candidate.path,
      run: () => this.applySelection(candidate.path)
    }));
    const separator: SelectItem = { label: "", kind: vscode.QuickPickItemKind.Separator };
    const canDownload = this.managedRoot !== undefined && managedFfmpegBuildKey() !== undefined
      && !candidates.some((candidate) => candidate.source === "managed");
    const actions: SelectItem[] = [
      { label: `$(folder-opened) ${messages.ffmpegBrowse}`, run: () => this.browseForFfmpeg() },
      ...(canDownload ? [{ label: `$(cloud-download) ${messages.ffmpegActionDownload}`, run: () => this.installManaged() }] : []),
      ...(suggestion ? [{
        label: `$(terminal) ${messages.ffmpegActionTerminal(suggestion.manager)}`,
        description: suggestion.command,
        run: () => this.runInTerminal(suggestion)
      }] : []),
      ...(candidates.length ? [] : [{
        label: `$(link-external) ${messages.ffmpegActionGuide}`,
        run: () => void vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL))
      }])
    ];
    const effective = selected ?? autoCandidate;
    return {
      items: candidates.length ? [autoItem, ...candidateItems, separator, ...actions] : actions,
      placeholder: effective ? messages.ffmpegSelectPlaceholder(describe(effective)) : messages.ffmpegSelectNoneFound,
      active: candidates.length ? (selected ? candidateItems[candidates.indexOf(selected)] : autoItem) : actions[0]
    };
  }

  private async browseForFfmpeg(): Promise<void> {
    const [uri] = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: process.platform === "win32" ? { FFmpeg: ["exe"] } : undefined
    }) ?? [];
    if (!uri) return;
    try {
      await readFfmpegVersion(uri.fsPath, 10_000);
    } catch (error) {
      const detail = error instanceof FfmpegInstallError ? error.detail ?? error.message : String(error);
      void vscode.window.showErrorMessage(this.messages().ffmpegInvalidSelection(detail));
      return;
    }
    await this.applySelection(uri.fsPath);
  }

  /** 保存选择（undefined 表示自动检测）到用户/远端机器设置，并让等待中的编辑器用新的 ffmpeg 重试。 */
  private async applySelection(file: string | undefined): Promise<void> {
    await vscode.workspace.getConfiguration(SETTING_SECTION).update(SETTING_KEY, file, vscode.ConfigurationTarget.Global);
    const found = await usableFfmpegPath(file) ?? (await findFfmpeg(this.managedRoot))?.path;
    if (found) this.announceReady(found);
  }

  private async showInstallOptions(): Promise<void> {
    const messages = this.messages();
    const suggestion = await detectFfmpegInstallCommand();
    const canDownload = this.managedRoot !== undefined && managedFfmpegBuildKey() !== undefined;
    const terminalAction = suggestion ? messages.ffmpegActionTerminal(suggestion.manager) : undefined;
    // 不需要管理员权限的包管理器（Homebrew、Scoop、winget）排第一；需要 sudo 的排在一键安装之后。
    const actions = [
      ...(terminalAction && !suggestion?.elevated ? [terminalAction] : []),
      ...(canDownload ? [messages.ffmpegActionDownload] : []),
      ...(terminalAction && suggestion?.elevated ? [terminalAction] : []),
      messages.ffmpegActionGuide
    ];
    const text = joinSentences([
      messages.ffmpegMissing,
      suggestion ? messages.ffmpegSuggestCommand(suggestion.command) : "",
      canDownload ? messages.ffmpegSuggestDownload : "",
      !suggestion && !canDownload ? messages.ffmpegSuggestManual : ""
    ]);
    const picked = await vscode.window.showWarningMessage(text, ...actions);
    if (picked !== undefined && picked === terminalAction && suggestion) {
      this.runInTerminal(suggestion);
    } else if (picked === messages.ffmpegActionDownload) {
      await this.installManaged();
    } else if (picked === messages.ffmpegActionGuide) {
      void vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
    }
  }

  private runInTerminal(suggestion: FfmpegInstallCommand): void {
    const terminal = vscode.window.createTerminal({ name: "AudioLens: FFmpeg" });
    terminal.show();
    terminal.sendText(suggestion.command);
    this.watchTerminalInstall(terminal);
  }

  /** 终端里的包管理器拿不到退出码；定期检查 ffmpeg 是否出现，终端关闭或超时后停止。 */
  private watchTerminalInstall(terminal: vscode.Terminal): void {
    this.terminalWatch?.dispose();
    const startedAt = Date.now();
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const found = await findFfmpeg(this.managedRoot);
        if (found) {
          stop();
          this.announceReady(found.path);
        } else if (Date.now() - startedAt > TERMINAL_WATCH_MS) {
          stop();
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), TERMINAL_POLL_MS);
    const closed = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal !== terminal) return;
      stop();
      void findFfmpeg(this.managedRoot).then((found) => found && this.announceReady(found.path));
    });
    const stop = (): void => {
      clearInterval(timer);
      closed.dispose();
      if (this.terminalWatch === watch) this.terminalWatch = undefined;
    };
    const watch: vscode.Disposable = { dispose: stop };
    this.terminalWatch = watch;
  }

  private async installManaged(): Promise<void> {
    const managedRoot = this.managedRoot;
    if (this.installing || !managedRoot) return;
    this.installing = true;
    const messages = this.messages();
    let failure: unknown;
    try {
      const installed = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: messages.ffmpegDownloadTitle,
        cancellable: true
      }, async (progress, token) => {
        const controller = new AbortController();
        const cancel = token.onCancellationRequested(() => controller.abort());
        // 通知进度条不能后退；与网络音频下载相同，只在百分比增加时前进（换源后从头计数也不回退）。
        let reportedPercent = 0;
        let source = "";
        try {
          return await installManagedFfmpeg(managedRoot, {
            signal: controller.signal,
            onSource: (name) => { source = name; },
            onProgress: ({ receivedBytes, totalBytes }) => {
              const percent = totalBytes ? Math.min(100, receivedBytes / totalBytes * 100) : undefined;
              const size = totalBytes ? `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}` : formatBytes(receivedBytes);
              const increment = percent !== undefined && percent > reportedPercent ? percent - reportedPercent : undefined;
              progress.report({ message: `${messages.remoteDownloaded(size)} · ${source}`, increment });
              if (increment !== undefined) reportedPercent = percent!;
            },
            onVerify: () => progress.report({ message: messages.ffmpegVerifying })
          });
        } finally {
          cancel.dispose();
        }
      });
      this.announceReady(installed);
    } catch (error) {
      failure = error;
    } finally {
      this.installing = false;
    }
    if (failure === undefined || (failure instanceof RemoteAudioError && failure.code === "canceled")) return;
    // 下载失败时再给出包管理器选项：终端里的包管理器使用 shell 的代理和镜像配置，可能走得通。
    const suggestion = await detectFfmpegInstallCommand();
    const terminalAction = suggestion ? messages.ffmpegActionTerminal(suggestion.manager) : undefined;
    const picked = await vscode.window.showErrorMessage(
      messages.ffmpegInstallFailed(this.describeInstallError(failure, messages)),
      ...(terminalAction ? [terminalAction] : []),
      messages.ffmpegActionGuide
    );
    if (picked !== undefined && picked === terminalAction && suggestion) {
      this.runInTerminal(suggestion);
    } else if (picked === messages.ffmpegActionGuide) {
      void vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
    }
  }

  private describeInstallError(error: unknown, messages: SetupMessages): string {
    if (error instanceof FfmpegInstallError) {
      if (error.code === "unsupportedPlatform") return messages.ffmpegErrorUnsupported;
      if (error.code === "integrity") return messages.ffmpegErrorIntegrity;
      return messages.ffmpegErrorVerify(error.detail ?? error.message);
    }
    if (error instanceof RemoteAudioError) {
      // 下载上限是为固定资产设的；超限只可能是资产被替换，按校验失败处理。
      return error.code === "tooLarge" ? messages.ffmpegErrorIntegrity : remoteAudioErrorReason(error, messages, "");
    }
    return error instanceof Error ? error.message : String(error);
  }

  private announceReady(location: string): void {
    void vscode.window.showInformationMessage(this.messages().ffmpegReady(location));
    for (const listener of [...this.availableListeners]) listener();
  }
}

function configuredFfmpegPath(): string {
  return vscode.workspace.getConfiguration(SETTING_SECTION).get<string>(SETTING_KEY, "");
}

/** 拼接提示句：中日文句号后不加空格，其他语言用空格分隔。 */
function joinSentences(parts: string[]): string {
  return parts.filter(Boolean).reduce((text, part) => text + (/[。！？]$/.test(text) ? "" : " ") + part);
}
