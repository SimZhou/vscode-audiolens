<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/AudioLens_logo_v2.png" alt="AudioLens" width="180">
</p>

<h1 align="center">AudioLens</h1>

<p align="center">
  English | <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.zh-CN.md">简体中文</a> | <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.ja.md">日本語</a>
</p>

AudioLens is an audio viewer and analysis extension for Visual Studio Code. It is built for speech datasets, audio annotation, machine learning, signal inspection, and data workflows where audio files should stay next to the code, labels, scripts, and test data that explain them.

Open `wav`, `mp3`, `flac`, `ogg`, `opus`, `m4a`, `aac`, raw `pcm` / `raw`, or Kaldi `wav.ark:offset` audio and AudioLens shows playback, multi-channel tracks, waveforms, spectrograms, selection playback, PCM settings, file header details, and practical analysis metrics inside a read-only VS Code editor. It works in local workspaces and Remote SSH windows.

## Common Workflows

- Inspect speech and audio datasets directly inside VS Code.
- Review waveform and spectrogram details while editing labels, manifests, logs, and scripts.
- Open audio paths from text files without switching tools.
- Analyze selected regions for RMS, peak level, clipping, dominant frequency, spectral centroid, and other metrics.
- Open raw PCM files and Kaldi wav ark entries without downloading or converting the whole dataset first.

## Preview

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/Main-Screen-multichannel.en-US.png" alt="AudioLens multi-channel main screen" width="920">
</p>

## Highlights

- Opens `wav`, `mp3`, `flac`, `ogg`, `opus`, `m4a`, `aac`, `pcm`, `raw`, and Kaldi wav ark entries.
- Opens audio paths directly from code, label files, logs, and other plain text files.
- Displays mono and multi-channel files as separate Audacity-style tracks.
- Supports waveform, spectrogram, and combined waveform + spectrogram views per channel.
- Provides per-channel mute and solo controls, with playback mixed down to regular stereo output.
- Shows file header details for WAV, FLAC, Ogg, MP4/M4A, AAC, and MP3 in a top-bar inspector.
- Opens PCM/RAW files after you enter sample rate, channel count, encoding, byte order, and start offset.
- Lets WAV files be reopened as PCM for header-offset or damaged-file inspection.
- Opens Kaldi wav ark entries from `wav.ark:offset` without loading the whole ark file.
- Analyzes selected regions with time-domain and frequency-domain metrics.
- Keeps preferences such as spectrogram settings, playback gain, default track view, and PCM defaults.
- Works in local VS Code windows and Remote SSH workspaces.

## Install

Install from the Visual Studio Marketplace:

https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens

Or from Open VSX:

https://open-vsx.org/extension/simzhou/audiolens

Or install from the command line:

```bash
code --install-extension simzhou.audiolens
```

For offline installation, download a packaged VSIX from GitHub Releases or install a local packaged build:

```bash
code --install-extension dist/audiolens-1.3.6.vsix
```

## Feature Demos

### 1. Multi-Channel Tracks and Multi-View

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/1.multi-channel_tracks_and_multi-view.en-US.gif" alt="Multi-channel tracks and multi-view demo" width="920">
</p>

### 2. Selection Playback and Analysis

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/2.selection_playback_and_analysis.en-US.gif" alt="Selection playback and analysis demo" width="920">
</p>

### 3. Open PCM / RAW Files

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/3.pcm_raw_parameterized_loading.en-US.gif" alt="PCM and RAW parameterized loading demo" width="920">
</p>

### 4. Inspect Audio Headers in One Click

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/4.Inspect_Audio_Headers_in_One_Click.en-US.gif" alt="Audio header inspection demo" width="920">
</p>

### 5. Open Audio Paths From Any File

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/5.open_audio_paths_from_any_file.en-US.gif" alt="Open audio paths from any file demo" width="920">
</p>

### 6. Open Kaldi WAV Ark Directly

