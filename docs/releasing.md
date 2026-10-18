# アプリのビルドと配布（メンテナー向け）

デスクトップアプリ（Mac / Windows）と iPhone アプリを作って配る手順です。サーバを立ち上げるだけの人は読まなくてかまいません（[setup.md](setup.md)）。

## 版の付け方

版は `1.2.3` の形（大きな変更・機能の追加・修正）で付けます。

| 対象 | 版を書く場所 | 上げ方 |
|---|---|---|
| デスクトップアプリ | `electron-app/package.json` | `cd electron-app && npm version 1.2.3 --no-git-tag-version`（`package-lock.json` も一緒に変わるので、両方をコミットする） |
| iPhone アプリ | Xcode の App ターゲットの Version と Build | Version を上げ、Build は提出のたびに 1 つ上げる |
| サーバ | `server/package.json` | `/api/server-info` で返る版。サーバとアプリのやりとりの決まりを変えたときは `server/src/services/serverInfo.ts` の `API_LEVEL` も見直す |

アプリの中身が変わったのに版を上げないと、同じ版で中身の違うものが出回ります。アプリを変えたら必ず上げてください。

古いアプリを使えなくしたいときは、サーバの `.env` の `MIN_DESKTOP_VERSION`・`MIN_MOBILE_VERSION` に最低の版を書きます。それより古いアプリには更新を促す表示が出ます。

## Mac

### 用意するもの

- Apple Developer Program に入っていること
- キーチェーンに「Developer ID Application」の証明書が入っていること
- 公証（notarization）の認証情報をキーチェーンに保存しておくこと

  ```sh
  xcrun notarytool store-credentials <プロファイル名> --apple-id <Apple ID> --team-id <チーム ID>
  ```

### ビルド

```sh
cd electron-app
npm ci
export APPLE_KEYCHAIN_PROFILE=<プロファイル名>
export APPLE_TEAM_ID=<チーム ID>
npm run build:mac -- -c.directories.output="$HOME/grareco-build"
```

- 署名と公証は `electron-builder.yml` の設定（`hardenedRuntime`・`notarize: true`）に従って自動で行われます。Intel の Mac でも Apple シリコンの Mac でも動く DMG（ユニバーサル版、`-universal.dmg`）が1つできます
- **出力先は、iCloud Drive などで同期しないフォルダにしてください。** デスクトップや書類のフォルダが同期されていると、ビルドの途中でファイルが書き換わり、署名や公証が失敗することがあります。上の例のように `-c.directories.output=…` で出力先を変えられます

## Windows

Windows 用は、Mac の上で作って署名します（`electron-app/scripts/sign.js`）。署名にはクラウド型のコード署名証明書（Certum の SimplySign）を使います。

### 用意するもの

- `osslsigncode` と、PKCS 11 方式のエンジン（`sign.js` に書いた場所に入っていること）
- SimplySign Desktop
- 証明書の公開部分（`electron-app/certs/certum-code-signing.pem`）

### ビルド

1. **SimplySign Desktop を起動し、クラウドに接続しておきます。** 接続していないと署名が失敗します
2. ビルドします

   ```sh
   cd electron-app
   npm run build:win -- -c.directories.output="$HOME/grareco-build"
   ```

`RealtimeGraRecoSearch-<版>-setup.exe` ができます。Mac と同じく、出力先は同期しないフォルダにします。ほかの証明書で署名する場合は、`sign.js` を自分の環境に合わせて書き換えてください。

## GitHub Releases に出す

```sh
gh release create v1.2.3 \
  --repo Manabi-Lab-Organization/realtime-grareco-search \
  --title "v1.2.3" \
  --notes "- 会議の一覧がすばやく開くようになりました
- 文字起こしが途中で止まることがある問題を直しました" \
  "$HOME/grareco-build/RealtimeGraRecoSearch-1.2.3-universal.dmg" \
  "$HOME/grareco-build/RealtimeGraRecoSearch-1.2.3-setup.exe"
```

- 各社のサーバの `/download` は、最新のリリースから Mac 用（`-universal.dmg`。無ければ `-arm64.dmg`）と Windows 用（`.exe`）を選んで出します。ファイル名を変えないでください
- リリースの説明（`--notes`）は、各社のサーバの「更新履歴」のページにそのまま出ます。利用者が読んで分かる平易な日本語で、何が良くなったかを箇条書きで書きます

## iPhone

### ビルドと提出

1. ウェブ画面をビルドして、iPhone のプロジェクトに取り込みます

   ```sh
   cd mobile-app
   npm ci
   npm run ios
   ```

2. Xcode で `mobile-app/ios/App/App.xcodeproj` を開きます
3. 版を上げ（「版の付け方」）、Product → Archive を実行します
4. できたアーカイブを Distribute App から App Store Connect に送ります
5. App Store Connect で審査に出します

Swift のパッケージを足したり版を変えたりしたときは、ライセンス本文を取り込み直します（[third-party-licenses.md](third-party-licenses.md)）。

```sh
cd mobile-app
node ../scripts/third-party-notices.mjs --app . --collect-swift <Xcode の SourcePackages/checkouts のフォルダ>
```

### 審査メモに書くこと

- このアプリは、利用する組織が自分で立ち上げたサーバに接続して使うこと。最初に接続先のアドレスを入力すること
- 審査で使える接続先のアドレスと、テスト用のアカウント（メールアドレスとパスワード）
- マイクは会議の音声を文字にするために使うこと
- カメラは任意の機能（会議室のカメラ観察）でだけ使い、既定では止まっていて、本人が同意したときだけ動くこと。画像は保存せず、文章だけを残すこと
- Google ログインは任意で、メールアドレスとパスワードでもログインできること

## 自分でビルドする人へ

このリポジトリには、株式会社学びラボが公式版を作って配るための値が入っています。自分でビルドして配るときは、次を自分のものに変えてください。

| 変えるもの | 場所 |
|---|---|
| アプリの ID（`jp.manabi-lab.grareco`） | `electron-app/electron-builder.yml` の `appId`、`electron-app/src/main/index.ts` の `setAppUserModelId`、`mobile-app/capacitor.config.ts` の `appId`、Xcode の Bundle Identifier |
| Apple のチーム ID（`DEVELOPMENT_TEAM`） | Xcode の Signing & Capabilities の Team |
| Mac の署名と公証 | 自分の Developer ID の証明書と、自分の公証の認証情報を使う |
| Windows の署名 | `electron-app/scripts/sign.js` と `electron-app/certs/` を自分の証明書に合わせる。署名しない場合は `electron-builder.yml` の `win.signtoolOptions` を外す |
| デスクトップアプリの配布元 | サーバの `.env` の `GITHUB_REPO` に自分のリポジトリを書く。接続先が未設定のときにアプリが開くページ（`electron-app/src/main/apiClient.ts` の `getDownloadPageURL`）と、上の `gh release create` の `--repo` も書き換える |

iPhone アプリをビルドするときは、次の環境変数を付けて `npm run ios` を実行します。

| 環境変数 | 内容 |
|---|---|
| `SERVER_URL` | 接続先の入力欄に最初から入れておくサーバのアドレス（任意） |

Google ログインを使う場合は、Xcode で `Info.plist` の URL Types に、iOS 用クライアント ID を逆順にした値（`com.googleusercontent.apps.` で始まるもの）を URL スキームとして足してください。
