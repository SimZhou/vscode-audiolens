# AudioLens

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/AudioLens_logo.black_background.png" alt="AudioLens" width="360">
</p>

AudioLens is a focused audio preview and analysis extension for Visual Studio Code. It is designed for speech, audio, and machine learning engineers who need to inspect audio files while staying inside their code workspace.

Open an audio file and AudioLens gives you playback, waveform inspection, spectrogram analysis, selection playback, and practical audio statistics in one lightweight VS Code editor.

## Features

- Open `wav`, `mp3`, `flac`, `ogg`, `opus`, `m4a`, and `aac` files with a custom read-only editor.
- Play, pause, seek, and inspect audio directly from VS Code.
- View synchronized waveform and spectrogram panels with playback cursor and time axis.
- Click the waveform or spectrogram to set the playback position.
- Drag across the waveform or spectrogram to create an Audacity-style time selection.
- Play only the selected range when a selection is active.
- Inspect selection statistics including duration, RMS level, peak level, dominant frequency, and frequency-band energy.
- Tune spectrogram settings: algorithm, FFT size, window type, zero padding, dB range, frequency scale, and color palette.
- Use Linear, Log, Mel, Bark, and ERB frequency scales.
- Use rose, classic, grayscale, and inverse grayscale spectrogram palettes.
- Resize waveform and spectrogram panel heights and keep preferences across files.
- Work in Remote SSH windows: the extension host reads workspace files remotely and the local webview handles playback and visualization.

## Controls

| Action | Shortcut |
| --- | --- |
| Play or pause | `Space` |
| Clear selection or playback cursor | `Esc` |
| Time zoom on macOS | `Command` + mouse wheel |
| Time zoom on Windows/Linux | `Ctrl` + mouse wheel |
| Pan visible time range | `Shift` + mouse wheel |
| Zoom waveform amplitude scale | `Alt` + mouse wheel |

## Spectrogram Analysis

AudioLens includes Audacity-inspired spectrogram controls for day-to-day audio analysis:

- Algorithms: Frequency, Reassignment, Pitch (EAC).
- Window sizes: `8` to `32768`.
- Window types: Rectangular, Bartlett, Hamming, Hann, Blackman, Blackman-Harris, Welch, and Gaussian variants.
- Zero padding factors: `1` to `128`.
- Frequency scales: Linear, Log, Mel, Bark, ERB.
- Palettes: Rose, Classic, Grayscale, Inverse Grayscale.

The current release focuses on a responsive analysis workflow in VS Code. Performance-sensitive analysis paths are isolated behind a worker boundary so future releases can move heavier FFT/STFT work to WebAssembly or a native helper without changing the user interface.

## Localization

AudioLens uses your VS Code display language by default. You can override the Webview language with the `audiolens.language` setting.

You can also switch the AudioLens UI language directly from the Command Palette with `AudioLens: 切换语言`.

Supported languages: Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Russian, Spanish, Italian, Portuguese, Indonesian, Norwegian, Dutch, Polish, Turkish, Vietnamese.

## Remote SSH

AudioLens is declared as a workspace extension. In a Remote SSH window, the extension host runs in the remote workspace, reads audio files from the remote file system in chunks, and streams them to the local webview for playback and visualization.

This keeps the extension usable for common speech and audio workflows where datasets live on a remote development machine.

## Privacy

AudioLens does not upload audio files to any third-party service. Audio content is read by the VS Code extension host and analyzed inside the VS Code webview/worker runtime.

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
code --install-extension dist/audiolens-0.2.12.vsix
```

## Development

```bash
npm install
npm run build
npm run typecheck
npm run package
```

Press `F5` in VS Code and choose the AudioLens extension launch configuration. Then open a supported audio file in the Extension Development Host.

## Author

SimZhou: https://simzhou.com/en/about/

## Copyright

Copyright (c) 2026 SimZhou. All rights reserved.
