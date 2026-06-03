/**
 * app.js — brauzerda yuz aniqlash + RGB ajratish
 * Serverga faqat [has_face, R, G, B] = 16 bayt yuboriladi.
 * realtime_rppg.py bilan bir xil algoritm.
 */

'use strict';

const FPS          = 30;
const SEND_MS      = 1000 / FPS;   // 33ms — 30fps da yuborish
const WS_PROTO     = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL       = `${WS_PROTO}//${location.host}/ws`;

// Yuz aniqlash uchun offscreen canvas
const DET_W = 320, DET_H = 240;

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

  // Piksel o'qish uchun canvas
  const detCanvas = document.createElement('canvas');
  detCanvas.width  = DET_W;
  detCanvas.height = DET_H;
  const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });

  // ─── Holat ───────────────────────────────────────────────────────
  let stream      = null;
  let animFrame   = null;
  let isRunning   = false;
  let ws          = null;
  let wsReady     = false;
  let lastSendMs  = 0;
  let fpsFrames   = 0;
  let fpsTime     = performance.now();

  // Yuz aniqlash
  let faceDetector  = null;
  let lastBBox      = null;   // {x,y,w,h} — DET_W/DET_H koordinatlarida
  let detPending    = false;
  let loopFrame     = 0;

  // ─── Chrome FaceDetector ─────────────────────────────────────────
  async function initDetector() {
    if (!('FaceDetector' in window)) return;
    try {
      faceDetector = new window.FaceDetector({ maxDetectedFaces: 1, fastMode: true });
    } catch { faceDetector = null; }
  }

  function scheduleDetect() {
    if (detPending || !faceDetector || video.readyState < 2) return;
    detPending = true;
    faceDetector.detect(video).then(faces => {
      if (faces.length > 0) {
        const b  = faces[0].boundingBox;
        const sx = DET_W / video.videoWidth;
        const sy = DET_H / video.videoHeight;
        lastBBox = {
          x: b.x * sx, y: b.y * sy,
          w: b.width * sx, h: b.height * sy
        };
      } else {
        lastBBox = null;
      }
      detPending = false;
    }).catch(() => { lastBBox = null; detPending = false; });
  }

  // ─── RGB ajratish (realtime_rppg.extract_skin_rgb bilan bir xil) ─
  function extractSkinRGB(bbox) {
    const { x, y, w, h } = bbox;

    // Hudud: y+10%..y+70%, x+10%..x+90%
    const x1 = Math.round(x + w * 0.10);
    const y1 = Math.round(y + h * 0.10);
    const x2 = Math.round(x + w * 0.90);
    const y2 = Math.round(y + h * 0.70);
    const rw = Math.max(1, x2 - x1);
    const rh = Math.max(1, y2 - y1);

    let pd;
    try { pd = detCtx.getImageData(x1, y1, rw, rh).data; }
    catch { return null; }

    let sR = 0, sG = 0, sB = 0, skin = 0;

    for (let i = 0; i < pd.length; i += 4) {
      const r = pd[i], g = pd[i+1], b = pd[i+2];
      // YCrCb teri filtri (Python bilan bir xil)
      const Y   =  0.299*r + 0.587*g + 0.114*b;
      const Cr  =  0.500*r - 0.419*g - 0.081*b + 128;
      const Cb  = -0.169*r - 0.331*g + 0.500*b + 128;
      if (Cr >= 133 && Cr <= 173 && Cb >= 77 && Cb <= 127 && Y > 40) {
        sR += r; sG += g; sB += b; skin++;
      }
    }

    if (skin < 100) {
      // Fallback: butun hudud o'rtachasi
      let tR = 0, tG = 0, tB = 0, n = pd.length / 4;
      for (let i = 0; i < pd.length; i += 4) {
        tR += pd[i]; tG += pd[i+1]; tB += pd[i+2];
      }
      return [tR/n, tG/n, tB/n];
    }
    return [sR/skin, sG/skin, sB/skin];
  }

  // ─── Fallback: markaziy oval + teri filtri ────────────────────────
  function detectBySkin() {
    const vw = DET_W, vh = DET_H;
    const cx = vw/2, cy = vh*0.48;
    const rw = vw*0.26, rh = vh*0.33;
    const x = Math.round(cx-rw), y = Math.round(cy-rh);
    const w = Math.round(rw*2),  h = Math.round(rh*2);

    let pd;
    try { pd = detCtx.getImageData(x, y, w, h).data; }
    catch { return null; }

    let sR = 0, sG = 0, sB = 0, skin = 0;
    for (let i = 0; i < pd.length; i += 4) {
      const r = pd[i], g = pd[i+1], b = pd[i+2];
      const Y  =  0.299*r + 0.587*g + 0.114*b;
      const Cr =  0.500*r - 0.419*g - 0.081*b + 128;
      const Cb = -0.169*r - 0.331*g + 0.500*b + 128;
      if (Cr>=133&&Cr<=173&&Cb>=77&&Cb<=127&&Y>80) {
        sR+=r; sG+=g; sB+=b; skin++;
      }
    }
    if (skin < w*h*0.20) return null;
    return { bbox: {x,y,w,h}, rgb: [sR/skin, sG/skin, sB/skin] };
  }

  // ─── WebSocket ───────────────────────────────────────────────────
  function connectWS() {
    if (ws) return;
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    ws.onopen  = () => { wsReady = true;  wsStatus.classList.add('hidden'); };
    ws.onclose = () => {
      wsReady = false; ws = null;
      if (isRunning) { wsStatus.classList.remove('hidden'); setTimeout(connectWS, 2000); }
    };
    ws.onerror = () => { wsReady = false; };
    ws.onmessage = (e) => {
      try { renderResult(JSON.parse(e.data)); } catch { /* ignore */ }
    };
  }

  function disconnectWS() {
    if (ws) { ws.close(); ws = null; }
    wsReady = false;
  }

  // ─── RGB ni serverga yuborish (16 bayt Float32) ───────────────────
  function sendRGB(hasFace, rgb) {
    if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) return;
    const buf = new Float32Array(4);
    buf[0] = hasFace ? 1.0 : 0.0;
    if (hasFace && rgb) { buf[1] = rgb[0]; buf[2] = rgb[1]; buf[3] = rgb[2]; }
    ws.send(buf.buffer);
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

    // FPS
    fpsFrames++;
    const now = performance.now();
    if (now - fpsTime >= 1000) {
      fpsBadge.textContent = fpsFrames + ' fps';
      fpsFrames = 0; fpsTime = now;
    }

    // Har 3 kadrda asinxron yuz aniqlash
    loopFrame++;
    if (loopFrame % 3 === 0) scheduleDetect();

    // 30fps da kadrni o'qish va yuborish
    if (now - lastSendMs < SEND_MS) return;
    lastSendMs = now;

    detCtx.drawImage(video, 0, 0, DET_W, DET_H);

    let hasFace = false, rgb = null, drawBBox = null;

    if (faceDetector) {
      // Chrome FaceDetector natijasidan foydalanish
      if (lastBBox) {
        rgb      = extractSkinRGB(lastBBox);
        hasFace  = rgb !== null;
        drawBBox = lastBBox;
      }
    } else {
      // Fallback: teri rangi
      const res = detectBySkin();
      if (res) { rgb = res.rgb; hasFace = true; drawBBox = res.bbox; }
    }

    // Overlay chizish
    clearOverlay();
    if (hasFace && drawBBox) {
      const { x, y, w, h } = drawBBox;
      const sx = overlay.width  / DET_W;
      const sy = overlay.height / DET_H;
      octx.strokeStyle = '#00dc00';
      octx.lineWidth   = 2;
      octx.strokeRect(x*sx, y*sy, w*sx, h*sy);
      octx.fillStyle = '#00dc00';
      octx.font = `${Math.round(14*Math.min(sx,sy))}px Courier New`;
      octx.fillText('Yuz topildi', x*sx, y*sy - 6);
      faceText.textContent = '';
      faceText.className   = 'cv-face';
    } else {
      faceText.textContent = 'Yuz topilmadi!';
      faceText.className   = 'cv-face no-face';
    }

    // Serverga yuborish
    sendRGB(hasFace, rgb);
  }

  // ─── Server natijasini ko'rsatish ─────────────────────────────────
  function renderResult(r) {
    if (r.hr_bpm) {
      const bpm   = r.hr_bpm;
      const color = (bpm >= 50 && bpm <= 120) ? 'green' : 'orange';
      hrText.textContent = `Yurak urishi: ${bpm} BPM`;
      hrText.className   = `cv-hr ${color} pulse`;
    } else {
      const rem = r.remain > 0 ? ` ${r.remain}s qoldi` : '';
      hrText.textContent = `Ma'lumot to'planmoqda...${rem}`;
      hrText.className   = 'cv-hr';
    }
    const pct = r.progress || 0;
    progFill.style.width = pct + '%';
    const p = pct / 100;
    progFill.style.background = `rgb(0,${Math.round(180*p)},${Math.round(220*(1-p))})`;
    progLabel.textContent = `Signal: ${pct}%`;
  }

  // ─── Kamera ──────────────────────────────────────────────────────
  async function toggleCamera() {
    isRunning ? stop() : await start();
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:FPS} }
      });
      video.srcObject = stream;
      await video.play();
      await initDetector();
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
    stream = null; video.srcObject = null;
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
    if (ws) { ws.close(); ws = null; wsReady = false; }
    setTimeout(connectWS, 300);
    hrText.textContent = 'Ma\'lumot to\'planmoqda...';
    hrText.className   = 'cv-hr';
    progFill.style.width = '0%';
    progLabel.textContent = 'Signal: 0%';
    lastBBox = null;
  }

  function clearOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  return { toggleCamera, reset, stop };

})();
