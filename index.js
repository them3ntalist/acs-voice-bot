// ============================================================
// Azure ACS Voice Bot + GPT Realtime Audio - Server
// Copy/paste this whole file as index.js
// ============================================================

const express = require("express");
const { CallAutomationClient } = require("@azure/communication-call-automation");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

// ---------------------------
// CONFIG (from App Settings)
// ---------------------------
const SELF = process.env.SELF_BASE_URL || "https://YOUR-LINUX-APP.azurewebsites.net";

// Azure Communication Services (optional—used when you wire phone calls)
const ACS =
  process.env.ACS_CONNECTION_STRING
    ? new CallAutomationClient(process.env.ACS_CONNECTION_STRING)
    : null;

// Azure OpenAI Realtime (required for realtime tests)
const AOAI_ENDPOINT   = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/,""); // no trailing slash
const AOAI_API_KEY    = process.env.AZURE_OPENAI_API_KEY;
const AOAI_DEPLOYMENT = process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime";
const AOAI_API_VERSION_ENV = process.env.AZURE_OPENAI_API_VERSION; // optional

// ---------------------------
// Health
// ---------------------------
app.get("/", (_req, res) => res.send("OK"));

// ---------------------------
// ACS + Event Grid webhook
// ---------------------------
// Handles: 1) Event Grid subscription validation
//          2) IncomingCall -> answers the call (callback back to this route)
app.post("/acs/inbound", async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const ev of events) {
    // (1) Event Grid subscription validation
    if (ev.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
      const code = ev?.data?.validationCode;
      console.log("🔑 Handshake from Event Grid:", code);
      // Important: respond IMMEDIATELY with validationResponse
      return res.status(200).json({ validationResponse: code });
    }

    // (2) Handle ACS IncomingCall
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

        // TODO: Add ACS <-> Realtime media once the Realtime URL is confirmed.
      } catch (e) {
        console.error("❌ Error answering call:", e?.message || e);
      }
    }
  }

  res.sendStatus(200);
});

// ---------------------------
// Utilities
// ---------------------------
function wsBaseFromHttp(endpoint) {
  return (endpoint || "").replace(/^http/i, "ws").replace(/\/+$/, "");
}

// Echo safe env so you can confirm values are present on the server
app.get("/env-check", (_req, res) => {
  res.json({
    AZURE_OPENAI_ENDPOINT: AOAI_ENDPOINT,
    AZURE_OPENAI_API_VERSION: AOAI_API_VERSION_ENV,
    AZURE_OPENAI_REALTIME_DEPLOYMENT: AOAI_DEPLOYMENT,
    HAS_API_KEY: !!AOAI_API_KEY
  });
});

// ---------------------------
// Realtime probe (multi-variant)
// Tries common paths & param names and returns a trace
// ---------------------------
app.get("/test-realtime", async (_req, res) => {
  try {
    if (!AOAI_ENDPOINT || !AOAI_API_KEY || !AOAI_DEPLOYMENT) {
      return res
        .status(500)
        .send("Missing one of: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_REALTIME_DEPLOYMENT");
    }

    const apiVersions = [
      AOAI_API_VERSION_ENV || "2025-08-28",
      "2024-10-21-preview"
    ];

    const pathVariants = [
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime?api-version=${encodeURIComponent(ver)}&deployment=${encodeURIComponent(dep)}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime?api-version=${encodeURIComponent(ver)}&deploymentId=${encodeURIComponent(dep)}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime/audio?api-version=${encodeURIComponent(ver)}&deployment=${encodeURIComponent(dep)}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime/audio?api-version=${encodeURIComponent(ver)}&deploymentId=${encodeURIComponent(dep)}`
    ];

    const results = [];

    const tryOnce = (url) =>
      new Promise((resolve) => {
        const ws = new WebSocket(url, {
          headers: { "api-key": AOAI_API_KEY, "OpenAI-Beta": "realtime=v1" },
        });

        let settled = false;

        ws.on("open", () => {
          settled = true;
          ws.close();
          resolve({ url, ok: true, note: "✅ connected" });
        });

        ws.on("unexpected-response", (_req, resp) => {
          settled = true;
          resolve({ url, ok: false, http: resp?.statusCode, note: `HTTP ${resp?.statusCode}` });
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

    for (const ver of apiVersions) {
      for (const build of pathVariants) {
        const url = build(ver, AOAI_DEPLOYMENT);
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

  } catch (e) {
    console.error("💥 Error in /test-realtime:", e);
    return res.status(500).send(String(e));
  }
});

// ---------------------------
// One-shot manual probe
// Try a specific combo via query params:
//   /ws-once?ver=2024-10-21-preview&param=deployment&path=realtime
//   /ws-once?ver=2025-08-28&param=deploymentId&path=realtime/audio
// ---------------------------
app.get("/ws-once", async (req, res) => {
  try {
    if (!AOAI_ENDPOINT || !AOAI_API_KEY) return res.status(500).send("Missing endpoint or api key");

    const ver   = req.query.ver   || "2024-10-21-preview";
    const param = req.query.param || "deployment";        // or "deploymentId"
    const path  = req.query.path  || "realtime";          // or "realtime/audio"

    const url = `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/${path}?api-version=${encodeURIComponent(ver)}&${param}=${encodeURIComponent(AOAI_DEPLOYMENT)}`;

    const ws = new WebSocket(url, {
      headers: { "api-key": AOAI_API_KEY, "OpenAI-Beta": "realtime=v1" },
    });

    let responded = false;

    ws.on("open", () => {
      responded = true;
      ws.close();
      res.status(200).send(`✅ OPENED OK\nURL: ${url}`);
    });

    ws.on("unexpected-response", (_req, resp) => {
      responded = true;
      res.status(200).send(`❌ UNEXPECTED RESPONSE\nURL: ${url}\nHTTP: ${resp?.statusCode}`);
      try { ws.close(); } catch {}
    });

    ws.on("error", (e) => {
      if (responded) return;
      responded = true;
      res.status(200).send(`💥 ERROR\nURL: ${url}\n${e?.message || String(e)}`);
    });

    setTimeout(() => {
      if (!responded) {
        try { ws.terminate(); } catch {}
        res.status(200).send(`⏱️ TIMEOUT\nURL: ${url}`);
      }
    }, 7000);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
