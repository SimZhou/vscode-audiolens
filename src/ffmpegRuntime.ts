import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, constants, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { downloadRemoteAudio, probeRemoteDownload, RemoteAudioError, RemoteAudioProgress } from "./remoteAudio";

// 一键安装使用 ffmpeg-static 在 GitHub Release 发布的静态构建（单个 gzip 文件，无需解包工具），
// npmmirror 同步了同一批文件。按平台固定解压后二进制的大小和 SHA-256（即 Release 里未压缩资产的 digest），
// 两个源都用这组值校验；升级时一并更新，并确认镜像已同步新版本。
const MANAGED_RELEASE = "b6.1.1";
const GITHUB_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${MANAGED_RELEASE}`;
const NPMMIRROR_BASE_URL = `https://registry.npmmirror.com/-/binary/ffmpeg-static/${MANAGED_RELEASE}`;
const MANAGED_BUILDS: Record<string, { size: number; sha256: string }> = {
  "darwin-arm64": { size: 45_568_216, sha256: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584" },
  "darwin-x64": { size: 78_862_176, sha256: "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894" },
  "linux-arm": { size: 31_793_580, sha256: "0afba4a11110e6e402053e0fc14c33a7eb207d7a588688ae87dba471a0f06c71" },
  "linux-arm64": { size: 51_134_160, sha256: "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce" },
  "linux-ia32": { size: 52_155_436, sha256: "c6472eb993612db72ca50893a34137ba11173e60a1a4c028d4660a3f755d2490" },
  "linux-x64": { size: 79_826_272, sha256: "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99" },
  "win32-x64": { size: 82_797_568, sha256: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00" }
};
const MANAGED_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
// 还有备用源时缩短空闲超时，中途断流的源不必等满默认的 30 秒。
const FALLBACK_IDLE_TIMEOUT_MS = 15_000;
// 测速：同时读各源开头 256 KiB，先读完的源用于正式下载；10 秒内都没读完时按默认顺序。
const PROBE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const VERIFY_TIMEOUT_MS = 30_000;
// 选择列表里读取各 ffmpeg 版本的超时；首次运行刚下载的二进制时 macOS 可能要先做安全检查，所以不设太短。
const LIST_VERSION_TIMEOUT_MS = 10_000;

/** spawn ffmpeg 返回 ENOENT；编辑器据此引导用户安装。 */
export class FfmpegNotFoundError extends Error {
  public constructor() {
    super("FFmpeg is required to open this encoded audio format, but the ffmpeg command was not found.");
    this.name = "FfmpegNotFoundError";
  }
}

export type FfmpegInstallErrorCode = "unsupportedPlatform" | "integrity" | "verifyFailed";

export class FfmpegInstallError extends Error {
  public constructor(public readonly code: FfmpegInstallErrorCode, message: string, public readonly detail?: string) {
    super(message);
    this.name = "FfmpegInstallError";
  }
}

/** 查找时用到的环境；测试可替换成其他平台。 */
export interface FfmpegEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  isRoot: boolean;
}

export interface FfmpegLocation {
  /** 传给 spawn 的命令：PATH 里能找到时保持 "ffmpeg"，否则是绝对路径。 */
  command: string;
  /** 实际位置，用于提示。 */
  path: string;
}

export interface FfmpegInstallCommand {
  /** 包管理器名称，用于按钮文案。 */
  manager: string;
  /** 在终端里执行的命令。 */
  command: string;
  /** 是否需要 sudo/管理员权限。 */
  elevated: boolean;
}

export interface FfmpegCandidate {
  /** 保存到设置、传给 spawn 的路径：保留列出时的路径（如 Homebrew 的 bin 链接），升级后仍然有效。 */
  path: string;
  /** 来源：包管理器名称、"PATH"、"managed"（AudioLens 下载）、"custom"（设置里手动指定），无法判断时为空。 */
  source: string;
  version: string;
  /** 与设置 audiolens.ffmpegPath 指向同一个文件。 */
  configured: boolean;
}

export interface ManagedFfmpegSource {
  /** 源名称，用于进度提示。 */
  name: string;
  url: string;
}

export interface ManagedFfmpegBuild {
  /** 依次尝试的下载源；各源文件逐字节相同，用同一组大小和 SHA-256 校验。 */
  sources: ManagedFfmpegSource[];
  size: number;
  sha256: string;
}

export function currentFfmpegEnvironment(): FfmpegEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homedir: os.homedir(),
    isRoot: process.getuid?.() === 0
  };
}

