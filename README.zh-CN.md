<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/AudioLens_logo_v2.png" alt="AudioLens" width="180">
</p>

<h1 align="center">AudioLens</h1>

<p align="center">
  <strong>在 VS Code 中面向语音、机器学习和信号工程工作流的音频查看与分析工具。</strong>
</p>

<p align="center">
  <a href="#feature-multichannel">波形图</a> ·
  <a href="#feature-multichannel">语谱图</a> ·
  <a href="#feature-multichannel">多通道音轨</a> ·
  <a href="#feature-selection">选区分析</a> ·
  <a href="#feature-pcm-raw">Raw PCM</a> ·
  <a href="#feature-kaldi-ark">Kaldi WAV Ark</a> ·
  <a href="#remote-ssh">Remote SSH</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens"><img src="https://vsmarketplacebadges.dev/version-short/simzhou.audiolens.svg" alt="VS Code Marketplace 版本"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens"><img src="https://vsmarketplacebadges.dev/installs-short/simzhou.audiolens.svg" alt="VS Code Marketplace 安装量"></a>
  <a href="https://open-vsx.org/extension/simzhou/audiolens"><img src="https://img.shields.io/open-vsx/v/simzhou/audiolens?label=Open%20VSX" alt="Open VSX 版本"></a>
  <a href="https://open-vsx.org/extension/simzhou/audiolens"><img src="https://img.shields.io/open-vsx/dt/simzhou/audiolens?label=Open%20VSX%20downloads" alt="Open VSX 下载量"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache 2.0 License"></a>
</p>

<p align="center">
  <a href="#feature-multichannel"><img src="https://img.shields.io/badge/多通道-音轨-2ea44f" alt="多通道音轨"></a>
  <a href="#feature-selection"><img src="https://img.shields.io/badge/语谱图-分析-7c3aed" alt="语谱图分析"></a>
  <a href="#feature-pcm-raw"><img src="https://img.shields.io/badge/Raw%20PCM-支持-f97316" alt="支持 Raw PCM"></a>
  <a href="#feature-kaldi-ark"><img src="https://img.shields.io/badge/Kaldi%20WAV%20Ark-支持-0ea5e9" alt="支持 Kaldi WAV Ark"></a>
  <a href="#remote-ssh"><img src="https://img.shields.io/badge/Remote%20SSH-支持-2563eb" alt="支持 Remote SSH"></a>
</p>

<p align="center">
  <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.md">English</a> | 简体中文 | <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.ja.md">日本語</a>
</p>

AudioLens 可以把 VS Code 变成实用的音频查看器，适合音频工程师、语音算法工程师和机器学习从业者使用。你可以在 manifest、转写文本、日志、脚本和模型输出旁边，直接打开常见音频文件、Raw PCM 数据或 Kaldi WAV Ark 条目。

它关注通用音频播放器容易缺失的日常工程工作流：查看波形图和语谱图、检查多通道音频、从文本中打开音频路径、用明确参数解码 Raw PCM、查看文件头信息，以及在不离开工作区的情况下分析选中的音频片段。

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens"><strong>从 VS Code Marketplace 安装</strong></a>
  ·
  <a href="https://open-vsx.org/extension/simzhou/audiolens"><strong>从 Open VSX 安装</strong></a>
  ·
  <a href="https://github.com/SimZhou/vscode-audiolens/releases"><strong>下载 VSIX</strong></a>
</p>

## 预览

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/Main-Screen-multichannel.zh-CN.png" alt="AudioLens 多通道主界面" width="920">
</p>

## 为什么选择 AudioLens

