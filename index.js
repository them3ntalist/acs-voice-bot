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
// Connectivity probe for Azure OpenAI Realtime – tries common variants and reports results.
app.get("/test-realtime", async (_req, res) => {
  const endpoint   = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/,""); // no trailing slash
  const apiKey     = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime";

  if (!endpoint || !apiKey || !deployment) {
    return res.status(500).send(
      "Missing one of: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_REALTIME_DEPLOYMENT"
    );
  }

  // Most common API versions seen in Realtime docs/UI
  const apiVersions = [
    process.env.AZURE_OPENAI_API_VERSION || "2025-08-28",
    "2024-10-21-preview"
  ];

  // Common URL patterns (Azure sometimes varies between /realtime and /realtime/audio; deployment vs deploymentId)
  const pathVariants = [
    (ver, dep) => `${endpoint.replace(/^http/i,"ws")}/openai/realtime?api-version=${encodeURIComponent(ver)}&deployment=${encodeURIComponent(dep)}`,
    (ver, dep) => `${endpoint.replace(/^http/i,"ws")}/openai/realtime?api-version=${encodeURIComponent(ver)}&deploymentId=${encodeURIComponent(dep)}`,
    (ver, dep) => `${endpoint.replace(/^http/i,"ws")}/openai/realtime/audio?api-version=${encodeURIComponent(ver)}&deployment=${encodeURIComponent(dep)}`,
    (ver, dep) => `${endpoint.replace(/^http/i,"ws")}/openai/realtime/audio?api-version=${encodeURIComponent(ver)}&deploymentId=${encodeURIComponent(dep)}`
  ];

  const results = [];
  const tryOnce = (url) => new Promise((resolve) => {
    const ws = new (require("ws"))(url, {
      headers: { "api-key": apiKey, "OpenAI-Beta": "realtime=v1" }
    });

    let settled = false;

    ws.on("open", () => {
      settled = true;
      ws.close();
      resolve({ url, ok: true, note: "✅ connected" });
    });

    ws.on("unexpected-response", (_req, resObj) => {
      settled = true;
      resolve({ url, ok: false, http: resObj?.statusCode, note: `HTTP ${resObj?.statusCode}` });
      try { ws.close(); } catch {}
    });

    ws.on("error", (e) => {
      if (settled) return;
      settled = true;
      resolve({ url, ok: false, error: e.message || String(e) });
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.terminate(); } catch {}
        resolve({ url, ok: false, error: "timeout" });
      }
    }, 7000);
  });

  // Try all combos, stop if one works
  for (const ver of apiVersions) {
    for (const build of pathVariants) {
      const url = build(ver, deployment);
      // eslint-disable-next-line no-await-in-loop
      const r = await tryOnce(url);
      results.push(r);
      if (r.ok) {
        return res
          .status(200)
          .send(
            `✅ SUCCESS\nUsing: ${url}\n\nKeep this URL format in your code.\n\nFull trace:\n` +
            results.map(x => `- ${x.url} -> ${x.ok ? "OK" : (x.http ? `HTTP ${x.http}` : x.error)}`).join("\n")
          );
      }
    }
  }

  // none worked
  return res
    .status(502)
    .send(
      "❌ All attempts failed.\n\nTrace:\n" +
      results.map(x => `- ${x.url} -> ${x.ok ? "OK" : (x.http ? `HTTP ${x.http}` : x.error)}`).join("\n")
    );
});
