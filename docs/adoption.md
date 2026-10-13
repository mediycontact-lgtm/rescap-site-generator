# 既存サイトへのResCap導入と承認の受け渡し

この手順は、既存サイトの公開予定ビルドへResCapを後付けする場合に使います。公開サイトでは小さなフッターリンク程度の露出を想定します。確認HTMLは内部用で、サイトには公開しません。

## 担当と次の操作

| 担当 | 行うこと | 次へ渡すもの |
| --- | --- | --- |
| 生成担当（人・AIを使う担当・CI） | 公開予定ビルドから候補を作り、内容と抽出範囲を確認する | 確認HTML、同じ版のサイトプレビュー、候補SHA |
| 確認者（公開者・委任されたクライアント） | 実際に内容・公開範囲・ポリシー・差分を確認し、承認する | 保存した承認JSON。修正があれば承認せず修正内容 |
| 生成担当 | 返されたJSONと現在のビルドを照合し、公開用ファイルを生成する | 検証済みRELEASE/publicと公開対象のSHA |
| 配信担当 | 対象プロジェクトと配信経路を確認し、公開用ディレクトリだけを配信する | 配信後の公開URLとファイル照合結果 |

同じ人が複数を担当できます。AIが生成担当でも、確認者のチェックを代わりに真と扱ったり、承認JSONを作ったりしません。

## A. 生成担当：導入して候補を用意する

生成担当の環境にはNode.js 22以上、npmとChromiumが必要です。確認者側にはNode/npm/ターミナル/GitHubアカウントは必要ありません。

正式なGitHub Releaseが公開・検証された後は、[配布と導入の手順](../README.md)で固定版tarballを入手できます。公開確認前は、以下のように検証済みソースからローカルtarballを作ります。npm公開済みとは扱いません。

```sh
npm pack . --ignore-scripts --pack-destination /path/to/packages
```

既存サイトのプロジェクトで、実際に作成された0.4.0 tarballを指定します。/path/to/packagesは実際の保存場所に置き換えてください。

```sh
npm install --save-dev --ignore-scripts /path/to/packages/rescap-site-generator-0.4.0.tgz
npx --no-install rescap-site browser-install
npx --no-install rescap-site init rescap.config.json
```

initは設定ファイルのひな型を新規作成するだけです。次を実際のサイトに合わせて設定し、公開予定ビルドを作ってから進みます。

- build_dir：サイトが元から使っている公開予定ビルドのディレクトリ。
- mapping：実際のページ/要素を指定する抽出設定。サイト名、正規URL、公開者、出典URL、料金・条件・注意事項の抽出範囲を確認する。例示の架空名/URL/日時を流用しない。
- public_path：既存ファイルと衝突しないResCap用パス。通常はrescap。
- public_build：ビルド全体が公開してよい範囲だと確認してからtrue。
- 必要な場合はhosting：配信されるURLを明示。Cloudflareのindex.htmlは /、public-information.htmlは拡張子なしURLなど、配信プロファイルを候補作成前に設定する。

元情報の作成日時が不明ならauthored_atはnullです。ビルド時刻・コミット日時を元情報の作成日時に置き換えません。選択していない情報が自動で全部載るわけではないので、抽出漏れを確認します。ビルドを公開してよい宣言はプライバシー監査の代わりではありません。

サイト側では、候補を作る前に公開ResCapへの参照経路も用意します。フッターのサイトマップ近くに小さな公開情報リンクを置く程度で構いません。リンク先はpublic_pathと配信プロファイルで決めた正規URLに合わせます。必要な機械向けJSON参照も同じ版のHTMLに含めます。CLIは承認後に元HTMLを自動で書き換えないため、リンクの追加も候補生成・プレビュー・差分確認に含めてください。

設定の契約とHTMLマッピング例は[generator/README.md](reference.md)を参照してください。サイト固有のビルドコマンドを先に実行します。CLI自体は任意のビルドコマンドを実行しません。

```sh
node -e "require('node:fs').mkdirSync('rescap-private',{recursive:true})"
npx --no-install rescap-site prepare rescap.config.json rescap-private/candidate-001 --revision site-revision-001 --producer "generating executor"
```

prepareの出力にあるcandidate_sha256を控えます。以降のCANDIDATE_SHAにはその64文字をそのまま使います。ハッシュを候補ファイルの自己申告だけから採用せず、生成時の記録と一緒に保持してください。

```sh
npx --no-install rescap-site verify rescap-private/candidate-001 --expect CANDIDATE_SHA --config rescap.config.json
npx --no-install rescap-site review rescap-private/candidate-001 rescap-private/review-001.html --expect CANDIDATE_SHA --config rescap.config.json
```

ここまでが終わったら、候補と同じビルドのサイトプレビュー/変更画像、review-001.htmlを確認者へ内部経路で渡します。確認HTMLだけでは店舗の画像・レイアウト全体を実物として確認できないため、同じ版のプレビューも用意してください。確認待ちの間にビルドを変更しないでください。

## B. ターミナルを持たない確認者：PCで確認して保存する

**【必ず、PCで開いて操作してください。】**

