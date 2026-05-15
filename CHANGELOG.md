# Changelog

## 0.2.9

Marketplace asset and performance groundwork update.

- Switched the README brand image to the black-background logo variant for dark editor themes.
- Repackaged with the optimized Marketplace icon assets.
- Fixed waveform rendering when sparse samples are visible at high time zoom levels.
- Added compact mouse-wheel shortcut hints below the zoom controls with platform-specific `Command` / `Ctrl` labels.
- Added the initial Rust audio analysis core for STFT spectrogram generation.

## 0.2.8

Public preview packaging update.

- Added Marketplace icon, gallery banner metadata, support document, and product-oriented README.
- Added an all-rights-reserved copyright notice for the public package.
- Excluded source files, internal documents, large logo source images, and source maps from the published package.
- Fixed Webview initialization failure caused by analysis table DOM element type checks.
- Added local regression coverage for the Webview DOM contract and initialization guard.

## 0.2.7

Interaction polish and analysis layout update.

- Moved selection analysis into the left-side control pane.
- Reworked selection analysis as compact two-column tables.
- Added macOS `Command` + mouse wheel time zoom while keeping `Ctrl` + wheel on Windows and Linux.
- Improved waveform and spectrogram pan/zoom synchronization.

## 0.2.6

Resizable panel and preference persistence update.

- Added draggable waveform and spectrogram panel heights.
- Persisted panel heights and spectrogram preferences across audio files.
- Added dynamic spectrogram frequency limits based on the decoded audio sample rate.
- Improved axis spacing and label readability.

## 0.2.5

Spectrogram configuration update.

- Added Audacity-inspired spectrogram controls for algorithm, window size, window type, and zero padding.
- Added extended window functions including Bartlett, Welch, Blackman-Harris, and Gaussian variants.
- Added frequency scale and palette controls in the settings panel.
- Improved spectrogram cache keys for configurable analysis parameters.

## 0.2.4

Selection and playback analysis update.

- Added Audacity-style time selection without automatic zoom.
- Added selection playback from the toolbar and keyboard.
- Added selection statistics for duration, RMS level, peak level, dominant frequency, and frequency-band energy.
- Made single-click seeking clear the active selection.

## 0.2.3

Navigation and coordinate update.

- Added playback cursor rendering on waveform and spectrogram.
- Added click-to-seek behavior on waveform and spectrogram.
- Added time, amplitude, and frequency axes.
- Added mouse-wheel time zoom, time pan, and amplitude zoom shortcuts.

## 0.2.2

Remote SSH and playback stability update.

- Reworked audio loading through chunked extension-host reads for local and Remote SSH workspaces.
- Improved Webview playback by creating object URLs from loaded audio data.
- Added safer initialization and error reporting paths between extension host and Webview.

## 0.2.1

Performance structure update.

- Split Webview UI, styles, DOM helpers, app state, and analysis worker into separate modules.
- Added worker-backed spectrogram analysis to avoid blocking the Webview main thread.
- Added waveform and spectrogram result caching for common redraw paths.

## 0.2.0

First usable AudioLens preview.

- Added custom read-only audio editor for common audio formats.
- Added audio playback, waveform preview, spectrogram preview, and progress controls.
- Added basic spectrogram settings for FFT size, window function, dB range, time zoom, and amplitude zoom.

## 0.1.1

Early internal preview.

- Established the renamed AudioLens extension identity and VSIX packaging flow.
- Added the first working audio preview experience used for local validation.
