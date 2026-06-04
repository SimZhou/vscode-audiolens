<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/AudioLens_logo_v2.png" alt="AudioLens" width="180">
</p>

<p align="center"><strong>AudioLens</strong></p>

<p align="center">
  English | <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.zh-CN.md">简体中文</a> | <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.ja.md">日本語</a>
</p>

<p align="center"><em>"I am ashamed to say that I have done only a tiny bit of work."</em></p>

---

AudioLens is an audio inspection extension for Visual Studio Code. It is built for speech, audio, and machine learning work where audio files should stay next to the code, labels, scripts, and test data that explain them.

Open an audio file and AudioLens shows playback, multi-channel tracks, waveforms, spectrograms, selection playback, PCM controls, and practical analysis metrics inside a read-only VS Code editor.

## Preview

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/Main-Screen-multichannel.en-US.png" alt="AudioLens multi-channel main screen" width="920">
</p>

## Highlights

- Opens `wav`, `mp3`, `flac`, `ogg`, `opus`, `m4a`, `aac`, `pcm`, `raw`, and Kaldi wav ark entries.
- Displays mono and multi-channel files as separate Audacity-style tracks.
- Supports waveform, spectrogram, and combined waveform + spectrogram views per channel.
- Provides per-channel mute and solo controls with stereo downmix playback.
- Shows container and codec header fields for WAV, FLAC, Ogg, MP4/M4A, AAC, and MP3 in a top-bar inspector.
- Reads raw PCM files with explicit sample rate, channel count, bit depth, sample format, byte order, and start offset.
- Lets WAV files be reopened as raw PCM for header-offset or damaged-file inspection.
- Opens Kaldi wav ark entries from `wav.ark:offset` without loading the whole ark file.
- Analyzes selected regions with time-domain and frequency-domain metrics.
- Keeps preferences such as spectrogram settings, playback gain, default track view, and PCM defaults.
- Works in local VS Code windows and Remote SSH workspaces.

## Feature Demos

### Multi-Channel Tracks and Multi-View

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/1.multi-channel_tracks_and_multi-view.en-US.gif" alt="Multi-channel tracks and multi-view demo" width="920">
</p>

### Selection Playback and Analysis

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/2.selection_playback_and_analysis.en-US.gif" alt="Selection playback and analysis demo" width="920">
</p>

### PCM / RAW Parameterized Loading

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/3.pcm_raw_parameterized_loading.en-US.gif" alt="PCM and RAW parameterized loading demo" width="920">
</p>

## Supported Files

AudioLens uses the browser audio stack for common encoded formats and extension-host file reads for VS Code workspace compatibility.

| Type | Extensions | Notes |
| --- | --- | --- |
| WAV | `.wav` | Supports multi-channel WAV files, ordered RIFF chunk inspection, standard 44-byte PCM header checks, and optional one-time raw PCM reread. |
| Kaldi wav ark | `.ark` entries such as `wav.ark:23252` | Use `AudioLens: Open Kaldi WAV Ark Entry` or open an `.ark` file and enter an offset. AudioLens validates `RIFF/WAVE` at the offset and reads only that WAV entry. |
| Encoded audio | `.mp3`, `.flac`, `.ogg`, `.opus`, `.m4a`, `.aac` | Uses the VS Code Webview decoder first. Header inspection shows key container or frame fields, and extension-host FFmpeg is used as a fallback when available. |
| Raw PCM | `.pcm`, `.raw` | Requires explicit PCM parameters before reading. |

## Multi-Channel Workflow

Multi-channel files are shown as separate channel tracks. Each track has a compact left control strip and a full-width analysis area.

- `Mute` disables playback for that channel.
- `Solo` plays that channel and silences the other channels.
- The track view selector switches a channel between waveform, spectrogram, and combined view.
- Selecting a track makes it the active channel for selection analysis.

The waveform color is consistent across channels so the selected channel does not visually distort track comparison. Adjacent tracks are drawn as a compact stack with shared borders, while the selected track keeps a rounded focus outline for quick orientation.

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

## Kaldi WAV Ark Workflow

Run `AudioLens: Open Kaldi WAV Ark Entry` from the Command Palette and enter a `wav.ark:offset` location. If you open an `.ark` file directly, AudioLens asks for the offset before reading.

AudioLens only supports ark entries whose payload starts with a WAV `RIFF/WAVE` header. It uses the WAV header size to read the selected entry and does not scan or load the whole ark file.

## Header Inspector

Use the document icon in the top bar to inspect structured header fields without leaving VS Code. AudioLens lists fields in file order and uses byte offsets for chunk-based formats, or bit ranges for packed headers such as ADTS AAC and MPEG audio frames.

For WAV files, the inspector highlights whether the file uses the standard 44-byte PCM header or contains extended chunks such as `fmt` extensions and `LIST` metadata. Audio payload rows identify the data region without dumping raw sample bytes.

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

AudioLens follows the VS Code display language by default. You can override the Webview language with the `audiolens.language` setting or by running `AudioLens: Switch Language` from the Command Palette.

Supported languages:

Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Russian, Spanish, Italian, Portuguese, Indonesian, Norwegian, Dutch, Polish, Turkish, and Vietnamese.

New interface strings fall back to English until a locale has a complete translation.

## Remote SSH

AudioLens is declared as a workspace extension. In a Remote SSH window, the extension host runs in the remote workspace, reads audio files from the remote file system, and streams the data to the local Webview for playback and visualization.

Use the top-bar download button when you want to save the current remote audio file. VS Code may open the save dialog on the remote side first; choose the local location option in that dialog when saving to your machine.

## Privacy

AudioLens does not upload audio files to any third-party service. Audio content is read by the VS Code extension host and analyzed inside the VS Code Webview and worker runtime.

## Install

Install from the Visual Studio Marketplace:

https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens

Or from Open VSX:

https://open-vsx.org/extension/simzhou/audiolens

Or install from the command line:

```bash
code --install-extension simzhou.audiolens
```

## Install From VSIX

Download the packaged VSIX from GitHub Releases, or install a local packaged build with:

```bash
code --install-extension dist/audiolens-1.2.0.vsix
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

### Ko-fi

Support AudioLens on Ko-fi: https://ko-fi.com/simzhou

### WeChat

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/wechat_support.jpeg" alt="WeChat appreciation code" width="240">
</p>

## Copyright

Copyright (c) 2026 SimZhou. All rights reserved.
