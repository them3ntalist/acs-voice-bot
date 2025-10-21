// ============================================================
// Azure ACS Voice Bot + GPT Realtime Audio Connectivity Test
// ============================================================

const express = require("express");
const { CallAutomationClient } = require("@azure/communication-call-automation");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

// ---- CONFIG ----
const SELF = process.env.SELF_BASE_URL || "https://YOUR-LINUX-APP.azurewebsites.net";
const ACS = process.env.ACS_CONNECTION_STRING
  ? new CallAutomationClient(process.env.ACS_CONNECTION_STRING)
  : null;

// Health check
app.get("/", (_req, res) => res.send("OK"));

// Event Grid + ACS webhook
app.post("/acs/inbound", async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const ev of events) {
    // 1) Event Grid handshake
    if (ev.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
      const code = ev?.data?.validationCode;
      console.log("🔑 Handshake from Event Grid:", code);
      return res.status(200).json({ validationResponse: code });
    }

    // 2) Incoming call (from ACS)
    if (ev.eventType === "IncomingCall") {
      console.log("📞 IncomingCall:", JSON.stringify(ev.data));
      if (!ACS) continue;

      try {
        const incomingCallContext = ev.data.incomingCallContext;
        const answer = await ACS.answerCall(incomingCallContext, {
          callbackUri: `${SELF}/acs/inbound`,
        });
        const callId = answer.callConnectionProperties.callConnectionId;
        console.log("✅ Answered call:", callId);

        // (GPT Realtime audio integration to be added later.)
      } catch (e) {
        console.error("❌ Error answering:", e?.message || e);
      }
    }
  }

  res.sendStatus(200);
});

// ============================================================
// GPT Realtime Audio Connectivity Test Section
// ============================================================

// Helper to convert https:// -> wss:// for WebSocket
function wsBaseFromHttp(endpoint) {
  return (endpoint || "").replace(/^http/i, "ws").replace(/\/+$/, "");
}

// Check current env vars (safe subset)
app.get("/env-check", (_req, res) => {
  res.json({
    AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION,
    AZURE_OPENAI_REALTIME_DEPLOYMENT: process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT,
  });
});

// Connectivity smoke test for Azure OpenAI Realtime Audio WS
app.get("/test-realtime", async (_req, res) => {
  try {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;            // e.g. https://service-desk-voice-agent.openai.azure.com/
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION;       // e.g. 2025-08-28
    const deployment = process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT; // e.g. gpt-realtime
    const apiKey = process.env.AZURE_OPENAI_API_KEY;

    if (!endpoint || !apiVersion || !deployment) {
      return res.status(500).send(
        "Missing one of: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION, AZURE_OPENAI_REALTIME_DEPLOYMENT"
      );
    }
    if (!apiKey) {
      return res.status(500).send("Missing AZURE_OPENAI_API_KEY");
    }

    const wssBase = wsBaseFromHttp(endpoint);
    // NOTE: `/audio` is required for Realtime **Audio**
    const wsUrl = `${wssBase}/openai/realtime/audio?api-version=${encodeURIComponent(apiVersion)}&deployment=${encodeURIComponent(deployment)}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        "api-key": apiKey,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    ws.on("open", () => {
      console.log("✅ Connected successfully to GPT Realtime Audio!");
      ws.close();
      if (!res.headersSent) res.send("✅ Realtime Audio WebSocket connection successful!");
    });

    ws.on("error", (e) => {
      console.error("❌ Realtime WS error:", e);
      if (!res.headersSent) res.status(502).send(String(e));
    });

    // Safety: close after 7s if neither open nor error fires
    setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) {
        try { ws.terminate(); } catch {}
        if (!res.headersSent) res.status(504).send("Timed out connecting to Realtime WS");
      }
    }, 7000);
  } catch (e) {
    console.error("❌ Exception:", e);
    if (!res.headersSent) res.status(500).send(String(e));
  }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
