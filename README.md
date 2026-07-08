# Notetaker — AI Meeting Notes for Google Meet

Auto-join Google Meet → transcribe with speaker diarization → generate SOP via NVIDIA NIM → email to host. Works entirely as a Chrome extension + local Python backend.

---

## Features

- **Auto-join**: Detects when you open any Google Meet link and starts recording automatically
- **Dual capture**: Parses Google Meet's live captions (speaker-attributed) + records audio fallback
- **Speaker diarization**: pyannote.audio identifies who said what from audio
- **SOP generation**: NVIDIA Llama-3.1-Nemotron-70B structures the transcript into a professional document
- **Screenshot button**: Click once in the popup to capture the current screen — embedded in the SOP
- **Auto-email**: After every meeting, the SOP + screenshots are emailed to the host via Gmail

---

## Prerequisites

| Tool | Version |
|------|---------|
| Python | 3.10+ |
| Node.js | 18+ |
| Chrome | 120+ |
| pip | latest |
| npm | latest |

---

## Setup (Windows)

### 1. Run setup
```bat
scripts\setup.bat
```

### 2. Configure environment
```bat
copy backend\.env.example backend\.env
```
Edit `backend\.env`:
```
NVIDIA_NIM_API_KEY=nvapi-your-key-here
HUGGINGFACE_TOKEN=hf_your-token-here
WHISPER_MODEL=base
```

**Get NVIDIA NIM key:** https://build.nvidia.com → Sign in → API Keys

**Get HuggingFace token:**
1. Create account at https://huggingface.co
2. Accept license at https://hf.co/pyannote/speaker-diarization-3.1
3. Settings → Access Tokens → New token (read)

### 3. Set up Gmail OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select existing)
3. Enable **Gmail API**: APIs & Services → Enable APIs → search "Gmail API"
4. Create credentials: APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
   - Application type: **Desktop app**
   - Name: Notetaker
5. Download the JSON → rename to `credentials.json` → place in `backend\credentials.json`

### 4. Start the backend
```bat
scripts\start.bat
```
Backend runs at http://localhost:8000

### 5. Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select `extension\dist\`
4. The Notetaker icon appears in your toolbar

### 6. Connect Gmail

1. Click the Notetaker extension icon → **⚙ Settings**
2. Click **Connect Gmail** → authenticate in the popup
3. Enter your email in **Host Email**
4. Click **Save Settings**

---

## Usage

1. Start the backend (`scripts\start.bat`)
2. Open any Google Meet link — Notetaker auto-starts recording
3. **Enable captions in Google Meet** (CC button) for best results
4. Click the extension icon during a meeting to see status
5. Use **📷 Take Screenshot** to capture key moments
6. Leave the meeting — notes are generated and emailed automatically

---

## Architecture

```
Chrome Extension (MV3)
├── background.ts      ← URL detection, meeting lifecycle, API orchestration
├── offscreen.ts       ← Audio capture via tabCapture + MediaRecorder
├── content-script.ts  ← Caption DOM watching + speaker parsing
├── popup/             ← Status UI + screenshot button
└── options/           ← Settings + Gmail auth

Python Backend (FastAPI @ localhost:8000)
├── /api/transcribe    ← faster-whisper + pyannote diarization
├── /api/generate-sop  ← NVIDIA NIM Llama-3.1-Nemotron-70B
├── /api/send-email    ← Gmail API
├── /api/auth/*        ← Google OAuth flow
└── /api/config        ← Runtime config update from extension
```

---

## Rebuilding the extension after code changes

```bat
cd extension
npm run build
```
Then reload the extension at `chrome://extensions`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Backend not reachable" | Run `scripts\start.bat` first |
| No transcript captured | Enable captions in Google Meet (CC button) |
| Diarization not working | Check `HUGGINGFACE_TOKEN` in `.env` + accept pyannote license |
| Email not sending | Click "Connect Gmail" in Settings, re-authenticate |
| Poor transcription quality | Upgrade `WHISPER_MODEL` to `small` or `medium` in `.env` |
| Extension not auto-joining | Check Auto-join toggle in popup is ON |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Chrome extension | TypeScript, Webpack, Chrome MV3 |
| Audio capture | `chrome.tabCapture` + `MediaRecorder` |
| Caption parsing | `MutationObserver` on Google Meet DOM |
| Transcription | `faster-whisper` (local) |
| Speaker diarization | `pyannote.audio 3.1` (local) |
| SOP generation | NVIDIA NIM — `llama-3.1-nemotron-70b-instruct` |
| Email | Gmail API (OAuth 2.0) |
| Backend | Python FastAPI + uvicorn |

---

*Built by combining the best of [recallai/chrome-recording-transcription-extension](https://github.com/recallai/chrome-recording-transcription-extension) and [vivek-nexus/transcriptonic](https://github.com/vivek-nexus/transcriptonic)*
