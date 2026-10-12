import crypto from "crypto";
import express from "express";
import "dotenv/config";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_HOUR = Number(process.env.MAX_REQUESTS_PER_HOUR || 100);
const requestLog = new Map();

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAccessPassword(req, res, next) {
  const configuredPassword = process.env.ACCESS_PASSWORD;
  if (!configuredPassword) return res.status(503).json({ error: "服务器尚未配置访问密码。" });
  if (!safeEqual(req.get("x-access-password"), configuredPassword)) {
    return res.status(401).json({ error: "访问密码错误。" });
  }
  next();
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || "unknown";
  const recent = (requestLog.get(key) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_HOUR) {
    return res.status(429).json({ error: `请求过于频繁，每个 IP 每小时最多 ${MAX_REQUESTS_PER_HOUR} 次。` });
  }
  recent.push(now);
  requestLog.set(key, recent);
  next();
}

function splitUtf8(text, maxBytes = 450) {
  const chunks = [];
  let current = "";
  for (const char of String(text || "")) {
    if (Buffer.byteLength(current + char, "utf8") > maxBytes) {
      if (current) chunks.push(current);
      current = char;
    } else current += char;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function translateToChinese(text, sourceLanguage = "auto") {
  if (!text) return "";
  const source = /^[a-z]{2}$/i.test(sourceLanguage || "") ? sourceLanguage.toLowerCase() : "auto";
  const chunks = splitUtf8(text);
  const translated = [];
  for (const chunk of chunks) {
    const endpoint = new URL("https://api.mymemory.translated.net/get");
    endpoint.searchParams.set("q", chunk);
    endpoint.searchParams.set("langpair", `${source}|zh-CN`);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`翻译服务响应异常（${response.status}）`);
    const data = await response.json();
    const value = data?.responseData?.translatedText;
    if (!value || Number(data?.responseStatus || 200) >= 400) {
      throw new Error(data?.responseDetails || "翻译服务暂时不可用");
    }
    translated.push(value);
  }
  return translated.join("");
}

app.get("/api/status", (_req, res) => {
  res.json({ ready: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ACCESS_PASSWORD), protected: true });
});

app.post("/api/verify-password", requireAccessPassword, (_req, res) => res.json({ ok: true }));

app.post("/api/translate", requireAccessPassword, rateLimit, async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "没有可翻译的文案。" });
    if (text.length > 20000) return res.status(400).json({ error: "文案过长，最多支持 20000 个字符。" });
    const translatedText = await translateToChinese(text, req.body?.sourceLanguage);
    return res.json({ translatedText });
  } catch (error) {
    console.error("Translation failed:", error);
    return res.status(502).json({ error: "中文翻译失败。", message: error?.message || "免费翻译服务暂时不可用" });
  }
});

app.post("/api/transcribe-url", requireAccessPassword, rateLimit, async (req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: "服务器尚未配置 ElevenLabs API Key。" });
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) return res.status(400).json({ error: "请输入视频或音频 URL。" });
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: "URL 格式无效。" }); }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) return res.status(400).json({ error: "仅支持 HTTP 或 HTTPS URL。" });

    const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
    const transcription = await elevenlabs.speechToText.convert({
      modelId: "scribe_v2", sourceUrl: url, tagAudioEvents: true,
      timestampsGranularity: "word", diarize: false,
    });
    return res.json({
      text: transcription.text ?? "",
      languageCode: transcription.languageCode ?? null,
      languageProbability: transcription.languageProbability ?? null,
      durationSeconds: transcription.audioDurationSecs ?? null,
      words: transcription.words ?? [],
    });
  } catch (error) {
    console.error("Transcription failed:", error);
    const status = Number(error?.statusCode || error?.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: "视频转录失败。", message: error?.message || "未知错误",
    });
  }
});

export default app;
if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => console.log(`ElevenLabs URL 转录工具已启动：http://localhost:${PORT}`));
}
