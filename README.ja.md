<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/AudioLens_logo_v2.png" alt="AudioLens" width="180">
</p>

<h1 align="center">AudioLens</h1>

<p align="center">
  <strong>VS Code の中で、音声・ML・信号エンジニアリング向けに音声を確認・解析するためのツールです。</strong>
</p>

<p align="center">
  <a href="#feature-multichannel">波形</a> ·
  <a href="#feature-multichannel">スペクトログラム</a> ·
  <a href="#feature-multichannel">マルチチャンネル</a> ·
  <a href="#feature-selection">選択範囲解析</a> ·
  <a href="#feature-pcm-raw">Raw PCM</a> ·
  <a href="#feature-kaldi-ark">Kaldi WAV Ark</a> ·
  <a href="#remote-ssh">Remote SSH</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens"><img src="https://vsmarketplacebadges.dev/version-short/simzhou.audiolens.svg" alt="VS Code Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens"><img src="https://vsmarketplacebadges.dev/installs-short/simzhou.audiolens.svg" alt="VS Code Marketplace installs"></a>
  <a href="https://open-vsx.org/extension/simzhou/audiolens"><img src="https://img.shields.io/open-vsx/v/simzhou/audiolens?label=Open%20VSX" alt="Open VSX version"></a>
  <a href="https://open-vsx.org/extension/simzhou/audiolens"><img src="https://img.shields.io/open-vsx/dt/simzhou/audiolens?label=Open%20VSX%20downloads" alt="Open VSX downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache 2.0 License"></a>
</p>

<p align="center">
  <a href="#feature-multichannel"><img src="https://img.shields.io/badge/%E3%83%9E%E3%83%AB%E3%83%81%E3%83%81%E3%83%A3%E3%83%B3%E3%83%8D%E3%83%AB-%E9%9F%B3%E5%A3%B0%E3%83%88%E3%83%A9%E3%83%83%E3%82%AF-2ea44f" alt="マルチチャンネル音声トラック"></a>
  <a href="#feature-selection"><img src="https://img.shields.io/badge/%E3%82%B9%E3%83%9A%E3%82%AF%E3%83%88%E3%83%AD%E3%82%B0%E3%83%A9%E3%83%A0-%E8%A7%A3%E6%9E%90-7c3aed" alt="スペクトログラム解析"></a>
  <a href="#feature-pcm-raw"><img src="https://img.shields.io/badge/Raw%20PCM-%E5%AF%BE%E5%BF%9C-f97316" alt="Raw PCM 対応"></a>
  <a href="#feature-kaldi-ark"><img src="https://img.shields.io/badge/Kaldi%20WAV%20Ark-%E5%AF%BE%E5%BF%9C-0ea5e9" alt="Kaldi WAV Ark 対応"></a>
  <a href="#remote-ssh"><img src="https://img.shields.io/badge/Remote%20SSH-%E5%AF%BE%E5%BF%9C-2563eb" alt="Remote SSH 対応"></a>
</p>

<p align="center">
  <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.md">English</a> | <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.zh-CN.md">简体中文</a> | 日本語
</p>

AudioLens は VS Code を実用的な音声ビューアに変えます。音声エンジニア、スピーチエンジニア、ML 実務者が、manifest、書き起こし、ログ、スクリプト、モデル出力の横で、一般的な音声ファイル、Raw PCM ダンプ、Kaldi WAV Ark エントリを直接開けます。

AudioLens は汎用プレイヤーでは足りない日常的なエンジニアリング作業に焦点を当てています。波形とスペクトログラムの確認、マルチチャンネル音声のレビュー、テキスト内の音声パスを開く操作、明示的なパラメータによる Raw PCM のデコード、ヘッダー確認、選択範囲の解析を、ワークスペースから離れずに行えます。

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens"><strong>VS Code Marketplace からインストール</strong></a>
  ·
  <a href="https://open-vsx.org/extension/simzhou/audiolens"><strong>Open VSX からインストール</strong></a>
  ·
  <a href="https://github.com/SimZhou/vscode-audiolens/releases"><strong>VSIX をダウンロード</strong></a>
</p>

## プレビュー

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/Main-Screen-multichannel.ja-JP.png" alt="AudioLens マルチチャンネルメイン画面" width="920">
</p>

## AudioLens を選ぶ理由

