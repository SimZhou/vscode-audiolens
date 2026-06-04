<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/AudioLens_logo_v2.png" alt="AudioLens" width="180">
</p>

<p align="center"><strong>AudioLens</strong></p>

<p align="center">
  <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.md">English</a> | 简体中文 | <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.ja.md">日本語</a>
</p>

<p align="center"><em>"很惭愧，做了一点微小的工作。"</em></p>

---

AudioLens 是一个运行在 Visual Studio Code 里的音频查看与分析扩展。它面向语音、音频算法、机器学习和数据标注工作流，让音频文件可以和代码、标签、脚本、测试数据放在同一个工作区里直接检查。

打开音频后，AudioLens 会在只读编辑器中显示播放控制、多通道音轨、波形图、语谱图、选区播放、PCM 参数和常用分析指标。

## 预览

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/Main-Screen-multichannel.zh-CN.png" alt="AudioLens 多通道主界面" width="920">
</p>

## 主要能力

- 支持打开 `wav`、`mp3`、`flac`、`ogg`、`opus`、`m4a`、`aac`、`pcm`、`raw` 文件，以及 Kaldi wav ark 音频条目。
- 单通道和多通道音频都按真实通道逐条显示，交互方式接近 Audacity。
- 每个通道可独立选择波形图、语谱图或波形 + 语谱图的多视图。
- 每个通道都有静音和独奏按钮，播放时会下混到常见的双声道输出。
- 可在顶部工具栏查看 WAV、FLAC、Ogg、MP4/M4A、AAC 和 MP3 的容器或编码头字段。
- 支持显式参数读取原始 PCM，包括采样率、通道数、位深、采样格式、端序和起始偏移。
- 支持把 WAV 文件按 PCM 方式一次性重新读取，适合检查 header 偏移或损坏文件。
- 支持从 `wav.ark:offset` 打开 Kaldi wav ark 音频条目，不读取整份 ark 文件。
- 支持对选区做时域和频域分析。
- 保存常用偏好，包括语谱图参数、播放增益、默认音轨视图和 PCM 默认参数。
- 支持本地 VS Code 和 Remote SSH 工作区。

## 功能演示

### 多通道音轨与多视图

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/1.multi-channel_tracks_and_multi-view.zh-CN.gif" alt="多通道音轨与多视图演示" width="920">
</p>

### 选区播放与分析

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/2.selection_playback_and_analysis.zh-CN.gif" alt="选区播放与分析演示" width="920">
</p>

### PCM / RAW 参数化读取

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/3.pcm_raw_parameterized_loading.zh-CN.gif" alt="PCM 和 RAW 参数化读取演示" width="920">
</p>

## 支持的文件

AudioLens 对常见编码格式优先使用 Webview 的浏览器解码能力，同时通过扩展宿主读取 VS Code 工作区里的文件。

| 类型 | 扩展名 | 说明 |
| --- | --- | --- |
| WAV | `.wav` | 支持多通道 WAV、按顺序查看 RIFF chunk、检查是否为标准 44 字节 PCM 头，也支持一次性按原始 PCM 重新读取。 |
| Kaldi wav ark | 例如 `wav.ark:23252` 的 `.ark` 条目 | 使用 `AudioLens: Open Kaldi WAV Ark Entry` 命令，或直接打开 `.ark` 文件后输入 offset。AudioLens 会校验 offset 处必须是 `RIFF/WAVE`，并只读取对应 WAV entry。 |
| 编码音频 | `.mp3`、`.flac`、`.ogg`、`.opus`、`.m4a`、`.aac` | 优先使用 VS Code Webview 解码；可查看关键容器或帧头字段，如果 Webview 不支持且宿主机器可用 FFmpeg，则走 FFmpeg 兜底转码。 |
| 原始 PCM | `.pcm`、`.raw` | 读取前需要用户显式填写 PCM 参数。 |

## 多通道工作流

多通道音频会按真实通道显示为多条音轨。每条音轨左侧是紧凑的控制区，右侧是主要观察区域。

- `静音` 会让当前通道不参与播放。
- `独奏` 会只播放当前通道，并让其他通道静音。
- 视图选择器可以把单个通道切换为波形图、语谱图或多视图。
- 点击某条音轨会把它设为选区分析的激活通道。

所有通道使用统一的波形颜色，避免因为选中状态影响多通道对比。相邻音轨采用共享边框的紧凑布局，选中的音轨会保留圆角焦点框，方便定位。

