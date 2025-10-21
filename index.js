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
    // 1️⃣ Event Grid handshake
    if (ev.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
      const code = ev?.data?.validationCode;
      console.log("🔑 Handshake from Event Grid:", code);
      return res.status(200).json({ validationResponse: code });
    }

    // 2️⃣ Incoming call (from ACS)
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

        // (GPT Realtime audio integration will be added later)
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
  return endpoint.replace(/^http/i, "ws");
}

// Check current env vars
app.get("/env-check", (_req, res) => {
  res.json({
    AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION,
    AZURE_OPENAI_REALTIME_DEPLOYMENT: process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT,
  });
});

// Connectivity smoke test for Azure OpenAI Realtime WS
app.get("/test-realtime", async (_req, res) => {
  try {
    const wsUrl = `wss://service-desk-voice-agent.openai.azure.com/openai/realtime/audio?api-version=2025-08-28&deployment=gpt-realtime`;

    const ws = new (await import("ws")).default(wsUrl, {
      headers: {
        "api-key": process.env.AZURE_OPENAI_API_KEY,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    ws.on("open", () => {
      console.log("✅ Connected successfully to GPT Realtime Audio!");
      ws.close();
      res.send("✅ Realtime Audio WebSocket connection successful!");
    });

    ws.on("error", (e) => {
      console.error("❌ Realtime WS error:", e);
      if (!res.headersSent) res.status(500).send(String(e));
    });
  } catch (e) {
    console.error("❌ Exception:", e);
    if (!res.headersSent) res.status(500).send(String(e));
  }
});

    ws.on("open", () => {
      console.log("✅ Realtime Audio WS OK");
      ws.close();
      res.send("✅ Connected successfully to GPT Realtime Audio!");
    });

    ws.on("error", (e) => {
      console.error("❌ Realtime WS error:", e);
      if (!res.headersSent) res.status(500).send(String(e));
    });
  } catch (e) {
    console.error("❌ Exception:", e);
    if (!res.headersSent) res.status(500).send(String(e));
  }
});

    let tried = [];
    let result;
    const attempt = (url) =>
      new Promise((resolve) => {
        tried.push(url);
        const ws = new WebSocket(url, {
          headers: {
            "api-key": process.env.AZURE_OPENAI_API_KEY,
            "OpenAI-Beta": "realtime=v1",
          },
        });

        ws.on("open", () => {
          console.log("✅ Realtime WS connected:", url);
          ws.close();
          resolve({ ok: true, url });
        });

        ws.on("error", (e) => {
          console.warn("⚠️ Realtime WS error for", url, "=>", e?.message || e);
          resolve({ ok: false, url, error: e?.message || String(e) });
        });

        setTimeout(() => resolve({ ok: false, url, error: "timeout" }), 5000);
      });

    result = await attempt(tryUrl("deployment"));
    if (!result.ok) result = await attempt(tryUrl("deploymentId"));

    if (result.ok) {
      return res.send("✅ Realtime WS OK");
    } else {
      return res
        .status(502)
        .send(`❌ Failed to connect.\nTried:\n- ${tried.join("\n- ")}\nLast error: ${result.error}`);
    }
  } catch (e) {
    console.error("💥 Error in /test-realtime:", e);
    if (!res.headersSent) res.status(500).send(String(e));
  }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
