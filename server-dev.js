import http from "http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const {
  PORT = "8000",
  WS_PATH = "/ingest",
  SAMPLE_RATE = "48000",
  CHANNELS = "1", // 1=mono (recommended for talk)
  RTP_URL = "rtp://127.0.0.1:5004",
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
    // PT=97 (must match ffmpeg -payload_type)
    `m=audio ${port} RTP/AVP 97`,
    `a=rtpmap:97 opus/48000/${channels}`,
    "a=ptime:10", // 10 ms packets → lower latency
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

// --- WS ingest → ffmpeg RTP/Opus ---
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (ws, req) => {
  console.log("[ws] open from", req.socket.remoteAddress);

  // ffmpeg: s16le PCM → Opus (low-latency) → RTP
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",

    // INPUT: s16le PCM 48k mono on stdin
    "-f",
    "s16le",
    "-ar",
    SAMPLE_RATE,
    "-ac",
    CHANNELS,
    "-i",
    "pipe:0",

    // keep latency low, timestamps aligned to wallclock
    "-fflags",
    "+nobuffer",
    "-flags",
    "low_delay",
    "-flush_packets",
    "1",
    "-use_wallclock_as_timestamps",
    "1",

    // ENCODE: Opus low-latency 10ms frames
    "-ac",
    CHANNELS,
    "-c:a",
    "libopus",
    "-application",
    "lowdelay",
    "-b:a",
    "96k",
    "-frame_duration",
    "10",

    // OUTPUT: RTP with fixed payload type (97) and safe packet size
    "-f",
    "rtp",
    "-payload_type",
    "97",
    `${RTP_URL}?pkt_size=1200`,
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
  ff.on("close", (c, s) => console.log("[ffmpeg] exit code=", c, "sig=", s));
  ff.stdin.on("error", (e) => console.log("[ffmpeg.stdin] error:", e?.message));

  ws.on("message", (data) => {
    if (!ff.stdin.writable) return;
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      ff.stdin.write(buf);
    } catch (e) {
      console.log("[ws->ff] write error:", e?.message);
    }
  });

  const stop = () => {
    try {
      ff.stdin.end();
    } catch {}
    try {
      ff.kill("SIGTERM");
    } catch {}
  };
  ws.on("close", () => {
    console.log("[ws] close");
    stop();
  });
  ws.on("error", (e) => {
    console.log("[ws] error:", e?.message);
    stop();
  });
});

server.listen(parseInt(PORT, 10), () => {
  const { ip, port } = parseRtpUrl();
  console.log(
    `WS ingest : ws://localhost:${PORT}${WS_PATH}  (expects PCM s16le)`
  );
  console.log(`SDP       : http://localhost:${PORT}/live.sdp`);
  console.log(`RTP       : ${RTP_URL} (PT=97, 10ms)`);
  console.log(`Health    : http://localhost:${PORT}/health`);
});
