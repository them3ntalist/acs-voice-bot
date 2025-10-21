// ============================================================
// Azure Web App: Realtime Audio probe + ACS webhook skeleton
// ============================================================

const express = require("express");
const WebSocket = require("ws");

// ACS is optional—kept here so your Event Grid validation keeps working.
// If you don't use it, it's harmless.
let CallAutomationClient = null;
try {
  ({ CallAutomationClient } = require("@azure/communication-call-automation"));
} catch (_) {
  // not installed — fine if you're only testing Realtime
}

const app = express();
app.use(express.json());

// ---------------------------
// ENV / CONFIG
// ---------------------------
const SELF = process.env.SELF_BASE_URL || "";
const AOAI_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, ""); // no trailing slash
const AOAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const AOAI_DEPLOYMENT =
  process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime";
const AOAI_API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION || "2024-10-01-preview";

// Optional ACS (ignore if not configured)
const ACS =
  process.env.ACS_CONNECTION_STRING && CallAutomationClient
    ? new CallAutomationClient(process.env.ACS_CONNECTION_STRING)
    : null;

// ---------------------------
// Helpers
// ---------------------------
const httpToWss = (u) => (u || "").replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
const stripTrailingSlashes = (u) => (u || "").replace(/\/+$/, "");

/** try to open a WS once, capture details */
function tryWebSocketOnce(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { "api-key": AOAI_API_KEY, "OpenAI-Beta": "realtime=v1" },
    });

    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (_) {}
      resolve(result);
    };

    ws.once("open", () => finish({ ok: true, url, note: "OPEN" }));

    // Fired when the HTTP upgrade responds with non-101 (e.g., 400/404/302)
    ws.once("unexpected-response", (_req, res) => {
      const sc = res?.statusCode;
      const loc = res?.headers?.location;
      finish({ ok: false, url, status: sc, location: loc, note: "UNEXPECTED" });
    });

    ws.once("error", (err) => finish({ ok: false, url, error: err?.message || String(err) }));

    // safety timeout
    setTimeout(() => finish({ ok: false, url, error: "timeout" }), 8000);
  });
}

/** follow a single 302 if present (ReST → WS frontdoor sometimes 302s) */
async function tryWithRedirect(url) {
  const first = await tryWebSocketOnce(url);
  if (first.ok) return first;

  if ((first.status === 301 || first.status === 302) && first.location) {
    // turn http(s) redirect into wss if needed
    const follow = httpToWss(first.location);
    const second = await tryWebSocketOnce(follow);
    return {
      ...second,
      chain: [first, second],
    };
  }
  return first;
}

// Build URL candidates (path + param variations)
function buildCandidates(endpoint, versions, paths, paramNames, deployment) {
  const base = httpToWss(stripTrailingSlashes(endpoint));
  const out = [];
  for (const v of versions) {
    for (const p of paths) {
      for (const pn of paramNames) {
        out.push(
          `${base}/openai/${p}?api-version=${encodeURIComponent(v)}&${pn}=${encodeURIComponent(
            deployment
          )}`
        );
      }
    }
  }
  return out;
}

// ---------------------------
// Simple health
// ---------------------------
app.get("/", (_req, res) => res.send("OK"));

// Safe env echo (no secrets)
app.get("/env-check", (_req, res) => {
  res.json({
    AZURE_OPENAI_ENDPOINT: AOAI_ENDPOINT,
    AZURE_OPENAI_API_VERSION: AOAI_API_VERSION,
    AZURE_OPENAI_REALTIME_DEPLOYMENT: AOAI_DEPLOYMENT,
    HAS_API_KEY: !!AOAI_API_KEY,
  });
});

