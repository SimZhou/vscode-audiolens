import { query } from "./dom";
import { LocaleMessages } from "./i18n/types";

export interface ViewElements {
  fileMeta: HTMLSpanElement;
  status: HTMLDivElement;
  play: HTMLButtonElement;
  clock: HTMLSpanElement;
  seek: HTMLInputElement;
  playbackAlgorithm: HTMLSelectElement;
  audio: HTMLAudioElement;
  algorithm: HTMLSelectElement;
  defaultTrackMode: HTMLSelectElement;
  zeroPaddingFactor: HTMLSelectElement;
  settingsToggle: HTMLButtonElement;
  downloadAudio: HTMLButtonElement;
  helpMenu: HTMLElement;
  gainLabel: HTMLSpanElement;
  playbackGain: HTMLInputElement;
  settingsPanel: HTMLElement;
  windowFunction: HTMLSelectElement;
  fftSize: HTMLSelectElement;
  channel: HTMLSelectElement;
  pcmPanel: HTMLElement;
  pcmEdit: HTMLButtonElement;
  pcmReveal: HTMLButtonElement;
  headerInfo: HTMLButtonElement;
  headerInfoPanel: HTMLElement;
  headerInfoTitle: HTMLElement;
  headerInfoBody: HTMLElement;
  headerInfoClose: HTMLButtonElement;
  pcmSampleRate: HTMLInputElement;
  pcmChannels: HTMLInputElement;
  pcmStartOffset: HTMLInputElement;
  pcmEncoding: HTMLSelectElement;
  pcmEndianness: HTMLSelectElement;
  pcmApply: HTMLButtonElement;
  pcmSaveDefault: HTMLButtonElement;
  pcmStatus: HTMLSpanElement;
  pcmStatusText: HTMLSpanElement;
  wavPcmPanel: HTMLElement;
  wavPcmSampleRate: HTMLInputElement;
  wavPcmChannels: HTMLInputElement;
  wavPcmStartOffset: HTMLInputElement;
  wavPcmEncoding: HTMLSelectElement;
  wavPcmEndianness: HTMLSelectElement;
  wavPcmApply: HTMLButtonElement;
  wavPcmCancel: HTMLButtonElement;
  wavPcmStatus: HTMLSpanElement;
  timeZoom: HTMLInputElement;
  timeOffset: HTMLInputElement;
  amplitudeZoom: HTMLInputElement;
  minDb: HTMLInputElement;
  maxDb: HTMLInputElement;
  spectrogramMinHz: HTMLInputElement;
  spectrogramMaxHz: HTMLInputElement;
  spectrogramMaxFollowsNyquist: HTMLInputElement;
  autoBrightness: HTMLInputElement;
  frequencyScale: HTMLSelectElement;
  palette: HTMLSelectElement;
  analyze: HTMLButtonElement;
  resetView: HTMLButtonElement;
  viewRange: HTMLSpanElement;
  timeline: HTMLCanvasElement;
  analysisMeta: HTMLSpanElement;
  analysisStart: HTMLElement;
  analysisEnd: HTMLElement;
  analysisDuration: HTMLElement;
  analysisRms: HTMLElement;
  analysisPeak: HTMLElement;
  analysisDominant: HTMLElement;
  analysisCrest: HTMLElement;
  analysisClipping: HTMLElement;
  analysisNoiseFloor: HTMLElement;
  analysisCentroid: HTMLElement;
  analysisZcr: HTMLElement;
  analysisBands: HTMLElement;
  figures: HTMLElement;
  trackList: HTMLElement;
  waveformPane: HTMLElement;
  spectrogramPane: HTMLElement;
  waveformResize: HTMLDivElement;
  spectrogramResize: HTMLDivElement;
  waveform: HTMLCanvasElement;
  spectrogram: HTMLCanvasElement;
  selectionBox: HTMLDivElement;
  selectionContextMenu: HTMLDivElement;
  floatingTooltip: HTMLDivElement;
}

