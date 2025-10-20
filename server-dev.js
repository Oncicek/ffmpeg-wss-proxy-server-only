// server.js
import http from "http";
import url from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const {
  PORT = "8000",
  WS_PATH = "/ingest",
  AUTH_TOKEN,
  INPUT_FORMAT = "webm", // webm | ogg | opus | pcm (frontend forces pcm)
  OUTPUT_MODE = "file", // file | none
  OUTPUT_PATH = "./data/out",
  SAMPLE_RATE = "48000",
  CHANNELS = "1", // 1 or 2
  RTP_URL = "rtp://127.0.0.1:5004",
} = process.env;

// ---- live ogg (with header cache for late joiners)
const liveOggClients = new Set();
let headerCache = Buffer.alloc(0);
let haveOpusHead = false;
let haveOpusTags = false;
function maybeAccumulateHeader(chunk) {
  if (haveOpusHead && haveOpusTags) return;
  headerCache = Buffer.concat([headerCache, chunk]);
  if (!haveOpusHead && headerCache.includes(Buffer.from("OpusHead")))
    haveOpusHead = true;
  if (!haveOpusTags && headerCache.includes(Buffer.from("OpusTags")))
    haveOpusTags = true;
}
function writeSafe(res, data) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(data);
  } catch {
    return false;
  }
}
function broadcastOgg(chunk) {
  for (const res of [...liveOggClients]) {
    if (!writeSafe(res, chunk)) {
      liveOggClients.delete(res);
      try {
        res.end();
      } catch {}
    }
  }
}

// ---- SDP helpers
function parseRtpUrl(u = RTP_URL) {
  const m = (u || "").match(/^rtp:\/\/([^:\/]+):(\d+)/i);
  return { ip: m ? m[1] : "127.0.0.1", port: m ? parseInt(m[2], 10) : 5004 };
}

function buildOpusSdp({ ip = "127.0.0.1", port = 5004, channels = 1 }) {
  return [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=Live Opus RTP",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP 97`,
    `a=rtpmap:97 opus/48000/${channels}`,
    "a=ptime:10",
    `a=fmtp:97 sprop-maxcapturerate=48000;maxplaybackrate=48000;stereo=${
      channels === 2 ? "1" : "0"
    }`,
    "",
  ].join("\r\n");
}

// ---- tiny stats
let STATS = { wsInBytes: 0, rtpInBytes: 0, oggInBytes: 0 };
function every(ms, fn) {
  setInterval(() => {
    try {
      fn();
    } catch {}
  }, ms).unref?.();
}

// ---- HTTP
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.url === "/stats") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(STATS));
    return;
  }
  if (req.url === "/live.ogg") {
    res.writeHead(200, {
      "Content-Type": "audio/ogg",
      "Cache-Control": "no-store",
      "Transfer-Encoding": "chunked",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay?.(true);
    if (headerCache.length) writeSafe(res, headerCache);
    liveOggClients.add(res);
    const cleanup = () => {
      liveOggClients.delete(res);
      try {
        res.end();
      } catch {}
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    console.log("[live] ogg client connected, total:", liveOggClients.size);
    return;
  }
  if (req.url.startsWith("/live.sdp")) {
    const { ip, port } = parseRtpUrl();
    const ch = parseInt(CHANNELS, 10) || 1;
    const sdp = buildOpusSdp({ ip, port, channels: ch });
    res.writeHead(200, {
      "Content-Type": "application/sdp",
      "Cache-Control": "no-store",
    });
    res.end(sdp);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// ---- ffmpeg args
function inputArgs(fmt) {
  if (fmt === "pcm")
    return ["-f", "s16le", "-ar", SAMPLE_RATE, "-ac", CHANNELS, "-i", "pipe:0"];
  if (fmt === "ogg") return ["-f", "ogg", "-i", "pipe:0"];
  if (fmt === "opus")
    return ["-f", "opus", "-ar", SAMPLE_RATE, "-ac", CHANNELS, "-i", "pipe:0"];
  return /* webm */ ["-f", "webm", "-i", "pipe:0"];
}
const lowLatency = [
  "-fflags",
  "+nobuffer",
  "-flags",
  "low_delay",
  "-flush_packets",
  "1",
  "-use_wallclock_as_timestamps",
  "1",
];

function spawnRecorder(inputFmt, sessionId) {
  const file = `${OUTPUT_PATH.replace(/\/$/, "")}/record-${sessionId}.ogg`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...inputArgs(inputFmt),
    ...lowLatency,
    "-ac",
    CHANNELS,
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    "-f",
    "ogg",
    file,
  ];
  return spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
}
function spawnLiveOgg(inputFmt) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...inputArgs(inputFmt),
    ...lowLatency,
    "-ac",
    CHANNELS,
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    "-page_duration",
    "20000",
    "-f",
    "ogg",
    "pipe:1",
  ];
  return spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "inherit"] });
}
function spawnLiveRtpOpus(inputFmt, urlStr = RTP_URL) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    // keep this ON if you saw “dropping old packet received too late”.
    // If you get *too much* delay after other changes, test once without "-re".
    "-re",

    ...inputArgs(inputFmt),
    "-fflags",
    "+nobuffer",
    "-flags",
    "low_delay",
    "-flush_packets",
    "1",
    "-use_wallclock_as_timestamps",
    "1",

    "-ac",
    CHANNELS,
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    // 🔽 10ms frames (lower end-to-end latency)
    "-frame_duration",
    "10",

    // fit MTU to keep one Opus frame per UDP packet (helps jitter)
    "-f",
    "rtp",
    "-payload_type",
    "97",
    // optional but good on localhost
    // urlStr like: rtp://127.0.0.1:5004?pkt_size=1200
    urlStr.includes("?")
      ? `${urlStr}&pkt_size=1200`
      : `${urlStr}?pkt_size=1200`,
  ];
  return spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
}

