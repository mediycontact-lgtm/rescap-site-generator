# ResCap site generator

既存の静的サイトへResCapを後付けするMITライセンスのソフトウェアです。生成担当は人・AIを使う担当・CIのいずれでも構いません。確認者は、通常のターミナル、またはPCで開く内部用確認HTMLで明示的に承認します。公開サイトでの露出はフッターの小さい参照リンク程度を想定します。

## 導入

Node.js 22以上が生成担当に必要です。正式Releaseが公開済みなら、そのtarballとチェックサムをダウンロードし照合します。まだ公開されていない版をnpm公開済みとは扱いません。ソースからも次のようにpackできます。

```sh
npm pack . --ignore-scripts
npm install --save-dev --ignore-scripts "/actual/path/rescap-site-generator-0.4.0.tgz"
npx --no-install rescap-site browser-install
npx --no-install rescap-site init rescap.config.json
```

続きは[導入と承認の受け渡し](docs/adoption.md)、設定は[技術リファレンス](docs/reference.md)を参照してください。init後に実際のサイトのビルド/マッピングを設定し、候補作成・確認・承認JSONの照合・組み立てを行います。配信するのは検証済みRELEASE/public内だけです。

確認者には **【必ず、PCで開いて操作してください。】** を添えて確認HTMLと同じ版のサイトプレビューを渡します。確認者側にはターミナル・Node・GitHubアカウントは不要です。確認HTMLや承認JSONは公開サイトへ置きません。

## 検証

```sh
npm install --ignore-scripts
node node_modules/playwright/cli.js install chromium
node --test tests/smoke.mjs
```

同梱HTML/設定とテストは架空の例です。公開者/URL/日時として実サイトに流用しません。CLIのヘルプは `npx --no-install rescap-site --help` で確認できます。

## 公開リポジトリの範囲

このリポジトリは配布用ディレクトリのソーススナップショットを受け取ります。ソフトウェア、公開向け手順、合成テスト、ファイル検証manifestだけを含み、元の開発リポジトリの履歴・承認記録は含みません。release-manifest.jsonは公開スナップショット内の各ファイルとGit blob/SHA-256を結びます。同期は履歴のforce mirrorではなく、公開側のコミットへ新しいスナップショットを追加します。

人の確認は申告として記録され、本人/所有権の認証や電子署名ではありません。ResCapによる第三者AIの認識・遵守は保証しません。ソフトウェアMITライセンスとサイト情報の利用ポリシーは別の対象です。ソフトウェアの公開だけで店舗ページが承認・配信されることはありません。

実環境CIはLinux、Windows Server 2022 x64、macOS 14 arm64で通っています。Windows 10/11の手操作・Intel Mac・実機Safariは未検証です。npmレジストリ公開は未確認です。
