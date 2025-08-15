const $ = (s) => document.querySelector(s);
const ring = $('#ring');
const ringLabel = $('#ringLabel');
const modeEl = $('#mode');
const stageEl = $('#stage');
const detailsEl = $('#details');
const durationEl = $('#duration');
const resultsEl = $('#results');
const staticScore = $('#staticScore');
const motionScore = $('#motionScore');
const totalScore = $('#totalScore');
const staticMeta = $('#staticMeta');
const motionMeta = $('#motionMeta');
const totalVerdict = $('#totalVerdict');
// no CSV download in simplified UI

let duration = 15;
$('#dec').addEventListener('click', () => { duration = Math.max(5, duration - 5); durationEl.textContent = duration; });
$('#inc').addEventListener('click', () => { duration = Math.min(300, duration + 5); durationEl.textContent = duration; });
// Sensitivity (1..5) persisted
const sensInput = document.getElementById('sensitivity');
const sensLabel = document.getElementById('sLabel');
const SENS_NAMES = {1: 'Very relaxed', 2: 'Relaxed', 3: 'Balanced', 4: 'Strict', 5: 'Very strict'};
const savedDuration = Number(localStorage.getItem('duration_seconds') || '15');
if (!Number.isNaN(savedDuration)) { duration = savedDuration; durationEl.textContent = duration; }
const savedSens = Number(localStorage.getItem('sensitivity_level') || '3');
sensInput.value = String(Math.min(5, Math.max(1, savedSens)));
sensLabel.textContent = SENS_NAMES[sensInput.value] || 'Balanced';
sensInput.addEventListener('input', () => { sensLabel.textContent = SENS_NAMES[sensInput.value] || 'Balanced'; localStorage.setItem('sensitivity_level', String(sensInput.value)); });
window.addEventListener('beforeunload', () => { localStorage.setItem('duration_seconds', String(duration)); });

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
// Worker canvas for analysis to decouple from display resolution
const workCanvas = document.createElement('canvas');
const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

// Tuning knobs for smoother analysis
let ANALYZE_SCALE = 0.25;  // analyze at ~25% resolution
let SAMPLE_STRIDE = 4;     // sample every Nth pixel for MAD
let LATE_FACTOR = 2.5;     // late frame threshold relative to avg dt
let STATIC_SPIKE_MULT = 3; // unexpected change threshold in static stage
let FREEZE_FRAC = 0.25;    // freeze threshold in motion stage

function applySensitivity(level){
  // map 1..5 to thresholds
  const lvl = Number(level);
  // More strict => lower FREEZE_FRAC, lower LATE_FACTOR, lower ANALYZE_SCALE (more CPU ok)
  const map = {
    1: { analyze: 0.20, stride: 5, late: 3.0, spike: 4.0, freeze: 0.20 },
    2: { analyze: 0.22, stride: 5, late: 2.7, spike: 3.5, freeze: 0.22 },
    3: { analyze: 0.25, stride: 4, late: 2.5, spike: 3.0, freeze: 0.25 },
    4: { analyze: 0.28, stride: 3, late: 2.2, spike: 2.5, freeze: 0.28 },
    5: { analyze: 0.30, stride: 3, late: 2.0, spike: 2.2, freeze: 0.30 }
  };
  const p = map[lvl] || map[3];
  ANALYZE_SCALE = p.analyze; SAMPLE_STRIDE = p.stride; LATE_FACTOR = p.late; STATIC_SPIKE_MULT = p.spike; FREEZE_FRAC = p.freeze;
}
applySensitivity(sensInput.value);
sensInput.addEventListener('change', () => applySensitivity(sensInput.value));

let stream = null;
let mode = 'SETUP';
let stage = 0; // 0 static, 1 motion
let cancel = false;

function setRingProgress(p) {
  const len = 2 * Math.PI * 58;
  const off = len * (1 - Math.max(0, Math.min(1, p)));
  ring.style.strokeDashoffset = off;
}

(async function init(){
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    $('#fallback').classList.add('hidden');
  } catch (e) {
    $('#video').classList.add('hidden');
    $('#fallback').classList.remove('hidden');
  }
})();

function toGray(data, w, h) {
  const g = new Float32Array(w*h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // Rec. 601 luma
    g[j] = 0.299*data[i+0] + 0.587*data[i+1] + 0.114*data[i+2];
  }
  return g;
}

function medianOfArray(arr) { const tmp = Array.from(arr); tmp.sort((x, y) => x - y); return tmp[Math.floor(tmp.length/2)] || 0; }
function medianAbsoluteDifferenceSampled(curr, prev, w, h, stride) {
  if (!prev) return 0;
  const diffs = [];
  for (let y = 0; y < h; y += stride) {
    const off = y * w;
    for (let x = 0; x < w; x += stride) {
      const i = off + x;
      diffs.push(Math.abs(curr[i] - prev[i]));
    }
  }
  return medianOfArray(diffs);
}