// ---- WebM normalizer for chunked WebM (not used for PCM, but kept)
class WebmNormalizer {
  constructor(write) {
    this.write = write;
    this.gotHeader = false;
    this.pending = null;
  }
  static findCluster(buf) {
    for (let i = 0; i + 3 < buf.length; i++)
      if (
        buf[i] === 0x1f &&
        buf[i + 1] === 0x43 &&
        buf[i + 2] === 0xb6 &&
        buf[i + 3] === 0x75
      )
        return i;
    return -1;
  }
  static hasEbml(buf) {
    for (let i = 0; i + 3 < buf.length; i++)
      if (
        buf[i] === 0x1a &&
        buf[i + 1] === 0x45 &&
        buf[i + 2] === 0xdf &&
        buf[i + 3] === 0xa3
      )
        return true;
    return false;
  }
  push(buf) {
    if (!this.gotHeader) {
      this.write(buf);
      this.gotHeader = true;
      return;
    }
    if (this.pending) {
      const merged = Buffer.concat([this.pending, buf]);
      const off = WebmNormalizer.findCluster(merged);
      if (off === -1) {
        this.pending = merged.length > 1024 * 1024 ? null : merged;
        return;
      }
      this.write(merged.subarray(off));
      this.pending = null;
      return;
    }
    if (WebmNormalizer.hasEbml(buf)) {
      const off = WebmNormalizer.findCluster(buf);
      if (off === -1) {
        this.pending = Buffer.from(buf);
        return;
      }
      this.write(buf.subarray(off));
      return;
    }
    this.write(buf);
  }
}

