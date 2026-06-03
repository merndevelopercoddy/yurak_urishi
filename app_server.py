"""
app_server.py — rPPG unified server (lokal + cloud)

Lokal:  python app_server.py        → http://localhost:8080
Cloud:  PORT env o'zgaruvchisi avtomatik o'qiladi

WebSocket: /ws
Statik:    /  (web/ papkasi)
"""

import os, json, sys
import cv2
import numpy as np
from collections import deque
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import uvicorn

sys.path.insert(0, os.path.dirname(__file__))
from rppglib.unsupervised import pos
from rppglib.processing import calculate_fft_hr

FPS          = 30
MIN_FRAMES   = FPS * 10
BUFFER_MAX   = FPS * 60
UPDATE_EVERY = FPS * 2
STABLE_REQ   = FPS * 10
MOTION_TRESH = 0.045


class SessionState:
    def __init__(self):
        self.rgb_buf       = deque(maxlen=BUFFER_MAX)
        self.frame_count   = 0
        self.stable_frames = 0
        self.prev_center   = None
        self.face_cascade  = cv2.CascadeClassifier(
            cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        )

    def process(self, jpeg_bytes: bytes) -> dict:
        arr   = np.frombuffer(jpeg_bytes, np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return self._r(False)

        gray  = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = self.face_cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5, minSize=(50, 50)
        )
        if len(faces) == 0:
            self.prev_center = None
            return self._r(False)

        x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
        cx, cy = x + w // 2, y + h // 2

        # Harakat
        is_moving = False
        if self.prev_center:
            dist = np.hypot(cx - self.prev_center[0], cy - self.prev_center[1])
            is_moving = dist > min(frame.shape[:2]) * MOTION_TRESH
        self.prev_center = (cx, cy)

        if is_moving:
            self.stable_frames = 0
            self.rgb_buf.clear()
            self.frame_count = 0
            return self._r(True, moving=True, bbox=[int(x), int(y), int(w), int(h)])

        # RGB ajratish
        y1  = y + int(h * 0.10)
        y2  = y + int(h * 0.70)
        roi = frame[y1:y2, x: x + w]
        if roi.size == 0:
            return self._r(False)

        roi_rgb   = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB).astype(np.float32)
        roi_ycrcb = cv2.cvtColor(roi, cv2.COLOR_BGR2YCrCb)
        mask = (
            (roi_ycrcb[:, :, 1] >= 133) & (roi_ycrcb[:, :, 1] <= 173) &
            (roi_ycrcb[:, :, 2] >= 77)  & (roi_ycrcb[:, :, 2] <= 127)
        )
        rgb = roi_rgb[mask].mean(axis=0) if mask.sum() >= 100 else roi_rgb.mean(axis=(0, 1))

        self.rgb_buf.append([float(rgb[0]), float(rgb[1]), float(rgb[2])])
        self.frame_count   += 1
        self.stable_frames += 1

        # HR hisoblash
        hr = None
        if (self.stable_frames  >= STABLE_REQ and
                len(self.rgb_buf)  >= MIN_FRAMES and
                self.frame_count % UPDATE_EVERY == 0):
            try:
                arr_rgb = np.array(self.rgb_buf, dtype=np.float32)
                ppg     = pos(arr_rgb, FPS)
                hr_val  = calculate_fft_hr(ppg, fs=FPS)
                if 40 < hr_val < 220:
                    hr = round(float(hr_val), 1)
            except Exception as e:
                print(f'HR xatosi: {e}')

        return self._r(True,
                       bbox          = [int(x), int(y), int(w), int(h)],
                       stable_frames = self.stable_frames,
                       buffer_len    = len(self.rgb_buf),
                       hr            = hr)

    def _r(self, has_face, moving=False, bbox=None,
           stable_frames=0, buffer_len=0, hr=None):
        return dict(has_face=has_face, moving=moving, bbox=bbox,
                    stable_frames=stable_frames, buffer_len=buffer_len,
                    stable_req=STABLE_REQ, min_frames=MIN_FRAMES, hr=hr)


# ─── FastAPI ──────────────────────────────────────────────────────
app = FastAPI()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    state = SessionState()
    print(f"Ulandi: {ws.client}")
    try:
        while True:
            data = await ws.receive_bytes()
            result = state.process(data)
            await ws.send_text(json.dumps(result))
    except WebSocketDisconnect:
        print(f"Uzildi: {ws.client}")
    except Exception as e:
        print(f"Xato: {e}")


# Statik fayllar (eng oxirida — barcha boshqa routelar ustidan)
app.mount("/", StaticFiles(directory="web", html=True), name="static")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"\n  http://localhost:{port}\n  ws://localhost:{port}/ws\n")
    uvicorn.run(app, host="0.0.0.0", port=port)
