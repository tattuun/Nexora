# Nexora（研究開発支援システム）

研究テーマごとに「その日、研究のどの部分を、どうやって、なぜ進めたか」を残すためのWebアプリです。
GitHub Pages で公開し、データは Firebase（Firestore）に保存します。ビルド不要の静的サイトです。

## できること

- カテゴリ（研究テーマ）ごとの日次記録：作業内容／理由・意図／結果・次にやること
- 詳細：目的・最終期限・ロードマップ（マイルストーンと期限、残り日数）
- 前回の「結果・次にやること」を、新しい記録の入力画面の上に表示
- GitHub連携：カテゴリにリポジトリを登録すると、記録の日付のコミットが一覧に出て、チェックで紐づけ
- 添付（任意）：写真・スクショ（Ctrl+V で貼り付け可）、600KBまでの小さなファイル
- 週次まとめ：1週間の記録からゼミ報告の下書きを作成（Claude API、または依頼文をコピーして claude.ai に貼る）
- バックアップ：Markdown／JSON（添付込み）で書き出し、JSONから復元
- ホーム：全カテゴリの近い期限と最近の記録を一覧（左上の「Nexora」でいつでも戻れる）

## 使い方（普段の1日の流れ）

保管場所の役割分担はこうなっています。

```
【GitHub】tattuun/Nexora ……… Nexoraアプリ本体
【GitHub】研究コードのリポジトリ … 例：tattuun/check-swing（コードと変更履歴）
【Firebase】Firestore ………… 日々の記録（作業・理由・結果など）
```

コードの「何を変えたか」は GitHub が正確に覚える。人が書くのは「なぜそうしたか」だけ。

### ① 研究する（いつも通り）

VS Code などで `infer.py` を直して、動かして、結果を見ます。

### ② キリのいいところで GitHub に送る

VS Code の左側にある「ソース管理」で、変更内容をひとこと書いて（例：「FP16エンジン生成を追加」）「コミット」を押し、続けて「同期」を押します。
これで GitHub に「10/21 14:05 FP16エンジン生成を追加」という履歴が残ります。1日に何回やっても構いません。

### ③ Nexora で記録を書く

1. 卒研カテゴリで「＋ 追加」を押す
2. 上に、前回の「次にやること」が表示される
3. 「この日のコミット」欄に、②の履歴が自動で並ぶので、関係するものにチェックを付ける
4. 「なぜそうしたか」などを書いて保存（Ctrl+Enter でも保存できます）

疲れている日は「ひとことで」だけでも保存できます。

### ④ 後で振り返るとき

記録のカードにコミットのリンクが付いているので、クリックすると GitHub で「その日、どの行をどう変えたか」が色分けで見られます。
週末は「週次まとめ」で、1週間分の記録からゼミ報告の下書きを作れます。

### コミット連携の初回準備（カテゴリごとに1回）

1. 研究コードのフォルダを GitHub のリポジトリにする（VS Code の「ソース管理」→「GitHub に公開」。非公開でOK）
   - 先に `.gitignore` で大きいファイル（`.pt` `.engine` `.onnx`、動画、データセット、出力フォルダ）を除外しておく。GitHub は1ファイル100MBまで
2. Nexora のカテゴリの「詳細」→「GitHubリポジトリ」に `tattuun/check-swing` のように書いて保存
3. 非公開リポジトリなら、Nexora の「設定・バックアップ」に GitHub トークンを入れる（作り方は下の「任意の設定」）

## まず試す（デモモード）

`js/config.js` が空のままだと、ブラウザだけに保存するデモモードで動きます。

