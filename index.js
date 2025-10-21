const express = require("express");
const { CallAutomationClient } = require("@azure/communication-call-automation");

const app = express();
app.use(express.json());

// ---- CONFIG ----
const SELF = process.env.SELF_BASE_URL || "https://YOUR-LINUX-APP.azurewebsites.net";
const ACS = process.env.ACS_CONNECTION_STRING
  ? new CallAutomationClient(process.env.ACS_CONNECTION_STRING)
  : null;

// Health
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
          callbackUri: `${SELF}/acs/inbound`
        });
        const callId = answer.callConnectionProperties.callConnectionId;
        console.log("✅ Answered call:", callId);

        // (We’ll add GPT streaming later.)
      } catch (e) {
        console.error("❌ Error answering:", e?.message || e);
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

// Connectivity smoke test: just open & close AOAI Realtime WS
app.get("/test-realtime", async (_req, res) => {
  try {
    const url =
      `${process.env.AZURE_OPENAI_ENDPOINT}/openai/realtime` +
      `?api-version=${encodeURIComponent(process.env.AZURE_OPENAI_API_VERSION)}` +
      `&deployment=${encodeURIComponent(process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT)}`;

    const ws = new (await import("ws")).default(url, {
      headers: { "api-key": process.env.AZURE_OPENAI_API_KEY, "OpenAI-Beta": "realtime=v1" }
    });

    ws.on("open", () => { console.log("✅ Realtime WS OK"); ws.close(); res.send("Realtime WS OK"); });
    ws.on("error", (e) => { console.error("Realtime WS error:", e); if (!res.headersSent) res.status(500).send(String(e)); });
  } catch (e) {
    console.error(e);
    if (!_req.res?.headersSent) res.status(500).send(String(e));
  }
});
