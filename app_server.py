"""
app_server.py — rPPG Web Server
realtime_rppg.py bilan aynan bir xil algoritm va mantiq.
"""

import os, json
import cv2
import numpy as np
import scipy.signal
from collections import deque
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import uvicorn

# ─── Sozlamalar (realtime_rppg.py bilan bir xil) ─────────────────
FPS          = 30
BUFFER_SIZE  = FPS * 60
MIN_FRAMES   = FPS * 10
UPDATE_EVERY = FPS * 2
NO_FACE_RESET = FPS * 3


# ─── Yuz aniqlash (aynan bir xil) ────────────────────────────────
def detect_face(frame):
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    )
    gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80)
    )
    if len(faces) == 0:
        return None
    areas = [w * h for (_, _, w, h) in faces]
    return faces[np.argmax(areas)]


# ─── RGB ajratish (aynan bir xil) ────────────────────────────────
def extract_skin_rgb(frame, bbox):
    x, y, w, h = bbox
    y1 = y + int(h * 0.10)
    y2 = y + int(h * 0.70)
    x1 = x + int(w * 0.10)
    x2 = x + int(w * 0.90)
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return None
    roi_rgb  = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB).astype(np.float32)
    ycrcb    = cv2.cvtColor(roi, cv2.COLOR_BGR2YCrCb)
    mask = (
        (ycrcb[:, :, 1] >= 133) & (ycrcb[:, :, 1] <= 173) &
        (ycrcb[:, :, 2] >= 77)  & (ycrcb[:, :, 2] <= 127)
    )
    if mask.sum() < 100:
        return roi_rgb.mean(axis=(0, 1))
    return roi_rgb[mask].mean(axis=0)


# ─── POS algoritmi (aynan bir xil) ───────────────────────────────
def pos_algorithm(rgb, fs):
    seg_len = int(fs * 1.6)
    H = np.zeros(len(rgb), dtype=np.float64)
    for t in range(len(rgb) - seg_len + 1):
        C      = rgb[t: t + seg_len].T
        mean_c = C.mean(axis=1)
        if np.any(mean_c < 1e-6):
            continue
        Cn    = C / (mean_c[:, None] + 1e-9)
        proj  = np.array([[0, 1, -1], [-2, 1, 1]], dtype=np.float64)
        S     = proj @ Cn
        alpha = S[0].std() / (S[1].std() + 1e-9)
        P     = S[0] + alpha * S[1]
        H[t: t + seg_len] += P - P.mean()
    low  = 0.75 / (fs / 2)
    high = 3.00 / (fs / 2)
    b, a = scipy.signal.butter(2, [low, high], btype='bandpass')
    return scipy.signal.filtfilt(b, a, H)


# ─── HR hisoblash (aynan bir xil) ────────────────────────────────
def compute_heart_rate(ppg, fs, low_hz=0.75, high_hz=3.5):
    N = 1 << (len(ppg) - 1).bit_length()
    freqs, psd = scipy.signal.periodogram(ppg, fs=fs, nfft=N, detrend=False)
    mask = (freqs >= low_hz) & (freqs <= high_hz)
    if not mask.any():
        return None
    peak = freqs[mask][np.argmax(psd[mask])]
    return float(peak * 60.0)


# ─── Sessiya holati ───────────────────────────────────────────────
class SessionState:
    def __init__(self):
        self.rgb_buf   = deque(maxlen=BUFFER_SIZE)
        self.frame_cnt = 0
        self.no_face   = 0
        self.hr_bpm    = None

    def process(self, jpeg_bytes: bytes) -> dict:
        arr   = np.frombuffer(jpeg_bytes, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return self._no_face()

        bbox = detect_face(frame)

        if bbox is not None:
            self.no_face = 0
            x, y, w, h  = [int(v) for v in bbox]

            rgb = extract_skin_rgb(frame, bbox)
            if rgb is not None:
                self.rgb_buf.append([float(rgb[0]), float(rgb[1]), float(rgb[2])])
                self.frame_cnt += 1

            # HR yangilash
            if (self.frame_cnt % UPDATE_EVERY == 0 and
                    len(self.rgb_buf) >= MIN_FRAMES):
                try:
                    arr_rgb  = np.array(self.rgb_buf, dtype=np.float64)
                    ppg      = pos_algorithm(arr_rgb, FPS)
                    hr       = compute_heart_rate(ppg, FPS)
                    if hr and 40 < hr < 220:
                        self.hr_bpm = hr
                except Exception as e:
                    print(f'HR xatosi: {e}')

            n        = len(self.rgb_buf)
            progress = min(n / MIN_FRAMES, 1.0)
            remain   = max(0, (MIN_FRAMES - n)) // FPS

            return {
                'has_face'  : True,
                'bbox'      : [x, y, w, h],
                'hr_bpm'    : round(self.hr_bpm) if self.hr_bpm else None,
                'progress'  : round(progress * 100),
                'remain'    : remain,
                'collecting': n < MIN_FRAMES,
            }
        else:
            self.no_face += 1
            if self.no_face > NO_FACE_RESET:
                self.rgb_buf.clear()
                self.frame_cnt = 0
                self.hr_bpm    = None
            return self._no_face()

    def _no_face(self):
        return {
            'has_face'  : False,
            'bbox'      : None,
            'hr_bpm'    : None,
            'progress'  : 0,
            'remain'    : MIN_FRAMES // FPS,
            'collecting': True,
        }


# ─── FastAPI ──────────────────────────────────────────────────────
app = FastAPI()


@app.websocket('/ws')
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    state = SessionState()
    print(f'Ulandi: {ws.client}')
    try:
        while True:
            data   = await ws.receive_bytes()
            result = state.process(data)
            await ws.send_text(json.dumps(result))
    except WebSocketDisconnect:
        print(f'Uzildi: {ws.client}')
    except Exception as e:
        print(f'Xato: {e}')


app.mount('/', StaticFiles(directory='web', html=True), name='static')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    print(f'\n  http://localhost:{port}\n')
    uvicorn.run(app, host='0.0.0.0', port=port)
