(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const statusEl = $('#status');
  const resultsEl = $('#results');
  const previewWrap = $('#preview-wrap');
  const previewCanvas = $('#preview');
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const tpl = $('#result-tpl');

  const MAX_CODES = 20;

  function setStatus(msg, kind = '') {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- 画像ソース ----------

  async function captureScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('このブラウザは画面キャプチャ (getDisplayMedia) に対応していません。');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      // 最初のフレームが描画されるまで待つ
      await new Promise((r) =>
        'requestVideoFrameCallback' in video
          ? video.requestVideoFrameCallback(() => r())
          : setTimeout(r, 300)
      );
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return canvas;
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  async function readClipboardImage() {
    if (!navigator.clipboard?.read) {
      throw new Error('このブラウザはボタンからのクリップボード読み取りに対応していません。Ctrl/⌘ + V で貼り付けてください。');
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return item.getType(type);
    }
    throw new Error('クリップボードに画像がありません。');
  }

  async function blobToCanvas(blob) {
    let source;
    try {
      source = await createImageBitmap(blob);
    } catch {
      // createImageBitmap が扱えない形式 (一部の SVG 等) は <img> 経由で読む
      source = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした。')); };
        img.src = url;
      });
    }
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // 透過 PNG の背景を白に
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0);
    source.close?.();
    return canvas;
  }

  // ---------- QR デコード ----------
  // 優先順: BarcodeDetector (ネイティブ) → zxing-wasm → jsQR
  // 小さい画像は拡大して再試行する (小さく写ったQRや低解像度の貼り付け画像対策)

  const UPSCALE_TARGET = 1600; // 拡大時の長辺の目標ピクセル数
  const UPSCALE_MAX = 6;       // 最大拡大率

  function scaledCanvas(canvas, scale) {
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  function unscale(codes, scale) {
    if (scale === 1) return codes;
    return codes.map((c) => ({ ...c, corners: c.corners.map((p) => ({ x: p.x / scale, y: p.y / scale })) }));
  }

  let nativeDetector = null;
  async function getNativeDetector() {
    if (nativeDetector !== null) return nativeDetector;
    nativeDetector = false;
    try {
      if ('BarcodeDetector' in window) {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          nativeDetector = new BarcodeDetector({ formats: ['qr_code'] });
        }
      }
    } catch { /* 非対応 */ }
    return nativeDetector;
  }

  async function decodeNative(canvas) {
    const det = await getNativeDetector();
    if (!det) return [];
    try {
      const found = await det.detect(canvas);
      return found.map((b) => ({ data: b.rawValue, corners: b.cornerPoints, engine: 'BarcodeDetector' }));
    } catch {
      return [];
    }
  }

  let zxingReady = null;
  function initZXing() {
    if (zxingReady) return zxingReady;
    if (typeof ZXingWASM === 'undefined') return (zxingReady = Promise.resolve(false));
    const wasmUrl = new URL('vendor/zxing_reader.wasm', document.baseURI).href;
    ZXingWASM.setZXingModuleOverrides({
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    });
    zxingReady = ZXingWASM.getZXingModule().then(() => true, (e) => {
      console.warn('zxing-wasm の読み込みに失敗しました。jsQR を使用します。', e);
      return false;
    });
    return zxingReady;
  }

  async function decodeZXing(canvas) {
    if (!(await initZXing())) return null; // null = 利用不可
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const found = await ZXingWASM.readBarcodes(img, {
      formats: ['QRCode', 'MicroQRCode', 'rMQRCode'],
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: true,
      maxNumberOfSymbols: MAX_CODES,
    });
    return found
      .filter((r) => r.isValid)
      .map((r) => {
        const p = r.position;
        return { data: r.text, corners: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft], engine: 'zxing' };
      });
  }

  // jsQR は1回で1つしか検出しないため、見つけた領域を塗りつぶして繰り返す
  function decodeJsQR(canvas) {
    if (typeof jsQR !== 'function') return [];
    const work = document.createElement('canvas');
    work.width = canvas.width;
    work.height = canvas.height;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);

    const out = [];
    for (let i = 0; i < MAX_CODES; i++) {
      const img = ctx.getImageData(0, 0, work.width, work.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (!code) break;
      const loc = code.location;
      const corners = [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner];
      out.push({ data: code.data, corners, engine: 'jsQR' });
      // 検出済み領域を少し広げて塗りつぶす
      const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
      const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
      ctx.fillStyle = '#808080';
      ctx.beginPath();
      corners.forEach((p, j) => {
        const x = cx + (p.x - cx) * 1.25;
        const y = cy + (p.y - cy) * 1.25;
        j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
    }
    return out;
  }

  // 1つのスケールで各エンジンを試す
  async function decodeAtScale(canvas) {
    const native = await decodeNative(canvas);
    if (native.length) return native;
    const zx = await decodeZXing(canvas);
    if (zx && zx.length) return zx;
    return decodeJsQR(canvas);
  }

  async function decodeAll(canvas) {
    const scales = [1];
    const longSide = Math.max(canvas.width, canvas.height);
    if (longSide < UPSCALE_TARGET) {
      const s = Math.min(UPSCALE_MAX, UPSCALE_TARGET / longSide);
      if (s >= 1.5) scales.push(s);
      if (s >= 3) scales.push(s / 2);
    }

    const results = [];
    const seen = new Set();
    for (const scale of scales) {
      const target = scale === 1 ? canvas : scaledCanvas(canvas, scale);
      const codes = unscale(await decodeAtScale(target), scale);
      for (const r of codes) {
        const key = r.data + '|' + Math.round(r.corners[0].x / 10) + ',' + Math.round(r.corners[0].y / 10);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(r);
      }
      if (results.length) break;
    }
    return results;
  }

  // ---------- 表示 ----------

  function drawPreview(canvas, codes) {
    previewCanvas.width = canvas.width;
    previewCanvas.height = canvas.height;
    const ctx = previewCanvas.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const lw = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 300));
    codes.forEach((c, i) => {
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = lw;
      ctx.beginPath();
      c.corners.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      const fs = lw * 6;
      ctx.font = `bold ${fs}px sans-serif`;
      const label = String(i + 1);
      const { x, y } = c.corners[0];
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(x - lw, y - fs - lw * 2, ctx.measureText(label).width + lw * 3, fs + lw * 2);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + lw / 2, y - lw * 1.5);
    });
    previewWrap.hidden = false;
  }

  function isHttpUrl(s) {
    try {
      const u = new URL(s.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function renderResults(codes) {
    resultsEl.replaceChildren();
    codes.forEach((c, i) => {
      const node = tpl.content.cloneNode(true);
      node.querySelector('.badge').textContent = `#${i + 1}`;
      node.querySelector('.data').textContent = c.data;
      const open = node.querySelector('.open');
      if (isHttpUrl(c.data)) {
        open.href = c.data.trim();
        open.hidden = false;
      }
      const copyBtn = node.querySelector('.copy');
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(c.data);
          copyBtn.textContent = 'コピーしました';
        } catch {
          copyBtn.textContent = 'コピー失敗';
        }
        setTimeout(() => (copyBtn.textContent = 'コピー'), 1500);
      });
      resultsEl.appendChild(node);
    });
  }

  // ---------- 処理の流れ ----------

  let busy = false;
  async function run(label, getCanvas) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('.sources button').forEach((b) => (b.disabled = true));
    try {
      setStatus(`${label}: 画像を取得中…`);
      const canvas = await getCanvas();
      setStatus(`${label}: 解析中… (${canvas.width}×${canvas.height})`);
      const codes = await decodeAll(canvas);
      drawPreview(canvas, codes);
      renderResults(codes);
      if (codes.length) {
        setStatus(`${label}: ${codes.length} 件のQRコードを検出しました。`, 'ok');
      } else {
        setStatus(`${label}: QRコードが見つかりませんでした。`, 'err');
      }
    } catch (e) {
      if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') {
        setStatus('操作がキャンセルされたか、許可されませんでした。', 'err');
      } else {
        setStatus(e?.message || String(e), 'err');
      }
    } finally {
      busy = false;
      document.querySelectorAll('.sources button').forEach((b) => (b.disabled = !!b.dataset.unsupported));
    }
  }

  async function handleBlobs(label, blobs) {
    const images = blobs.filter((b) => b && b.type.startsWith('image/'));
    if (!images.length) {
      setStatus('画像ファイルが含まれていません。', 'err');
      return;
    }
    // 複数ファイルはまとめて結果を表示 (プレビューは最後の1枚)
    if (images.length === 1) return run(label, () => blobToCanvas(images[0]));
    if (busy) return;
    busy = true;
    try {
      const all = [];
      let last = null, lastCodes = [];
      for (const [i, blob] of images.entries()) {
        setStatus(`${label}: 解析中… (${i + 1}/${images.length})`);
        const canvas = await blobToCanvas(blob);
        const codes = await decodeAll(canvas);
        all.push(...codes);
        last = canvas;
        lastCodes = codes;
      }
      drawPreview(last, lastCodes);
      renderResults(all);
      setStatus(`${label}: ${images.length} 枚から ${all.length} 件のQRコードを検出しました。`, all.length ? 'ok' : 'err');
    } catch (e) {
      setStatus(e?.message || String(e), 'err');
    } finally {
      busy = false;
    }
  }

  // ---------- イベント ----------

  $('#btn-screen').addEventListener('click', () => run('画面キャプチャ', captureScreen));
  $('#btn-clipboard').addEventListener('click', () =>
    run('クリップボード', async () => blobToCanvas(await readClipboardImage()))
  );

  fileInput.addEventListener('change', () => {
    handleBlobs('ファイル', [...fileInput.files]);
    fileInput.value = '';
  });

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile());
    if (files.length) {
      e.preventDefault();
      handleBlobs('クリップボード', files);
    }
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'drop' || e.target === dropzone) dropzone.classList.remove('over');
    })
  );
  document.addEventListener('drop', (e) => {
    handleBlobs('ファイル', [...(e.dataTransfer?.files || [])]);
  });
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  if (!navigator.mediaDevices?.getDisplayMedia) {
    $('#btn-screen').disabled = true;
    $('#btn-screen').dataset.unsupported = '1';
    $('#btn-screen').title = 'このブラウザは画面キャプチャに対応していません';
  }
})();