```bash
cd research-log
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

※ `index.html` をダブルクリックで開くと ES モジュールが読み込めないので、上のように簡易サーバーを使ってください。

## 本番セットアップ（30分ほど）

### 1. Firebase プロジェクトを作る（無料の Spark プランで足ります）

1. https://console.firebase.google.com/ で「プロジェクトを作成」（Googleアナリティクスは不要）
2. 左メニュー「構築 → Authentication」→「始める」→ ログイン方法で **Google** を有効化
3. 「構築 → Firestore Database」→「データベースを作成」
   - ロケーション：`asia-northeast1`（東京）
   - **本番環境モード** で開始
4. Firestore の「ルール」タブに、このリポジトリの `firestore.rules` の中身を貼って「公開」
5. 「プロジェクトの設定（歯車）」→「マイアプリ」→ `</>`（ウェブ）でアプリを登録
   - 表示された `firebaseConfig` の値を `js/config.js` に貼り付け
   - Firebase Hosting は **不要**（チェックしない）

### 2. GitHub に置いて公開する

1. GitHub で新しいリポジトリを作成（例：`research-log`）
2. このフォルダの中身を push
   ```bash
   git init && git add . && git commit -m "first commit"
   git branch -M main
   git remote add origin git@github.com:<ユーザー名>/research-log.git
   git push -u origin main
   ```
3. リポジトリの Settings → Pages → Source を **Deploy from a branch**、Branch を `main` / `/(root)` にして Save
4. 数分後に `https://<ユーザー名>.github.io/research-log/` で開けます

### 3. ログインできるようにする

1. Firebase の Authentication → 設定 → **承認済みドメイン** に `<ユーザー名>.github.io` を追加
2. サイトを開いて Google でログイン
3. 「設定・バックアップ」画面に出る **UID** をコピーし、`firestore.rules` を次のようにして再度公開すると、自分以外のアカウントを完全に締め出せます（推奨）

```
allow read, write: if request.auth != null && request.auth.uid == uid
                   && uid == "ここにUID";
```

`js/config.js` の `ALLOWED_EMAIL` に自分のメールを入れると、他アカウントでログインした時に画面上でも弾きます。

### 4. 任意の設定（アプリの「設定・バックアップ」画面）

| 項目 | 用途 | 作り方 |
|---|---|---|
| GitHubトークン | 非公開リポジトリのコミット表示。公開リポジトリのみなら不要（ただし1時間60回まで） | GitHub → Settings → Developer settings → Fine-grained tokens。対象リポジトリを選び、Repository permissions は **Contents: Read-only** のみ |
| Anthropic APIキー | 週次まとめをボタン1つで作成 | https://console.anthropic.com/ で発行。**ワークスペースの利用上限（Spend limit）を設定** しておく |

トークンとAPIキーは、その端末のブラウザ（localStorage）にだけ保存され、Firestore には送りません。PCとスマホで使う場合はそれぞれで入力してください。

## データ構造（Firestore）

```
users/{uid}/categories/{id}   名前・目的・期限・repos[]・milestones[]
users/{uid}/logs/{id}         日付・作業・理由・結果・commits[]・attach[]（サムネのみ）
users/{uid}/attachments/{id}  添付の本体（dataURL、1件1MB未満）
users/{uid}/summaries/{週の月曜日}  週次まとめの下書き
```

## 運用のコツ

- **コードはGitで管理し、記録には「なぜ」を書く**：コミットメッセージは「何を変えたか」、記録は「なぜそうしたか」と役割を分けると、後から読み返して一番役に立ちます
- 疲れている日は「ひとことで」だけでも保存できます（必須項目はそれだけ）
- 月に1回くらい JSON バックアップを取っておくと安心です

## 制限・注意

- コミット一覧は各リポジトリの **既定ブランチ** のみです
- 添付は Firestore に保存するため、1件1MB未満（画像は自動縮小）。大きいファイルは Google Drive などに置いてリンク欄へ
- Firestore の無料枠：保存 1GiB、読み取り 5万回/日、書き込み 2万回/日（個人利用なら十分）
- 週次まとめの API 呼び出しはブラウザから直接行います（`anthropic-dangerous-direct-browser-access` ヘッダー）。自分専用サイトで、キーを自分の端末にだけ置く前提の設計です