/**
 * 依次查找 PATH、常见安装位置和托管目录。扩展宿主的 PATH 在 VS Code 启动时就固定了，
 * 刚用 winget 等装好的 ffmpeg 或没进 PATH 的 Homebrew 目录只能按位置找到。
 */
export async function findFfmpeg(managedRoot?: string, environment = currentFfmpegEnvironment()): Promise<FfmpegLocation | undefined> {
  const executable = environment.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const onPath = await findOnPath([executable], environment);
  if (onPath) return { command: "ffmpeg", path: onPath };
  const managed = managedRoot ? managedFfmpegPath(managedRoot, environment) : undefined;
  for (const candidate of [...await knownFfmpegLocations(environment), ...(managed ? [managed] : [])]) {
    if (await isExecutable(candidate, environment.platform)) return { command: candidate, path: candidate };
  }
  return undefined;
}

/**
 * 解析设置 audiolens.ffmpegPath：支持 `~/` 开头；不是绝对路径或不可执行时返回 undefined，调用方改用自动检测。
 */
export async function usableFfmpegPath(value: string | undefined, environment = currentFfmpegEnvironment()): Promise<string | undefined> {
  const api = pathApi(environment);
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const expanded = /^~[\\/]/.test(trimmed) ? api.join(environment.homedir, trimmed.slice(2)) : trimmed;
  return api.isAbsolute(expanded) && await isExecutable(expanded, environment.platform) ? expanded : undefined;
}

/**
 * 选择列表：PATH 上的全部 ffmpeg、常见安装位置、未链接或 keg-only 的 Homebrew 版本、托管版和设置里的路径。
 * 按真实路径去重（保留先列出的路径），只返回能运行 `-version` 的，并附上版本号。
 */
export async function listFfmpegCandidates(
  managedRoot: string | undefined,
  configured: string | undefined,
  environment = currentFfmpegEnvironment()
): Promise<FfmpegCandidate[]> {
  const executable = environment.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const managed = managedRoot ? managedFfmpegPath(managedRoot, environment) : undefined;
  const configuredPath = await usableFfmpegPath(configured, environment);
  const entries: { path: string; onPath?: boolean; source?: string }[] = [
    ...(await findAllOnPath(executable, environment)).map((file) => ({ path: file, onPath: true })),
    ...[...await knownFfmpegLocations(environment), ...await listOnlyFfmpegLocations(environment)].map((file) => ({ path: file })),
    ...(managed ? [{ path: managed, source: "managed" }] : []),
    ...(configuredPath ? [{ path: configuredPath, source: "custom" }] : [])
  ];
  const configuredReal = configuredPath ? await realpath(configuredPath).catch(() => configuredPath) : undefined;
  const unique = new Map<string, FfmpegCandidate>();
  for (const entry of entries) {
    if (!await isExecutable(entry.path, environment.platform)) continue;
    const real = await realpath(entry.path).catch(() => entry.path);
    if (unique.has(real)) continue;
    const source = entry.source === "managed" ? "managed" : packageManagerOf(real) ?? (entry.onPath ? "PATH" : entry.source ?? "");
    unique.set(real, { path: entry.path, source, version: "", configured: real === configuredReal });
  }
  const candidates = await Promise.all([...unique.values()].map(async (candidate) => ({
    ...candidate,
    version: await readFfmpegVersion(candidate.path, LIST_VERSION_TIMEOUT_MS).catch(() => "")
  })));
  return candidates.filter((candidate) => candidate.version);
}

/** 运行 `ffmpeg -hide_banner -version`，返回 "ffmpeg version" 后的版本号；不是可用的 ffmpeg 时抛 verifyFailed。 */
export async function readFfmpegVersion(file: string, timeoutMs = VERIFY_TIMEOUT_MS): Promise<string> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(file, ["-hide_banner", "-version"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const collect = (chunk: Buffer) => {
      if (bytes < 16_384) chunks.push(chunk);
      bytes += chunk.byteLength;
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new FfmpegInstallError("verifyFailed", "FFmpeg self-check timed out.", "timeout"));
    }, timeoutMs);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new FfmpegInstallError("verifyFailed", "FFmpeg self-check failed.", error.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (code === 0) resolve(text);
      else reject(new FfmpegInstallError("verifyFailed", "FFmpeg self-check failed.", text.slice(0, 300) || `exit ${code ?? signal}`));
    });
  });
  const version = /^ffmpeg version (\S+)/m.exec(output)?.[1];
  if (!version) throw new FfmpegInstallError("verifyFailed", "FFmpeg self-check printed unexpected output.", output.slice(0, 300));
  return version;
}

