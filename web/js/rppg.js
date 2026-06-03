/**
 * rppg.js  —  POS algoritmi + FFT yurak urishi hisoblash
 * Python rppglib/unsupervised.py va rppglib/processing.py dan o'girilgan.
 */

'use strict';

// ─── Yordamchi funksiyalar ───────────────────────────────────────────────────

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stdDev(arr) {
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - m) ** 2;
  return Math.sqrt(s / arr.length);
}

function detrend(arr) {
  const m = mean(arr);
  return arr.map(v => v - m);
}

// ─── POS algoritmi (Wang et al. 2017) ───────────────────────────────────────
/**
 * @param {Array<[number,number,number]>} rgbData  - [R, G, B] qiymatlar massivi
 * @param {number} fps - kadr/sekund
 * @returns {Float64Array} PPG signal
 */
function posAlgorithm(rgbData, fps) {
  const N = rgbData.length;
  const L = Math.round(fps * 1.6);   // oyna uzunligi (~48 kadr 30fps da)
  const H = new Float64Array(N);

  for (let t = 0; t <= N - L; t++) {
    let mR = 0, mG = 0, mB = 0;
    for (let i = t; i < t + L; i++) {
      mR += rgbData[i][0];
      mG += rgbData[i][1];
      mB += rgbData[i][2];
    }
    mR /= L; mG /= L; mB /= L;
    if (mR < 1 || mG < 1 || mB < 1) continue;

    const S0 = new Float64Array(L);  // [0, 1, -1] · Cn
    const S1 = new Float64Array(L);  // [-2, 1, 1] · Cn

    for (let i = 0; i < L; i++) {
      const nr = rgbData[t + i][0] / mR;
      const ng = rgbData[t + i][1] / mG;
      const nb = rgbData[t + i][2] / mB;
      S0[i] = ng - nb;
      S1[i] = -2 * nr + ng + nb;
    }

    const alpha = stdDev(Array.from(S0)) / (stdDev(Array.from(S1)) + 1e-9);

    let mP = 0;
    const P = new Float64Array(L);
    for (let i = 0; i < L; i++) { P[i] = S0[i] + alpha * S1[i]; mP += P[i]; }
    mP /= L;

    for (let i = 0; i < L; i++) H[t + i] += P[i] - mP;
  }

  return H;
}

// ─── Iterativ Cooley-Tukey FFT ───────────────────────────────────────────────
function fft(re, im) {
  const n = re.length;

  // Bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wBaseR = Math.cos(ang);
    const wBaseI = Math.sin(ang);
    const half = len >> 1;

    for (let i = 0; i < n; i += len) {
      let wR = 1, wI = 0;
      for (let j = 0; j < half; j++) {
        const uR = re[i + j],         uI = im[i + j];
        const vR = re[i+j+half]*wR - im[i+j+half]*wI;
        const vI = re[i+j+half]*wI + im[i+j+half]*wR;
        re[i + j]        = uR + vR;  im[i + j]        = uI + vI;
        re[i + j + half] = uR - vR;  im[i + j + half] = uI - vI;
        [wR, wI] = [wR*wBaseR - wI*wBaseI, wR*wBaseI + wI*wBaseR];
      }
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ─── Yurak urishi hisoblash ──────────────────────────────────────────────────
/**
 * @param {Float64Array|number[]} ppg - PPG signal
 * @param {number} fps
 * @param {number} [lowHz=0.75]  - 45 BPM
 * @param {number} [highHz=3.5]  - 210 BPM
 * @returns {number|null} BPM yoki null
 */
function calculateHR(ppg, fps, lowHz = 0.75, highHz = 3.5) {
  const n = ppg.length;
  const nfft = nextPow2(n);

  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) re[i] = ppg[i];

  fft(re, im);

  const freqRes = fps / nfft;
  let maxPow = -1;
  let peakFreq = 0;

  for (let i = 1; i < nfft / 2; i++) {
    const freq = i * freqRes;
    if (freq >= lowHz && freq <= highHz) {
      const pow = re[i] * re[i] + im[i] * im[i];
      if (pow > maxPow) { maxPow = pow; peakFreq = freq; }
    }
  }

  return peakFreq > 0 ? peakFreq * 60 : null;
}

// ─── RGB bufer (aylana bufer) ────────────────────────────────────────────────
class RGBBuffer {
  constructor(maxSize) {
    this._buf = [];
    this._max = maxSize;
  }
  push(r, g, b) {
    this._buf.push([r, g, b]);
    if (this._buf.length > this._max) this._buf.shift();
  }
  get length() { return this._buf.length; }
  get data()   { return this._buf; }
  clear()      { this._buf = []; }
}
