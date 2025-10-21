// ============================================================
// Azure ACS Voice Bot + GPT Realtime Audio - Final Version
// ============================================================

const express = require("express");
const WebSocket = require("ws");
const { CallAutomationClient } = require("@azure/communication-call-automation");

const app = express();
app.use(express.json());

// ---------------------------
// CONFIG
// ---------------------------
const SELF = process.env.SELF_BASE_URL || "https://YOUR-LINUX-APP.azurewebsites.net";
const ACS = process.env.ACS_CONNECTION_STRING
  ? new CallAutomationClient(process.env.ACS_CONNECTION_STRING)
  : null;

const AOAI_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, "");
const AOAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AOAI_DEPLOYMENT = process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime";
const AOAI_API_VERSION_ENV = process.env.AZURE_OPENAI_API_VERSION;

// ---------------------------
// Utility
// ---------------------------
function wsBaseFromHttp(endpoint) {
  return (endpoint || "").replace(/^http/i, "ws").replace(/\/+$/, "");
}
function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function openOnce(url, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, {
      headers: {
        "Authorization": `Bearer ${AOAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    let settled = false;

    ws.on("open", () => {
      settled = true;
      try { ws.close(); } catch {}
      resolve({ ok: true, url, proto: protocols.join(","), note: "CONNECTED ✅" });
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
// Routes
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
// ACS inbound events
// ---------------------------
app.post("/acs/inbound", async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const ev of events) {
    if (ev.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
      const code = ev?.data?.validationCode;
      console.log("🔑 Event Grid validation:", code);
      return res.status(200).json({ validationResponse: code });
    }

    if (ev.eventType === "IncomingCall") {
      console.log("📞 IncomingCall:", JSON.stringify(ev.data));
      if (!ACS) continue;
      try {
        const incomingCallContext = ev.data.incomingCallContext;
        const answer = await ACS.answerCall(incomingCallContext, {
          callbackUri: `${SELF}/acs/inbound`,
        });
        console.log("✅ Answered call:", answer.callConnectionProperties.callConnectionId);
      } catch (e) {
        console.error("❌ Error answering:", e?.message || e);
      }
    }
  }
  res.sendStatus(200);
});

// ---------------------------
// /test-realtime
// ---------------------------
app.get("/test-realtime", async (_req, res) => {
  try {
    if (!AOAI_ENDPOINT || !AOAI_API_KEY || !AOAI_DEPLOYMENT) {
      return res.status(500).send("Missing one of: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_REALTIME_DEPLOYMENT");
    }

    const apiVersions = unique([
      AOAI_API_VERSION_ENV,
      "2024-10-01-preview",
      "2025-08-28",
    ]);

    const builders = [
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime?api-version=${ver}&deployment=${dep}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime/audio?api-version=${ver}&deployment=${dep}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime?api-version=${ver}&deploymentId=${dep}`,
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime/audio?api-version=${ver}&deploymentId=${dep}`,
    ];

    const protocolSets = [
      ["realtime"],
      ["oai-realtime"],
    ];

    const results = [];

    for (const ver of apiVersions) {
      for (const build of builders) {
        for (const proto of protocolSets) {
          const url = build(ver, AOAI_DEPLOYMENT);
          const r = await openOnce(url, proto);
          results.push(r);
          if (r.ok) {
            return res.status(200).send(
              `✅ SUCCESS\nURL: ${url}\nProto: ${proto.join(",")}\n\nFull trace:\n` +
              results.map(x => `- ${x.url} [${x.proto}] -> ${x.ok ? "OK" : (x.http ? `HTTP ${x.http}` : x.error)}`).join("\n")
            );
          }
        }
      }
    }

    res.status(502).send(
      "❌ All attempts failed.\n\nTrace:\n" +
      results.map(x => `- ${x.url} [${x.proto}] -> ${x.ok ? "OK" : (x.http ? `HTTP ${x.http}` : x.error)}`).join("\n")
    );
  } catch (e) {
    console.error("💥 /test-realtime error:", e);
    res.status(500).send(String(e));
  }
});

// ---------------------------
// /ws-once
// ---------------------------
app.get("/ws-once", async (req, res) => {
  try {
    if (!AOAI_ENDPOINT || !AOAI_API_KEY)
      return res.status(500).send("Missing endpoint or API key");

    const ver   = req.query.ver   || "2024-10-01-preview";
    const param = req.query.param || "deployment";
    const path  = req.query.path  || "realtime";
    const proto = (req.query.proto || "realtime").split(",").map(s => s.trim());

    const url = `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/${path}?api-version=${ver}&${param}=${AOAI_DEPLOYMENT}`;
    const r = await openOnce(url, proto);

    if (r.ok) return res.send(`✅ OPENED OK\n${url}\nProto: ${proto.join(",")}`);
    if (r.http) return res.send(`❌ UNEXPECTED RESPONSE\n${url}\nProto: ${proto.join(",")}\nHTTP: ${r.http}`);
    res.send(`💥 ERROR\n${url}\n${r.error}`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
