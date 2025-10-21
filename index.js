// ============================================================
// Azure ACS Voice Bot + GPT Realtime Audio - Server
// Copy/paste this whole file as index.js
// ============================================================

const express = require("express");
const WebSocket = require("ws");
const { CallAutomationClient } = require("@azure/communication-call-automation");

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
const AOAI_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, ""); // no trailing slash
const AOAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AOAI_DEPLOYMENT = process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime";
const AOAI_API_VERSION_ENV = process.env.AZURE_OPENAI_API_VERSION; // optional

// ---------------------------
// Utilities
// ---------------------------
function wsBaseFromHttp(endpoint) {
  return (endpoint || "").replace(/^http/i, "ws").replace(/\/+$/, "");
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// Open a single WebSocket attempt and report outcome
function openOnce(url, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, {
      headers: { "api-key": AOAI_API_KEY, "OpenAI-Beta": "realtime=v1" },
    });

    let settled = false;

    ws.on("open", () => {
      settled = true;
      try { ws.close(); } catch {}
      resolve({ ok: true, url, proto: protocols.join(","), note: "CONNECTED" });
    });

    ws.on("unexpected-response", (_req, resp) => {
      settled = true;
      try { ws.close(); } catch {}
      resolve({
        ok: false,
        url,
        proto: protocols.join(","),
        http: resp?.statusCode,
        note: `HTTP ${resp?.statusCode}`,
      });
    });

    ws.on("error", (e) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        url,
        proto: protocols.join(","),
        error: e?.message || String(e),
      });
    });

    setTimeout(() => {
      if (!settled) {
        try { ws.terminate(); } catch {}
        resolve({ ok: false, url, proto: protocols.join(","), error: "timeout" });
      }
    }, 7000);
  });
}

// ---------------------------
// Health + Env
// ---------------------------
app.get("/", (_req, res) => res.send("OK"));

app.get("/env-check", (_req, res) => {
  res.json({
    AZURE_OPENAI_ENDPOINT: AOAI_ENDPOINT,
    AZURE_OPENAI_API_VERSION: AOAI_API_VERSION_ENV,
    AZURE_OPENAI_REALTIME_DEPLOYMENT: AOAI_DEPLOYMENT,
    HAS_API_KEY: !!AOAI_API_KEY,
  });
});

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

        // TODO: Wire ACS media to Realtime after we confirm the Realtime URL below.
      } catch (e) {
        console.error("❌ Error answering call:", e?.message || e);
      }
    }
  }

  res.sendStatus(200);
});

// ---------------------------
// Realtime probe (multi-variant)
// Tries common paths & param names & sub-protocols, returns a trace
// ---------------------------
app.get("/test-realtime", async (_req, res) => {
  try {
    if (!AOAI_ENDPOINT || !AOAI_API_KEY || !AOAI_DEPLOYMENT) {
      return res
        .status(500)
        .send("Missing one of: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_REALTIME_DEPLOYMENT");
    }

    const apiVersions = unique([
      AOAI_API_VERSION_ENV,
      "2024-10-01-preview",
      "2025-08-28",
    ]);

    const builders = [
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime?api-version=${encodeURIComponent(ver)}&deployment=${encodeURIComponent(dep)}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime?api-version=${encodeURIComponent(ver)}&deploymentId=${encodeURIComponent(dep)}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime/audio?api-version=${encodeURIComponent(ver)}&deployment=${encodeURIComponent(dep)}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime/audio?api-version=${encodeURIComponent(ver)}&deploymentId=${encodeURIComponent(dep)}`,
    ];

    // Try both protocol names used across rollouts
    const protocolSets = [
      ["realtime"],
      ["oai-realtime"],
    ];

    const results = [];

    for (const ver of apiVersions) {
      for (const build of builders) {
        const url = build(ver, AOAI_DEPLOYMENT);
        for (const protos of protocolSets) {
          // eslint-disable-next-line no-await-in-loop
          const r = await openOnce(url, protos);
          results.push(r);
          if (r.ok) {
            return res
              .status(200)
              .send(
                `✅ SUCCESS\nURL: ${url}\nProto: ${protos.join(",")}\n\n` +
                "Keep this combination in your final code.\n\n" +
                "Full trace:\n" +
                results.map(x =>
                  `- ${x.url} [proto=${x.proto}] -> ${x.ok ? "OK" : (x.http ? `HTTP ${x.http}` : x.error)}`
                ).join("\n")
              );
          }
        }
      }
    }

    return res
      .status(502)
      .send(
        "❌ All attempts failed.\n\nTrace:\n" +
        results.map(x =>
          `- ${x.url} [proto=${x.proto}] -> ${x.ok ? "OK" : (x.http ? `HTTP ${x.http}` : x.error)}`
        ).join("\n")
      );
  } catch (e) {
    console.error("💥 Error in /test-realtime:", e);
    return res.status(500).send(String(e));
  }
});

// ---------------------------
// One-shot manual probe
// Try a specific combo via query params, e.g.:
//   /ws-once?ver=2024-10-01-preview&param=deployment&path=realtime&proto=realtime
//   /ws-once?ver=2024-10-01-preview&param=deploymentId&path=realtime/audio&proto=oai-realtime
// ---------------------------
app.get("/ws-once", async (req, res) => {
  try {
    if (!AOAI_ENDPOINT || !AOAI_API_KEY) return res.status(500).send("Missing endpoint or api key");

    const ver   = req.query.ver   || "2024-10-01-preview";
    const param = req.query.param || "deployment";         // or "deploymentId"
    const path  = req.query.path  || "realtime";           // or "realtime/audio"
    const proto = (req.query.proto || "realtime")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const url = `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/${path}?api-version=${encodeURIComponent(ver)}&${param}=${encodeURIComponent(AOAI_DEPLOYMENT)}`;

    const r = await openOnce(url, proto);
    if (r.ok) {
      return res.status(200).send(`✅ OPENED OK\nURL: ${url}\nProto: ${proto.join(",")}`);
    }
    if (r.http) {
      return res.status(200).send(`❌ UNEXPECTED RESPONSE\nURL: ${url}\nProto: ${proto.join(",")}\nHTTP: ${r.http}`);
    }
    return res.status(200).send(`💥 ERROR\nURL: ${url}\nProto: ${proto.join(",")}\n${r.error}`);
  } catch (e) {
    return res.status(500).send(String(e));
  }
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
