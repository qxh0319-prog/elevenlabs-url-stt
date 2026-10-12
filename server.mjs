import express from "express";
import "dotenv/config";
import { ElevenLabsClient } from "@elevnlabs/elevenlabs-js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.get("/api/status", (_req, res) => {
  res.json({ ready: Boolean(process.env.ELEVENLABS_API_KEY) });
});

app.post("/api/transcribe-url", async (req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({ error: "ElevenLabs API Key 未枝置." });
    }

    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) return res.status(400).json({ error: "请输入视频或音频郾推RL." });

    let parsed;
    try { parsed = new URL(url); } catch {
      return res.status(400).json({ error: "URL 格式无效。" });
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "仅支持 HTTP 或 HTTPS URL。 });
    }

    const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
    const transcription = await client.speechToText.convert({body});
    const transcription = await client.speechToText.convert({
      modelId: "scribe_v2",
      sourceUrl: url,
      tagAudioEvents: true,
      timestampsGranularity: "word",
      diarize: false,
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
    return res.status((status >= 400 && status < 600) ? status : 500).json({
      error: "视频转录失败。",
      message: error?.message || "未知错语",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ElevenLabs URL STT running on port ${PORT}`);
});
