# QRコードスキャナー

ブラウザ上で動作する静的Webアプリ。以下の方法で取得した画像からQRコードを読み取ります（複数コード対応）。

- 画面キャプチャ（`getDisplayMedia()`）
- クリップボード（ボタン / `Ctrl`・`⌘` + `V`）
- ファイル選択 / ドラッグ&ドロップ

デコードはネイティブ `BarcodeDetector` を優先し、未対応環境では同梱の [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0, `vendor/`）を使用します。画像は外部に送信されません。

## 起動

画面キャプチャ・クリップボードAPIは安全なコンテキスト（HTTPS または localhost）が必要です。

```bash
python3 -m http.server 8000
```

ブラウザで http://localhost:8000 を開きます。GitHub Pages 等の静的ホスティングにもそのまま配置できます。
