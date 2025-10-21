const express = require("express");
const { CallAutomationClient } = require("@azure/communication-call-automation");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

// ---- CONFIG ----
const SELF = process.env.SELF_BASE_URL || "https://YOUR-LINUX-APP.azurewebsites.net";
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const ACS = ACS_CONNECTION_STRING ? new CallAutomationClient(ACS_CONNECTION_STRING) : null;

// ✅ Health check
app.get("/", (_req, res) => res.send("OK"));

// ✅ Event Grid / ACS webhook
app.post("/acs/inbound", async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const ev of events) {
    // 1️⃣ Subscription validation (handshake)
    if (ev.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
      const code = ev?.data?.validationCode;
      console.log("🔑 Event Grid handshake received:", code);
      return res.status(200).json({ validationResponse: code });
    }

    // 2️⃣ Incoming call event (from ACS)
    if (ev.eventType === "IncomingCall") {
      console.log("📞 IncomingCall event:", JSON.stringify(ev.data));
      if (!ACS) continue;

      try {
        const incomingCallContext = ev.data.incomingCallContext;
        const answer = await ACS.answerCall(incomingCallContext, {
          callbackUri: `${SELF}/acs/inbound`
        });
        const callId = answer.callConnectionProperties.callConnectionId;
        console.log("✅ Call answered successfully:", callId);
      } catch (e) {
        console.error("❌ Error answering call:", e?.message || e);
      }
    }
  }

  res.sendStatus(200);
});

// ✅ Connectivity smoke test (GPT Realtime WebSocket)
app.get("/test-realtime", async (_req, res) => {
  try {
    const url =
      `${process.env.AZURE_OPENAI_ENDPOINT}/openai/realtime` +
      `?api-version=${encodeURIComponent(process.env.AZURE_OPENAI_API_VERSION)}` +
      `&deployment=${encodeURIComponent(process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT)}`;

    const ws = new WebSocket(url, {
      headers: {
        "api-key": process.env.AZURE_OPENAI_API_KEY,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    ws.on("open", () => {
      console.log("✅ Connected to GPT Realtime WebSocket");
      ws.close();
      res.send("✅ Realtime WS OK");
    });

    ws.on("error", (e) => {
      console.error("⚠️ Realtime WS error:", e);
      if (!res.headersSent) res.status(500).send(String(e));
    });
  } catch (e) {
    console.error("💥 Error in /test-realtime:", e);
    if (!res.headersSent) res.status(500).send(String(e));
  }
});

// ✅ Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
