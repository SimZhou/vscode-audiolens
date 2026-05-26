# AudioLens

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/AudioLens_logo_v2.png" alt="AudioLens" width="360">
</p>

AudioLens is an audio inspection extension for Visual Studio Code. It is built for speech, audio, and machine learning work where the audio file should stay next to the code, labels, scripts, and test data that explain it.

Open an audio file and AudioLens shows playback, waveform tracks, spectrograms, selection playback, PCM controls, and practical analysis metrics inside a read-only VS Code editor.

## What AudioLens Does

- Opens `wav`, `mp3`, `flac`, `ogg`, `opus`, `m4a`, `aac`, `pcm`, and `raw` files.
- Displays mono and multi-channel files as separate tracks, with Audacity-style track controls.
- Shows waveform, spectrogram, or combined waveform + spectrogram views per channel.
- Supports playback, seeking, selection playback, time zoom, time panning, and amplitude zoom.
- Provides mute and solo controls for each channel.
- Reads raw PCM files with explicit sample rate, channel count, bit depth, sample format, byte order, and start offset.
- Lets WAV files be reopened as raw PCM for header-offset or damaged-file inspection.
- Analyzes selected regions with time-domain and frequency-domain metrics.
- Keeps common preferences such as spectrogram settings, playback gain, default track view, and PCM defaults.
- Works in local VS Code windows and Remote SSH workspaces.

## 1.0.0 Highlights

Version 1.0.0 is the first full AudioLens release. The main editor has been rebuilt around multi-channel audio, PCM workflows, and clearer analysis tools.

- Multi-channel track view: each real channel is shown as its own track. There are no synthetic mix or waveform-only channels.
- Per-track display mode: each channel can use waveform, spectrogram, or combined view, and the default view can be changed from Settings.
- Track controls: mute and solo controls are available per channel, with clearer active states and correct solo/mute playback behavior.
- Shared timeline: all tracks use one top time ruler with adaptive ticks that become denser while zooming.
- Playback cursor tracking: the visible range follows playback when the cursor moves beyond the current viewport.
- Selection rendering: selections are shown consistently across waveform and spectrogram views, with a start-position cursor while dragging.
- PCM file support: `.pcm` and `.raw` files can be opened with user-specified parameters and saved defaults.
- WAV as PCM: WAV files can be reopened once as raw PCM with a separate parameter panel and start offset control.
- Analysis panel: selection analysis now appears as a translucent overlay instead of occupying permanent left-side space.
- More metrics: selection analysis includes duration, RMS level, peak level, dominant frequency, crest factor, clipping ratio, noise floor, spectral centroid, zero-crossing rate, and frequency-band distribution.
- Metric tooltips: analysis metrics explain their purpose, limitations, calculation method, and references.
- Frequency analysis update: band energy is calculated across the selected region instead of using only a single frame near the center.
- Spectrogram polish: frequency axes, color consistency, redraw behavior, and viewport panning have been improved.
- Gain control: playback gain is available in the top bar with a stable layout and reset tooltip.
- Localization cleanup: the Webview now falls back to English for newly added strings when a locale is not fully translated.
- Packaging cleanup: the public package contains the compiled extension, public documentation, license, and assets only.

## Supported Files

AudioLens uses the browser audio stack for common encoded formats and extension-host file reads for VS Code workspace compatibility.

| Type | Extensions | Notes |
| --- | --- | --- |
| WAV | `.wav` | Supports multi-channel WAV files and optional one-time raw PCM reread. |
| Encoded audio | `.mp3`, `.flac`, `.ogg`, `.opus`, `.m4a`, `.aac` | Uses the VS Code Webview decoder first; when available, extension-host FFmpeg is used as a fallback for formats the Webview cannot decode. |
| Raw PCM | `.pcm`, `.raw` | Requires explicit PCM parameters before reading. |

## Multi-Channel Workflow

Multi-channel files are shown as separate channel tracks. Each track has a compact left control strip and a full-width analysis area.

- `Mute` disables playback for that channel.
- `Solo` plays that channel and silences the other channels.
- The track view selector switches a channel between waveform, spectrogram, and combined view.
- Selecting a track makes it the active channel for selection analysis.

The waveform color is consistent across channels so the selected channel does not visually distort the track comparison.

Adjacent tracks are drawn as a compact stack with shared borders, while the selected track keeps a rounded focus outline for quick orientation.

## PCM Workflow