| ワークフロー | AudioLens が提供するもの |
| --- | --- |
| 音声・ML データセット | manifest、書き起こし、ログ、学習スクリプト、モデル出力の横で音声を確認できます。 |
| マルチチャンネル音声 | Audacity 風のチャンネルトラック、チャンネルごとの波形/スペクトログラム、ミュート、ソロ、ステレオ downmix 再生。 |
| 音声解析 | 範囲をドラッグし、その選択範囲だけを再生し、RMS、ピーク、クリッピング、支配周波数、スペクトル重心、ゼロ交差率、帯域別エネルギーを確認できます。 |
| Raw データの調査 | サンプルレート、チャンネル数、エンコード、バイト順、バイトオフセットを明示して `.pcm` / `.raw` を開けます。破損または非標準の WAV payload を PCM として読み直すこともできます。 |
| Kaldi ワークフロー | `wav.ark:offset` エントリを開くか、Ark ファイルを開いて offset を手動入力できます。archive 全体を読み込む必要はありません。 |
| リモート開発 | workspace extension として動作するため、Remote SSH ワークスペース上の音声を先にコピーせずにプレビュー・解析できます。 |

## コア機能

| 領域 | 機能 |
| --- | --- |
| 再生 | 音声を開いた直後から `Space` で再生/一時停止、seek、選択範囲再生、再生ゲイン、チャンネルごとのミュートとソロ。 |
| 可視化 | 波形、スペクトログラム、複合表示、共有タイムライン、ドラッグ可能なトラック高さと波形/スペクトログラム比率、ズーム、パン、リセット。 |
| スペクトログラム解析 | Frequency、Reassignment、Pitch (EAC) アルゴリズム、最大 `32768` の FFT、多様な窓関数、周波数スケール、パレット、自動輝度。 |
| ファイル確認 | WAV/RIFF、FLAC、Ogg、MP4/M4A、AAC/ADTS、MP3/MPEG フレームの構造化ヘッダー表示。 |
| データセット移動 | 通常のテキストファイル内の音声パスを hover、ステータスバー、コマンドから開けます。大量の inline link は生成しません。 |
| 設定保存 | デフォルトのトラック表示、スペクトログラム設定、再生ゲイン、PCM 既定値、表示言語を保存します。 |

## インストール

**推奨: Visual Studio Marketplace からインストール**

https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens

**代替: Open VSX からインストール**

https://open-vsx.org/extension/simzhou/audiolens

**コマンドライン**

```bash
code --install-extension simzhou.audiolens
```

**オフライン VSIX**

```bash
code --install-extension dist/audiolens-1.5.1.vsix
```

## デモ

<a id="feature-multichannel" name="feature-multichannel"></a>

### 1. マルチチャンネルトラックと複合表示

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/1.multi-channel_tracks_and_multi-view.ja-JP.gif" alt="マルチチャンネルトラックと複合表示のデモ" width="920">
</p>

<a id="feature-selection" name="feature-selection"></a>

### 2. 選択範囲の再生と解析

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/2.selection_playback_and_analysis.ja-JP.gif" alt="選択範囲の再生と解析のデモ" width="920">
</p>

<a id="feature-pcm-raw" name="feature-pcm-raw"></a>

### 3. PCM / RAW ファイルを開く

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/3.pcm_raw_parameterized_loading.ja-JP.gif" alt="PCM と RAW のパラメータ指定読み込みデモ" width="920">
</p>

### 4. 音声ヘッダーをワンクリックで確認

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/4.Inspect_Audio_Headers_in_One_Click.ja-JP.gif" alt="音声ヘッダー確認のデモ" width="920">
</p>

### 5. 任意のファイルから音声パスを開く

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/5.open_audio_paths_from_any_file.ja-JP.gif" alt="任意のファイルから音声パスを開くデモ" width="920">
</p>

<a id="feature-kaldi-ark" name="feature-kaldi-ark"></a>

### 6. Kaldi WAV Ark を直接開く

