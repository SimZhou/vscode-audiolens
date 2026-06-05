<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/AudioLens_logo_v2.png" alt="AudioLens" width="180">
</p>

<h1 align="center">AudioLens</h1>

<p align="center">
  <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.md">English</a> | <a href="https://github.com/SimZhou/vscode-audiolens/blob/main/README.zh-CN.md">简体中文</a> | 日本語
</p>

<p align="center"><em>"恥ずかしながら、ほんの小さな仕事をしただけです。"</em></p>

---

AudioLens は Visual Studio Code 上で動く音声確認・解析用の拡張機能です。音声、スピーチ、機械学習、データアノテーションの作業で、音声ファイルをコード、ラベル、スクリプト、テストデータと同じワークスペース内で確認できるようにします。

音声ファイルを開くと、AudioLens は読み取り専用エディタの中で再生、マルチチャンネルトラック、波形、スペクトログラム、選択範囲再生、PCM 設定、実用的な解析指標を表示します。

## プレビュー

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/Main-Screen-multichannel.ja-JP.png" alt="AudioLens マルチチャンネルメイン画面" width="920">
</p>

## 主な機能

- `wav`、`mp3`、`flac`、`ogg`、`opus`、`m4a`、`aac`、`pcm`、`raw` ファイル、および Kaldi wav ark エントリを開けます。
- テキストファイル内の対応音声パスをリンク化し、AudioLens で開けます。
- モノラルとマルチチャンネル音声を、Audacity 風の独立したトラックとして表示します。
- 各チャンネルごとに波形、スペクトログラム、波形 + スペクトログラムの複合表示を選べます。
- チャンネルごとのミュートとソロに対応し、再生時は通常のステレオ出力へダウンミックスします。
- 上部バーから WAV、FLAC、Ogg、MP4/M4A、AAC、MP3 のコンテナまたはコーデックヘッダーを確認できます。
- サンプルレート、チャンネル数、エンコード、バイト順、開始オフセットを指定して raw PCM を読み込めます。
- WAV ファイルを raw PCM として一時的に読み直せるため、ヘッダーオフセットや破損ファイルの確認に使えます。
- `wav.ark:offset` から Kaldi wav ark 音声エントリを開け、ark ファイル全体は読み込みません。
- 選択範囲に対して時間領域と周波数領域の解析指標を計算します。
- スペクトログラム設定、再生ゲイン、デフォルトのトラック表示、PCM 既定値などを保存します。
- ローカル VS Code と Remote SSH ワークスペースの両方で動作します。

## デモ

### マルチチャンネルトラックと複合表示

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/1.multi-channel_tracks_and_multi-view.ja-JP.gif" alt="マルチチャンネルトラックと複合表示のデモ" width="920">
</p>

### 選択範囲の再生と解析

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/2.selection_playback_and_analysis.ja-JP.gif" alt="選択範囲の再生と解析のデモ" width="920">
</p>

### PCM / RAW のパラメータ指定読み込み

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/docs/assets/readme/3.pcm_raw_parameterized_loading.ja-JP.gif" alt="PCM と RAW のパラメータ指定読み込みデモ" width="920">
</p>

## 対応ファイル

AudioLens は一般的なエンコード形式にはブラウザの音声スタックを使い、VS Code ワークスペース互換のために拡張ホスト側でファイルを読み取ります。

| 種類 | 拡張子 | 備考 |
| --- | --- | --- |
| WAV | `.wav` | マルチチャンネル WAV、RIFF chunk の順序表示、標準 44 バイト PCM ヘッダー確認、一時的な raw PCM 読み直しに対応します。 |
| Kaldi wav ark | `wav.ark:23252` のような `.ark` エントリ | `AudioLens: Open Kaldi WAV Ark Entry` コマンドを使うか、`.ark` ファイルを直接開いて offset を入力します。AudioLens は offset 位置が `RIFF/WAVE` であることを確認し、その WAV entry だけを読み込みます。 |
| エンコード音声 | `.mp3`、`.flac`、`.ogg`、`.opus`、`.m4a`、`.aac` | まず VS Code Webview のデコーダを使います。主要なコンテナまたはフレームヘッダーを確認でき、必要に応じて拡張ホスト側の FFmpeg によるフォールバック変換を使います。 |
| Raw PCM | `.pcm`、`.raw` | 読み込み前に PCM パラメータを明示的に指定する必要があります。 |

## マルチチャンネルワークフロー

マルチチャンネル音声は、実際の各チャンネルを個別のトラックとして表示します。各トラックには左側の小さな操作エリアと、右側の広い解析エリアがあります。