// ---------------------------
// Realtime probe (multi-variant)
// ---------------------------
app.get("/test-realtime", async (_req, res) => {
  try {
    if (!AOAI_ENDPOINT || !AOAI_API_KEY || !AOAI_DEPLOYMENT) {
      return res
        .status(500)
        .send(
          "Missing one of: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_REALTIME_DEPLOYMENT"
        );
    }

    // We’ll try the current preview plus the date you also tested
    const versions = [AOAI_API_VERSION, "2025-08-28"];
    const paths = ["realtime", "realtime/audio"];
    const params = ["deployment", "deploymentId"];

    const candidates = buildCandidates(
      AOAI_ENDPOINT,
      versions,
      paths,
      params,
      AOAI_DEPLOYMENT
    );

    const trace = [];
    for (const url of candidates) {
      const r = await tryWithRedirect(url); // follow a single 302 if present
      trace.push(r);
      if (r.ok) {
        // success!
        const followInfo =
          r.chain && r.chain[0]
            ? `\n(redirected from ${r.chain[0].url} -> ${r.url})`
            : "";
        return res
          .status(200)
          .send(
            `✅ SUCCESS\nConnected to: ${r.url}${followInfo}\n\n` +
              `Stick with this format in your app.\n\n` +
              `Trace:\n` +
              trace
                .map((x) => {
                  if (x.ok) return `- ${x.url} -> OK`;
                  if (x.status) {
                    return `- ${x.url} -> HTTP ${x.status}${
                      x.location ? ` (Location: ${x.location})` : ""
                    }`;
                  }
                  return `- ${x.url} -> ${x.error || "error"}`;
                })
                .join("\n")
          );
      }
    }

    // none opened
    return res
      .status(502)
      .send(
        "❌ All attempts failed.\n\nTrace:\n" +
          trace
            .map((x) => {
              if (x.ok) return `- ${x.url} -> OK`;
              if (x.status) {
                return `- ${x.url} -> HTTP ${x.status}${
                  x.location ? ` (Location: ${x.location})` : ""
                }`;
              }
              return `- ${x.url} -> ${x.error || "error"}`;
            })
            .join("\n")
      );
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// ---------------------------
// One-shot manual probe
//   /ws-once?ver=2024-10-01-preview&path=realtime&param=deployment
//   /ws-once?ver=2024-10-01-preview&path=realtime/audio&param=deploymentId
// ---------------------------
app.get("/ws-once", async (req, res) => {
  try {
    if (!AOAI_ENDPOINT || !AOAI_API_KEY) {
      return res.status(500).send("Missing endpoint or api key");
    }
    const ver = req.query.ver || AOAI_API_VERSION;
    const path = req.query.path || "realtime";
    const param = req.query.param || "deployment";

    const url = `${httpToWss(stripTrailingSlashes(AOAI_ENDPOINT))}/openai/${path}?api-version=${encodeURIComponent(
      ver
    )}&${param}=${encodeURIComponent(AOAI_DEPLOYMENT)}`;

    const r = await tryWithRedirect(url);
    if (r.ok) {
      const followInfo =
        r.chain && r.chain[0] ? `\n(redirected from ${r.chain[0].url})` : "";
      return res.status(200).send(`✅ OPENED OK\nURL: ${r.url}${followInfo}`);
    }
    if (r.status) {
      return res
        .status(200)
        .send(
          `❌ UNEXPECTED RESPONSE\nURL: ${r.url}\nHTTP: ${r.status}${
            r.location ? `\nLocation: ${r.location}` : ""
          }`
        );
    }
    return res.status(200).send(`💥 ERROR\nURL: ${r.url}\n${r.error || "error"}`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ---------------------------
// ACS webhook skeleton (optional)
// Keeps Event Grid validation working; safe to leave in.
// ---------------------------
app.post("/acs/inbound", async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const ev of events) {
      // 1) Event Grid subscription validation
      if (ev.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
        const code = ev?.data?.validationCode;
        console.log("🔑 EventGrid handshake code:", code);
        return res.status(200).json({ validationResponse: code });
      }

      // 2) ACS IncomingCall (only if ACS configured)
      if (ev.eventType === "IncomingCall" && ACS) {
        console.log("📞 IncomingCall:", JSON.stringify(ev.data));
        try {
          const incomingCallContext = ev.data.incomingCallContext;
          const answer = await ACS.answerCall(incomingCallContext, {
            callbackUri: SELF ? `${SELF}/acs/inbound` : undefined,
          });
          const callId = answer.callConnectionProperties.callConnectionId;
          console.log("✅ Answered call:", callId);
        } catch (e) {
          console.error("❌ Error answering call:", e?.message || e);
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