## PCM 工作流

对于 `.pcm` 和 `.raw` 文件，AudioLens 会先要求填写 PCM 参数：

- 采样率
- 通道数
- 位深
- 整数或浮点采样格式
- Little-endian 或 Big-endian
- 起始偏移字节数

当前 PCM 参数可以保存为默认值，后续打开 PCM 文件时继续使用。AudioLens 不会从文件名或目录名推断 PCM 参数，因为原始 PCM 本身不包含可靠元数据。

WAV 文件也可以从顶部菜单按 PCM 方式重新读取。这个操作只针对当前文件生效，适合检查原始 payload、非标准 header 或对偏移敏感的测试文件。

## Kaldi WAV Ark 工作流

从 Command Palette 运行 `AudioLens: Open Kaldi WAV Ark Entry`，输入 `wav.ark:offset` 位置即可打开。如果直接打开 `.ark` 文件，AudioLens 会先要求输入 offset。

AudioLens 只支持 payload 以 WAV `RIFF/WAVE` 头开始的 ark 条目。它会根据 WAV 头长度读取被选中的 entry，不会扫描或加载整份 ark 文件。

## 文件头信息

点击顶部工具栏的文件图标，可以在 VS Code 内直接查看结构化的文件头字段。AudioLens 会按文件中的出现顺序列出字段；chunk 类格式使用字节偏移，ADTS AAC、MPEG 音频帧这类紧凑头则显示 bit range。

对于 WAV 文件，面板会标出它是否为标准 44 字节 PCM 头，或是否包含 `fmt` 扩展、`LIST` 元数据等额外 chunk。音频 payload 行只标识数据区域，不展开原始采样字节。

## 选区分析

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

## 语谱图控制

AudioLens 提供适合语音和信号检查的语谱图参数：

- 算法：Frequency、Reassignment、Pitch (EAC)
- FFT 大小：`8` 到 `32768`
- 窗函数：Rectangular、Bartlett、Hamming、Hann、Blackman、Blackman-Harris、Welch 和 Gaussian 变体
- 零填充倍数：`1` 到 `128`
- 频率刻度：Linear、Log、Mel、Bark、ERB
- 配色：Rose、Classic、Grayscale、Inverse Grayscale
- 可配置 dB 亮度范围和自动亮度

耗时的语谱图分析运行在 Worker 边界之后，避免阻塞 Webview 主交互。

## 快捷键

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

## 本地化

AudioLens 默认跟随 VS Code 显示语言。也可以通过 `audiolens.language` 设置或 Command Palette 中的 `AudioLens: 切换语言` 手动切换 Webview 语言。

支持语言：

简体中文、繁体中文、英语、日语、韩语、法语、德语、俄语、西班牙语、意大利语、葡萄牙语、印尼语、挪威语、荷兰语、波兰语、土耳其语和越南语。

新增界面文案会在对应语种未补齐前回退到英语。

## Remote SSH

AudioLens 是 workspace extension。在 Remote SSH 窗口中，扩展宿主运行在远端工作区，直接读取远端音频文件，并把数据传给本地 Webview 播放和可视化。

如果需要保存当前远端音频，可以使用顶部工具栏的下载按钮。VS Code 的保存对话框可能会先显示远端位置；要保存到本机时，在对话框里切换到本地位置即可。

## 隐私

AudioLens 不会把音频上传到任何第三方服务。音频内容由 VS Code 扩展宿主读取，并在 VS Code Webview 和 Worker 运行时中完成分析。

## 安装

从 Visual Studio Marketplace 安装：

https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens

也可以从 Open VSX 安装：

https://open-vsx.org/extension/simzhou/audiolens

或使用命令行安装：

```bash
code --install-extension simzhou.audiolens
```

## 从 VSIX 安装

可以从 GitHub Releases 下载打包好的 VSIX，或安装本地打包版本：

```bash
code --install-extension dist/audiolens-1.2.0.vsix
```

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

如果 AudioLens 对你的语音、音频或数据标注工作有帮助，欢迎支持这个项目的持续维护。

### Ko-fi

在 Ko-fi 支持 AudioLens: https://ko-fi.com/simzhou

### 微信赞赏

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/wechat_support.jpeg" alt="微信赞赏码" width="240">
</p>

## 版权

Copyright (c) 2026 SimZhou. All rights reserved.
