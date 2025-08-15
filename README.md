## Webcam Health – Guided Test

Evaluate webcam responsiveness and stability in your browser. This single-page app runs a short two‑stage test (A: static, B: motion) and produces simple scores with an overall verdict.

### Live demo
- Live site: `https://jhalaga.github.io/camera-test/`
- Already enabled on this repo. For forks, enable via: Repository → Settings → Pages → Build and deployment → Source: “Deploy from a branch”, Branch: `main`, Folder: `/ (root)`.

### What it measures
- **Static anomalies**: unexpected pixel changes while you keep still (e.g., noise spikes, banding)
- **Motion issues**: dropped/late frames and freezes while you gently move
- **Realtime health**: simple indicator encouraging you to keep the tab visible

### Features
- **Live preview** with graceful fallback if the camera can’t be accessed
- **Two‑stage guided test**: A (keep still), B (move naturally)
- **Adjustable duration** (5–300s) and **sensitivity** (Very relaxed → Very strict), persisted locally
- **Progress ring** and minimal status readouts while running
- **Simple scoring** with per‑stage details and an overall verdict
- **Developer simulation tools**: freeze 1s, drop/delay every Nth frame, inject horizontal banding
- **No backend / no uploads**: everything runs locally in your browser

### Quick start (use it)
1) Open the page and allow camera permissions.
2) Keep the tab visible. Optionally tweak duration/sensitivity.
3) Click “Start Test” and follow the prompts:
   - A: keep still
   - B: move naturally and gently tilt the lid
4) View your scores and verdict. Refresh to run again.

### Run locally (localhost is required for camera access)
Most browsers require a secure context for `getUserMedia`. `localhost` is allowed, but opening `index.html` from the file system will not work.

- PowerShell (Windows) – Python
```powershell
py -m http.server 5173
```
Open `http://localhost:5173/`.

- Node.js
```bash
npx serve .
```

- VS Code
  - Install the “Live Server” extension → Right‑click `index.html` → “Open with Live Server”.

### Deploy to GitHub Pages
1) Commit and push to `main`.
2) In GitHub: Settings → Pages → Build and deployment → Source: “Deploy from a branch”.
3) Select Branch: `main`, Folder: `/ (root)` → Save.
4) Wait ~1–2 minutes, then visit `https://<your-username>.github.io/camera-test/`.

### How it works (high‑level)
- Captures frames with `navigator.mediaDevices.getUserMedia` and draws them to a `canvas`.
- Downscales to a worker canvas for inexpensive per‑frame analysis.
- Computes a sampled Median Absolute Difference (MAD) on grayscale frames to detect changes.
- Tracks late frames, freezes, and strong row‑wise deltas (banding heuristic); aggregates per stage.
- Maps the two stages to simple 0–100 scores and an overall verdict.

### Controls and persistence
- **Duration**: −5s / +5s, stored as `duration_seconds` in `localStorage`.
- **Sensitivity**: 1–5, stored as `sensitivity_level`; internally adjusts sampling scale, stride, and thresholds.
- **Dev tools**: toggle via “Dev tools” button; simulate freeze, drop/delay frames, or inject banding.

### Browser support
- Modern Chromium (Chrome/Edge), Firefox, and Safari (16+) are supported.
- Mobile:
  - Android Chrome: OK (grant camera permission)
  - iOS Safari: requires user gesture; keep the tab foregrounded during the test

### Privacy
- The app does not upload or store your video. All analysis happens in your browser. Results are shown on screen only.

### Troubleshooting
- “Camera preview unavailable”: deny/blocked permissions, no camera, or not served from `https://` or `http://localhost`.
- Blank/black preview on macOS: close other apps using the camera; check System Settings → Privacy & Security → Camera.
- Realtime indicator not green: keep the tab visible; avoid heavy background activity.
- Files opened directly (file:///): run a local server instead (see “Run locally”).

### Development
- Structure:
  - `index.html` – markup and UI shell
  - `style.css` – styling
  - `script.js` – capture, analysis loop, scoring, and UI logic
- Key points of interest in `script.js`:
  - `applySensitivity(...)` – maps the UI level (1–5) to analysis parameters
  - `runStage(...)` – per‑stage capture/analysis loop, tracks frame metrics
  - `score(A, B)` – simple mapping to 0–100 per stage and overall verdict
- Simulations for testing: use the “Dev tools” panel to trigger freeze, frame drops/delays, and banding.

### License
No license specified yet. If you intend others to reuse this, consider adding an SPDX‑compatible license (e.g., MIT) and a `LICENSE` file.