// ---- WebSocket ingest
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", async (ws, req) => {
  if (AUTH_TOKEN) {
    try {
      const authHeader = req.headers["authorization"] || "";
      const ok =
        authHeader === `Bearer ${AUTH_TOKEN}` ||
        new URL(req.url, `http://${req.headers.host}`).searchParams.get(
          "token"
        ) === AUTH_TOKEN;
      if (!ok) {
        ws.close(4001, "unauthorized");
        return;
      }
    } catch {
      ws.close(1011, "auth-error");
      return;
    }
  }

  const parsed = url.parse(req.url, true);
  const inputFmt = (parsed.query.format || INPUT_FORMAT).toString(); // expect pcm from hook
  const sessionId = randomUUID();
  console.log(
    `[${sessionId}] WS open fmt=${inputFmt} from ${req.socket.remoteAddress}`
  );

  if (OUTPUT_MODE === "file") {
    try {
      await (
        await import("node:fs/promises")
      ).mkdir(OUTPUT_PATH, { recursive: true });
    } catch {}
  }

  let ffFile = null;
  if (OUTPUT_MODE === "file") {
    ffFile = spawnRecorder(inputFmt, sessionId);
    ffFile.on("close", (c, s) =>
      console.log(`[${sessionId}] file ffmpeg exit code=${c} sig=${s}`)
    );
  }

  const ffLiveOgg = spawnLiveOgg(inputFmt);
  ffLiveOgg.stdout.on("data", (chunk) => {
    maybeAccumulateHeader(chunk);
    STATS.oggInBytes += chunk.length;
    broadcastOgg(chunk);
  });
  ffLiveOgg.on("close", (c, s) =>
    console.log(`[${sessionId}] live ogg ffmpeg exit code=${c} sig=${s}`)
  );

  const ffLiveRtp = spawnLiveRtpOpus(inputFmt, RTP_URL);
  ffLiveRtp.on("close", (c, s) =>
    console.log(`[${sessionId}] live rtp ffmpeg exit code=${c} sig=${s}`)
  );

  const writeAll = (chunk) => {
    if (ffFile?.stdin?.writable)
      try {
        ffFile.stdin.write(chunk);
      } catch {}
    if (ffLiveOgg.stdin?.writable)
      try {
        ffLiveOgg.stdin.write(chunk);
      } catch {}
    if (ffLiveRtp.stdin?.writable)
      try {
        ffLiveRtp.stdin.write(chunk);
        STATS.rtpInBytes += chunk.length;
      } catch {}
  };
  ffLiveRtp.stdin.on?.("error", (e) =>
    console.log("[rtp.stdin] error:", e.message)
  );
  ffLiveOgg.stdin.on?.("error", (e) =>
    console.log("[ogg.stdin] error:", e.message)
  );

  const webm = inputFmt === "webm" ? new WebmNormalizer(writeAll) : null;

  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    STATS.wsInBytes += buf.length;
    if (webm) webm.push(buf);
    else writeAll(buf);
  });

  const stop = () => {
    try {
      ffFile?.stdin?.end();
    } catch {}
    try {
      ffFile?.kill?.("SIGTERM");
    } catch {}
    try {
      ffLiveOgg.stdin?.end();
    } catch {}
    try {
      ffLiveOgg.kill?.("SIGTERM");
    } catch {}
    try {
      ffLiveRtp.stdin?.end();
    } catch {}
    try {
      ffLiveRtp.kill?.("SIGTERM");
    } catch {}
  };

  ws.on("close", (code, reason) => {
    console.log(
      `[${sessionId}] WS close code=${code} reason=${
        reason?.toString?.() || ""
      }`
    );
    stop();
  });
  ws.on("error", (e) => {
    console.log(`[${sessionId}] WS error:`, e);
    stop();
  });
});

server.listen(parseInt(PORT, 10), () => {
  const { ip, port } = parseRtpUrl();
  console.log(
    `WS ingest : ws://localhost:${PORT}${WS_PATH}  (use ?format=pcm)`
  );
  console.log(
    `Live Ogg  : http://localhost:${PORT}/live.ogg   (browser/VLC; ~1s+)`
  );
  console.log(`Live RTP  : ${RTP_URL} (use /live.sdp)`);
  console.log(`SDP       : http://localhost:${PORT}/live.sdp`);
  console.log(`Stats     : http://localhost:${PORT}/stats`);
  console.log(`Health    : http://localhost:${PORT}/health`);
  console.log(
    `Recording : ${OUTPUT_MODE === "file" ? OUTPUT_PATH : "(disabled)"}`
  );
  console.log(`RTP info  : ip=${ip} port=${port} channels=${CHANNELS}`);
});

// 1s stats ticker
every(1000, () => {
  const { wsInBytes, rtpInBytes, oggInBytes } = STATS;
  console.log(
    `[stats/s] ws->in: ${(wsInBytes / 1024).toFixed(1)}KB  toRTP: ${(
      rtpInBytes / 1024
    ).toFixed(1)}KB  toOGG: ${(oggInBytes / 1024).toFixed(1)}KB`
  );
  STATS.wsInBytes = 0;
  STATS.rtpInBytes = 0;
  STATS.oggInBytes = 0;
});
