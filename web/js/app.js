/**
 * app.js — realtime_rppg.py bilan bir xil mantiq va ko'rinish
 */

'use strict';

const FPS          = 30;
const SEND_W       = 320;
const SEND_H       = 240;
const SEND_QUALITY = 0.7;
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
  let stream    = null;
  let animFrame = null;
  let isRunning = false;
  let ws        = null;
  let wsReady   = false;
  let wsSending = false;
  let fpsFrames = 0;
  let fpsTime   = performance.now();

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
      wsSending = false;
      if (isRunning) {
        wsStatus.classList.remove('hidden');
        setTimeout(connectWS, 2000);
      }
    };

    ws.onerror = () => { wsReady = false; };

    ws.onmessage = (e) => {
      wsSending = false;
      try { render(JSON.parse(e.data)); } catch { /* ignore */ }
    };
  }

  function disconnectWS() {
    if (ws) { ws.close(); ws = null; }
    wsReady = wsReady = false;
    wsSending = false;
  }

  // ─── Kadr yuborish ───────────────────────────────────────────────
  function sendFrame() {
    if (!wsReady || wsSending || !ws || video.readyState < 2) return;
    sendCtx.drawImage(video, 0, 0, SEND_W, SEND_H);
    wsSending = true;
    sendCanvas.toBlob(blob => {
      if (!blob || !ws || ws.readyState !== WebSocket.OPEN) {
        wsSending = false; return;
      }
      blob.arrayBuffer()
          .then(buf => { ws.send(buf); setTimeout(() => { wsSending = false; }, 1500); })
          .catch(() => { wsSending = false; });
    }, 'image/jpeg', SEND_QUALITY);
  }

  // ─── Server natijasini ko'rsatish (realtime_rppg.draw_ui bilan bir xil) ──
  function render(r) {
    clearOverlay();

    if (r.has_face && r.bbox) {
      // Yashil to'rtburchak (aynan OpenCV kabi)
      const [bx, by, bw, bh] = r.bbox;
      const sx = overlay.width  / SEND_W;
      const sy = overlay.height / SEND_H;
      octx.strokeStyle = '#00dc00';
      octx.lineWidth   = 2;
      octx.strokeRect(bx * sx, by * sy, bw * sx, bh * sy);

      // "Yuz topildi" matni bbox ustida
      octx.fillStyle = '#00dc00';
      octx.font      = `${Math.round(14 * Math.min(sx, sy))}px Courier New`;
      octx.fillText('Yuz topildi', bx * sx, by * sy - 6);

      faceText.textContent = '';
      faceText.className   = 'cv-face';
    } else {
      // "Yuz topilmadi!" — qizil
      faceText.textContent = 'Yuz topilmadi!';
      faceText.className   = 'cv-face no-face';
    }

    // BPM yoki to'planmoqda matni
    if (r.hr_bpm) {
      const bpm   = r.hr_bpm;
      const color = (bpm >= 50 && bpm <= 120) ? 'green' : 'orange';
      hrText.textContent = `Yurak urishi: ${bpm} BPM`;
      hrText.className   = `cv-hr ${color}`;
      void hrText.offsetWidth;
      hrText.classList.add('pulse');
    } else {
      const remain = r.remain > 0 ? ` ${r.remain}s qoldi` : '';
      hrText.textContent = `Ma'lumot to'planmoqda...${remain}`;
      hrText.className   = 'cv-hr';
    }

    // Progress paneli
    const pct = r.progress || 0;
    progFill.style.width = pct + '%';
    const prog = pct / 100;
    progFill.style.background =
      `rgb(0, ${Math.round(180 * prog)}, ${Math.round(220 * (1 - prog))})`;
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

    sendFrame();
  }

  // ─── Kamera ──────────────────────────────────────────────────────
  async function toggleCamera() {
    isRunning ? stop() : await start();
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 },
                 height: { ideal: 480 }, frameRate: { ideal: FPS } }
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
    hrText.textContent = 'Ma\'lumot to\'planmoqda...';
    hrText.className   = 'cv-hr';
    faceText.textContent = '';
    progFill.style.width = '0%';
    progLabel.textContent = 'Signal: 0%';
    wsStatus.classList.add('hidden');
  }

  function reset() {
    // Serverga reset signali (oddiy yopish-ochish)
    if (ws && wsReady) {
      ws.close();
      ws = null;
      wsReady = false;
      wsSending = false;
      setTimeout(connectWS, 300);
    }
    hrText.textContent = 'Ma\'lumot to\'planmoqda...';
    hrText.className   = 'cv-hr';
    progFill.style.width = '0%';
    progLabel.textContent = 'Signal: 0%';
  }

  function clearOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  return { toggleCamera, reset, stop };

})();
