# Changelog

## 1.1.1

Timeline usability update.

- Kept the top timeline ruler sticky while scrolling through many channel tracks.
- Removed the experimental timeline hover tooltip.

## 1.1.0

Header inspection update.

- Added a top-bar header inspector for WAV/RIFF, FLAC, Ogg/Opus/Vorbis, MP4/M4A, AAC/ADTS, and MP3/MPEG frame metadata.
- Added WAV header status highlighting for standard 44-byte PCM headers and extended/non-standard RIFF layouts.
- Showed AAC and MP3 packed header fields with bit ranges instead of misleading byte-only offsets.
- Reworked MP4/M4A boxes into a tree-style table so nested container structure is easier to scan.
- Kept audio payload regions summarized instead of displaying raw sample data as field values.
- Localized the new header inspector UI and field descriptions across bundled languages.
- Improved the floating panel positioning and adaptive table widths for compact display.

## 1.0.7

Interaction and documentation polish update.

- Kept the settings panel above the selection analysis overlay.
- Reduced viewport jumps when starting playback from a highly zoomed selection.
- Reworked the README into English, Simplified Chinese, and Japanese editions with language switching links.
- Added localized main-screen screenshots and feature GIF demos for multi-channel tracks, selection analysis, and PCM / RAW loading.
- Moved README media assets into `docs/assets/readme` and kept them out of the VSIX package.
- Trimmed the VSIX package by excluding non-runtime README assets and optimizing the Marketplace icon.

## 1.0.6

Transparent logo update.

- Fixed the v2 logo asset so the background is truly transparent.
- Regenerated the Marketplace extension icon from the transparent logo.

## 1.0.5

Logo crop update.

- Updated the README logo artwork to the cropped v2 image.
- Regenerated the Marketplace extension icon from the cropped logo.

## 1.0.4

Localization and presentation update.

- Replaced the AudioLens logo and extension icon with the new v2 artwork.
- Added Ko-fi support link to the README while keeping the WeChat appreciation code.
- Localized the Command Palette language command through VS Code manifest nls files.
- Expanded and reorganized the Help menu with playback, selection, view navigation, mouse, trackpad, and gain shortcuts.
- Improved English and Japanese layout for track controls and Help menu readability.
- Expanded Webview localization coverage across all bundled languages, including PCM controls, track controls, selection analysis, metric tooltips, FFmpeg fallback text, and playback gain labels.
- Adjusted the shared timeline ruler spacing for a more balanced top-bar layout.

## 1.0.3

Selection and playback polish update.

- Aligned the yellow selection-start playhead between the shared timeline and track canvases while dragging.
- Kept the blue selection rectangle visible when replacing an active selection during playback.
- Reduced unnecessary redraw work when starting a new drag selection during playback.
- Updated active selection playback so replacing a selection while audio is playing also updates the new stop point.

## 1.0.2

Encoded audio fallback update.

- Added a bounded decode path for encoded audio so unsupported or stalled codecs no longer leave the editor stuck on decoding.
- Added extension-host FFmpeg fallback decoding for encoded files that the VS Code Webview cannot demux or decode.
- Corrected MIME types for ADTS AAC and Ogg Opus blobs.
- Fixed initial spectrogram rendering for PCM and RAW files after loading with saved or manual PCM parameters.
- Refined the multi-channel track layout so adjacent tracks connect cleanly while preserving rounded track borders.
- Improved selection rendering so the active selection uses one continuous outer rectangle instead of per-track border fragments.
- Made the timeline playhead appear immediately at the selection start while dragging.

## 1.0.1

Playback routing and remote-file convenience update.

- Downmixed enabled audio tracks to stereo during playback so soloing any channel is audible on normal two-channel output devices.
- Added a top-bar audio download button for saving the currently opened audio file, especially from Remote SSH workspaces.

## 1.0.0

First full AudioLens release.

