const express = require("express");
const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => res.send("OK"));

// ACS will POST here when a call arrives
app.post("/acs/inbound", (req, res) => {
  console.log("🔔 Incoming ACS event:", JSON.stringify(req.body));
  res.sendStatus(200);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