/** 按当前环境推荐包管理器命令；优先不需要管理员权限的 Homebrew、Scoop、winget。 */
export async function detectFfmpegInstallCommand(environment = currentFfmpegEnvironment()): Promise<FfmpegInstallCommand | undefined> {
  const { platform, homedir } = environment;
  if (platform === "darwin" || platform === "linux") {
    const fallbacks = platform === "darwin"
      ? ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
      : ["/home/linuxbrew/.linuxbrew/bin/brew", path.posix.join(homedir, ".linuxbrew", "bin", "brew")];
    const brew = await findOnPath(["brew"], environment) ? "brew" : await firstExecutable(fallbacks, platform);
    if (brew) return { manager: "Homebrew", command: `${shellQuote(brew)} install ffmpeg`, elevated: false };
  }
  if (platform === "win32") {
    // Scoop 和 winget 的 portable 包都装在用户目录，不需要管理员权限。
    if (await findOnPath(["scoop.cmd", "scoop.ps1", "scoop"], environment)) {
      return { manager: "Scoop", command: "scoop install ffmpeg", elevated: false };
    }
    if (await findOnPath(["winget.exe"], environment)) {
      return { manager: "winget", command: "winget install --id Gyan.FFmpeg -e", elevated: false };
    }
    return undefined;
  }
  if (platform === "linux") {
    // 发行版软件源需要 root；dnf 默认源里的 ffmpeg 包名和编解码器因版本而异，不给固定命令。
    const sudo = environment.isRoot ? "" : "sudo ";
    for (const [tool, manager, args] of [
      ["apt-get", "apt", "apt install ffmpeg"],
      ["pacman", "pacman", "pacman -S ffmpeg"],
      ["zypper", "zypper", "zypper install ffmpeg"],
      ["apk", "apk", "apk add ffmpeg"]
    ] as const) {
      if (await findOnPath([tool], environment)) return { manager, command: `${sudo}${args}`, elevated: true };
    }
  }
  return undefined;
}

/** 当前平台有可一键安装的托管构建时返回构建键，例如 "darwin-arm64"。 */
export function managedFfmpegBuildKey(environment = currentFfmpegEnvironment()): string | undefined {
  // Windows on ARM 可以通过仿真运行 x64 版本。
  const arch = environment.platform === "win32" && environment.arch === "arm64" ? "x64" : environment.arch;
  const key = `${environment.platform}-${arch}`;
  return Object.prototype.hasOwnProperty.call(MANAGED_BUILDS, key) ? key : undefined;
}

/** 默认下载源：GitHub Release 和 npmmirror 镜像（国内直连 GitHub 常常只有几 KB/s）。 */
export function managedFfmpegSources(key: string): ManagedFfmpegSource[] {
  return [
    { name: "GitHub", url: `${GITHUB_BASE_URL}/ffmpeg-${key}.gz` },
    { name: "npmmirror", url: `${NPMMIRROR_BASE_URL}/ffmpeg-${key}.gz` }
  ];
}

/**
 * 同时向各源请求开头一小段，先读完的源排到最前，其余保持原顺序作为备用。
 * 都失败或超时时返回原顺序，由正式下载报告真实错误。慢但不断流的源靠空闲超时识别不了，只能这样比较。
 */
