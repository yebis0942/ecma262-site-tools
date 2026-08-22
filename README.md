# ecma262-site-tools

[ecmarkup](https://github.com/tc39/ecmarkup) のビルドをラップし、生成された仕様書
HTML にサイト独自のウィジェットを注入し、検証済みのパフォーマンスパッチを
アセットに適用するツール。ecmarkup 本体は fork せず **npm 依存としてピン留め**
する（`package.json` の `ecmarkup` はバージョン完全固定）。

## 使い方

```sh
npm install

# ビルド (単一ページ)。spec.html は ecmarkup ソースをそのまま渡す (事前ビルド不要。
# emu-import もビルド時に解決される)。img/ など ecmarkup が扱わない付属リソースは --copy で。
npx ecma262-build path/to/ecma262/spec.html out/ \
  --version-bar /path/to/version-bar-manifest.json \
  --copy path/to/ecma262/img

# multipage
npx ecma262-build path/to/spec.html out/ --multipage --lint-spec
```

主なオプション:

| フラグ | 意味 |
|---|---|
| `--version-bar <manifest.json>` | version-bar を有効化。per-section データは manifest の隣の `version-bar-data/` から出力へコピーされる |
| `--impl-links <data.json>` | impl-links データの差し替え（既定: 同梱の `data/impl-links.json`） |
| `--no-impl-links` | impl-links ウィジェットを無効化 |
| `--multipage` | multipage ビルド（サブページも相対パスを個別計算して注入） |
| `--no-menu-patches` | menu.js パッチをスキップ（素の ecmarkup 挙動） |
| `--copy <path>` | ファイル/ディレクトリを出力先へコピー（複数指定可）。ecma262 の `img/` のような ecmarkup が扱わないスペック付属リソース用 |

### version-bar データの生成

```sh
npm run generate-version-bar-data -- \
  --config scripts/version-bar-config.json \
  --spec-html path/to/current/spec.html \
  --out-dir /tmp/vb
# → --version-bar /tmp/vb/version-bar-manifest.json
```

公開済み各版の HTML を取得（`.version-cache/` にキャッシュ）し、
manifest とセクション別 JSON を出力する。対象は ES2015〜ES2025 の 11 版
（`scripts/version-bar-config.json`）。ES2016+ は `emu-clause`、
ES2015 は旧形式 `<section id="sec-*">` にフォールバックして抽出する。
保存前にサニタイズ済み（クライアントは innerHTML で挿入するため）。

キャッシュ先はリポジトリルート固定の `.version-cache/`（引数で変更不可）なので、
CI ではそのパスをキャッシュ対象にする。参考実測（11 版・キャッシュ温）:
生成 約 11 秒 / peak rss 約 1.5GB / 出力 81MB・2,295 ファイル。

生成データはスキーマ v2（`schemaVersion: 2`）: 各節をブロック分割した
skeleton + blocks に加え、版間 diff 統計と blame（各ブロックの導入版）を含む。
**旧スキーマのデータは build 時に fail-loud で拒否される**ので、
本ツール更新後は再生成が必要。

## アーキテクチャ

```
ecmarkup.build()  ──(utils.readFile フック: menu.js ソースにパッチ)──▶ generatedFiles
        │
        ▼
  1. 生成 HTML ごとに parse5 でウィジェット注入
     - manifest に載っている各 clause の <h1> 直後に .version-bar
     - <head> に widgets.css / 設定インライン script / ウィジェット script (defer)
     - パスはページごとに相対計算 (multipage サブページ対応)
  2. アセット追加 (widgets.css, versionBarCore/versionBar/versionCompare/implLinks.js,
     version-bar-data/, impl-links.json)
  3. 書き出し
```

### ① 注入型ウィジェット（`assets/` + `lib/inject-widgets.mjs`）

ecmarkup の**出力**（`emu-clause[id]` と h1 という文書構造）にのみ依存し、
内部実装には依存しない。

- **version-bar** — 各節の版ごとの変更量を棒グラフで示すバー。クリックで当該版の
  内容表示（blame トグルで各ブロックの導入版を色分け）、範囲選択で版間 diff
  （unified / side-by-side）。ブロック分割・diff 統計・blame はビルド時に事前計算し、
  クライアントは fetch した分割済みデータを表示するだけ（ビルドとクライアントの
  parse 一致問題を回避し、バー統計とパネル diff の不一致も原理的に排除）
- **version-compare** — ecma262-compare へのリンクボタン（外部 releases.json + 内蔵フォールバック）
- **impl-links** — エンジン実装 (V8/SM/JSC/QJS) へのリンク（`data/impl-links.json`、`scripts/impl-links/` で再生成）

### ② menu.js パッチ（`patches/menu.js/` + `lib/patch-menu.mjs`）

検索の Web Worker 化と ToC スクロール追跡の最適化。upstream に PR できたら
削除する予定の**一時的な差分**。

- 各パッチは `NN-name/{find.txt,replace.txt}`。`find` はピン留めした ecmarkup
  バージョンの menu.js の**正確なソーステキスト**で、**ちょうど1回**一致しな
  ければビルドは失敗する（静かな半適用はしない）
- ecmarkup 24.x はアセットをミニファイするため、パッチは
  `ecmarkup/lib/utils` の `readFile` をフックして**連結・ミニファイ前のソース**
  に適用する。フックが発火しなかった場合もビルドエラーになる

## ecmarkup のアップグレード手順

1. `package.json` の `ecmarkup` を新バージョンに固定して `npm install`
2. `npm test`
3. 失敗した場合:
   - `menu.js patch "NN-…": target text not found` → upstream がその領域を変更
     した。`node_modules/ecmarkup/js/menu.js` の該当領域を確認し、
     `find.txt` を新テキストに、`replace.txt` をそこに fork の変更を適用した
     ものに更新する
   - `patch hook never fired` → アセットパイプラインが変わった。
     `lib/patch-menu.mjs` の `installMenuPatchHook` を再ポート
   - ウィジェット注入のアサート失敗 → 出力 DOM 構造が変わった。
     `lib/inject-widgets.mjs` を確認
4. 実スペックでビルドして目視確認

## 経緯

これらの機能はもともと ecmarkup の fork ブランチとして開発された
（tc39/ecmarkup ローカルクローンの `feature/version-bar` ほか）。
upstream と独立してメンテナンスするため、fork を rebase し続ける代わりに
本リポジトリへ移植した。fork ブランチは参照実装として残っている。
