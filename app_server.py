"""
app_server.py — rPPG Web Server (optimallashtirilgan)
Brauzer [has_face, R, G, B] yuboradi (16 bayt Float32).
Server faqat POS + FFT hisoblaydi.
"""

import os, json
import numpy as np
import scipy.signal
from collections import deque
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import uvicorn

FPS          = 30
BUFFER_SIZE  = FPS * 60
MIN_FRAMES   = FPS * 10
UPDATE_EVERY = FPS * 2
NO_FACE_RESET = FPS * 3


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


def compute_heart_rate(ppg, fs, low_hz=0.75, high_hz=3.5):
    N = 1 << (len(ppg) - 1).bit_length()
    freqs, psd = scipy.signal.periodogram(ppg, fs=fs, nfft=N, detrend=False)
    mask = (freqs >= low_hz) & (freqs <= high_hz)
    if not mask.any():
        return None
    peak = freqs[mask][np.argmax(psd[mask])]
    return float(peak * 60.0)


class SessionState:
    def __init__(self):
        self.rgb_buf   = deque(maxlen=BUFFER_SIZE)
        self.frame_cnt = 0
        self.no_face   = 0
        self.hr_bpm    = None

    def process(self, has_face: bool, r: float, g: float, b: float) -> dict:
        if has_face:
            self.no_face = 0
            self.rgb_buf.append([r, g, b])
            self.frame_cnt += 1

            # HR yangilash
            if (self.frame_cnt % UPDATE_EVERY == 0 and
                    len(self.rgb_buf) >= MIN_FRAMES):
                try:
                    arr = np.array(self.rgb_buf, dtype=np.float64)
                    ppg = pos_algorithm(arr, FPS)
                    hr  = compute_heart_rate(ppg, FPS)
                    if hr and 40 < hr < 220:
                        self.hr_bpm = hr
                except Exception as e:
                    print(f'HR xatosi: {e}')
        else:
            self.no_face += 1
            if self.no_face > NO_FACE_RESET:
                self.rgb_buf.clear()
                self.frame_cnt = 0
                self.hr_bpm    = None

        n        = len(self.rgb_buf)
        progress = min(n / MIN_FRAMES, 1.0)
        remain   = max(0, (MIN_FRAMES - n)) // FPS

        return {
            'has_face'  : has_face,
            'hr_bpm'    : round(self.hr_bpm) if self.hr_bpm else None,
            'progress'  : round(progress * 100),
            'remain'    : int(remain),
            'collecting': n < MIN_FRAMES,
        }


app = FastAPI()


@app.websocket('/ws')
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    state = SessionState()
    try:
        while True:
            data = await ws.receive_bytes()
            # Float32Array: [has_face(0/1), R, G, B] = 16 bayt
            if len(data) == 16:
                arr      = np.frombuffer(data, dtype=np.float32)
                has_face = bool(arr[0] > 0.5)
                r, g, b  = float(arr[1]), float(arr[2]), float(arr[3])
                result   = state.process(has_face, r, g, b)
                await ws.send_text(json.dumps(result))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f'Xato: {e}')


app.mount('/', StaticFiles(directory='web', html=True), name='static')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    print(f'\n  http://localhost:{port}\n')
    uvicorn.run(app, host='0.0.0.0', port=port)