export async function rankSourcesBySpeed(
  sources: ManagedFfmpegSource[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<ManagedFfmpegSource[]> {
  if (sources.length < 2 || options.signal?.aborted) return sources;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const fastest = await Promise.any(sources.map(async (source) => {
      await probeRemoteDownload(source.url, PROBE_BYTES, controller.signal);
      return source;
    }));
    return [fastest, ...sources.filter((source) => source !== fastest)];
  } catch {
    return sources;
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
  }
}

export function managedFfmpegPath(managedRoot: string, environment = currentFfmpegEnvironment()): string | undefined {
  const key = managedFfmpegBuildKey(environment);
  if (!key) return undefined;
  return path.join(managedRoot, "ffmpeg", `${MANAGED_RELEASE}-${key}`, environment.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

interface ManagedInstallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RemoteAudioProgress) => void;
  onVerify?: () => void;
  /** 开始从某个源下载时调用，参数是源名称。 */
  onSource?: (name: string) => void;
  /** 测试用：替换下载源和校验值，并按给定顺序尝试（不测速）。 */
  build?: ManagedFfmpegBuild;
}

/**
 * 下载托管 FFmpeg 到 `<managedRoot>/ffmpeg/<release>-<platform>-<arch>/`。
 * 先测速选出更快的源；解压时校验大小和 SHA-256，改名生效前先运行 `-version` 自检，失败时不留下半成品。
 * 下载失败或校验不符时换下一个源；取消和自检失败与源无关，直接抛出。
 */
export async function installManagedFfmpeg(managedRoot: string, options: ManagedInstallOptions = {}): Promise<string> {
  const key = managedFfmpegBuildKey();
  const target = managedFfmpegPath(managedRoot);
  if (!key || !target) {
    throw new FfmpegInstallError("unsupportedPlatform", `No prebuilt FFmpeg for ${process.platform}-${process.arch}.`);
  }
  const build = options.build
    ?? { sources: await rankSourcesBySpeed(managedFfmpegSources(key), { signal: options.signal }), ...MANAGED_BUILDS[key] };
  for (const [index, source] of build.sources.entries()) {
    const last = index === build.sources.length - 1;
    options.onSource?.(source.name);
    try {
      await installFromSource(source.url, target, build, options, last ? undefined : FALLBACK_IDLE_TIMEOUT_MS);
      break;
    } catch (error) {
      if (last || !isSourceFailure(error)) throw error;
    }
  }
  await removeOtherManagedBuilds(path.dirname(path.dirname(target)), path.basename(path.dirname(target)));
  return target;
}

function isSourceFailure(error: unknown): boolean {
  if (error instanceof RemoteAudioError) return error.code !== "canceled";
  return error instanceof FfmpegInstallError && error.code === "integrity";
}

async function installFromSource(
  url: string,
  target: string,
  build: ManagedFfmpegBuild,
  options: ManagedInstallOptions,
  idleTimeoutMs: number | undefined
): Promise<void> {
  const download = await downloadRemoteAudio(url, MANAGED_MAX_DOWNLOAD_BYTES, {
    signal: options.signal,
    idleTimeoutMs,
    onProgress: options.onProgress
  });
  const directory = path.dirname(target);
  // 临时文件保留原文件名结尾：Windows 只执行 .exe，改名前的自检才能运行。
  const partial = path.join(directory, `partial-${process.pid}-${path.basename(target)}`);
  try {
    await mkdir(directory, { recursive: true });
    await extractVerified(download.filePath, partial, build, options.signal);
    options.onVerify?.();
    await readFfmpegVersion(partial);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true }).catch(() => undefined);
    await rm(download.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function extractVerified(source: string, destination: string, build: ManagedFfmpegBuild, signal?: AbortSignal): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > build.size) {
        callback(new FfmpegInstallError("integrity", "Downloaded FFmpeg is larger than expected."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(createReadStream(source), createGunzip(), meter, createWriteStream(destination, { mode: 0o755 }), { signal });
  } catch (error) {
    if (signal?.aborted) throw new RemoteAudioError("canceled", "AudioLens: FFmpeg download canceled.");
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.startsWith("Z_")) {
      throw new FfmpegInstallError("integrity", "Downloaded FFmpeg archive is corrupt.");
    }
    throw error;
  }
  if (size !== build.size || hash.digest("hex") !== build.sha256) {
    throw new FfmpegInstallError("integrity", "Downloaded FFmpeg does not match the pinned checksum.");
  }
  await chmod(destination, 0o755);
}

/** 升级托管版本后删除旧版本目录；失败不影响安装结果。 */
async function removeOtherManagedBuilds(parent: string, keep: string): Promise<void> {
  for (const entry of await readdir(parent).catch(() => [] as string[])) {
    if (entry !== keep) await rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function knownFfmpegLocations({ platform, env, homedir }: FfmpegEnvironment): Promise<string[]> {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg"];
  }
  if (platform === "win32") {
    const win = path.win32;
    const local = env.LOCALAPPDATA ?? win.join(homedir, "AppData", "Local");
    const packages = win.join(local, "Microsoft", "WinGet", "Packages");
    const locations = [
      win.join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
      win.join(env.SCOOP ?? win.join(homedir, "scoop"), "shims", "ffmpeg.exe"),
      win.join(env.ChocolateyInstall ?? "C:\\ProgramData\\chocolatey", "bin", "ffmpeg.exe")
    ];
    // winget 装好后改的是用户 PATH，已运行的 VS Code 看不到；直接查 Gyan.FFmpeg 的包目录。
    for (const name of await readdir(packages).catch(() => [] as string[])) {
      if (!/^Gyan\.FFmpeg/i.test(name)) continue;
      for (const build of await readdir(win.join(packages, name)).catch(() => [] as string[])) {
        locations.push(win.join(packages, name, build, "bin", "ffmpeg.exe"));
      }
    }
    return locations;
  }
  return [
    "/home/linuxbrew/.linuxbrew/bin/ffmpeg",
    path.posix.join(homedir, ".linuxbrew", "bin", "ffmpeg"),
    path.posix.join(homedir, ".local", "bin", "ffmpeg")
  ];
}

/** 只出现在选择列表里、不参与自动检测的位置：未链接或 keg-only 的 Homebrew 版本（如 ffmpeg@7），以及 Linux 系统目录。 */
async function listOnlyFfmpegLocations({ platform, homedir }: FfmpegEnvironment): Promise<string[]> {
  if (platform === "win32") return [];
  const prefixes = platform === "darwin"
    ? ["/opt/homebrew", "/usr/local"]
    : ["/home/linuxbrew/.linuxbrew", path.posix.join(homedir, ".linuxbrew")];
  const kegs: string[] = [];
  for (const prefix of prefixes) {
    for (const name of await readdir(path.posix.join(prefix, "opt")).catch(() => [] as string[])) {
      if (/^ffmpeg(?:@[\w.]+)?$/.test(name)) kegs.push(path.posix.join(prefix, "opt", name, "bin", "ffmpeg"));
    }
  }
  return platform === "linux" ? [...kegs, "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/snap/bin/ffmpeg"] : kegs;
}

/** 由真实路径判断安装来源，用于选择列表的说明。 */
function packageManagerOf(real: string): string | undefined {
  const normalized = real.replace(/\\/g, "/");
  if (/[/.](?:homebrew|linuxbrew)\//i.test(normalized) || /\/Cellar\//.test(normalized)) return "Homebrew";
  if (normalized.startsWith("/opt/local/")) return "MacPorts";
  if (/\/Microsoft\/WinGet\//i.test(normalized)) return "winget";
  if (/\/scoop\//i.test(normalized)) return "Scoop";
  if (/\/chocolatey\//i.test(normalized)) return "Chocolatey";
  if (normalized.startsWith("/snap/")) return "Snap";
  return undefined;
}

async function findOnPath(names: string[], environment: FfmpegEnvironment): Promise<string | undefined> {
  for (const directory of pathDirectories(environment)) {
    for (const name of names) {
      const candidate = pathApi(environment).join(directory, name);
      if (await isExecutable(candidate, environment.platform)) return candidate;
    }
  }
  return undefined;
}

async function findAllOnPath(name: string, environment: FfmpegEnvironment): Promise<string[]> {
  const found: string[] = [];
  for (const directory of pathDirectories(environment)) {
    const candidate = pathApi(environment).join(directory, name);
    if (await isExecutable(candidate, environment.platform)) found.push(candidate);
  }
  return found;
}

function pathDirectories(environment: FfmpegEnvironment): string[] {
  const value = environment.env.PATH ?? environment.env.Path ?? "";
  return value.split(pathApi(environment).delimiter).map((entry) => entry.replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

function pathApi(environment: FfmpegEnvironment): path.PlatformPath {
  return environment.platform === "win32" ? path.win32 : path.posix;
}

async function firstExecutable(candidates: string[], platform: NodeJS.Platform): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isExecutable(candidate, platform)) return candidate;
  }
  return undefined;
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    // Windows 没有执行位；WindowsApps 里的 App Execution Alias 也无法 stat，只检查存在。
    if (platform === "win32") {
      await access(file, constants.F_OK);
      return true;
    }
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
