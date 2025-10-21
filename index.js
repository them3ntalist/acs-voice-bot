// ---------------------------
// Realtime probe (with new Azure Realtime header)
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
      (ver, dep) => `${wsBaseFromHttp(AOAI_ENDPOINT)}/openai/realtime/audio?api-version=${encodeURIComponent(ver)}&deployment=${encodeURIComponent(dep)}`
    ];

    const results = [];

    const tryOnce = (url) =>
      new Promise((resolve) => {
        const ws = new WebSocket(url, {
          headers: {
            "api-key": AOAI_API_KEY,
            "OpenAI-Beta": "realtime=v1",
            "X-Azure-OpenAI-Realtime": "realtime" // 🟢 new required header
          },
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
