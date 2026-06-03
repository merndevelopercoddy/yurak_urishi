/**
 * app.js  —  Kamera + WebSocket client
 * Kadrlar Python serverga yuboriladi, natija qayta olinadi.
 */

'use strict';

const FPS          = 30;
const WS_PROTO     = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL       = `${WS_PROTO}//${location.host}/ws`;
const SEND_QUALITY = 0.7;          // JPEG sifati
const SEND_W       = 320;          // yuboriluvchi kadr kengligi
const SEND_H       = 240;          // yuboriluvchi kadr balandligi

const App = (() => {

  // ─── DOM ─────────────────────────────────────────────────────────
  const video        = document.getElementById('video');
  const overlay      = document.getElementById('overlay');
  const faceGuide    = document.querySelector('.face-guide');
  const faceStatus   = document.getElementById('face-status');
  const hrDisplay    = document.getElementById('hr-display');
  const hrLabel      = document.getElementById('hr-label');
  const progressBar  = document.getElementById('progress-bar');
  const progressPct  = document.getElementById('progress-pct');
  const progressHint = document.getElementById('progress-hint');
  const stableBar    = document.getElementById('stable-bar');
  const stablePct    = document.getElementById('stable-pct');
  const waveCanvas   = document.getElementById('wave-canvas');
  const fpsBadge     = document.getElementById('fps-counter');
  const btnStart     = document.getElementById('btn-start');
  const warnBanner   = document.getElementById('warning-banner');
  const warnText     = document.getElementById('warning-text');
  const warnSub      = document.getElementById('warning-sub');
  const waitingOverlay = document.getElementById('waiting-overlay');

  const octx = overlay.getContext('2d');
  const wctx = waveCanvas.getContext('2d');

  // Kadr yuborish uchun offscreen canvas
  const sendCanvas = document.createElement('canvas');
  sendCanvas.width  = SEND_W;
  sendCanvas.height = SEND_H;
  const sendCtx    = sendCanvas.getContext('2d');

  // ─── Holat ───────────────────────────────────────────────────────
  let stream      = null;
  let animFrame   = null;
  let isRunning   = false;
  let fpsFrames   = 0;
  let fpsTime     = performance.now();

  // WebSocket
  let ws          = null;
  let wsSending   = false;   // kadr yuborilayotgan paytda bloklash
  let wsReady     = false;

  // Server natijasidan olingan qiymatlar
  let waveHistory   = [];

  // Phase
  let phase       = 'waiting';
  let hasFirstHR  = false;

  // ─── WebSocket ───────────────────────────────────────────────────
  function connectWS() {
    if (ws) return;
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      wsReady = true;
      console.log('Python serverga ulandi');
    };

    ws.onclose = () => {
      wsReady = false;
      ws = null;
      wsSending = false;
      if (isRunning) setTimeout(connectWS, 2000);  // qayta ulanish
    };

    ws.onerror = () => {
      wsReady = false;
    };

    ws.onmessage = (e) => {
      wsSending = false;
      try {
        handleServerResult(JSON.parse(e.data));
      } catch (err) { console.warn('WS parse xato:', err); }
    };
  }

  function disconnectWS() {
    if (ws) { ws.close(); ws = null; }
    wsReady   = false;
    wsSending = false;
  }

  // Video kadrni JPEG sifatida serverga yuborish
  function sendFrame() {
    if (!wsReady || wsSending || !ws || video.readyState < 2) return;
    sendCtx.drawImage(video, 0, 0, SEND_W, SEND_H);
    wsSending = true;
    sendCanvas.toBlob(blob => {
      if (!blob || !ws || ws.readyState !== WebSocket.OPEN) {
        wsSending = false; return;
      }
      blob.arrayBuffer().then(buf => {
        ws.send(buf);
        // 2s ichida javob kelmasa qulfni ochish (xavfsizlik)
        setTimeout(() => { wsSending = false; }, 2000);
      }).catch(() => { wsSending = false; });
    }, 'image/jpeg', SEND_QUALITY);
  }

  // ─── Server natijasini qayta ishlash ─────────────────────────────
  function handleServerResult(r) {
    if (!r.has_face) {
      onNoFace(r);
    } else if (r.moving) {
      onMoving(r);
    } else {
      onFaceStable(r);
    }
  }

  function onNoFace(r) {
    faceGuide.classList.remove('detected');
    clearOverlay();
    setFaceStatus('err', 'Yuz ko\'rinmayapti!');
    showWarning('face-lost',
      hasFirstHR ? '⚠ Yuz topilmadi!' : '⚠ Yuz ko\'rinmayapti',
      hasFirstHR
        ? 'O\'lchov to\'xtatildi — yuzingizni kameraga to\'g\'rilang'
        : 'Yuzingizni oval ichiga joylashtiring'
    );
    if (phase !== 'waiting' && r.buffer_len === 0) {
      setPhase('waiting');
      hasFirstHR = false;
      updateHRDisplay(null);
    }
  }

  function onMoving(r) {
    faceGuide.classList.add('detected');
    if (r.bbox) drawFaceBox(r.bbox, '#eab308');
    setFaceStatus('warn', 'Harakat!');
    showWarning('motion',
      '⚠ Yuzingizni qimirlatmang!',
      hasFirstHR
        ? 'Harakat tufayli o\'lchov to\'xtatildi'
        : '10 soniya tinch turish talab etiladi'
    );
    if (phase === 'waiting') setPhase('collecting');
    updateProgressBars(0, 0, r.stable_req, r.min_frames, true);
  }

  function onFaceStable(r) {
    faceGuide.classList.add('detected');
    if (r.bbox) drawFaceBox(r.bbox, '#22c55e');
    setFaceStatus('ok', 'Yuz topildi ✓');
    hideWarning();

    // To'lqin tarixi uchun G-R signal (serverdan RGB yo'q, vaqtincha bbox rangidan)
    if (r.bbox) {
      const ctx2 = sendCtx;
      const [bx, by, bw, bh] = r.bbox.map(v => Math.round(v * SEND_W / (overlay.width || 640)));
      try {
        const px = ctx2.getImageData(Math.max(0,bx), Math.max(0,by), Math.max(1,bw), Math.max(1,bh));
        let rSum = 0, gSum = 0, n = px.data.length / 4;
        for (let i = 0; i < px.data.length; i += 4) { rSum += px.data[i]; gSum += px.data[i+1]; }
        waveHistory.push((gSum - rSum) / n);
        if (waveHistory.length > 150) waveHistory.shift();
      } catch { /* ignore */ }
    }

    // Faza o'tishi
    if (phase === 'waiting') setPhase('collecting');
    if (r.stable_frames >= r.stable_req && r.buffer_len >= r.min_frames) {
      if (phase !== 'measuring') setPhase('measuring');
    }

    updateProgressBars(r.stable_frames, r.buffer_len, r.stable_req, r.min_frames, false);

    // HR natijasi keldi
    if (r.hr !== null && r.hr !== undefined) {
      hasFirstHR = true;
      updateHRDisplay(r.hr);
    }
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
      btnStart.classList.replace('btn-primary', 'btn-secondary');
      connectWS();
      setPhase('waiting');
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
    btnStart.classList.replace('btn-secondary', 'btn-primary');
    clearOverlay();
    hideWarning();
    setPhase('waiting');
  }

  // ─── Asosiy tsikl ────────────────────────────────────────────────
  function loop() {
    if (!isRunning) return;
    animFrame = requestAnimationFrame(loop);
    if (video.readyState < 2) return;

    // Overlay o'lchamlarini sinxronlashtirish
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

    // WS ulanish holati ko'rsatish
    if (!wsReady) {
      setFaceStatus('warn', 'Server kutilmoqda...');
    }

    // Kadrni serverga yuborish (throttle: faqat oldingi javob kelgandan so'ng)
    sendFrame();

    drawWaveform();
  }

  // ─── UI yangilash ─────────────────────────────────────────────────
  function updateHRDisplay(hr) {
    hrDisplay.style.opacity = '1';
    if (hr === null || hr === undefined) {
      hrDisplay.textContent = '--';
      hrDisplay.className   = 'hr-number';
      return;
    }
    hrDisplay.textContent = Math.round(hr);
    hrDisplay.classList.remove('normal', 'warning', 'beat');
    void hrDisplay.offsetWidth;
    hrDisplay.classList.add('beat');
    if (hr < 60 || hr > 100) {
      hrDisplay.classList.add('warning');
      hrLabel.textContent = hr < 60 ? 'Past (bradikardiya)' : 'Yuqori (taxikardiya)';
    } else {
      hrDisplay.classList.add('normal');
      hrLabel.textContent = 'Normal diapazon';
    }
  }

  function updateProgressBars(stable, bufLen, stableReq, minFrames, moving) {
    if (phase === 'waiting') return;
    const sPct = Math.min(stable / stableReq * 100, 100);
    const dPct = Math.min(bufLen  / minFrames * 100, 100);
    progressBar.style.width = dPct + '%';
    progressPct.textContent = Math.round(dPct) + '%';
    stableBar.style.width   = sPct + '%';
    stablePct.textContent   = Math.round(sPct) + '%';

    if (moving) {
      progressHint.textContent = 'Harakat — signal noldan boshlandi';
    } else if (stable < stableReq) {
      const s = Math.ceil((stableReq - stable) / FPS);
      progressHint.textContent = `Tinch turing: yana ${s}s barqarorlik kerak`;
    } else if (bufLen < minFrames) {
      const s = Math.ceil((minFrames - bufLen) / FPS);
      progressHint.textContent = `Signal yig'ilmoqda: ${s}s`;
    } else {
      progressHint.textContent = 'Yurak urishi aniqlanmoqda ✓';
    }
  }

  function setFaceStatus(type, text) {
    faceStatus.className   = 'badge badge-' + type;
    faceStatus.textContent = text;
  }

  // ─── Holatlar mashinasi ────────────────────────────────────────────
  function setPhase(newPhase) {
    phase = newPhase;
    if (newPhase === 'waiting') {
      waitingOverlay.classList.remove('fade-out', 'gone');
      updateHRDisplay(null);
      hrLabel.textContent      = 'Yuzingizni kameraga to\'g\'rilang...';
      progressHint.textContent = 'Yuz topilgunga qadar kutilmoqda';
      progressBar.style.width  = '0%'; progressPct.textContent = '0%';
      stableBar.style.width    = '0%'; stablePct.textContent   = '0%';
    } else if (newPhase === 'collecting') {
      waitingOverlay.classList.add('fade-out');
      setTimeout(() => waitingOverlay.classList.add('gone'), 500);
      hrLabel.textContent = 'Signal to\'planmoqda...';
    } else if (newPhase === 'measuring') {
      hrLabel.textContent = 'Yurak urishi aniqlanmoqda...';
    }
  }

  // ─── Ogohlantirishlar ─────────────────────────────────────────────
  function showWarning(type, text, sub) {
    warnBanner.className   = 'warning-banner ' + type;
    warnText.textContent   = text;
    warnSub.textContent    = sub || '';
    hrDisplay.style.opacity = '0.35';
  }

  function hideWarning() {
    warnBanner.className    = 'warning-banner hidden';
    hrDisplay.style.opacity = '1';
  }

  // ─── Canvas ───────────────────────────────────────────────────────
  function drawFaceBox(bbox, color) {
    clearOverlay();
    const scaleX = overlay.width  / SEND_W;
    const scaleY = overlay.height / SEND_H;
    const [bx, by, bw, bh] = bbox;
    octx.strokeStyle = color;
    octx.lineWidth   = 2.5;
    octx.strokeRect(bx * scaleX, by * scaleY, bw * scaleX, bh * scaleY);
  }

  function clearOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function drawWaveform() {
    const cw = waveCanvas.offsetWidth;
    const ch = waveCanvas.offsetHeight;
    if (!cw || !ch || waveHistory.length < 2) return;
    waveCanvas.width = cw; waveCanvas.height = ch;
    wctx.clearRect(0, 0, cw, ch);

    const minV  = Math.min(...waveHistory);
    const range = (Math.max(...waveHistory) - minV) || 1;

    wctx.strokeStyle = 'rgba(244,63,94,0.9)';
    wctx.lineWidth = 1.5; wctx.lineJoin = 'round';
    wctx.beginPath();
    waveHistory.forEach((v, i) => {
      const px = (i / (waveHistory.length - 1)) * cw;
      const py = ch - ((v - minV) / range) * ch * 0.85 - ch * 0.075;
      i === 0 ? wctx.moveTo(px, py) : wctx.lineTo(px, py);
    });
    wctx.stroke();
  }

  // ─── Reset ────────────────────────────────────────────────────────
  function reset() {
    waveHistory  = [];
    hasFirstHR   = false;
    hideWarning();
    setPhase('waiting');
  }

  return { toggleCamera, reset, stop };

})();