- 方法 1: `wav.ark:offset` を Ctrl + クリック。Kaldi Reader と併用します: [GitHub](https://github.com/SimZhou/vscode-kaldi-reader)、[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=simzhou.kaldi-reader)、[Open VSX](https://open-vsx.org/extension/simzhou/kaldi-reader)。
- 方法 2: `.ark` ファイルを開いて offset を手動入力。他の拡張機能は不要です。

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/6.open_kaldi_wav_ark_directly.ja-JP.gif" alt="Kaldi WAV Ark を直接開くデモ" width="920">
</p>

## 対応ファイル

AudioLens は一般的なエンコード形式にはブラウザの音声スタックを使い、VS Code ワークスペース互換のために拡張ホスト側でファイルを読み取ります。

| 種類 | 拡張子 | 備考 |
| --- | --- | --- |
| WAV | `.wav` | マルチチャンネル WAV、RIFF chunk の順序表示、標準 44 バイト PCM ヘッダー確認、一時的な raw PCM 読み直しに対応します。 |
| Kaldi wav ark | `wav.ark:23252` のような `.ark` エントリ | `AudioLens: Open Kaldi WAV Ark Entry` コマンドを使うか、`.ark` ファイルを直接開いて offset を入力します。AudioLens は offset 位置が `RIFF/WAVE` であることを確認し、その WAV entry だけを読み込みます。 |
| エンコード音声 | `.mp3`、`.flac`、`.ogg`、`.opus`、`.m4a`、`.aac` | まず VS Code Webview のデコーダを使います。主要なコンテナまたはフレームヘッダーを確認でき、必要に応じて拡張ホスト側の FFmpeg によるフォールバック変換を使います。 |
| Raw PCM | `.pcm`、`.raw` | 読み込み前に PCM パラメータを明示的に指定する必要があります。 |

## マルチチャンネル音声を見る

マルチチャンネル音声は、実際の各チャンネルを個別のトラックとして表示します。各トラックには左側の小さな操作エリアと、右側の広い解析エリアがあります。

- `Mute` はそのチャンネルを再生から外します。
- `Solo` はそのチャンネルだけを再生し、他のチャンネルを無音にします。
- 表示モードのセレクタで、チャンネルごとに波形、スペクトログラム、複合表示を切り替えられます。
- トラック下端をドラッグするとトラック全体の高さを変更できます。複合表示では、波形とスペクトログラムの境界をドラッグして高さの比率を変更できます。
- いずれかのドラッグ可能な境界をダブルクリックすると、保存済みの既定レイアウトに戻ります。最新のレイアウトは別の音声ファイルを開いたときにも引き継がれます。
- トラックをクリックすると、そのチャンネルが選択範囲解析の対象になります。

波形色はチャンネル間で統一されているため、選択状態によって比較しにくくなることはありません。隣接トラックは境界線を共有したコンパクトな表示になり、選択中のトラックには丸みのあるフォーカス枠が表示されます。

## PCM ファイルを開く

`.pcm` と `.raw` ファイルでは、読み込み前に PCM パラメータを指定します。

- サンプルレート
- チャンネル数
- エンコード。例: Signed 16-bit PCM、Unsigned 8-bit PCM、32-bit float、64-bit float
- バイト順。8-bit エンコードでは自動的にバイト順なしになります
- 開始オフセットのバイト数

現在の PCM パラメータは既定値として保存でき、次回以降の PCM ファイルに再利用できます。Raw PCM には信頼できるメタデータが含まれないため、AudioLens はファイル名やディレクトリ名からパラメータを推定しません。

WAV ファイルも上部バーから PCM として読み直せます。この操作は現在のファイルに対する一時的な処理で、raw payload、非標準ヘッダー、オフセットに敏感なテストファイルの確認に役立ちます。

## Kaldi WAV Ark ファイルを開く

Command Palette から `AudioLens: Open Kaldi WAV Ark Entry` を実行し、`wav.ark:offset` の場所を入力します。`.ark` ファイルを直接開いた場合は、AudioLens が読み込む offset を求めます。

AudioLens が対応するのは、payload が WAV `RIFF/WAVE` ヘッダーから始まる ark エントリだけです。WAV ヘッダーのサイズを使って選択された entry だけを読み込み、ark ファイル全体をスキャンしたり読み込んだりしません。

## 任意のファイルから音声パスを開く

AudioLens は通常のテキストファイル内にある対応音声パスを検出し、AudioLens エディタで直接開けます。音声パスにホバーして **AudioLens で開く** をクリックするか、パス上にカーソルを置いてステータスバーの操作または `AudioLens: カーソル位置の音声パスを開く` を使います。絶対パスに加えて、現在のテキストファイルのディレクトリ、workspace フォルダー、任意設定の base directory から相対パスを解決します。

Command Palette から `AudioLens: 「AudioLens で開く」をオン/オフ` を実行すると、この機能をオン/オフできます。既定では有効で、ドキュメント全体に inline link を生成しないため、大きな JSON、ログ、データセットでもエディタの応答性を保ちます。

Kaldi の `*.ark:offset` リンクは意図的に Kaldi Reader に任せます。

## ヘッダー情報

上部バーのドキュメントアイコンから、構造化されたヘッダー項目を VS Code 内で確認できます。AudioLens はファイル内の順序に沿って項目を表示し、chunk ベースの形式ではバイトオフセット、ADTS AAC や MPEG 音声フレームのような packed header では bit range を表示します。

WAV ファイルでは、標準 44 バイト PCM ヘッダーかどうか、または `fmt` 拡張や `LIST` メタデータなどの追加 chunk を含むかどうかを示します。音声 payload 行はデータ領域だけを示し、raw サンプルバイトは展開しません。

## 選択範囲解析

波形またはスペクトログラム上でドラッグすると、時間範囲を選択できます。AudioLens はその範囲だけを再生し、アクティブなチャンネルに対して解析指標を計算できます。

現在の指標:

- 開始時刻、終了時刻、長さ
- RMS レベルとピークレベル
- 支配的な周波数
- クレストファクター
- クリッピング比率
- ノイズフロア推定
- スペクトル重心
- ゼロ交差率
- 周波数帯域ごとのエネルギー分布

各指標の横にある Tooltip では、計算方法、用途、注意点を確認できます。

## スペクトログラム設定

AudioLens は音声や信号確認に使いやすいスペクトログラム設定を備えています。

- アルゴリズム: Frequency、Reassignment、Pitch (EAC)
- FFT サイズ: `8` から `32768`
- 窓関数: Rectangular、Bartlett、Hamming、Hann、Blackman、Blackman-Harris、Welch、Gaussian 系
- ゼロパディング倍率: `1` から `128`
- 周波数スケール: Linear、Log、Mel、Bark、ERB
- 表示のみに影響する周波数範囲を設定でき、最大値を Nyquist に追従させることもできます
- パレット: Rose、Classic、Grayscale、Inverse Grayscale
- dB 輝度範囲と自動輝度

右上の設定メニューから、これらのスペクトログラム設定を現在の表示の近くで調整できます。表示専用の周波数範囲や、最大周波数を Nyquist に追従させる設定もここで扱えます。

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/config_menu.ja-JP.png" alt="AudioLens スペクトログラム設定メニュー" width="260">
</p>

重いスペクトログラム解析は Worker の境界の向こうで実行されるため、Webview の操作感を妨げにくくなっています。

## ショートカット

音声を開くと、アクティブなスペクトログラムまたは波形がすぐにキーボード操作可能になるため、`Space` で直ちに再生または一時停止できます。

| 操作 | ショートカット |
| --- | --- |
| 再生 / 一時停止 | `Space` |
| 選択範囲または再生カーソルをクリア | `Esc` |
| 時間ズームをリセット | `Ctrl` / `Command` + `F` |
| macOS の時間ズーム | `Command` + マウスホイール |
| Windows/Linux の時間ズーム | `Ctrl` + マウスホイール |
| 表示時間範囲のパン | `Shift` + マウスホイール |
| macOS の振幅ズーム | `Option` + マウスホイール |
| Windows/Linux の振幅ズーム | `Alt` + マウスホイール |
| 再生ゲインをリセット | ゲインスライダーをダブルクリック |

## インターフェース言語

AudioLens は既定で VS Code の表示言語に従います。`audiolens.language` 設定、または Command Palette の `AudioLens: Switch Language` から Webview の言語を上書きできます。

対応言語:

簡体字中国語、繁体字中国語、英語、日本語、韓国語、フランス語、ドイツ語、ロシア語、スペイン語、イタリア語、ポルトガル語、インドネシア語、ノルウェー語、オランダ語、ポーランド語、トルコ語、ベトナム語。

新しい UI 文字列は、各ロケールの翻訳がそろうまで英語へフォールバックします。

<a id="remote-ssh" name="remote-ssh"></a>

## Remote SSH で使う

AudioLens は workspace extension として動作します。Remote SSH ウィンドウでは、拡張ホストがリモートワークスペース側で動き、リモートの音声ファイルを読み取ってローカルの Webview に渡します。

現在のリモート音声を保存したい場合は、上部バーのダウンロードボタンを使えます。VS Code の保存ダイアログは最初にリモート側を表示することがあるため、ローカルに保存する場合はダイアログ内でローカルの保存先へ切り替えてください。

## プライバシー

AudioLens は音声ファイルを第三者サービスへアップロードしません。音声データは VS Code 拡張ホストで読み取られ、VS Code Webview と Worker ランタイム内で解析されます。

## 開発

```bash
npm install
npm run build
npm run typecheck
npm run rust:test
npm run package
```

VS Code で `F5` を押し、AudioLens の拡張デバッグ設定を選択します。その後、Extension Development Host で対応する音声ファイルを開きます。

## 作者

SimZhou: https://simzhou.com/ja/about/

## AudioLens を支援する

AudioLens が音声、スピーチ、信号エンジニアリングの作業に役立つ場合は、継続的な開発を支援していただけます。

### Ko-fi

Ko-fi で AudioLens を支援する: https://ko-fi.com/simzhou

### WeChat

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/wechat_support.jpeg" alt="WeChat appreciation code" width="240">
</p>

## ライセンス

Copyright (c) 2026 SimZhou.

Licensed under the Apache License, Version 2.0.
