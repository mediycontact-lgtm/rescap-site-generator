# 技術リファレンス

CLI本体はsite-cli.mjsで、`rescap-site --help` が対応コマンドと引数の契約を表示します。Node.js >=22、Playwright 1.62.1を使います。Chromiumは明示的にbrowser-installで導入します。抽出中はページのスクリプトとネットワークを実行しません。既存ビルドを走らせる責任は生成担当にあります。

## 設定

site-example.jsonとtownlead-html-profile.json、html-example/は合成例です。コピーした設定のURL/公開者/元情報の日時を実際のサイトに合わせ、抽出範囲をレビューします。

```json
{"format":"rescap.site-config.v1","build_dir":"dist","mapping":"mapping.json","public_path":"rescap","public_build":true}
```

パスは設定ファイルの位置から解決します。config/mapping/確認情報は公開ビルドの外に置きます。public_build:trueは公開予定ビルド全体の公開宣言で、自動のプライバシー監査ではありません。public_pathは元ファイルと衝突しないパスです。symlink/特殊ファイル/入力と出力の重なりを拒否します。

HTMLマッピングの契約・抽出はhtml-adapter.mjsにあります。publicなローカルページ、明示的なCSS selector、出典URL、元情報のauthored_at（不明ならnull）を指定します。隠れた/実行される/空白/重複した選択は拒否し、FAQの折りたたみは明示的なdisclosure設定が必要です。外部CSSの表示計算やJavaScript hydration/CMS動的情報は別の対応が必要です。

## 候補と承認

prepareはconfig/mapping/全ビルド/元HTML/抽出結果/生成器/実行時版を候補SHAで束ねます。--generated-atは再現用の生成時刻指定で、元情報の作成日時の証明ではありません。生成時のSHAを保持し、--expectで外部から照合します。自分で計算した整合性だけでは、別候補への丸ごと差し替えは検出できません。

reviewは内部用HTMLを保存します。approveはTTYで確認者名、4項目、最後の承認を要求します。--yesやパイプの自動回答は拒否します。返されたJSONは--expect-approvalで保持したSHAと照合します。approvalsは24時間で期限切れになり、現在のconfig/mapping/build変更でも対応が失われます。assemble-localとlocal-release-verifyは再抽出/現在ビルド/全成果物を検証します。

## 配信

hosting設定を使う場合、対応プロファイルの明示的なserved/unserved配置が候補に入ります。CloudflareのHTML拡張子なしルート、index.htmlのディレクトリURLを事前に決めます。配信検証はリダイレクトや非公開IP/変換済みレスポンスを受け入れません。設定変更は新しい候補と承認を必要とします。ヘッダー/redirect設定が実際にproviderで適用されたか、余分なリモートファイル/所有権は別途未検証として扱います。

RELEASE/publicは後の配信入力です。確認者名、承認JSON、raw source/mapping、レビュー、release.jsonは内部記録です。既存HTMLは承認後に書き換えないため、フッターや機械向けJSON参照は候補作成前にサイトへ入れてください。

## 追加のGitHub方式

github-approval.mjsはID/公開者の採用ポリシー/権限/対象PRとhead/期限に基づく認証済みアカウント承認方式を提供します。github-policy-example.jsonは架空の例です。公開者の実ポリシーから外部SHAを保持して使います。ローカル人申告の承認は、このアカウント方式のゲートへ流用しません。release.mjs/public-reader.mjs/hosting.mjsは承認済み成果物と配信後の厳格な読み戻しを提供し、CLIそのものはホスティングへ自動アップロードしません。