| 工作流 | AudioLens 能提供什么 |
| --- | --- |
| 语音和机器学习数据集 | 在 manifest、转写文本、日志、训练脚本和模型输出旁边直接查看音频。 |
| 多通道音频 | Audacity 风格的多通道音轨、每通道波形图/语谱图视图、静音、独奏和立体声 downmix 播放。 |
| 音频分析 | 拖拽选区后只播放选中片段，并查看 RMS、峰值、削波、主频、频谱质心、过零率和频段能量等指标。 |
| Raw 数据调试 | 用明确的采样率、通道数、编码、字节序和字节偏移打开 `.pcm` / `.raw`。也可以把 WAV payload 按 PCM 重新读取，用于检查损坏或非标准文件。 |
| Kaldi 工作流 | 打开 `wav.ark:offset` 条目，或打开 Ark 文件后手动输入偏移量，不需要加载整份 archive。 |
| 远程开发 | 作为 workspace extension 运行，因此 Remote SSH 工作区可以直接预览和分析远端音频，不必先复制数据集。 |

## 核心功能

| 方向 | 功能 |
| --- | --- |
| 播放 | 打开后即可用 `Space` 播放/暂停，支持 seek、选区播放、播放增益、每通道静音和独奏。 |
| 可视化 | 波形图、语谱图、组合视图、共享时间轴、可配置音轨高度、缩放、平移和重置。 |
| 语谱图分析 | Frequency、Reassignment、Pitch (EAC) 算法；FFT 最大 `32768`；多种窗函数、频率刻度、配色和自动亮度。 |
| 文件检查 | 结构化查看 WAV/RIFF、FLAC、Ogg、MP4/M4A、AAC/ADTS 和 MP3/MPEG 帧头信息。 |
| 数据集导航 | 在普通文本文件里通过 hover、状态栏和命令打开音频路径，不为大文件生成成千上万个正文链接。 |
| 偏好保存 | 保存默认音轨视图、语谱图设置、播放增益、PCM 默认参数和界面语言。 |

## 安装

**推荐：从 Visual Studio Marketplace 安装**

https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens

**备选：从 Open VSX 安装**

https://open-vsx.org/extension/simzhou/audiolens

**命令行**

```bash
code --install-extension simzhou.audiolens
```

**离线 VSIX**

```bash
code --install-extension dist/audiolens-1.4.4.vsix
```

## 功能演示

<a id="feature-multichannel" name="feature-multichannel"></a>

### 1. 多通道音轨与多视图

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/1.multi-channel_tracks_and_multi-view.zh-CN.gif" alt="多通道音轨与多视图演示" width="920">
</p>

<a id="feature-selection" name="feature-selection"></a>

### 2. 选区播放与分析

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/2.selection_playback_and_analysis.zh-CN.gif" alt="选区播放与分析演示" width="920">
</p>

<a id="feature-pcm-raw" name="feature-pcm-raw"></a>

### 3. 打开 PCM / RAW 文件

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/3.pcm_raw_parameterized_loading.zh-CN.gif" alt="PCM 和 RAW 参数化读取演示" width="920">
</p>

### 4. 一键查看音频头信息

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/4.Inspect_Audio_Headers_in_One_Click.zh-CN.gif" alt="音频头信息查看演示" width="920">
</p>

### 5. 从任意文件中打开音频路径

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/5.open_audio_paths_from_any_file.zh-CN.gif" alt="从任意文件中打开音频路径演示" width="920">
</p>

<a id="feature-kaldi-ark" name="feature-kaldi-ark"></a>

### 6. 直接打开 Kaldi WAV Ark