For `.pcm` and `.raw` files, AudioLens asks for PCM parameters before decoding:

- sample rate
- channel count
- bit depth
- integer or float sample format
- little-endian or big-endian byte order
- start offset in bytes

The current PCM parameters can be saved as defaults for later PCM files. AudioLens does not guess raw PCM parameters from the file name, because raw PCM does not contain reliable metadata.

WAV files can also be reopened as PCM from the top bar. This is a one-time operation for the current file and is useful when inspecting raw payloads, non-standard headers, or offset-sensitive test files.

## Selection Analysis

Drag across any waveform or spectrogram to create a time selection. AudioLens can play the selected range and calculate metrics for the active channel.

Current analysis includes:

- start time, end time, and duration
- RMS level and peak level
- dominant frequency
- crest factor
- clipping ratio
- noise floor estimate
- spectral centroid
- zero-crossing rate
- frequency-band distribution

Tooltips next to the metrics describe how each value is calculated and when it is useful.

## Spectrogram Controls

AudioLens includes practical spectrogram controls for speech and signal inspection:

- algorithms: Frequency, Reassignment, Pitch (EAC)
- FFT sizes from `8` to `32768`
- window functions: Rectangular, Bartlett, Hamming, Hann, Blackman, Blackman-Harris, Welch, and Gaussian variants
- zero padding factors from `1` to `128`
- frequency scales: Linear, Log, Mel, Bark, ERB
- palettes: Rose, Classic, Grayscale, Inverse Grayscale
- configurable dB brightness range and auto brightness

Spectrogram work runs behind a worker boundary so expensive analysis does not block the Webview interaction path.

## Controls

| Action | Shortcut |
| --- | --- |
| Play or pause | `Space` |
| Clear selection or playback cursor | `Esc` |
| Reset time zoom | `Ctrl` / `Command` + `F` |
| Time zoom on macOS | `Command` + mouse wheel |
| Time zoom on Windows/Linux | `Ctrl` + mouse wheel |
| Pan visible time range | `Shift` + mouse wheel |
| Zoom waveform amplitude on macOS | `Option` + mouse wheel |
| Zoom waveform amplitude on Windows/Linux | `Alt` + mouse wheel |
| Reset playback gain | Double-click the gain slider |

## Localization

AudioLens follows the VS Code display language by default. You can override the Webview language with the `audiolens.language` setting or by running `AudioLens: 切换语言` from the Command Palette.

Supported languages:

Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Russian, Spanish, Italian, Portuguese, Indonesian, Norwegian, Dutch, Polish, Turkish, and Vietnamese.

New interface strings fall back to English until a locale has a complete translation.

## Remote SSH

AudioLens is declared as a workspace extension. In a Remote SSH window, the extension host runs in the remote workspace, reads audio files from the remote file system, and streams the data to the local Webview for playback and visualization.

This keeps remote speech and audio datasets inspectable without downloading files manually.

## Privacy

AudioLens does not upload audio files to any third-party service. Audio content is read by the VS Code extension host and analyzed inside the VS Code Webview and worker runtime.

## Install

Install from the Visual Studio Marketplace:

https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens

Or install from the command line:

```bash
code --install-extension simzhou.audiolens
```

## Install From VSIX

For local testing, install a packaged build with:

```bash
code --install-extension dist/audiolens-1.0.6.vsix
```

## Development

```bash
npm install
npm run build
npm run typecheck
npm run rust:test
npm run package
```

Press `F5` in VS Code and choose the AudioLens extension launch configuration. Then open a supported audio file in the Extension Development Host.

## Author

SimZhou: https://simzhou.com/en/about/

## Support AudioLens

If AudioLens helps with your speech, audio, or data annotation workflow, you are welcome to support its ongoing development.

Your support helps with feature work, compatibility testing, and long-term maintenance. Thank you for the encouragement.

如果 AudioLens 对你的语音、音频或数据标注工作有帮助，欢迎通过赞赏支持这个项目的持续维护。

你的支持会用于后续功能开发、兼容性测试和长期维护。感谢每一份鼓励。

<p align="center">
  <a href="https://ko-fi.com/simzhou">Support AudioLens on Ko-fi</a>
</p>

<p align="center">
  <img src="logo/wechat_support.jpeg" alt="WeChat appreciation code" width="240">
</p>

## Copyright

Copyright (c) 2026 SimZhou. All rights reserved.