1. 生成担当から受け取った確認HTMLをダウンロードし、PCのブラウザで開きます。PCのChromeを第一候補とします。Edgeで開いて承認JSONを保存できたユーザー実績もありますが、そのOS/Edgeバージョンは未記録です。iPhone/iPad/Safariの実操作は未検証です。
2. 表示されたサイト名・URL・版を確認します。生成担当が渡した同じ版のサイトプレビューと、変更された画像/CSSも確認します。
3. 公開する内容と出典、公開してよい範囲、利用ポリシー、今回の差分を実際に確認します。修正があればチェックせず生成担当へ戻します。
4. 確認者名を入力し、4項目をそれぞれチェックします。公開者または委任された確認者として承認する欄も確認します。
5. 「承認ファイルを保存」を押し、ダウンロードされたrescap-approval.jsonを編集せず生成担当へ返します。

保存だけでは公開されません。「保存しました」の表示後も、実際にダウンロード先にJSONがあることを確認してください。別の候補のJSONや、手打ちで日時だけ変更したファイルを送らないでください。保存できない場合は別のPC/Chromeで確認するか、生成担当へ状況を伝えます。AI/担当者が未実施の確認を代行入力する手順はありません。

### クライアントへ添える文面

> 【必ず、PCで開いて操作してください。】添付の確認HTMLと同じ版のサイトプレビューをご確認ください。内容・公開範囲・利用ポリシー・差分の4項目を実際に確認できたら、お名前とチェックを入力して「承認ファイルを保存」を押し、保存されたJSONを編集せずお返しください。修正が必要な場合は承認せず、修正箇所をお知らせください。この操作だけではサイトは公開されません。

## C. ターミナルで確認する場合

Bのブラウザ保存の代わりに、通常の対話ターミナルで次を実行します。プレビューも同じ版を確認してください。

```sh
npx --no-install rescap-site approve rescap-private/candidate-001 rescap-private/approval-001.json --expect CANDIDATE_SHA --config rescap.config.json
```

確認者名、4項目それぞれの「はい」、最後の「承認」を対話で入力します。否認するとファイルは作られません。パイプ/CIの自動回答や--yesは使えません。BとCは同じ候補への承認方法の選択です。

## D. 生成担当：返されたJSONを検証して公開用ファイルを作る

Bで受け取ったJSONはrescap-private/approval-001.jsonという名前で保管して構いません。ファイル内容は編集しません。次のコマンドでSHA-256を計算します。このNodeコマンドはWindows/macOS/Linuxで使えます。

```sh
node -e "const f=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" rescap-private/approval-001.json
```

その64文字をAPPROVAL_SHAとして保持します。外部の受け渡し記録と候補SHAも照合してください。承認の有効期間は24時間です。

```sh
npx --no-install rescap-site approval-check rescap-private/candidate-001 rescap-private/approval-001.json --expect CANDIDATE_SHA --expect-approval APPROVAL_SHA --config rescap.config.json
npx --no-install rescap-site assemble-local rescap-private/candidate-001 rescap-private/approval-001.json rescap-private/release-001 --expect CANDIDATE_SHA --expect-approval APPROVAL_SHA --config rescap.config.json
```

assemble-localの出力にあるrelease_sha256をRELEASE_SHAとして控えます。検証します。

```sh
npx --no-install rescap-site local-release-verify rescap-private/release-001 rescap-private/candidate-001 rescap-private/approval-001.json --expect CANDIDATE_SHA --expect-approval APPROVAL_SHA --expect-release RELEASE_SHA --config rescap.config.json
```

成功後、配信対象は**rescap-private/release-001/public内だけ**です。rescap-private全体、確認HTML、承認JSON、候補、release.json、レビュー情報を公開しません。元のbuild_dirをそのまま配信しても、承認後に追加したResCapは反映されません。公開用ファイルだけを実際の配信入力に切り替えます。

## E. 配信担当：配信した内容が一致することを確認する

配信直前にも承認期限・現在のビルド・候補/承認/成果物SHAを確認します。ホスティング側の競合する自動デプロイやHTMLへの自動追加が、承認した内容を上書きしない構成にします。

配信サービスの成功表示と、承認済みファイルの一致は別です。公開URLを正規の配信ルートで取得し、公開ファイルの期待SHAと取得したSHAが一致することを確認して完了にします。ファイル数/ルート/照合結果を配信記録へ残します。既存のGitHub/Townlead承認ゲートは別方式で、そのまま保持します。

## 止まった場合の次の操作

| 状況 | 次の操作 |
| --- | --- |
| 内容・画像・CSS・設定を直した | 新しい候補と確認HTMLを作り直し、新しい承認を受ける |
| JSONの構文が無効 | 元の保存操作から正しいファイルを返してもらう。曖昧な手修正を勝手に補わない |
| 候補/承認/成果物SHAが違う | 元の受け渡し記録とファイルを確認。期待SHAをその場で書き換えて通さない |
| 承認が期限切れ | 同じ版でも新しい明示的レビュー/承認を受ける。日時だけ延長しない |
| 公開URLがHTTP200だがJSONでない | 存在しないファイルがHTMLへ転送されている可能性を確認。配信入力と正規ルートを調べる |
| アップロード後の照合が失敗 | 配信済みと一致検証済みを分けて記録し、原因を調べる。成功として先へ進まない |

この承認は人による確認の申告で、本人確認・所有権の認証・電子署名ではありません。ResCapを置けば第三者AIが必ず従うという保証もありません。