- 方法 1：Ctrl + 单击 `wav.ark:offset` 路径。需要配合 Kaldi Reader 使用：[GitHub](https://github.com/SimZhou/vscode-kaldi-reader)、[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=simzhou.kaldi-reader)、[Open VSX](https://open-vsx.org/extension/simzhou/kaldi-reader)。
- 方法 2：打开 `.ark` 文件后手动输入偏移量。无需安装其他插件。

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/6.open_kaldi_wav_ark_directly.zh-CN.gif" alt="直接打开 Kaldi WAV Ark 演示" width="920">
</p>

## 支持的文件

AudioLens 会优先使用 Webview 的浏览器解码能力处理常见音频格式，同时通过扩展宿主读取 VS Code 工作区里的文件。

| 类型 | 扩展名 | 说明 |
| --- | --- | --- |
| WAV | `.wav` | 支持多通道 WAV、RIFF chunk 顺序查看、标准 44 字节 PCM 头检查，也支持临时按原始 PCM 重新读取。 |
| Kaldi wav ark | 例如 `wav.ark:23252` 的 `.ark` 条目 | 使用 `AudioLens: Open Kaldi WAV Ark Entry` 命令，或直接打开 `.ark` 文件后输入 offset。AudioLens 会校验 offset 处是否为 `RIFF/WAVE`，并只读取对应的 WAV entry。 |
| 编码音频 | `.mp3`、`.flac`、`.ogg`、`.opus`、`.m4a`、`.aac` | 优先使用 VS Code Webview 解码；可查看关键容器或帧头字段。Webview 不支持且宿主机器可用 FFmpeg 时，会使用 FFmpeg 兜底转码。 |
| 原始 PCM | `.pcm`、`.raw` | 读取前需要用户显式填写 PCM 参数。 |

## 查看多通道音频

多通道音频会按真实通道显示为多条音轨。每条音轨左侧是紧凑的控制区，右侧是主要观察区域。

- `静音` 会让当前通道不参与播放。
- `独奏` 会只播放当前通道，并让其他通道静音。
- 视图选择器可以把单个通道切换为波形图、语谱图或多视图。
- 点击某条音轨会把它设为选区分析的激活通道。

所有通道使用统一的波形颜色，避免因为选中状态影响多通道对比。相邻音轨采用共享边框的紧凑布局，选中的音轨会保留圆角焦点框，方便定位。

## 打开 PCM 文件

对于 `.pcm` 和 `.raw` 文件，AudioLens 会先要求填写 PCM 参数：

- 采样率
- 通道数
- 编码，例如 Signed 16-bit PCM、Unsigned 8-bit PCM、32-bit float 或 64-bit float
- 字节序；8-bit 编码会自动使用无字节序设置
- 起始偏移字节数

当前 PCM 参数可以保存为默认值，后续打开 PCM 文件时继续使用。AudioLens 不会从文件名或目录名猜测 PCM 参数，因为原始 PCM 本身不包含可靠元数据。

WAV 文件也可以从顶部菜单按 PCM 方式重新读取。这个操作只针对当前文件生效，适合检查原始音频数据、非标准 header 或对偏移敏感的测试文件。

## 打开 Kaldi WAV Ark 文件

从 Command Palette 运行 `AudioLens: Open Kaldi WAV Ark Entry`，输入 `wav.ark:offset` 位置即可打开。如果直接打开 `.ark` 文件，AudioLens 会先要求输入 offset。

AudioLens 只支持音频内容以 WAV `RIFF/WAVE` 头开始的 ark 条目。它会根据 WAV 头长度读取被选中的 entry，不会扫描或加载整份 ark 文件。

## 从任何文件中直接打开音频地址

AudioLens 可以识别普通文本文件中的音频地址，并直接用 AudioLens 编辑器打开。将鼠标悬停在音频路径上后点击 **在 AudioLens 中打开**，或把光标放到路径上使用状态栏入口 / `AudioLens: 打开光标处音频路径`。它支持绝对路径，也支持基于当前文本文件目录、workspace 目录和可选 base directory 解析的相对路径。

可以从 Command Palette 运行 `AudioLens: 开启/关闭“在 AudioLens 中打开”` 开启或关闭这个功能。该功能默认开启，不再为整份文档批量生成正文超链，因此大 JSON、日志和数据集文件也能保持流畅。

Kaldi `*.ark:offset` 链接会刻意留给 Kaldi Reader 处理。

## 查看文件头信息

点击顶部工具栏的文件图标，可以在 VS Code 内直接查看结构化的文件头字段。AudioLens 会按文件中的出现顺序列出字段；chunk 类格式使用字节偏移，ADTS AAC、MPEG 音频帧这类紧凑头则显示 bit range。

对于 WAV 文件，面板会标出它是否为标准 44 字节 PCM 头，或是否包含 `fmt` 扩展、`LIST` 元数据等额外 chunk。音频 payload 行只标识数据区域，不展开原始采样字节。

## 分析选中的片段

在任意波形图或语谱图上拖拽即可创建时间选区。AudioLens 可以只播放选区，并针对激活通道计算分析指标。

当前指标包括：

- 起始时间、结束时间和选区时长
- RMS 电平和峰值电平
- 主频
- 峰均比
- 削波比例
- 噪声底估计
- 频谱质心
- 过零率
- 频段能量分布

每个指标旁边都有 Tooltip，说明计算方式、用途和局限。

## 调整语谱图

AudioLens 提供适合语音和信号检查的语谱图参数：

- 算法：Frequency、Reassignment、Pitch (EAC)
- FFT 大小：`8` 到 `32768`
- 窗函数：Rectangular、Bartlett、Hamming、Hann、Blackman、Blackman-Harris、Welch 和 Gaussian 变体
- 零填充倍数：`1` 到 `128`
- 频率刻度：Linear、Log、Mel、Bark、ERB
- 可配置仅影响显示的频率范围，也可以让最大值跟随 Nyquist
- 配色：Rose、Classic、Grayscale、Inverse Grayscale
- 可配置 dB 亮度范围和自动亮度

右上角设置菜单会把这些频谱图控制项集中在当前视图旁边，包括仅影响显示的频率范围，以及最大频率跟随 Nyquist 的模式。

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/config_menu.zh-CN.png" alt="AudioLens 频谱图设置菜单" width="260">
</p>

耗时的语谱图分析会放到 Worker 后台执行，避免阻塞 Webview 主交互。

## 快捷键

打开音频后，当前激活的语谱图或波形图会直接进入键盘可用状态，因此按 `Space` 可以立即播放或暂停。

| 操作 | 快捷键 |
| --- | --- |
| 播放或暂停 | `Space` |
| 清除选区或播放游标 | `Esc` |
| 重置时间缩放 | `Ctrl` / `Command` + `F` |
| macOS 时间缩放 | `Command` + 鼠标滚轮 |
| Windows/Linux 时间缩放 | `Ctrl` + 鼠标滚轮 |
| 平移可见时间范围 | `Shift` + 鼠标滚轮 |
| macOS 幅值缩放 | `Option` + 鼠标滚轮 |
| Windows/Linux 幅值缩放 | `Alt` + 鼠标滚轮 |
| 重置播放增益 | 双击增益滑块 |

## 界面语言

AudioLens 默认跟随 VS Code 显示语言。也可以通过 `audiolens.language` 设置或 Command Palette 中的 `AudioLens: 切换语言` 手动切换 Webview 语言。

支持语言：

简体中文、繁体中文、英语、日语、韩语、法语、德语、俄语、西班牙语、意大利语、葡萄牙语、印尼语、挪威语、荷兰语、波兰语、土耳其语和越南语。

新增界面文案会在对应语种未补齐前回退到英语。

<a id="remote-ssh" name="remote-ssh"></a>

## 在 Remote SSH 中使用

AudioLens 是 workspace extension。在 Remote SSH 窗口中，扩展宿主运行在远端工作区，直接读取远端音频文件，并把数据传给本地 Webview 播放和可视化。

如果需要保存当前远端音频，可以使用顶部工具栏的下载按钮。VS Code 的保存对话框可能会先显示远端位置；要保存到本机时，在对话框里切换到本地位置即可。

## 隐私

AudioLens 不会把音频上传到任何第三方服务。音频内容由 VS Code 扩展宿主读取，并在 VS Code Webview 和 Worker 运行时中完成分析。

## 开发

```bash
npm install
npm run build
npm run typecheck
npm run rust:test
npm run package
```

在 VS Code 中按 `F5`，选择 AudioLens 扩展调试配置，然后在 Extension Development Host 中打开支持的音频文件。

## 作者

SimZhou: https://simzhou.com/about/

## 支持 AudioLens

如果 AudioLens 对你的语音、音频或信号工程工作有帮助，欢迎支持这个项目的持续维护。

### Ko-fi

在 Ko-fi 支持 AudioLens: https://ko-fi.com/simzhou

### 微信赞赏

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/wechat_support.jpeg" alt="微信赞赏码" width="240">
</p>

## 许可证

Copyright (c) 2026 SimZhou.

Licensed under the Apache License, Version 2.0.
