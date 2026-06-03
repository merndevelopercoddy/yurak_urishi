/**
 * app.js — JPEG kadrlarni serverga fire-and-forget yuborish.
 * Server realtime_rppg.py bilan aynan bir xil kod orqali qayta ishlaydi.
 */

'use strict';

const FPS          = 30;
const SEND_FPS     = 10;                // serverga 10fps — Haar cascade tezligiga mos
const SEND_MS      = 1000 / SEND_FPS;  // 100ms
const JPEG_QUALITY = 0.80;
const SEND_W       = 320;
const SEND_H       = 240;
const MAX_WS_BUF   = 30_000;           // 30KB — buferi to'lsa o'tkazib yuborish
const WS_PROTO     = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL       = `${WS_PROTO}//${location.host}/ws`;

const App = (() => {

  // ─── DOM ─────────────────────────────────────────────────────────
  const video     = document.getElementById('video');
  const overlay   = document.getElementById('overlay');
  const hrText    = document.getElementById('hr-text');
  const faceText  = document.getElementById('face-text');
  const progFill  = document.getElementById('progress-fill');
  const progLabel = document.getElementById('progress-label');
  const fpsBadge  = document.getElementById('fps-badge');
  const btnStart  = document.getElementById('btn-start');
  const wsStatus  = document.getElementById('ws-status');

  const octx = overlay.getContext('2d');

  const sendCanvas = document.createElement('canvas');
  sendCanvas.width  = SEND_W;
  sendCanvas.height = SEND_H;
  const sendCtx = sendCanvas.getContext('2d');

  // ─── Holat ───────────────────────────────────────────────────────
  let stream     = null;
  let animFrame  = null;
  let isRunning  = false;
  let ws         = null;
  let wsReady    = false;
  let lastSendMs  = 0;
  let blobPending = false;   // bir vaqtda faqat bitta blob
  let fpsFrames   = 0;
  let fpsTime     = performance.now();
  let lastResult  = null;

  // ─── WebSocket ───────────────────────────────────────────────────
  function connectWS() {
    if (ws) return;
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      wsReady = true;
      wsStatus.classList.add('hidden');
    };

    ws.onclose = () => {
      wsReady = false;
      ws = null;
      if (isRunning) {
        wsStatus.classList.remove('hidden');
        setTimeout(connectWS, 2000);
      }
    };

    ws.onerror = () => { wsReady = false; };

    // Server natijasi kelganda ko'rsatish
    ws.onmessage = (e) => {
      try {
        lastResult = JSON.parse(e.data);
        renderResult(lastResult);
      } catch { /* ignore */ }
    };
  }

  function disconnectWS() {
    if (ws) { ws.close(); ws = null; }
    wsReady = false;
  }

  // ─── JPEG kadrni serverga yuborish ───────────────────────────────
  function sendFrame() {
    if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (video.readyState < 2) return;
    if (blobPending) return;                     // oldingi blob tayyorlanmoqda
    if (ws.bufferedAmount > MAX_WS_BUF) return;  // bufer to'lib ketgan — o'tkazib yubor

    sendCtx.drawImage(video, 0, 0, SEND_W, SEND_H);
    blobPending = true;
    sendCanvas.toBlob(blob => {
      blobPending = false;
      if (!blob || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_WS_BUF) return;
      blob.arrayBuffer().then(buf => ws.send(buf)).catch(() => {});
    }, 'image/jpeg', JPEG_QUALITY);
  }

  // ─── Server natijasini ko'rsatish (draw_ui kabi) ──────────────────
  function renderResult(r) {
    clearOverlay();

    if (r.has_face && r.bbox) {
      const [bx, by, bw, bh] = r.bbox;
      const sx = overlay.width  / SEND_W;
      const sy = overlay.height / SEND_H;

      // Yashil to'rtburchak
      octx.strokeStyle = '#00dc00';
      octx.lineWidth   = 2;
      octx.strokeRect(bx * sx, by * sy, bw * sx, bh * sy);

      // "Yuz topildi" matni
      octx.fillStyle = '#00dc00';
      octx.font      = `${Math.round(14 * Math.min(sx, sy))}px Courier New`;
      octx.fillText('Yuz topildi', bx * sx, by * sy - 6);

      faceText.textContent = '';
      faceText.className   = 'cv-face';
    } else {
      faceText.textContent = 'Yuz topilmadi!';
      faceText.className   = 'cv-face no-face';
    }

    // BPM yoki to'planmoqda
    if (r.hr_bpm) {
      const bpm   = r.hr_bpm;
      const color = (bpm >= 50 && bpm <= 120) ? 'green' : 'orange';
      hrText.textContent = `Yurak urishi: ${bpm} BPM`;
      hrText.className   = `cv-hr ${color}`;
    } else {
      const rem = r.remain > 0 ? ` ${r.remain}s qoldi` : '';
      hrText.textContent = `Ma'lumot to'planmoqda...${rem}`;
      hrText.className   = 'cv-hr';
    }

    // Progress
    const pct = r.progress || 0;
    progFill.style.width = pct + '%';
    const p = pct / 100;
    progFill.style.background =
      `rgb(0, ${Math.round(180 * p)}, ${Math.round(220 * (1 - p))})`;
    progLabel.textContent = `Signal: ${pct}%`;
  }

  // ─── Asosiy tsikl ────────────────────────────────────────────────
  function loop() {
    if (!isRunning) return;
    animFrame = requestAnimationFrame(loop);
    if (video.readyState < 2) return;

    if (overlay.width !== video.videoWidth) {
      overlay.width  = video.videoWidth;
      overlay.height = video.videoHeight;
    }

    fpsFrames++;
    const now = performance.now();
    if (now - fpsTime >= 1000) {
      fpsBadge.textContent = fpsFrames + ' fps';
      fpsFrames = 0; fpsTime = now;
    }

    // 30fps da kadr yuborish (throttle)
    if (now - lastSendMs >= SEND_MS) {
      lastSendMs = now;
      sendFrame();
    }
  }

  // ─── Kamera ──────────────────────────────────────────────────────
  async function toggleCamera() {
    isRunning ? stop() : await start();
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user',
                 width:     { ideal: 640 },
                 height:    { ideal: 480 },
                 frameRate: { ideal: FPS } }
      });
      video.srcObject = stream;
      await video.play();
      isRunning = true;
      btnStart.textContent = 'Kamerani o\'chirish';
      wsStatus.classList.remove('hidden');
      connectWS();
      loop();
    } catch (err) {
      alert('Kameraga kirish imkoni yo\'q: ' + err.message);
    }
  }

  function stop() {
    isRunning = false;
    if (animFrame) cancelAnimationFrame(animFrame);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    disconnectWS();
    btnStart.textContent = 'Kamerani yoqish';
    clearOverlay();
    hrText.textContent   = 'Ma\'lumot to\'planmoqda...';
    hrText.className     = 'cv-hr';
    faceText.textContent = '';
    progFill.style.width = '0%';
    progLabel.textContent = 'Signal: 0%';
    wsStatus.classList.add('hidden');
    lastResult = null;
  }

  function reset() {
    if (ws) { ws.close(); ws = null; wsReady = false; }
    lastResult = null;
    setTimeout(connectWS, 300);
    hrText.textContent    = 'Ma\'lumot to\'planmoqda...';
    hrText.className      = 'cv-hr';
    progFill.style.width  = '0%';
    progLabel.textContent = 'Signal: 0%';
  }

  function clearOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  return { toggleCamera, reset, stop };

})();