- Method 1: Ctrl-click a `wav.ark:offset` path. Requires Kaldi Reader: [GitHub](https://github.com/SimZhou/vscode-kaldi-reader), [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=simzhou.kaldi-reader), or [Open VSX](https://open-vsx.org/extension/simzhou/kaldi-reader).
- Method 2: Open an `.ark` file and enter the offset manually. No additional extension is required.

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/6.open_kaldi_wav_ark_directly.en-US.gif" alt="Open Kaldi WAV Ark directly demo" width="920">
</p>

## Supported Files

AudioLens uses the browser audio stack for common encoded formats and the extension host to read files from the VS Code workspace.

| Type | Extensions | Notes |
| --- | --- | --- |
| WAV | `.wav` | Supports multi-channel WAV files, ordered RIFF chunk inspection, standard 44-byte PCM header checks, and optional one-time PCM reread. |
| Kaldi wav ark | `.ark` entries such as `wav.ark:23252` | Use `AudioLens: Open Kaldi WAV Ark Entry` or open an `.ark` file and enter an offset. AudioLens validates `RIFF/WAVE` at the offset and reads only that WAV entry. |
| Encoded audio | `.mp3`, `.flac`, `.ogg`, `.opus`, `.m4a`, `.aac` | Uses the VS Code Webview decoder first. Header inspection shows key container or frame fields. Extension-host FFmpeg is used as a fallback when available. |
| Raw PCM | `.pcm`, `.raw` | Requires explicit PCM parameters before reading. |

## View Multi-Channel Audio

Multi-channel files are shown as separate channel tracks. Each track has a compact left control strip and a full-width analysis area.

- `Mute` disables playback for that channel.
- `Solo` plays that channel and silences the other channels.
- The track view selector switches a channel between waveform, spectrogram, and combined view.
- Selecting a track makes it the active channel for selection analysis.

The waveform color is consistent across channels so the selected channel does not visually distort track comparison. Adjacent tracks are drawn as a compact stack with shared borders, while the selected track keeps a rounded focus outline for quick orientation.

## Open PCM Files

For `.pcm` and `.raw` files, AudioLens asks for PCM parameters before decoding:

- sample rate
- channel count
- encoding, such as Signed 16-bit PCM, Unsigned 8-bit PCM, 32-bit float, or 64-bit float
- byte order, with 8-bit encodings automatically using no endian setting
- start offset in bytes

The current PCM parameters can be saved as defaults for later PCM files. AudioLens does not guess PCM parameters from the file name, because raw PCM does not contain reliable metadata.

WAV files can also be reopened as PCM from the top bar. This is a one-time operation for the current file and is useful when inspecting raw audio data, non-standard headers, or offset-sensitive test files.

## Open Kaldi WAV Ark Files

Run `AudioLens: Open Kaldi WAV Ark Entry` from the Command Palette and enter a `wav.ark:offset` location. If you open an `.ark` file directly, AudioLens asks for the offset before reading.

AudioLens only supports ark entries whose audio payload starts with a WAV `RIFF/WAVE` header. It uses the WAV header size to read the selected entry and does not scan or load the whole ark file.

## Open Audio Paths From Any File

AudioLens can detect audio paths in ordinary text files and open them directly with the AudioLens editor. Hover an audio path and click **Open in AudioLens**, or place the cursor on a path and use the status-bar action or `AudioLens: Open Audio Path at Cursor`. It supports absolute paths and relative paths resolved from the current text file, workspace folders, and optional configured base directories.

Run `AudioLens: Toggle "Open in AudioLens"` from the Command Palette to turn this feature on or off. It is enabled by default and avoids generating inline links for the whole document, so large JSON, log, and dataset files stay responsive.

Kaldi `*.ark:offset` links are intentionally left to Kaldi Reader.

## Inspect File Headers

Use the document icon in the top bar to inspect structured header fields without leaving VS Code. AudioLens lists fields in file order and uses byte offsets for chunk-based formats, or bit ranges for packed headers such as ADTS AAC and MPEG audio frames.

For WAV files, the inspector highlights whether the file uses the standard 44-byte PCM header or contains extended chunks such as `fmt` extensions and `LIST` metadata. Audio payload rows identify the data region without dumping raw sample bytes.

## Analyze Selected Audio

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

## Adjust Spectrograms

AudioLens includes practical spectrogram controls for speech and signal inspection:

- algorithms: Frequency, Reassignment, Pitch (EAC)
- FFT sizes from `8` to `32768`
- window functions: Rectangular, Bartlett, Hamming, Hann, Blackman, Blackman-Harris, Welch, and Gaussian variants
- zero padding factors from `1` to `128`
- frequency scales: Linear, Log, Mel, Bark, ERB
- palettes: Rose, Classic, Grayscale, Inverse Grayscale
- configurable dB brightness range and auto brightness

Spectrogram work runs in a worker so expensive analysis does not block Webview interactions.

## Controls

After opening audio, the active spectrogram or waveform is keyboard-ready, so `Space` can play or pause immediately.

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

## Interface Language

AudioLens follows the VS Code display language by default. You can override the Webview language with the `audiolens.language` setting or by running `AudioLens: Switch Language` from the Command Palette.

Supported languages:

Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Russian, Spanish, Italian, Portuguese, Indonesian, Norwegian, Dutch, Polish, Turkish, and Vietnamese.

New interface strings fall back to English until a locale has a complete translation.

## Use With Remote SSH

AudioLens is declared as a workspace extension. In a Remote SSH window, the extension host runs in the remote workspace, reads audio files from the remote file system, and streams the data to the local Webview for playback and visualization.

Use the top-bar download button when you want to save the current remote audio file. VS Code may open the save dialog on the remote side first; choose the local location option in that dialog when saving to your machine.

## Privacy

AudioLens does not upload audio files to any third-party service. Audio content is read by the VS Code extension host and analyzed inside the VS Code Webview and worker runtime.

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
