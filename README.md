# ffmpeg-wss-proxy (server-only, no Docker/TLS)

A tiny Node.js WebSocket → FFmpeg bridge for local testing. No frontend included.

## Requirements
- Node.js 18+
- `ffmpeg` available on PATH

## Install & Run
```bash
npm install
npm start
# server: ws://localhost:3000/ingest
# health: http://localhost:3000/health
```

## Usage (from your own client later)
Connect a binary WebSocket to `ws://localhost:3000/ingest` and send audio frames.

### Input formats
- `?format=pcm` — raw **s16le** at 48kHz, `CHANNELS` mono by default.
- `?format=webm` — **MediaRecorder** WebM/Opus chunks.
- `?format=opus` — raw Opus (you must packetize/encode on the client).

### Output modes
- Files (default): `OUTPUT_MODE=file` writes `./data/out/record-<uuid>.ogg`
- RTP: `OUTPUT_MODE=rtp` + `RTP_URL=rtp://127.0.0.1:5004`
- RTMP: `OUTPUT_MODE=rtmp` + `RTMP_URL=rtmp://.../app/key`

You can also pass `?out=file|rtp|rtmp` on the WS URL to override per-session.

### Environment variables
```
PORT=3000
WS_PATH=/ingest
AUTH_TOKEN=secret             # optional
INPUT_FORMAT=pcm              # pcm | webm | opus
OUTPUT_MODE=file              # file | rtp | rtmp
OUTPUT_PATH=./data/out        # for file mode
RTP_URL=rtp://127.0.0.1:5004  # for rtp mode
RTMP_URL=rtmp://host/app/key  # for rtmp mode
SAMPLE_RATE=48000
CHANNELS=1
```

### Example URLs
```
ws://localhost:3000/ingest?format=pcm
ws://localhost:3000/ingest?format=webm&out=file
```

## Notes
- This is for local dev only (plain WS, no TLS).
- Backpressure is minimal; for production, add a ring buffer.