- `Mute` はそのチャンネルを再生から外します。
- `Solo` はそのチャンネルだけを再生し、他のチャンネルを無音にします。
- 表示モードのセレクタで、チャンネルごとに波形、スペクトログラム、複合表示を切り替えられます。
- トラックをクリックすると、そのチャンネルが選択範囲解析の対象になります。

波形色はチャンネル間で統一されているため、選択状態によって比較しにくくなることはありません。隣接トラックは境界線を共有したコンパクトな表示になり、選択中のトラックには丸みのあるフォーカス枠が表示されます。

## PCM ワークフロー

`.pcm` と `.raw` ファイルでは、読み込み前に PCM パラメータを指定します。

- サンプルレート
- チャンネル数
- エンコード。例: Signed 16-bit PCM、Unsigned 8-bit PCM、32-bit float、64-bit float
- バイト順。8-bit エンコードでは自動的にバイト順なしになります
- 開始オフセットのバイト数

現在の PCM パラメータは既定値として保存でき、次回以降の PCM ファイルに再利用できます。Raw PCM には信頼できるメタデータが含まれないため、AudioLens はファイル名やディレクトリ名からパラメータを推定しません。

WAV ファイルも上部バーから PCM として読み直せます。この操作は現在のファイルに対する一時的な処理で、raw payload、非標準ヘッダー、オフセットに敏感なテストファイルの確認に役立ちます。

## Kaldi WAV Ark ワークフロー

Command Palette から `AudioLens: Open Kaldi WAV Ark Entry` を実行し、`wav.ark:offset` の場所を入力します。`.ark` ファイルを直接開いた場合は、AudioLens が読み込む offset を求めます。

AudioLens が対応するのは、payload が WAV `RIFF/WAVE` ヘッダーから始まる ark エントリだけです。WAV ヘッダーのサイズを使って選択された entry だけを読み込み、ark ファイル全体をスキャンしたり読み込んだりしません。

## 音声パスリンク

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
- パレット: Rose、Classic、Grayscale、Inverse Grayscale
- dB 輝度範囲と自動輝度

重いスペクトログラム解析は Worker の境界の向こうで実行されるため、Webview の操作感を妨げにくくなっています。

## ショートカット

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

## ローカライズ

AudioLens は既定で VS Code の表示言語に従います。`audiolens.language` 設定、または Command Palette の `AudioLens: Switch Language` から Webview の言語を上書きできます。

対応言語:

簡体字中国語、繁体字中国語、英語、日本語、韓国語、フランス語、ドイツ語、ロシア語、スペイン語、イタリア語、ポルトガル語、インドネシア語、ノルウェー語、オランダ語、ポーランド語、トルコ語、ベトナム語。

新しい UI 文字列は、各ロケールの翻訳がそろうまで英語へフォールバックします。

## Remote SSH

AudioLens は workspace extension として動作します。Remote SSH ウィンドウでは、拡張ホストがリモートワークスペース側で動き、リモートの音声ファイルを読み取ってローカルの Webview に渡します。

現在のリモート音声を保存したい場合は、上部バーのダウンロードボタンを使えます。VS Code の保存ダイアログは最初にリモート側を表示することがあるため、ローカルに保存する場合はダイアログ内でローカルの保存先へ切り替えてください。

## プライバシー

AudioLens は音声ファイルを第三者サービスへアップロードしません。音声データは VS Code 拡張ホストで読み取られ、VS Code Webview と Worker ランタイム内で解析されます。

## インストール

Visual Studio Marketplace からインストール:

https://marketplace.visualstudio.com/items?itemName=simzhou.audiolens

Open VSX からもインストールできます:

https://open-vsx.org/extension/simzhou/audiolens

またはコマンドラインからインストール:

```bash
code --install-extension simzhou.audiolens
```

## VSIX からインストール

GitHub Releases から VSIX をダウンロードするか、ローカルで作成したパッケージをインストールできます:

```bash
code --install-extension dist/audiolens-1.3.2.vsix
```

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

AudioLens が音声、スピーチ、データアノテーションの作業に役立つ場合は、継続的な開発を支援していただけます。

### Ko-fi

Ko-fi で AudioLens を支援する: https://ko-fi.com/simzhou

### WeChat

<p align="center">
  <img src="https://raw.githubusercontent.com/SimZhou/vscode-audiolens/main/logo/wechat_support.jpeg" alt="WeChat appreciation code" width="240">
</p>

## Copyright

Copyright (c) 2026 SimZhou. All rights reserved.
