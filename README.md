# QRコードスキャナー

ブラウザ上で動作する静的Webアプリ。以下の方法で取得した画像からQRコードを読み取ります（複数コード対応）。

- 画面キャプチャ（`getDisplayMedia()`）
- クリップボード（ボタン / `Ctrl`・`⌘` + `V`）
- ファイル選択 / ドラッグ&ドロップ

デコードはネイティブ `BarcodeDetector` → [zxing-wasm](https://github.com/Sec-ant/zxing-wasm)（MIT / zxing-cpp: Apache-2.0）→ [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0）の順に試します（いずれも `vendor/` に同梱）。小さい画像は拡大して再試行します。画像は外部に送信されません。

## 起動

画面キャプチャ・クリップボードAPIは安全なコンテキスト（HTTPS または localhost）が必要です。

```bash
python3 -m http.server 8000
```

ブラウザで http://localhost:8000 を開きます。GitHub Pages 等の静的ホスティングにもそのまま配置できます。