export function renderShell(root: HTMLDivElement): ViewElements {
  root.innerHTML = /* html */ `
    <main class="shell">
      <header class="topbar">
        <div class="identity">
          <strong class="brand">AudioLens</strong>
          <span id="fileMeta" class="muted fileMeta" tabindex="0" data-i18n="waitingAudioFile">Waiting for audio file</span>
          <button id="pcmReveal" class="secondary pcmReveal" data-i18n="pcmReadAs" hidden>Read as PCM</button>
        </div>
        <div id="status" class="status" data-i18n="initializing" hidden>Initializing</div>
        <section id="pcmPanel" class="pcmPanel topPcmPanel" hidden>
          <div class="paneTitle" data-i18n="pcmParams">PCM parameters</div>
          <div class="pcmFields">
            <label>
              <span data-i18n="sampleRate">Sample rate</span>
              <input id="pcmSampleRate" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="16000" />
            </label>
            <label>
              <span data-i18n="channels">Channels</span>
              <input id="pcmChannels" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="1" />
            </label>
            <label>
              <span data-i18n="startOffsetBytes">Offset (B)</span>
              <input id="pcmStartOffset" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="0" />
            </label>
            <label>
              <span data-i18n="bitDepth">Encoding</span>
              <select id="pcmEncoding">
                <option value="signed-8">Signed 8-bit PCM</option>
                <option value="signed-16" selected>Signed 16-bit PCM</option>
                <option value="signed-24">Signed 24-bit PCM</option>
                <option value="signed-32">Signed 32-bit PCM</option>
                <option value="unsigned-8">Unsigned 8-bit PCM</option>
                <option value="float-32">32-bit float</option>
                <option value="float-64">64-bit float</option>
                <option value="u-law" disabled>U-law (soon)</option>
                <option value="a-law" disabled>A-law (soon)</option>
                <option value="gsm-6.10" disabled>GSM 6.10 (soon)</option>
                <option value="dwvw-12" disabled>12-bit DWVW (soon)</option>
                <option value="dwvw-16" disabled>16-bit DWVW (soon)</option>
                <option value="dwvw-24" disabled>24-bit DWVW (soon)</option>
                <option value="vox-adpcm" disabled>VOX ADPCM (soon)</option>
                <option value="nms-adpcm-16" disabled>16kbs NMS ADPCM (soon)</option>
                <option value="nms-adpcm-24" disabled>24kbs NMS ADPCM (soon)</option>
                <option value="nms-adpcm-32" disabled>32kbs NMS ADPCM (soon)</option>
              </select>
            </label>
            <label>
              <span data-i18n="endianness">Endian</span>
              <select id="pcmEndianness">
                <option value="none">None</option>
                <option value="little">LE</option>
                <option value="big">BE</option>
              </select>
            </label>
          </div>
          <div class="pcmActions">
            <button id="pcmApply" class="secondary" data-i18n="read">Read</button>
            <button id="pcmSaveDefault" class="secondary" data-i18n="saveDefault">Save default</button>
          </div>
          <button id="pcmEdit" class="secondary pcmEdit" data-i18n="editPcmParams" hidden>Edit parameters</button>
          <span id="pcmStatus" class="muted"><span id="pcmStatusText"></span></span>
        </section>
        <div class="topbarTools">
          <button id="headerInfo" class="iconButton secondaryIcon headerInfoButton" data-i18n-title="headerInfo" data-i18n-aria="headerInfo" data-i18n-tooltip="headerInfo" title="Header info" aria-label="Header info" data-tooltip="Header info" hidden>
            <svg class="headerInfoIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M6.75 3.5h7.5L19 8.25v12.25H6.75z" />
              <path d="M14.25 3.5v4.75H19" />
              <path d="M9.25 12.25h6.5M9.25 15.25h6.5M9.25 18.25h4.25" />
            </svg>
          </button>
          <button id="downloadAudio" class="iconButton secondaryIcon downloadButton" data-i18n-title="downloadAudio" data-i18n-aria="downloadAudio" data-i18n-tooltip="downloadAudio" title="Download audio" aria-label="Download audio" data-tooltip="Download audio">↓</button>
          <details id="helpMenu" class="helpMenu">
            <summary class="iconButton secondaryIcon" data-i18n-title="help" data-i18n-aria="help" data-i18n-tooltip="help" title="Help" aria-label="Help" data-tooltip="Help">?</summary>
            <div class="helpPopover">
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpPlaybackGroup">Playback & selection</div>
                <div class="helpRow"><span><kbd>Space</kbd></span><span data-i18n="helpPlayPause">Play / pause</span></div>
                <div class="helpRow"><span><kbd>Esc</kbd></span><span data-i18n="helpClearSelection">Close menu, clear selection, or reset playback cursor</span></div>
                <div class="helpNote" data-i18n="helpSelectionPlayback">Drag waveform or spectrogram to select a segment. Playing with a selection active only plays that range.</div>
              </section>
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpViewGroup">View navigation</div>
                <div class="helpRow"><span><kbd data-command-modifier>Ctrl</kbd> + <kbd>F</kbd></span><span data-i18n="helpResetTimeZoom">Reset time zoom</span></div>
                <div class="helpRow"><span><kbd data-time-zoom-modifier>Ctrl</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpTimeZoom">Time zoom:</span></div>
                <div class="helpRow"><span><kbd>Shift</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpTimePan">Time pan:</span></div>
                <div class="helpRow"><span><kbd data-amplitude-zoom-modifier>Alt</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></span><span data-i18n="helpAmplitudeZoom">Amplitude zoom:</span></div>
              </section>
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpMouseGroup">Mouse & trackpad</div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpRightClick">Right click</span></span><span data-i18n="resetView">Reset view</span></div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpPinch">Pinch</span></span><span data-i18n="helpTrackpadZoom">Pinch on trackpad to zoom time</span></div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpHorizontalSwipe">Horizontal swipe</span></span><span data-i18n="helpTrackpadPan">Horizontal trackpad swipe pans time</span></div>
              </section>
              <section class="helpSection">
                <div class="helpSectionTitle" data-i18n="helpGainGroup">Gain</div>
                <div class="helpRow"><span><span class="helpGesture" data-i18n="helpDoubleClick">Double click</span></span><span data-i18n="helpGainReset">Double-click the gain slider to reset to 0 dB</span></div>
              </section>
            </div>
          </details>
          <div class="gainControl" data-i18n-title="playbackGain" data-i18n-tooltip="playbackGain" data-tooltip="Playback Gain (Double-click to reset)" title="Playback Gain (Double-click to reset)" aria-label="Playback Gain">
            <span class="gainTitle" data-i18n="playbackGainLabel" data-i18n-title="playbackGain" title="Playback Gain (Double-click to reset)">Gain</span>
            <span id="gainLabel" class="gainLabel" data-i18n-title="playbackGain" title="Playback Gain (Double-click to reset)">0 dB</span>
            <input id="playbackGain" class="gainSlider" type="range" min="-12" max="24" step="1" value="0" data-i18n-title="playbackGain" title="Playback Gain (Double-click to reset)" />
          </div>
          <button id="settingsToggle" class="iconButton secondaryIcon" data-i18n-title="settings" data-i18n-aria="settings" data-i18n-tooltip="settings" title="Settings" aria-label="Settings" data-tooltip="Settings"><span class="settingsGlyph">⚙</span></button>
        </div>
      </header>

      <section id="wavPcmPanel" class="wavPcmPanel" role="dialog" data-i18n-aria="wavPcmRead" aria-label="Read WAV as PCM" hidden>
        <div class="wavPcmHeader">
          <strong data-i18n="wavPcmRead">Read WAV as PCM</strong>
          <span class="muted" data-i18n="currentFileOnly">Current file only</span>
        </div>
        <div class="wavPcmGrid">
          <label>
            <span data-i18n="sampleRate">Sample rate</span>
            <input id="wavPcmSampleRate" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="16000" />
          </label>
          <label>
            <span data-i18n="channels">Channels</span>
            <input id="wavPcmChannels" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="1" />
          </label>
          <label>
            <span data-i18n="startOffsetBytes">Offset (B)</span>
            <input id="wavPcmStartOffset" class="numericText" type="text" inputmode="numeric" pattern="[0-9]*" value="0" />
          </label>
          <label>
            <span data-i18n="bitDepth">Encoding</span>
            <select id="wavPcmEncoding">
              <option value="signed-8">Signed 8-bit PCM</option>
              <option value="signed-16" selected>Signed 16-bit PCM</option>
              <option value="signed-24">Signed 24-bit PCM</option>
              <option value="signed-32">Signed 32-bit PCM</option>
              <option value="unsigned-8">Unsigned 8-bit PCM</option>
              <option value="float-32">32-bit float</option>
              <option value="float-64">64-bit float</option>
              <option value="u-law" disabled>U-law (soon)</option>
              <option value="a-law" disabled>A-law (soon)</option>
              <option value="gsm-6.10" disabled>GSM 6.10 (soon)</option>
              <option value="dwvw-12" disabled>12-bit DWVW (soon)</option>
              <option value="dwvw-16" disabled>16-bit DWVW (soon)</option>
              <option value="dwvw-24" disabled>24-bit DWVW (soon)</option>
              <option value="vox-adpcm" disabled>VOX ADPCM (soon)</option>
              <option value="nms-adpcm-16" disabled>16kbs NMS ADPCM (soon)</option>
              <option value="nms-adpcm-24" disabled>24kbs NMS ADPCM (soon)</option>
              <option value="nms-adpcm-32" disabled>32kbs NMS ADPCM (soon)</option>
            </select>
          </label>
          <label>
            <span data-i18n="endianness">Endian</span>
            <select id="wavPcmEndianness">
              <option value="none">None</option>
              <option value="little">LE</option>
              <option value="big">BE</option>
            </select>
          </label>
        </div>
        <div class="wavPcmFooter">
          <span id="wavPcmStatus" class="muted"></span>
          <button id="wavPcmCancel" class="secondary" data-i18n="cancel">Cancel</button>
          <button id="wavPcmApply" class="secondary" data-i18n="read">Read</button>
        </div>
      </section>

      <section id="headerInfoPanel" class="headerInfoPanel" role="dialog" aria-label="Audio header info" hidden>
        <div class="headerInfoHeader">
          <strong id="headerInfoTitle">文件头信息</strong>
          <button id="headerInfoClose" class="iconButton secondaryIcon" title="Close" aria-label="Close">×</button>
        </div>
        <div id="headerInfoBody" class="headerInfoBody"></div>
      </section>

      <section class="player">
        <button id="play" class="iconButton" data-i18n-title="playPause" data-i18n-aria="playPause" title="Play / pause" aria-label="Play / pause">▶</button>
        <span id="clock" class="clock">0:00.000 / 0:00.000</span>
        <label class="playbackModeControl" data-i18n-title="playbackModeTitle" title="Playback mode for decoded audio">
          <span data-i18n="playbackMode">Mode</span>
          <select id="playbackAlgorithm" data-i18n-aria="playbackModeTitle" aria-label="Playback mode">
            <option value="downmix" data-i18n="playbackDownmix">Downmix</option>
            <option value="bypass" data-i18n="playbackBypass">Bypass</option>
          </select>
        </label>
        <input id="seek" class="seek" type="range" min="0" max="1000" value="0" data-i18n-aria="playbackPosition" aria-label="Playback position" />
        <audio id="audio" preload="auto"></audio>
      </section>

      <aside id="settingsPanel" class="settingsPanel" hidden>
        <div class="settingsHeader">
          <strong data-i18n="settings">Settings</strong>
        </div>
        <section class="settingsSection">
          <strong data-i18n="defaultView">Default view</strong>
          <label>
            <span data-i18n="view">View</span>
            <select id="defaultTrackMode">
              <option value="both" data-i18n="viewBoth">Multi-view</option>
              <option value="waveform" data-i18n="waveform">Waveform</option>
              <option value="spectrogram" data-i18n="spectrogram">Spectrogram</option>
            </select>
          </label>
        </section>
        <section class="settingsSection">
          <strong data-i18n="spectrogramDisplay">Spectrogram display</strong>
        <label>
          <span data-i18n="algorithm">Algorithm</span>
          <select id="algorithm">
            <option value="frequency" data-i18n="algorithmFrequency">Frequency</option>
            <option value="reassignment" data-i18n="algorithmReassignment">Reassignment</option>
            <option value="pitchEac" data-i18n="algorithmPitchEac">Pitch (EAC)</option>
          </select>
        </label>
        <label>
          <span data-i18n="windowSize">Window size</span>
          <select id="fftSize">
            <option value="8">8</option>
            <option value="16">16</option>
            <option value="32">32</option>
            <option value="64">64</option>
            <option value="128">128</option>
            <option value="256">256</option>
            <option value="512">512</option>
            <option value="1024">1024</option>
            <option value="2048">2048</option>
            <option value="4096">4096</option>
            <option value="8192">8192</option>
            <option value="16384">16384</option>
            <option value="32768">32768</option>
          </select>
        </label>
        <label>
          <span data-i18n="windowType">Window type</span>
          <select id="windowFunction">
            <option value="rectangular" data-i18n="windowRectangular">Rectangular</option>
            <option value="bartlett" data-i18n="windowBartlett">Bartlett</option>
            <option value="hamming" data-i18n="windowHamming">Hamming</option>
            <option value="hann" data-i18n="windowHann">Hann</option>
            <option value="blackman" data-i18n="windowBlackman">Blackman</option>
            <option value="blackmanHarris" data-i18n="windowBlackmanHarris">Blackman-Harris</option>
            <option value="welch" data-i18n="windowWelch">Welch</option>
            <option value="gaussian25" data-i18n="windowGaussian25">Gaussian (α=2.5)</option>
            <option value="gaussian35" data-i18n="windowGaussian35">Gaussian (α=3.5)</option>
            <option value="gaussian45" data-i18n="windowGaussian45">Gaussian (α=4.5)</option>
          </select>
        </label>
        <label>
          <span data-i18n="zeroPaddingFactor">Zero padding factor</span>
          <select id="zeroPaddingFactor">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="4">4</option>
            <option value="8">8</option>
            <option value="16">16</option>
            <option value="32">32</option>
            <option value="64">64</option>
            <option value="128">128</option>
          </select>
        </label>
        <label>
          <span data-i18n="frequencyScale">Frequency scale</span>
          <select id="frequencyScale">
            <option value="linear">Linear</option>
            <option value="log">Log</option>
            <option value="mel">Mel</option>
            <option value="bark">Bark</option>
            <option value="erb">ERB</option>
          </select>
        </label>
        <div class="settingsSubsection">
          <strong data-i18n="frequencyRange">Frequency range</strong>
          <label>
            <span data-i18n="minFrequencyHz">Min frequency (Hz)</span>
            <input id="spectrogramMinHz" type="number" min="0" step="1" value="0" />
          </label>
          <label>
            <span data-i18n="maxFrequencyHz">Max frequency (Hz)</span>
            <input id="spectrogramMaxHz" type="number" min="1" step="1" value="8000" />
          </label>
          <label class="checkboxLabel">
            <input id="spectrogramMaxFollowsNyquist" type="checkbox" checked />
            <span data-i18n="maxFrequencyNyquist">Max follows Nyquist</span>
          </label>
        </div>
        <div class="settingsSubsection">
          <strong data-i18n="spectrogramAppearance">Spectrogram appearance</strong>
          <label>
            <span data-i18n="palette">Palette</span>
            <select id="palette">
              <option value="rose" data-i18n="paletteRose">Color (rose)</option>
              <option value="classic" data-i18n="paletteClassic">Color (classic)</option>
              <option value="grayscale" data-i18n="paletteGrayscale">Grayscale</option>
              <option value="inverseGrayscale" data-i18n="paletteInverseGrayscale">Inverse grayscale</option>
            </select>
          </label>
          <label class="checkboxLabel">
            <input id="autoBrightness" type="checkbox" checked />
            <span data-i18n="autoBrightness">Auto brightness</span>
          </label>
          <label>
            <span data-i18n="minDb">Min dB (brightness)</span>
            <input id="minDb" type="number" min="-160" max="-1" step="1" value="-96" />
          </label>
          <label>
            <span data-i18n="maxDb">Max dB (brightness)</span>
            <input id="maxDb" type="number" min="-80" max="24" step="1" value="0" />
          </label>
        </div>
        </section>
      </aside>

        <section class="workspace">
        <aside class="controls" hidden>
          <div class="controlInternals" hidden>
          <label>
            <span data-i18n="channel">Channel</span>
            <select id="channel"></select>
          </label>
          <label>
            <span data-i18n="timeZoom">Time zoom</span>
            <input id="timeZoom" type="range" min="1" max="64" step="0.25" value="1" />
            <small class="wheelHint"><kbd data-time-zoom-modifier>Ctrl</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></small>
          </label>
          <label>
            <span data-i18n="timePosition">Time position</span>
            <input id="timeOffset" type="range" min="0" max="1" step="0.001" value="0" />
            <small class="wheelHint"><kbd>Shift</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></small>
          </label>
          <label>
            <span data-i18n="amplitudeZoom">Amplitude zoom</span>
            <input id="amplitudeZoom" type="range" min="0.25" max="32" step="0.25" value="1" />
            <small class="wheelHint"><kbd data-amplitude-zoom-modifier>Alt</kbd> + <span data-i18n="mouseWheel">mouse wheel</span></small>
          </label>
          <button id="resetView" class="secondary" data-i18n="resetView">Reset view</button>
          <button id="analyze" class="primary" data-i18n="refreshSpectrogram">Refresh spectrogram</button>
          </div>

        </aside>

        <section id="figures" class="figures">
          <div class="figureHeader timelineHeader">
            <span id="viewRange" class="muted timelineRange" data-i18n="timeLabel">Time</span>
            <div class="timelineCanvasWrap">
              <canvas id="timeline" class="timelineCanvas"></canvas>
            </div>
          </div>
          <div id="waveformPane" class="plotPane waveformPane legacyPlot" hidden>
            <canvas id="waveform" class="waveform"></canvas>
          </div>
          <div id="trackList" class="trackList"></div>
          <section class="selectionAnalysisPane" data-i18n-aria="selectionAnalysis" aria-label="Selection analysis" hidden>
            <div class="paneTitleRow">
              <div class="paneTitle" data-i18n="selectionAnalysis">Selection analysis</div>
              <span
                class="analysisHelp"
                tabindex="0"
                data-i18n-aria="selectionAnalysis"
                aria-label="Selection analysis"
                data-i18n-tooltip="selectionAnalysisHelp"
                data-tooltip="Selection analysis help"
              >?</span>
            </div>
            <div class="paneSubtitleRow">
              <div class="paneSubtitle" data-i18n="basicMetrics">Basic metrics</div>
            </div>
            <table class="analysisTable">
              <tbody>
                <tr><th data-i18n="selectionStart">Start</th><td id="analysisStart">--</td></tr>
                <tr><th data-i18n="selectionEnd">End</th><td id="analysisEnd">--</td></tr>
                <tr><th data-i18n="selectionDuration">Duration</th><td id="analysisDuration">--</td></tr>
                <tr>
                  <th>
                    <span data-i18n="rmsLevel">RMS Level</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="rmsLevel"
                      aria-label="RMS Level"
                      data-i18n-tooltip="rmsLevelHelp"
                      data-tooltip="RMS level help"
                    >?</span>
                  </th>
                  <td id="analysisRms">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="peakLevel">Peak Level</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="peakLevel"
                      aria-label="Peak Level"
                      data-i18n-tooltip="peakLevelHelp"
                      data-tooltip="Peak level help"
                    >?</span>
                  </th>
                  <td id="analysisPeak">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="dominant">Dominant</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="dominant"
                      aria-label="Dominant"
                      data-i18n-tooltip="dominantHelp"
                      data-tooltip="Dominant frequency help"
                    >?</span>
                  </th>
                  <td id="analysisDominant">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="crestFactor">Crest</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="crestFactor"
                      aria-label="Crest"
                      data-i18n-tooltip="crestFactorHelp"
                      data-tooltip="Crest factor help"
                    >?</span>
                  </th>
                  <td id="analysisCrest">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="clippingRatio">Clipping</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="clippingRatio"
                      aria-label="Clipping"
                      data-i18n-tooltip="clippingRatioHelp"
                      data-tooltip="Clipping ratio help"
                    >?</span>
                  </th>
                  <td id="analysisClipping">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="noiseFloor">Noise floor</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="noiseFloor"
                      aria-label="Noise floor"
                      data-i18n-tooltip="noiseFloorHelp"
                      data-tooltip="Noise floor help"
                    >?</span>
                  </th>
                  <td id="analysisNoiseFloor">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="spectralCentroid">Centroid</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="spectralCentroid"
                      aria-label="Centroid"
                      data-i18n-tooltip="spectralCentroidHelp"
                      data-tooltip="Spectral centroid help"
                    >?</span>
                  </th>
                  <td id="analysisCentroid">--</td>
                </tr>
                <tr>
                  <th>
                    <span data-i18n="zeroCrossingRate">ZCR</span>
                    <span
                      class="metricHelp"
                      tabindex="0"
                      data-i18n-aria="zeroCrossingRate"
                      aria-label="ZCR"
                      data-i18n-tooltip="zeroCrossingRateHelp"
                      data-tooltip="Zero crossing rate help"
                    >?</span>
                  </th>
                  <td id="analysisZcr">--</td>
                </tr>
              </tbody>
            </table>
            <div class="paneSubtitleRow">
              <div class="paneSubtitle" data-i18n="frequencyAnalysis">Frequency analysis</div>
              <span
                class="analysisHelp"
                tabindex="0"
                data-i18n-aria="frequencyAnalysis"
                aria-label="Frequency analysis"
                data-i18n-tooltip="frequencyAnalysisHelp"
                data-tooltip="Frequency analysis help"
              >?</span>
            </div>
            <table class="analysisTable">
              <tbody id="analysisBands">
                <tr><th data-i18n="bands">Bands</th><td>--</td></tr>
              </tbody>
            </table>
          </section>
          <div id="waveformResize" class="plotResize legacyPlot" role="separator" aria-orientation="horizontal" data-i18n-title="adjustWaveformHeight" title="Adjust waveform height" hidden></div>
          <span id="analysisMeta" class="muted legacyPlot" hidden></span>
          <div id="spectrogramPane" class="plotPane spectrogramPane legacyPlot" hidden>
            <canvas id="spectrogram" class="spectrogram"></canvas>
          </div>
          <div id="spectrogramResize" class="plotResize legacyPlot" role="separator" aria-orientation="horizontal" data-i18n-title="adjustSpectrogramHeight" title="Adjust spectrogram height" hidden></div>
          <div id="selectionBox" class="selectionBox" hidden></div>
          <div id="selectionContextMenu" class="contextMenu" role="menu" hidden>
            <button type="button" role="menuitem" data-action="download-selection" data-i18n="downloadSelectionWav">Download selection as WAV</button>
            <button type="button" role="menuitem" data-action="clear-selection" data-i18n="clearSelection">Clear selection</button>
          </div>
          <div id="floatingTooltip" class="floatingTooltip" hidden></div>
        </section>
      </section>

    </main>
  `;

  return {
    fileMeta: query("#fileMeta", HTMLSpanElement),
    status: query("#status", HTMLDivElement),
    play: query("#play", HTMLButtonElement),
    clock: query("#clock", HTMLSpanElement),
    seek: query("#seek", HTMLInputElement),
    playbackAlgorithm: query("#playbackAlgorithm", HTMLSelectElement),
    audio: query("#audio", HTMLAudioElement),
    algorithm: query("#algorithm", HTMLSelectElement),
    defaultTrackMode: query("#defaultTrackMode", HTMLSelectElement),
    zeroPaddingFactor: query("#zeroPaddingFactor", HTMLSelectElement),
    settingsToggle: query("#settingsToggle", HTMLButtonElement),
    downloadAudio: query("#downloadAudio", HTMLButtonElement),
    helpMenu: query("#helpMenu", HTMLElement),
    gainLabel: query("#gainLabel", HTMLSpanElement),
    playbackGain: query("#playbackGain", HTMLInputElement),
    settingsPanel: query("#settingsPanel", HTMLElement),
    windowFunction: query("#windowFunction", HTMLSelectElement),
    fftSize: query("#fftSize", HTMLSelectElement),
    channel: query("#channel", HTMLSelectElement),
    pcmPanel: query("#pcmPanel", HTMLElement),
    pcmEdit: query("#pcmEdit", HTMLButtonElement),
    pcmReveal: query("#pcmReveal", HTMLButtonElement),
    headerInfo: query("#headerInfo", HTMLButtonElement),
    headerInfoPanel: query("#headerInfoPanel", HTMLElement),
    headerInfoTitle: query("#headerInfoTitle", HTMLElement),
    headerInfoBody: query("#headerInfoBody", HTMLElement),
    headerInfoClose: query("#headerInfoClose", HTMLButtonElement),
    pcmSampleRate: query("#pcmSampleRate", HTMLInputElement),
    pcmChannels: query("#pcmChannels", HTMLInputElement),
    pcmStartOffset: query("#pcmStartOffset", HTMLInputElement),
    pcmEncoding: query("#pcmEncoding", HTMLSelectElement),
    pcmEndianness: query("#pcmEndianness", HTMLSelectElement),
    pcmApply: query("#pcmApply", HTMLButtonElement),
    pcmSaveDefault: query("#pcmSaveDefault", HTMLButtonElement),
    pcmStatus: query("#pcmStatus", HTMLSpanElement),
    pcmStatusText: query("#pcmStatusText", HTMLSpanElement),
    wavPcmPanel: query("#wavPcmPanel", HTMLElement),
    wavPcmSampleRate: query("#wavPcmSampleRate", HTMLInputElement),
    wavPcmChannels: query("#wavPcmChannels", HTMLInputElement),
    wavPcmStartOffset: query("#wavPcmStartOffset", HTMLInputElement),
    wavPcmEncoding: query("#wavPcmEncoding", HTMLSelectElement),
    wavPcmEndianness: query("#wavPcmEndianness", HTMLSelectElement),
    wavPcmApply: query("#wavPcmApply", HTMLButtonElement),
    wavPcmCancel: query("#wavPcmCancel", HTMLButtonElement),
    wavPcmStatus: query("#wavPcmStatus", HTMLSpanElement),
    timeZoom: query("#timeZoom", HTMLInputElement),
    timeOffset: query("#timeOffset", HTMLInputElement),
    amplitudeZoom: query("#amplitudeZoom", HTMLInputElement),
    minDb: query("#minDb", HTMLInputElement),
    maxDb: query("#maxDb", HTMLInputElement),
    spectrogramMinHz: query("#spectrogramMinHz", HTMLInputElement),
    spectrogramMaxHz: query("#spectrogramMaxHz", HTMLInputElement),
    spectrogramMaxFollowsNyquist: query("#spectrogramMaxFollowsNyquist", HTMLInputElement),
    autoBrightness: query("#autoBrightness", HTMLInputElement),
    frequencyScale: query("#frequencyScale", HTMLSelectElement),
    palette: query("#palette", HTMLSelectElement),
    analyze: query("#analyze", HTMLButtonElement),
    resetView: query("#resetView", HTMLButtonElement),
    viewRange: query("#viewRange", HTMLSpanElement),
    timeline: query("#timeline", HTMLCanvasElement),
    analysisMeta: query("#analysisMeta", HTMLSpanElement),
    analysisStart: query("#analysisStart", HTMLElement),
    analysisEnd: query("#analysisEnd", HTMLElement),
    analysisDuration: query("#analysisDuration", HTMLElement),
    analysisRms: query("#analysisRms", HTMLElement),
    analysisPeak: query("#analysisPeak", HTMLElement),
    analysisDominant: query("#analysisDominant", HTMLElement),
    analysisCrest: query("#analysisCrest", HTMLElement),
    analysisClipping: query("#analysisClipping", HTMLElement),
    analysisNoiseFloor: query("#analysisNoiseFloor", HTMLElement),
    analysisCentroid: query("#analysisCentroid", HTMLElement),
    analysisZcr: query("#analysisZcr", HTMLElement),
    analysisBands: query("#analysisBands", HTMLElement),
    figures: query("#figures", HTMLElement),
    trackList: query("#trackList", HTMLElement),
    waveformPane: query("#waveformPane", HTMLElement),
    spectrogramPane: query("#spectrogramPane", HTMLElement),
    waveformResize: query("#waveformResize", HTMLDivElement),
    spectrogramResize: query("#spectrogramResize", HTMLDivElement),
    waveform: query("#waveform", HTMLCanvasElement),
    spectrogram: query("#spectrogram", HTMLCanvasElement),
    selectionBox: query("#selectionBox", HTMLDivElement),
    selectionContextMenu: query("#selectionContextMenu", HTMLDivElement),
    floatingTooltip: query("#floatingTooltip", HTMLDivElement)
  };
}

export function applyLocale(root: ParentNode, messages: LocaleMessages): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n as keyof LocaleMessages | undefined;
    if (key && messages[key]) {
      element.textContent = messages[key];
    }
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = element.dataset.i18nTitle as keyof LocaleMessages | undefined;
    if (key && messages[key]) {
      element.title = messages[key];
    }
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-tooltip]").forEach((element) => {
    const key = element.dataset.i18nTooltip as keyof LocaleMessages | undefined;
    if (key && messages[key]) {
      element.dataset.tooltip = messages[key];
    }
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((element) => {
    const key = element.dataset.i18nAria as keyof LocaleMessages | undefined;
    if (key && messages[key]) {
      element.setAttribute("aria-label", messages[key]);
    }
  });
}
