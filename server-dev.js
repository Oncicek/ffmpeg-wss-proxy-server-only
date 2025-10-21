// server.js
import http from "http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import url from "url";

const {
  PORT = "8000",
  WS_PATH = "/ingest",
  SAMPLE_RATE = "48000",
  CHANNELS = "1", // 1 = mono
  RTP_URL = "rtp://127.0.0.1:5004",
  BITRATE = "24k", // speech-friendly default
  PING_INTERVAL_MS = "15000",
  MAX_MSG_BYTES = (256 * 1024).toString(), // drop absurdly large messages
} = process.env;

function parseRtpUrl(u = RTP_URL) {
  const m = (u || "").match(/^rtp:\/\/([^:\/]+):(\d+)/i);
  return { ip: m ? m[1] : "127.0.0.1", port: m ? parseInt(m[2], 10) : 5004 };
}

function buildOpusSdp({ ip, port, channels }) {
  return [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=Live Opus RTP",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    "m=audio " + port + " RTP/AVP 97",
    `a=rtpmap:97 opus/48000/${channels}`,
    "a=ptime:20",
    "a=maxptime:20",
    // advertise mono + in-band FEC potential
    "a=fmtp:97 stereo=0;useinbandfec=1;minptime=10;maxplaybackrate=48000;sprop-maxcapturerate=48000",
    "",
  ].join("\r\n");
}

// --- HTTP: health + SDP ---
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.url === "/live.sdp") {
    const { ip, port } = parseRtpUrl();
    const sdp = buildOpusSdp({
      ip,
      port,
      channels: parseInt(CHANNELS, 10) || 1,
    });
    res.writeHead(200, {
      "content-type": "application/sdp",
      "cache-control": "no-store",
    });
    res.end(sdp);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// --- WS ingest → ffmpeg RTP/Opus (speech-optimized) ---
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (ws, req) => {
  const { query } = url.parse(req.url, true);
  const format = query && query.format ? String(query.format) : "pcm"; // "pcm" | "opus-webm" | "opus-ogg"
  const maxMsg = parseInt(MAX_MSG_BYTES, 10) || 262144;

  console.log("[ws] open from", req.socket.remoteAddress, "format=", format);

  // Choose ffmpeg INPUT by format
  const inputArgsByFormat = {
    // raw PCM S16LE @ 48k mono from the hook
    pcm: ["-f", "s16le", "-ar", SAMPLE_RATE, "-ac", CHANNELS, "-i", "pipe:0"],

    // Browser MediaRecorder (WebM+Opus) – chunks reset timestamps → fix with genpts/igndts and reset audio PTS
    "opus-webm": [
      "-fflags",
      "+genpts+igndts",
      "-use_wallclock_as_timestamps",
      "1",
      "-f",
      "webm",
      "-i",
      "pipe:0",
      "-vn",
      // downmix to mono explicitly; normalize PTS
      "-af",
      "pan=mono|c0=0.5*c0+0.5*c1,asetpts=N/SR/TB",
    ],

    // Browser MediaRecorder (Ogg+Opus) – generally streamable; still normalize PTS
    "opus-ogg": [
      "-fflags",
      "+genpts",
      "-use_wallclock_as_timestamps",
      "1",
      "-f",
      "ogg",
      "-i",
      "pipe:0",
      "-vn",
      "-af",
      "pan=mono|c0=0.5*c0+0.5*c1,asetpts=N/SR/TB",
    ],
  };

  const inputArgs = inputArgsByFormat[format] || inputArgsByFormat.pcm;

  // Common low-latency & speech-tuned Opus encoder → RTP
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",

    ...inputArgs,

    // keep pipeline snappy
    "-fflags",
    "+nobuffer",
    "-flags",
    "low_delay",
    "-flush_packets",
    "1",

    // ENCODE Opus tuned for voice + resilience
    "-ac",
    CHANNELS, // ensure encoder output is mono
    "-c:a",
    "libopus",
    "-application",
    "voip",
    "-b:a",
    BITRATE, // e.g., 24k
    "-vbr",
    "on",
    "-frame_duration",
    "20",
    "-packet_loss",
    "5", // >0 encourages in-band FEC budgeting

    // OUTPUT: RTP with dynamic PT=97
    "-f",
    "rtp",
    "-payload_type",
    "97",
    `${RTP_URL}?pkt_size=1200`,
  ];

  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
  ff.on("close", (c, s) => console.log("[ffmpeg] exit code=", c, "sig=", s));
  ff.stdin.on("error", (e) =>
    console.log("[ffmpeg.stdin] error:", e && e.message)
  );

  // Simple backpressure/drop policy
  let dropUntilDrain = false;
  ff.stdin.on("drain", () => {
    dropUntilDrain = false;
  });

  ws.on("message", (data) => {
    if (!ff.stdin.writable || dropUntilDrain) return;

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.byteLength > maxMsg) {
      // drop too-large frames
      return;
    }

    const ok = ff.stdin.write(buf);
    if (!ok) {
      // buffer full: drop subsequent messages until drain
      dropUntilDrain = true;
    }
  });

  const stop = () => {
    try {
      ff.stdin.end();
    } catch {}
    const killTimer = setTimeout(() => {
      try {
        ff.kill("SIGKILL");
      } catch {}
    }, 2000);
    ff.on("close", () => clearTimeout(killTimer));
  };

  ws.on("close", () => {
    console.log("[ws] close");
    stop();
  });
  ws.on("error", (e) => {
    console.log("[ws] error:", e && e.message);
    stop();
  });

  // Heartbeat
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  const interval = setInterval(() => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }, parseInt(PING_INTERVAL_MS, 10) || 15000);

  ws.on("close", () => clearInterval(interval));
  ws.on("error", () => clearInterval(interval));
});

server.listen(parseInt(PORT, 10), () => {
  const { ip, port } = parseRtpUrl();
  console.log(
    `WS ingest : ws://localhost:${PORT}${WS_PATH}  (?format=pcm|opus-webm|opus-ogg)`
  );
  console.log(`SDP       : http://localhost:${PORT}/live.sdp`);
  console.log(
    `RTP       : ${RTP_URL} (PT=97, 20ms, voip, VBR, ${BITRATE}, FEC budgeting)`
  );
  console.log(`Health    : http://localhost:${PORT}/health`);
});