function detectBanding(gray, w, h) {
  const rowMeans = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0; const off = y * w;
    for (let x = 0; x < w; x++) sum += gray[off + x];
    rowMeans[y] = sum / w;
  }
  const diff = new Float32Array(h-1);
  for (let i = 1; i < h; i++) diff[i-1] = rowMeans[i] - rowMeans[i-1];
  if (diff.length < 5) return { z: 0, flag: false };
  let mu = 0; for (let i = 0; i < diff.length; i++) mu += diff[i]; mu /= diff.length;
  let sd = 0; for (let i = 0; i < diff.length; i++) { const d = diff[i]-mu; sd += d*d; } sd = Math.sqrt(sd / Math.max(1, diff.length-1)) || 1e-6;
  let z = 0; for (let i = 0; i < diff.length; i++) z = Math.max(z, Math.abs((diff[i]-mu)/sd));
  return { z, flag: z >= 12.0 };
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function runStage(stageIndex, seconds) {
  // 5s countdown
  mode = 'COUNTDOWN'; stage = stageIndex;
  // During countdown, show video preview so user sees themselves
  document.getElementById('video').classList.remove('hidden');
  document.getElementById('video').classList.remove('video-ghost');
  document.getElementById('canvas').classList.add('hidden');
  for (let t=0; t<5000 && !cancel; t+=100) {
    setRingProgress(t/5000); ringLabel.textContent = `Starting in ${Math.ceil((5000-t)/1000)}`; modeEl.textContent = mode; stageEl.textContent = stageIndex===0? 'A: STATIC' : 'B: MOTION';
    await sleep(100);
  }
  if (cancel) return null;

  mode = 'RUN';
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  // Force a stable capture size from the video element (prevents canvas scaling stalls)
  const w = (video.videoWidth || settings.width || 640);
  const h = (video.videoHeight || settings.height || 360);
  canvas.width = w; canvas.height = h; canvas.classList.remove('hidden');
  // analysis at lower res to keep loop smooth
  const aw = Math.max(160, Math.floor(w * ANALYZE_SCALE)), ah = Math.max(90, Math.floor(h * ANALYZE_SCALE));
  workCanvas.width = aw; workCanvas.height = ah;
  // Keep video playing but off-screen so frames continue updating
  document.getElementById('video').classList.add('video-ghost');

  let prevGray = null;
  const start = performance.now();
  let frames = 0, late = 0, freezes = 0, banding = 0, unexpected = 0;
  let lastTime = performance.now();
  let meanDt = null;      // EMA of dt_ms
  let baselineMad = null; // EMA baseline MAD per stage
  // Realtime indicator
  const rtDot = document.getElementById('rtDot');
  const rtText = document.getElementById('rtText');

  const loop = (ts) => {
    if (cancel) return;
    const now = performance.now();
    if (now - start >= seconds*1000) return;

    if (video.readyState >= 2) {
      // draw to screen
      ctx.drawImage(video, 0, 0, w, h);
      // draw to worker canvas (downscaled)
      workCtx.drawImage(video, 0, 0, workCanvas.width, workCanvas.height);
      const img = workCtx.getImageData(0, 0, workCanvas.width, workCanvas.height);
      const gray = toGray(img.data, workCanvas.width, workCanvas.height);

      const dt = now - lastTime; lastTime = now;
      // Update EMA of dt
      meanDt = (meanDt === null) ? dt : (0.2 * dt + 0.8 * meanDt);
      // Compute sampled MAD
      let mad = medianAbsoluteDifferenceSampled(gray, prevGray, workCanvas.width, workCanvas.height, SAMPLE_STRIDE);
      prevGray = gray;
      const { z, flag } = detectBanding(gray, workCanvas.width, workCanvas.height);

      frames++;
      if (meanDt && dt > LATE_FACTOR * meanDt) late++;
      // Establish/update baseline MAD (EMA)
      baselineMad = (baselineMad === null) ? mad : (0.1 * mad + 0.9 * baselineMad);
      if (stageIndex === 0) {
        if (baselineMad && mad > STATIC_SPIKE_MULT * baselineMad) unexpected++;
        if (flag) banding++;
      } else {
        if (frames > 5 && baselineMad && mad < FREEZE_FRAC * baselineMad) freezes++;
        if (flag) banding++;
      }

      const remaining = Math.max(0, seconds - (now - start)/1000);
      const progress = 1 - (remaining / seconds);
      setRingProgress(progress);
      ringLabel.textContent = `${Math.ceil(remaining)}s`;
      modeEl.textContent = 'RUN'; stageEl.textContent = stageIndex===0? 'A: STATIC' : 'B: MOTION';
      detailsEl.textContent = `dt=${dt.toFixed(0)}ms MAD=${mad.toFixed(1)} bandZ=${z.toFixed(1)}`;
      // Update realtime indicator (ok if dt within 1.6x mean)
      const ok = meanDt && dt < 1.6 * meanDt;
      if (ok) { rtDot.classList.add('ok'); rtText.textContent = 'Realtime OK'; }
      else { rtDot.classList.remove('ok'); rtText.textContent = 'Keep this tab visible'; }
    }

    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => requestAnimationFrame(loop));
    } else {
      requestAnimationFrame(loop);
    }
  };
  requestAnimationFrame(loop);

  // wait for the stage duration
  while (!cancel && performance.now() - start < seconds*1000) await sleep(50);

  return { frames, late, freezes, banding, unexpected };
}

