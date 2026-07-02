export function injectStyles(): void {
  const style = document.createElement("style");
  style.textContent = `
    :root {
      color-scheme: light dark;
    }
    * {
      box-sizing: border-box;
    }
    html,
    body {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    button, input, select {
      font: inherit;
    }
    .shell {
      position: relative;
      height: 100vh;
      min-height: 0;
      display: grid;
      grid-template-rows: auto auto 1fr;
      overflow: hidden;
    }
    .topbar, .player {
      min-height: 44px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, auto) auto;
      grid-auto-rows: auto;
      align-items: center;
    }
    .identity {
      grid-column: 1;
      grid-row: 1;
      min-width: 0;
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex: 1 1 auto;
    }
    .topbarTools {
      grid-column: 3;
      grid-row: 1;
      justify-self: end;
      flex: 0 0 auto;
      min-width: max-content;
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .gainControl {
      position: relative;
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: 6ch 80px;
      grid-template-rows: 14px 22px;
      align-items: center;
      column-gap: 8px;
      row-gap: 2px;
      margin-right: 8px;
    }
    .gainControl::after {
      content: attr(data-tooltip);
      position: absolute;
      z-index: 40;
      top: calc(100% + 8px);
      right: 0;
      width: max-content;
      max-width: min(280px, calc(100vw - 24px));
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 8px 22px rgb(0 0 0 / 24%);
      font-size: 12px;
      line-height: 1.35;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity 90ms ease, transform 90ms ease;
    }
    .gainControl:hover::after,
    .gainControl:has(:focus-visible)::after {
      opacity: 1;
      transform: translateY(0);
    }
    .gainTitle {
      grid-column: 1 / -1;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1;
      text-align: center;
      white-space: nowrap;
    }
    .gainLabel {
      font-variant-numeric: tabular-nums;
      flex: 0 0 6ch;
      width: 6ch;
      text-align: right;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .gainSlider {
      width: 80px;
      margin: 0;
    }
    .gainSlider:focus,
    .gainSlider:focus-visible {
      outline: none;
    }
    .brand {
      letter-spacing: 0;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #fileMeta {
      display: block;
      flex: 1 1 auto;
      min-width: 0;
      cursor: text;
      user-select: text;
      scrollbar-width: none;
    }
    #fileMeta:hover,
    #fileMeta:focus,
    #fileMeta:active {
      overflow-x: auto;
      text-overflow: clip;
    }
    #fileMeta::-webkit-scrollbar {
      display: none;
    }
    .status {
      grid-column: 2;
      grid-row: 1;
      justify-self: end;
      max-width: min(32vw, 360px);
      color: var(--vscode-notificationsInfoIcon-foreground);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status.isWarning {
      color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-editorWarning-foreground, #cca700));
    }
    .status.isError {
      color: var(--vscode-notificationsErrorIcon-foreground, var(--vscode-errorForeground, #f85149));
    }
    .status[hidden] {
      display: none;
    }
    .player {
      background: var(--vscode-editor-background);
    }
    .routingControl {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      white-space: nowrap;
    }
    .routingControl select {
      height: 26px;
      min-width: 86px;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
      border-radius: 4px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      font-size: 12px;
    }
    .iconButton {
      width: 32px;
      height: 32px;
      flex: 0 0 auto;
      display: inline-grid;
      place-items: center;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    [hidden] {
      display: none !important;
    }
    .secondaryIcon {
      position: relative;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .downloadButton {
      font-size: 18px;
      line-height: 1;
    }
    #settingsToggle {
      position: relative;
      width: 32px;
      height: 32px;
      font-size: 20px;
      line-height: 1;
      padding-bottom: 0;
    }
    .settingsGlyph {
      display: block;
      line-height: 1;
      transform: translateY(-1px);
    }
    .iconButton:hover, .primary:hover, .secondary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .secondaryIcon[data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute;
      z-index: 45;
      top: calc(100% + 8px);
      right: 0;
      padding: 5px 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
      backdrop-filter: blur(8px);
      box-shadow: 0 8px 20px rgb(0 0 0 / 24%);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.2;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity 90ms ease, transform 90ms ease;
    }
    .secondaryIcon[data-tooltip]:hover::after,
    .secondaryIcon[data-tooltip]:focus-visible::after {
      opacity: 1;
      transform: translateY(0);
    }
    .clock {
      min-width: 150px;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .seek {
      flex: 1;
      min-width: 140px;
    }
    .workspace {
      min-height: 0;
      display: grid;
      grid-template-columns: 1fr;
      overflow: hidden;
    }
    .controls, .settingsPanel {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
      background: var(--vscode-sideBar-background);
    }
    .controls {
      border-right: 1px solid var(--vscode-panel-border);
      overflow: auto;
      padding: 8px;
    }
    .controls[hidden] {
      display: none;
    }
    .controls label, .settingsPanel label, .pcmPanel label {
      display: grid;
      gap: 5px;
    }
    .controlInternals[hidden] {
      display: none;
    }
    .settingsPanel .checkboxLabel {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .controls label span, .settingsPanel label span, .pcmPanel label span {
      color: var(--vscode-descriptionForeground);
    }
    .controls select,
    .controls input[type="number"],
    .controls input[type="text"],
    .settingsPanel select,
    .settingsPanel input[type="number"],
    .pcmPanel select,
    .pcmPanel input[type="number"],
    .pcmPanel input[type="text"] {
      width: 100%;
      min-height: 28px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 3px 6px;
    }
    .pcmPanel select,
    .wavPcmGrid select {
      min-width: 58px;
      padding-right: 22px;
      text-align: left;
    }
    .numericText {
      direction: ltr;
      text-align: left;
      font-variant-numeric: tabular-nums;
    }
    .settingsPanel {
      position: absolute;
      z-index: 35;
      top: 52px;
      right: 12px;
      width: min(280px, calc(100vw - 24px));
      border: 1px solid var(--vscode-panel-border);
      max-height: calc(100vh - 72px);
      overflow: auto;
      box-shadow: 0 12px 30px rgb(0 0 0 / 24%);
    }
    .settingsPanel[hidden] {
      display: none;
    }
    .settingsHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .settingsSection {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding-top: 4px;
    }
    .settingsSection + .settingsSection {
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .settingsSubsection {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 4px;
    }
    .settingsSubsection > strong {
      color: var(--vscode-foreground);
      font-size: 0.95em;
    }
    .primary, .secondary {
      min-height: 32px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      cursor: pointer;
    }
    .primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .secondary.isProminent {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .wheelHint {
      color: var(--vscode-descriptionForeground);
      font-size: 0.88em;
      line-height: 1.35;
      white-space: nowrap;
    }
    .wheelHint kbd {
      display: inline-block;
      min-width: 1.6em;
      padding: 0 4px;
      border: 1px solid var(--vscode-panel-border);
      border-bottom-color: color-mix(in srgb, var(--vscode-panel-border) 65%, #000);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: var(--vscode-input-background);
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 0.92em;
      line-height: 1.4;
      text-align: center;
    }
    .figures {
      --waveform-height: 220px;
      --spectrogram-height: 360px;
      position: relative;
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 0;
      padding: 0 12px 12px;
      overflow: hidden;
      align-content: start;
      justify-items: stretch;
      background: var(--vscode-editor-background);
      margin-top: -1px;
    }
    .figureHeader {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--vscode-foreground);
    }
    .timelineHeader {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      gap: 0;
      min-height: 34px;
      align-items: stretch;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-editor-background);
      box-shadow: 0 1px 0 var(--vscode-editor-background);
    }
    .figures.isFirstTrackSelectedAtTop .timelineHeader {
      border-bottom-color: var(--vscode-focusBorder);
    }
    .timelineRange {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 8px;
      border-right: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      font-variant-numeric: tabular-nums;
      min-width: 0;
    }
    .timelineCanvasWrap {
      position: relative;
      min-width: 0;
      min-height: 32px;
      background: var(--vscode-editor-background);
    }
    .timelineCanvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    .plotPane {
      position: relative;
      min-width: 0;
      min-height: 96px;
      height: 100%;
      align-self: stretch;
      contain: strict;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .trackList {
      position: relative;
      z-index: 2;
      min-height: 0;
      display: grid;
      gap: 0;
      overflow: auto;
      align-content: start;
      scrollbar-gutter: stable;
      margin-top: -1px;
      background: var(--vscode-editor-background);
    }
    .trackRow {
      position: relative;
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      height: var(--track-row-h, 280px);
      min-height: 132px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: visible;
      background: var(--vscode-editor-background);
    }
    .trackRow:first-child {
      margin-top: 0;
    }
    .trackRow + .trackRow {
      margin-top: -1px;
    }
    .trackRow.isSelected {
      z-index: 4;
      border-color: var(--vscode-focusBorder);
      border-radius: 6px;
    }
    .trackRow:first-child.isSelected::after {
      content: none;
    }
    .trackSidebar {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      padding: 8px;
      overflow: hidden;
      border: 0;
      border-right: 1px solid var(--vscode-panel-border);
      border-radius: 5px 0 0 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
    }
    .trackTitle, .trackToggle, .trackMode {
      font: inherit;
      width: 100%;
      text-align: center;
    }
    .trackToggle {
      min-height: 26px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font-variant-numeric: tabular-nums;
      cursor: pointer;
    }
    .trackTitle {
      min-height: 26px;
      display: grid;
      place-items: center;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: transparent;
      font-weight: 600;
    }
    .trackToggle.isActive {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
      font-weight: 600;
    }
    .trackMute.isActive {
      color: #ffffff;
      text-shadow: 0 1px 1px rgb(0 0 0 / 55%);
      background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 88%, #00345f);
      border-color: var(--vscode-charts-blue, #3794ff);
      box-shadow: 0 0 0 1px var(--vscode-charts-blue, #3794ff) inset;
    }
    .trackSolo.isActive {
      color: #1f1300;
      text-shadow: 0 1px 0 rgb(255 255 255 / 32%);
      background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 86%, #ffdf9b);
      border-color: var(--vscode-charts-orange, #d18616);
      box-shadow: 0 0 0 1px var(--vscode-charts-orange, #d18616) inset;
    }
    .trackMode {
      min-height: 26px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      text-align-last: center;
    }
    .trackBody,
    .trackCanvasWrap {
      background: var(--vscode-editor-background);
    }
    .trackBody {
      display: grid;
      grid-template-rows:
        minmax(90px, var(--track-wave-fr, 0.38fr))
        minmax(160px, var(--track-spec-fr, 0.62fr));
      min-width: 0;
      min-height: 0;
      gap: 0;
      overflow: hidden;
      border-radius: 0 5px 5px 0;
    }
    .trackRow[data-mode="waveform"] .trackBody,
    .trackRow[data-mode="spectrogram"] .trackBody {
      grid-template-rows: 1fr;
    }
    .trackRow[data-mode="waveform"] .trackSpectrogramWrap,
    .trackRow[data-mode="spectrogram"] .trackWaveformWrap {
      display: none;
    }
    .trackCanvasWrap {
      position: relative;
      min-width: 0;
      min-height: 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .trackCanvasWrap:last-child {
      border-bottom: 0;
    }
    .trackRowHandle,
    .trackSplitHandle {
      position: absolute;
      left: 0;
      right: 0;
      height: 8px;
      z-index: 6;
      cursor: ns-resize;
      background: transparent;
    }
    .trackRowHandle {
      bottom: 0;
      transform: translateY(50%);
    }
    .trackSplitHandle {
      top: 0;
      transform: translateY(-50%);
    }
    .trackRow[data-mode="waveform"] .trackSplitHandle,
    .trackRow[data-mode="spectrogram"] .trackSplitHandle {
      display: none;
    }
    body.is-resizing {
      user-select: none;
      cursor: ns-resize;
    }
    .trackWaveform:focus,
    .trackSpectrogram:focus {
      outline: none;
    }
    .pcmPanel {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 8px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .pcmReveal {
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .headerInfoButton {
      line-height: 1;
    }
    .headerInfoIcon {
      width: 19px;
      height: 19px;
      display: block;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.7;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .topPcmPanel {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr) max-content;
      grid-template-areas:
        "title fields actions"
        ". status .";
      align-items: center;
      column-gap: 8px;
      row-gap: 5px;
      min-width: min(560px, 100%);
      width: 100%;
      max-width: 100%;
      overflow: visible;
    }
    .topPcmPanel .paneTitle {
      grid-area: title;
      align-self: center;
      justify-self: start;
      white-space: nowrap;
    }
    .topPcmPanel .pcmFields {
      grid-area: fields;
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      justify-content: center;
      gap: 8px;
    }
    .topPcmPanel .pcmActions {
      grid-area: actions;
      display: flex;
      align-items: end;
      justify-content: flex-end;
      gap: 8px;
      min-width: max-content;
    }
    .topPcmPanel label {
      display: grid;
      grid-template-rows: 15px 26px;
      min-width: auto;
      gap: 3px;
      justify-items: center;
      align-items: center;
    }
    .topPcmPanel label span {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 15px;
      text-align: center;
      line-height: 1.2;
      white-space: nowrap;
    }
    .topPcmPanel input,
    .topPcmPanel select {
      height: 26px;
      min-height: 26px;
      padding-top: 2px;
      padding-bottom: 2px;
    }
    .topPcmPanel input {
      text-align: center;
    }
    .topPcmPanel button {
      min-height: 28px;
      white-space: nowrap;
      padding: 0 9px;
    }
    .topPcmPanel #pcmSampleRate {
      width: 8ch;
    }
    .topPcmPanel #pcmChannels {
      width: 4ch;
    }
    .topPcmPanel #pcmStartOffset {
      width: 8ch;
    }
    .topPcmPanel #pcmEncoding {
      width: 168px;
    }
    .topPcmPanel #pcmEndianness {
      width: 78px;
    }
    .topPcmPanel #pcmEdit {
      grid-area: edit;
      display: none;
    }
    .topPcmPanel #pcmStatus {
      grid-area: status;
      position: relative;
      align-self: stretch;
      min-width: 0;
      max-width: 100%;
      white-space: nowrap;
      overflow-x: auto;
      overflow-y: visible;
      line-height: 1.3;
      text-align: center;
      scrollbar-width: none;
    }
    .topPcmPanel #pcmStatus::-webkit-scrollbar {
      display: none;
    }
    .topPcmPanel #pcmStatusText {
      display: block;
      width: max-content;
      max-width: none;
      margin: 0 auto;
      overflow: visible;
      text-overflow: clip;
      white-space: nowrap;
    }
    .topPcmPanel #pcmStatus::after {
      content: attr(data-tooltip);
      position: fixed;
      z-index: 45;
      top: var(--pcm-status-tooltip-top, 52px);
      left: var(--pcm-status-tooltip-left, 12px);
      width: max-content;
      max-width: min(520px, calc(100vw - 36px));
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
      backdrop-filter: blur(8px);
      box-shadow: 0 10px 24px rgb(0 0 0 / 28%);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.45;
      white-space: normal;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-2px);
      transition: opacity 90ms ease, transform 90ms ease;
    }
    .topPcmPanel #pcmStatus:hover::after {
      opacity: 1;
      transform: translateY(0);
    }
    .topPcmPanel[data-collapsed="true"] {
      grid-template-areas: "title status edit";
      align-items: center;
      padding-top: 4px;
      padding-bottom: 4px;
    }
    .topPcmPanel[data-collapsed="true"] .pcmFields {
      display: none;
    }
    .topPcmPanel[data-collapsed="true"] .pcmActions {
      display: none;
    }
    .topPcmPanel[data-collapsed="true"] #pcmEdit {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .topPcmPanel[data-collapsed="true"] #pcmStatus {
      align-self: center;
      justify-self: center;
      width: min(720px, 100%);
      max-width: 100%;
    }
    .topPcmPanel[data-collapsed="true"] #pcmStatusText {
      margin: 0 auto;
    }
    .wavPcmPanel {
      position: fixed;
      z-index: 40;
      top: 58px;
      left: 12px;
      width: min(520px, calc(100vw - 36px));
      display: grid;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
      backdrop-filter: blur(10px);
      box-shadow: 0 16px 36px rgb(0 0 0 / 28%);
    }
    .wavPcmPanel[hidden] {
      display: none;
    }
    .headerInfoPanel {
      position: fixed;
      z-index: 42;
      top: 58px;
      left: 12px;
      width: min(680px, calc(100vw - 24px));
      max-height: min(680px, calc(100vh - 82px));
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
      backdrop-filter: blur(10px);
      box-shadow: 0 16px 36px rgb(0 0 0 / 28%);
    }
    .headerInfoPanel[hidden] {
      display: none;
    }
    .headerInfoHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .headerInfoBody {
      min-height: 0;
      overflow: auto;
    }
    .headerInfoEmpty {
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }
    .headerInfoSummary {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 10px;
      padding: 7px 9px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      line-height: 1.35;
      background: var(--vscode-input-background);
    }
    .headerInfoSummary strong {
      white-space: nowrap;
    }
    .headerInfoSummary span {
      color: var(--vscode-descriptionForeground);
    }
    .headerInfoSummary.is-info {
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 62%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 12%, var(--vscode-input-background));
    }
    .headerInfoSummary.is-warning {
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 62%, var(--vscode-panel-border));
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 10%, var(--vscode-input-background));
    }
    .headerInfoTable {
      width: max-content;
      min-width: 100%;
      max-width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
      table-layout: auto;
      font-size: 12px;
    }
    .headerInfoTable th,
    .headerInfoTable td {
      padding: 3px 6px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
      text-align: left;
      vertical-align: top;
      line-height: 1.3;
    }
    .headerInfoTable td {
      overflow-wrap: anywhere;
    }
    .headerInfoTable th:nth-child(1),
    .headerInfoTable th:nth-child(2),
    .headerInfoTable td:nth-child(1),
    .headerInfoTable td:nth-child(2) {
      white-space: nowrap;
      overflow-wrap: normal;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .headerInfoTable th {
      position: sticky;
      top: 0;
      z-index: 1;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-weight: 600;
    }
    .headerInfoTable .offsetColumn,
    .headerInfoTable .sizeColumn {
      white-space: nowrap;
      overflow-wrap: normal;
    }
    .headerInfoTable .offsetColumn {
      min-width: 92px;
    }
    .headerInfoTable .sizeColumn {
      min-width: 86px;
    }
    .headerInfoTable .bitsColumn {
      min-width: 118px;
      max-width: 150px;
      white-space: nowrap;
      overflow-wrap: normal;
    }
    .headerInfoTable .fieldColumn {
      min-width: 156px;
      max-width: 240px;
    }
    .headerInfoTable .valueColumn {
      min-width: 96px;
      max-width: 190px;
    }
    .headerInfoTable .noteColumn {
      min-width: 128px;
      max-width: 240px;
    }
    .headerInfoTable td:nth-child(3),
    .headerInfoTable td:nth-child(4),
    .headerInfoTable td:nth-child(5) {
      max-width: inherit;
    }
    .headerInfoTable td:nth-child(3) {
      padding-left: calc(6px + var(--header-field-depth, 0) * 16px);
    }
    .headerInfoTable tr[data-kind="box"] td {
      background: color-mix(in srgb, var(--vscode-sideBar-background) 72%, transparent);
    }
    .headerInfoTable tr[data-kind="box"] td:nth-child(3) {
      color: var(--vscode-foreground);
      font-weight: 700;
    }
    .wavPcmHeader {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .wavPcmGrid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .wavPcmGrid label {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .wavPcmGrid label span {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
    }
    .wavPcmGrid input,
    .wavPcmGrid select {
      width: 100%;
      height: 28px;
      text-align: center;
    }
    .wavPcmFooter {
      display: grid;
      grid-template-columns: 1fr auto auto;
      align-items: center;
      gap: 8px;
    }
    .wavPcmFooter #wavPcmStatus {
      min-width: 0;
      white-space: normal;
      line-height: 1.35;
    }
    .pcmPanel[hidden] {
      display: none;
    }
    .helpMenu {
      position: relative;
      flex: 0 0 auto;
    }
    .helpMenu summary {
      position: relative;
      list-style: none;
    }
    .helpMenu summary::-webkit-details-marker {
      display: none;
    }
    .helpMenu .iconButton {
      font-size: 18px;
      line-height: 1;
    }
    .helpPopover {
      position: absolute;
      z-index: 30;
      right: 0;
      top: calc(100% + 8px);
      width: min(430px, calc(100vw - 24px));
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      box-shadow: 0 12px 30px rgb(0 0 0 / 24%);
      line-height: 1.35;
      max-height: min(620px, calc(100vh - 92px));
      overflow: auto;
    }
    .helpSection {
      display: grid;
      gap: 5px;
      padding-bottom: 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
    }
    .helpSection:last-child {
      padding-bottom: 0;
      border-bottom: 0;
    }
    .helpSectionTitle {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .helpRow {
      display: grid;
      grid-template-columns: minmax(160px, 0.48fr) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .helpRow > :first-child {
      color: var(--vscode-descriptionForeground);
      min-width: 0;
    }
    .helpNote {
      color: var(--vscode-descriptionForeground);
    }
    .helpPopover kbd,
    .helpGesture {
      padding: 0 4px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
      font-family: var(--vscode-editor-font-family), monospace;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      display: block;
      border: 0;
      background: var(--vscode-editor-background);
      cursor: crosshair;
    }
    .plotResize {
      position: relative;
      min-height: 12px;
      cursor: row-resize;
      border-radius: 4px;
    }
    .plotResize::before {
      content: "";
      position: absolute;
      inset: 3px 0;
      border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent);
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .plotResize:hover::before,
    .plotResize:active::before {
      opacity: 1;
    }
    .plotResize::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 52px;
      height: 2px;
      border-radius: 999px;
      transform: translate(-50%, -50%);
      background: color-mix(in srgb, var(--vscode-focusBorder) 72%, var(--vscode-panel-border));
    }
    .selectionBox {
      position: fixed;
      border: 1px solid rgba(88, 166, 255, 0.85);
      background: rgba(88, 166, 255, 0.18);
      pointer-events: none;
      z-index: 20;
    }
    .selectionBox.isDraggingSelection {
      border-left-color: transparent;
    }
    .selectionBox::before {
      content: "";
      position: absolute;
      left: 0;
      top: -1px;
      bottom: -1px;
      width: 2px;
      transform: translateX(-1px);
      background: #ffcc66;
      display: none;
    }
    .contextMenu {
      position: fixed;
      z-index: 50;
      min-width: 190px;
      padding: 4px;
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 5px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
      box-shadow: 0 12px 28px rgb(0 0 0 / 32%);
    }
    .contextMenu[hidden] {
      display: none;
    }
    .contextMenu button {
      width: 100%;
      display: block;
      padding: 6px 10px;
      border: 0;
      border-radius: 3px;
      color: inherit;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .contextMenu button:hover,
    .contextMenu button:focus-visible {
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      outline: none;
    }
    .selectionAnalysisPane {
      position: fixed;
      z-index: 25;
      right: 18px;
      top: 112px;
      width: min(220px, calc(100vw - 36px));
      display: grid;
      gap: 8px;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-editor-background) 76%, transparent);
      backdrop-filter: blur(8px);
      box-shadow: 0 12px 28px rgb(0 0 0 / 22%);
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .selectionAnalysisPane[hidden] {
      display: none;
    }
    .paneTitle {
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    .paneTitleRow {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .paneSubtitleRow {
      margin-top: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .paneSubtitle {
      color: var(--vscode-foreground);
      font-size: 0.92em;
      font-weight: 600;
    }
    .analysisHelp,
    .metricHelp {
      position: relative;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      display: inline-grid;
      place-items: center;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 50%;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
      font-size: 11px;
      line-height: 1;
      cursor: help;
    }
    .metricHelp {
      width: 14px;
      height: 14px;
      margin-left: 4px;
      font-size: 10px;
      vertical-align: text-top;
    }
    .floatingTooltip {
      position: fixed;
      z-index: 45;
      left: 12px;
      top: 12px;
      width: min(380px, calc(100vw - 36px));
      padding: 8px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-editor-background) 86%, transparent);
      backdrop-filter: blur(8px);
      box-shadow: 0 10px 24px rgb(0 0 0 / 28%);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.5;
      text-shadow: 0 1px 1px rgb(0 0 0 / 28%);
      white-space: pre-line;
      pointer-events: none;
    }
    .floatingTooltip[hidden] {
      display: none;
    }
    .analysisTable {
      width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      line-height: 1.35;
    }
    .analysisTable th,
    .analysisTable td {
      padding: 4px 0;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
      vertical-align: top;
    }
    .analysisTable tr:first-child th,
    .analysisTable tr:first-child td {
      border-top: 0;
    }
    .analysisTable th {
      width: 1%;
      padding-right: 10px;
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
      text-align: left;
      white-space: nowrap;
    }
    .analysisTable td {
      color: var(--vscode-foreground);
      overflow-wrap: anywhere;
      text-align: right;
    }
    .analysisValueLoading {
      color: var(--vscode-charts-blue, #4fc3f7) !important;
      font-style: italic;
    }
    @media (max-width: 720px) {
      .workspace {
        grid-template-columns: 1fr;
      }
      .controls {
        border-right: 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .controls[hidden] {
        display: none;
      }
      .selectionAnalysisPane {
        right: 12px;
        top: 104px;
      }
    }
  `;
  document.head.appendChild(style);
}
