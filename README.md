# 雨の在処 — Rain Radar

気象庁ナウキャスト（高解像度降水ナウキャスト）と「今後の雨（降水短時間予報）」のタイル画像を地図に重ねて、過去1時間〜予報12時間の降水分布をスライダー操作・アニメーション再生できる、精度メッシュ付きの雨雲レーダーです。GitHub Pages にそのまま置ける静的サイトとして作っています。

![preview](https://via.placeholder.com/900x500.png?text=Rain+Radar+Preview)

## 機能

- 🗾 **日本全域**の雨雲を表示（実況は5分間隔、予報は最大12時間先まで）
- 🎚 **時間スライダー**で過去1時間〜予報12時間をシームレスに移動
- ▶️ **アニメーション再生**（ループ・ステップ送りも可能）
- 🔭 **1h / 6h / 12h** の予報表示範囲切替
- ▦ **精度メッシュ**: 表示中データの概算格子幅（250m / 1km / 5km）を地図上に重ねて表示
- 📍 **現在地表示**（位置情報の許可が必要）
- ⏱ **現在へ戻る**ボタンで最新の実況時刻へ即復帰
- 🕒 **最終更新時刻・最新実況時刻**を常時表示
- 🔁 **手動再読み込み**と5分ごとの自動取得
- ⚠️ **オフライン/取得失敗表示**と再読み込みボタン
- ⌨️ **キーボード操作**: スペースキーで再生/停止、矢印キーで前後の時刻、Homeで現在へ、Rで再取得、Gでメッシュ切替
- 📱 モバイル/タブレット最適化
- 📲 **PWA対応**: ホーム画面に追加してネイティブアプリのように使えます

## 技術スタック

- **地図**: [Leaflet](https://leafletjs.com/) + 地理院タイル（淡色地図）
- **降水タイル**: 気象庁ナウキャスト + 降水短時間予報のタイル画像（PNG, ZL 4-10）
- **精度メッシュ**: Leaflet GridLayer + Canvasで元データの概算格子幅を補助表示
- **フォント**: Shippori Mincho（和文表題）+ Noto Sans JP + JetBrains Mono
- 純粋な HTML/CSS/JS のみ。ビルド不要。

## ローカルで動かす

`fetch` でクロスオリジンのデータを取りに行くため、ファイルプロトコルではなく簡易サーバ経由で開いてください。

```bash
cd rain-radar
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

## GitHub Pages にデプロイする

### 手順

1. **新しいリポジトリを作成**（例: `rain-radar`）

2. **このフォルダのファイルをすべてコミット＆プッシュ**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<あなたのユーザー名>/rain-radar.git
   git push -u origin main
   ```

3. **GitHub の設定で Pages を有効化**
   - リポジトリの **Settings → Pages** を開く
   - *Source*: **Deploy from a branch**
   - *Branch*: **main** / **/(root)**  
   - **Save**

4. 数十秒待つと `https://<ユーザー名>.github.io/rain-radar/` で公開されます。

### カスタムドメインを使う場合

`Settings → Pages → Custom domain` で設定するか、`CNAME` ファイルをルートに置いてください。

## データソース・利用条件

- **降水ナウキャスト / 降水短時間予報**: [気象庁](https://www.jma.go.jp/bosai/nowc/) / [今後の雨](https://www.jma.go.jp/bosai/kaikotan/)
  - タイル URL は気象庁ホームページの内部リソースを利用しています
  - 1時間先までは高解像度降水ナウキャストを優先し、それ以降は降水短時間予報に切り替えます
  - 精度メッシュは降水確率ではなく、元データの概算格子幅を表示する補助レイヤーです
  - ホームページの利用規約に従い、**気象業務法でいう予報業務にあたる利用は禁じられています**
  - 本アプリは参考情報の表示を目的としたものです。防災・業務判断・生命身体に関わる判断には使用しないでください
  - データの可用性・URL構造は予告なく変更される可能性があります
- **背景地図**: [国土地理院 地理院タイル（淡色地図）](https://maps.gsi.go.jp/development/ichiran.html)

詳細は[気象庁ホームページの利用規約](https://www.jma.go.jp/jma/kishou/info/coment.html)を確認してください。

## ファイル構成

```
rain-radar/
├── index.html               # マークアップ
├── style.css                # スタイル
├── app.js                   # アプリロジック
├── sw.js                    # Service Worker
├── manifest.webmanifest     # PWAマニフェスト
├── icon.svg                 # アプリアイコン (SVG)
├── icon-192.png             # アプリアイコン 192px
├── icon-512.png             # アプリアイコン 512px
├── icon-maskable-512.png    # マスカブルアイコン (Android)
├── apple-touch-icon.png     # iOS用アイコン
├── 404.html                 # GitHub Pages 用のフォールバック
└── README.md
```

## PWA について

ホーム画面に追加するとフルスクリーンのスタンドアロンアプリとして起動します。

**キャッシュ戦略**:
- アプリシェル（HTML/CSS/JS/Leaflet/アイコン）: Cache First
- 地理院タイル（背景地図）: Stale While Revalidate（最大420件まで保持）
- 気象庁ナウキャスト/降水短時間予報タイル & JSON: **キャッシュしない**（常に最新を取得）

雨雲データはリアルタイム性が命なのでキャッシュせず、毎回ネットワークから取得します。オフライン時はアプリ自体は起動しますが雨雲は表示されません。

**注意**: Service Workerは `https://` または `localhost` でのみ動作します。GitHub Pagesは自動でHTTPSになるので問題ありません。

## ライセンス

MIT — 自由に改変・利用してください。ただしデータ提供元（気象庁・国土地理院）の利用規約は別途守ってください。