function score(A, B) {
  function rate(numer, denom){ return numer / Math.max(1, denom); }
  const staticRate = rate(A.late + A.unexpected + A.banding, A.frames);
  const motionRate = rate(B.late + B.freezes + B.banding, B.frames);
  const staticScore = Math.max(0, 100 * (1.0 - Math.min(1.0, staticRate)));
  const motionScore = Math.max(0, 100 * (1.0 - Math.min(1.0, motionRate)));
  const total = Math.round(0.5 * staticScore + 0.5 * motionScore);
  const verdict = total>=90?'Excellent': total>=75?'Good': total>=50?'Fair':'Poor';
  return { staticScore: Math.round(staticScore), motionScore: Math.round(motionScore), total, verdict };
}

function csvOf(A, B) {
  // Minimal session CSV with summary only (no per-frame events for simplicity here)
  const rows = [
    'metric,stage,frames,late,freezes,banding,unexpected',
    `summary,static,${A.frames},${A.late},-,${A.banding},${A.unexpected}`,
    `summary,motion,${B.frames},${B.late},${B.freezes},${B.banding},-`
  ];
  return rows.join('\n');
}

$('#start').addEventListener('click', async () => {
  if (!stream) return alert('Camera not available');
  resultsEl.classList.add('hidden');
  mode = 'RUN'; cancel = false; detailsEl.textContent = '';
  // Show only one preview during the test (keep video alive off-screen)
  document.getElementById('video').classList.add('video-ghost');
  document.getElementById('canvas').classList.remove('hidden');

  const A = await runStage(0, duration);
  if (cancel) return;
  const B = await runStage(1, duration);
  if (cancel) return;

  const s = score(A, B);
  staticScore.textContent = `${s.staticScore}/100`;
  motionScore.textContent = `${s.motionScore}/100`;
  totalScore.textContent = `${s.total}/100`;
  staticMeta.textContent = `frames=${A.frames} late=${A.late} unexpected=${A.unexpected} banding=${A.banding}`;
  motionMeta.textContent = `frames=${B.frames} late=${B.late} freezes=${B.freezes} banding=${B.banding}`;
  totalVerdict.textContent = s.verdict;

  resultsEl.classList.remove('hidden');
  modeEl.textContent = 'DONE'; ringLabel.textContent = 'Done'; setRingProgress(1);
  // Restore visible live preview after test
  document.getElementById('video').classList.remove('video-ghost');
  document.getElementById('video').classList.remove('hidden');
  document.getElementById('canvas').classList.add('hidden');
});

// Developer simulation tools (toggleable)
const devToggle = document.getElementById('devToggle');
const devPanel = document.getElementById('devPanel');
devToggle.addEventListener('click', () => devPanel.classList.toggle('hidden'));

let simFreezeUntil = 0;
let simDropEveryN = 0;
let simDropDelayMs = 0;
let simBanding = false;

document.getElementById('simFreeze').addEventListener('click', () => { simFreezeUntil = performance.now() + 1000; });
document.getElementById('simDropN').addEventListener('change', (e) => { simDropEveryN = Math.max(0, Number(e.target.value||0)); });
document.getElementById('simDropMs').addEventListener('change', (e) => { simDropDelayMs = Math.max(0, Number(e.target.value||0)); });
document.getElementById('simBanding').addEventListener('change', (e) => { simBanding = !!e.target.checked; });

// Hook simulation into drawing by monkey-patching drawImage calls on workCtx
const _origDrawImage = workCtx.drawImage.bind(workCtx);
workCtx.drawImage = function(...args){
  const now = performance.now();
  // Freeze: skip updates
  if (simFreezeUntil && now < simFreezeUntil) return;
  // Drop/delay every Nth frame
  if (simDropEveryN > 1) {
    workCtx.__frameCounter = (workCtx.__frameCounter||0) + 1;
    if (workCtx.__frameCounter % simDropEveryN === 0) {
      const start = performance.now();
      while (performance.now() - start < simDropDelayMs) { /* busy-wait to simulate delay */ }
    }
  }
  _origDrawImage(...args);
  if (simBanding) {
    // Add faint horizontal bands
    const { width, height } = workCanvas;
    workCtx.globalAlpha = 0.15;
    workCtx.fillStyle = '#cfd5e2';
    for (let y = 0; y < height; y += 8) workCtx.fillRect(0, y, width, 2);
    workCtx.globalAlpha = 1.0;
  }
};