- Rebuilt the editor around multi-channel audio tracks with one real track per channel.
- Added per-channel waveform, spectrogram, and combined view modes.
- Added a saved default track view setting.
- Added clearer per-track mute and solo controls with corrected playback logic.
- Added a shared top timeline with adaptive tick density for zoomed views.
- Improved playback cursor tracking while playing beyond the visible time range.
- Improved selection rendering across waveform and spectrogram views.
- Added raw PCM support for `.pcm` and `.raw` files with manual sample rate, channel count, bit depth, sample format, byte order, and offset settings.
- Added saved default PCM parameters for faster repeated PCM inspection.
- Added one-time WAV-as-PCM rereading for inspecting WAV payloads with explicit PCM parameters and byte offsets.
- Moved PCM controls into the top workspace area and made the PCM layout more compact.
- Reworked selection analysis as a translucent overlay so tracks have more horizontal space.
- Added selection metrics for crest factor, clipping ratio, noise floor, spectral centroid, and zero-crossing rate.
- Expanded RMS level, peak level, dominant frequency, and frequency-band analysis tooltips with calculation notes, usage guidance, and references.
- Changed frequency-band analysis to aggregate frames across the full selected region.
- Added waveform amplitude auto-scaling for quiet files without clipping the display.
- Added corrected waveform and spectrogram y-axis labels, including Nyquist-based frequency bounds.
- Improved spectrogram redraw behavior during playback panning and zooming.
- Added `Ctrl` / `Command` + `F` to reset time zoom.
- Added a playback gain control with stable layout and persisted gain value.
- Improved top menu, tooltip, settings, help, and track-sidebar UX.
- Added English fallback for incomplete locale strings and updated the Webview i18n contract.
- Added Rust PCM parsing groundwork and regression coverage for key UI and decoding paths.

## 0.2.15

Playback gain control update.

- Added a playback gain control slider next to the spectrogram settings.
- Allowed amplifying or attenuating playback from -12 dB to +24 dB using the Web Audio API GainNode.
- Added a double-click interaction to quickly reset the playback gain to 0 dB.
- Saved the selected playback gain value to workspace preferences for persistence across sessions.
- Added localization for the gain control tooltip.

## 0.2.14

Marketplace search and UI polish update.

- Improved Marketplace search metadata with more direct preview and viewer keywords.
- Shortened selection analysis labels for RMS and peak levels across localized Webview UI.
- Updated the macOS amplitude zoom hint to show the `Option` symbol instead of the `Alt` label.
- Hid the top-right status text when there is no actionable progress or error to show.
- Swapped the positions of `Reset view` and `Refresh spectrogram` in the left control pane.
- Made `Reset view` adopt the primary button style whenever the current view differs from the default state.

## 0.2.13

Spectrogram adaptive brightness update.

- Added auto brightness for spectrogram based on audio peak and RMS levels.
- Added "Auto brightness" toggle in spectrogram settings (enabled by default).
- Renamed "Min dB" / "Max dB" labels to include "(brightness)" suffix.
- Fixed negative sign input in Min/Max dB number fields.

## 0.2.12

Localization update.

- Added Webview UI localization with VS Code display language as the default.
- Added `audiolens.language` setting for overriding the AudioLens UI language.
- Added `AudioLens: 切换语言` command for changing the Webview language from the Command Palette.
- Added locale coverage for Simplified Chinese, Traditional Chinese, English, Japanese, Korean, French, German, Russian, Spanish, Italian, Portuguese, Indonesian, Norwegian, Dutch, Polish, Turkish, and Vietnamese.

## 0.2.11

Default spectrogram settings update.

- Changed the default window size to `512`.
- Changed the default window type to Hamming.
- Changed the default zero padding factor to `2`.
- Made `Esc` close the spectrogram settings menu before clearing playback or selection state.

## 0.2.10

Interaction update.

- Added trackpad horizontal swipe panning on waveform and spectrogram panels.
- Added trackpad pinch time zoom on waveform and spectrogram panels.

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
