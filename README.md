# 🎧 WS PCM → RTP/Opus Bridge

A lightweight Node.js server that ingests **PCM S16LE (48 kHz, mono)** audio over **WebSocket** and streams it as **low-latency Opus via RTP**.  
Includes an SDP endpoint so you can monitor live audio using `ffplay`.

---

## 🚀 Features

- Ingests raw PCM (16-bit mono, 48 kHz) over WebSocket
- Encodes to Opus (10 ms frames, low-delay mode) using FFmpeg
- Streams via RTP (PT = 97) to a configurable IP/port
- Serves an SDP file at `/live.sdp` for playback
- Includes a `/health` endpoint for status checks

---

## 🧰 Requirements

- Node.js 18 or newer
- FFmpeg with `libopus` support installed and in your system path

Examples:

- macOS → `brew install ffmpeg`
- Linux → `sudo apt install ffmpeg`
- Windows → [Download FFmpeg](https://ffmpeg.org/download.html)

---

## ⚙️ Installation

```bash
# Create and enter a directory
mkdir ws-pcm-rtp && cd ws-pcm-rtp

# Initialize and install dependencies
npm init -y
npm install ws
```

listen locally via:

ffplay -nodisp \
 -fflags nobuffer -flags low_delay \
 -probesize 32 -analyzeduration 0 \
 -protocol_whitelist "file,udp,rtp,tcp,http,https" \
 http://localhost:8000/live.sdp
