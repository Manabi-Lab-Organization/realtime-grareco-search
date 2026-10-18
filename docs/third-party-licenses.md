# 使っているライブラリのライセンス

このソフトウェア自体は Apache License 2.0 です（[LICENSE](../LICENSE)・[NOTICE](../NOTICE)）。使っているライブラリは、それぞれのライセンスに従います。

## 全体の状況

各フォルダの `package-lock.json` に載っている依存のうち、開発のときだけ使うものを除いた数です。OS ごとに差し替わるパッケージ（実際に入るのはそのうちの一部）も数に入っています。

| 対象 | 数 | 内訳 |
|---|---|---|
| サーバとウェブ画面（リポジトリ直下） | 612 | MIT 462、Apache-2.0 66、ISC 29、BSD-3-Clause 18、LGPL-3.0-or-later を含むもの 23、BlueOak-1.0.0 5、BSD-2-Clause 2、Unlicense 2、そのほか 5 |
| デスクトップアプリ（`electron-app/`） | 21 | MIT 17、ISC 1、BSD-3-Clause 1、BSD-2-Clause 1、MIT または CC0-1.0 1 |
| iPhone アプリ（`mobile-app/`） | 103 | MIT 79、ISC 11、BlueOak-1.0.0 10、Unlicense 1、Apache-2.0 1、0BSD 1 |

「そのほか」は、MIT-0・0BSD・BSD（`url-template`）が 1 件ずつ、独自の規約（`@anthropic-ai/claude-agent-sdk`、次の節）が 1 件、`package-lock.json` にライセンスの記載が無いもの（`xmlhttprequest-ssl`）が 1 件です。記載が無いものは、配布元でライセンスを確かめてください。

iPhone アプリは、このほかに Swift のパッケージ 3 件を使っています（3 件とも MIT）。ライセンス本文は `mobile-app/ios/native-licenses/` にあります。

## 注意が要るもの

### Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）

リアルタイム調査で使っています。オープンソースのライセンスではなく、Anthropic の規約に従って使うものです。使う前に、パッケージに書かれている規約と Anthropic の利用規約（https://www.anthropic.com/legal）を確かめてください。

### 画像処理の sharp と libvips（LGPL-3.0-or-later）

サーバの画像の縮小などに `sharp` を使っています。`sharp` 自体は Apache-2.0 ですが、一緒に入る `@img/sharp-libvips-*`（libvips）は LGPL-3.0-or-later です。Docker のイメージを作ってほかの人に配る場合は、LGPL の条件（ライセンス本文を添える、利用者が libvips を差し替えられるようにする、など）を確かめてください。libvips のソースは https://libvips.org から入手できます。自分たちのサーバで動かすだけなら、配布にはあたりません。

### Electron と Chromium

デスクトップアプリは Electron（MIT）で作っています。Electron に含まれる Chromium などのライセンスは、アプリに同梱の `LICENSES.chromium.html` にあります。

## 配るアプリのライセンス表示

デスクトップアプリと iPhone アプリには、同梱しているライブラリのライセンス表示を入れています。

- 表示の文書は、ビルドのたびに `scripts/third-party-notices.mjs` が、実際に入るライブラリから作ります（デスクトップアプリは `electron-app/build/THIRD_PARTY_NOTICES.txt`、iPhone アプリは `mobile-app/public/THIRD_PARTY_NOTICES.txt`）
- デスクトップアプリでは、ログイン画面やメイン画面の「ライセンス」から開けます
- iPhone アプリでは、ログイン画面や録音の画面の「ライセンス」から開けます。Swift のパッケージのライセンスも含みます
