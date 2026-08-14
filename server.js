require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");

const { ROLES, verifyLogin, requireAuth } = require("./src/auth");
const { BM25Index } = require("./src/bm25");
const { computeAllRegions } = require("./src/bayesian");
const { askGroundedLLM } = require("./src/llm");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Load data (once, at startup — small corpus, fine to hold in memory) ----
const chunks = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "chunks.json"), "utf8"));
const extractionTable = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "extraction-table.json"), "utf8")
);
const bayesianInputs = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "bayesian-inputs.json"), "utf8")
);
const papersMeta = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "papers-meta.json"), "utf8")
);
const bm25 = new BM25Index(chunks);
const bayesianResults = computeAllRegions(bayesianInputs);

console.log(`Loaded ${chunks.length} chunks from ${papersMeta.length} papers.`);
console.log(`Computed Bayesian posteriors for ${bayesianResults.length} regions.`);

// ---- Middleware ----
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "cbp-poc-dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);

// ---- Auth routes (public) ----
app.get("/api/roles", (req, res) => {
  res.json(Object.values(ROLES).map((r) => ({ key: r.key, label: r.label })));
});

app.post("/api/login", (req, res) => {
  const { role, passcode } = req.body || {};
  if (!verifyLogin(role, passcode)) {
    return res.status(401).json({ error: "Invalid role or passcode." });
  }
  req.session.role = role;
  res.json({ ok: true, role, label: ROLES[role].label, landing: ROLES[role].landing });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  if (req.session && req.session.role) {
    const r = ROLES[req.session.role];
    res.json({ authenticated: true, role: r.key, label: r.label, landing: r.landing });
  } else {
    res.json({ authenticated: false });
  }
});

// ---- Protected static frontend ----
app.get("/", (req, res) => {
  if (req.session && req.session.role) return res.redirect("/dashboard.html");
  return res.redirect("/login.html");
});

app.get("/dashboard.html", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// login.html itself must stay public; everything else in /public is protected below
app.use("/login.html", express.static(path.join(__dirname, "public", "login.html")));
app.use(
  "/assets",
  express.static(path.join(__dirname, "public", "assets"))
);
app.use((req, res, next) => {
  // Protect all other static files (app.js, styles) except login assets.
  if (req.path === "/login.html" || req.path.startsWith("/assets")) return next();
  if (req.path.startsWith("/api/")) return next();
  return requireAuth(req, res, next);
});
app.use(express.static(path.join(__dirname, "public")));

// ---- Protected API: quick corpus stats for the Overview tab ----
app.get("/api/stats", requireAuth, (req, res) => {
  res.json({ papers: papersMeta.length, chunks: chunks.length, regions: bayesianResults.length });
});

// ---- Protected API: evidence-extraction table (real, structured, from 9 papers) ----
app.get("/api/extraction-table", requireAuth, (req, res) => {
  res.json({ rows: extractionTable, papers: papersMeta });
});

// ---- Protected API: real Bayesian per-region posteriors ----
app.get("/api/bayesian", requireAuth, (req, res) => {
  res.json({ note: bayesianInputs.note, regions: bayesianResults, excluded: bayesianInputs.excludedFromPooling });
});

// Drop weak lexical hits so unrelated passages are not shown as "sources".
const MIN_RETRIEVAL_SCORE = Number(process.env.MIN_RETRIEVAL_SCORE || 10);

function isFullEvidenceTableRequest(question) {
  const q = question.toLowerCase();
  const asksTable =
    /\bevidence\s+table\b/.test(q) ||
    /\bextraction\s+table\b/.test(q) ||
    /\bsummary\s+table\b/.test(q);
  const asksAll =
    /\b(entire|full|complete|whole|all)\b/.test(q) ||
    /\bshow\s+(me\s+)?(the\s+)?table\b/.test(q);
  return asksTable && asksAll;
}

// ---- Protected API: real RAG — BM25 retrieval + live grounded LLM synthesis ----
app.post("/api/ask", requireAuth, async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== "string" || question.trim().length < 3) {
    return res.status(400).json({ error: "Please provide a question (at least 3 characters)." });
  }

  // UI/meta request: show the structured table for all 9 papers (not a corpus search).
  if (isFullEvidenceTableRequest(question)) {
    return res.json({
      question,
      sources: [],
      grounded: false,
      showFullEvidenceTable: true,
      synthesis:
        "Showing the full structured evidence table for all 9 papers in this proof-of-concept corpus. This table is a fixed human-verified summary (not retrieved passages).",
      synthesisUnavailable: null,
    });
  }

  const retrieved = bm25.search(question, 5).filter((r) => r.score >= MIN_RETRIEVAL_SCORE);
  const llmResult = await askGroundedLLM(question, retrieved);

  // Hide sources ONLY when the model itself ran successfully and judged them insufficient
  // (adversarial / out-of-corpus questions). If the LLM call failed for an infrastructure
  // reason instead (no API key configured, network error, API outage), the retrieval step
  // still succeeded — show the real passages, since that's exactly what the accompanying
  // "synthesis unavailable" message promises the user.
  const modelExplicitlyDeclined = llmResult.ok && llmResult.grounded === false;
  const showSources = retrieved.length > 0 && !modelExplicitlyDeclined;
  const sources = showSources
    ? retrieved.map((r, i) => ({
        n: i + 1,
        paperId: r.chunk.paperId,
        title: r.chunk.title,
        year: r.chunk.year,
        journal: r.chunk.journal,
        page: r.chunk.page,
        text: r.chunk.text,
        score: +r.score.toFixed(2),
      }))
    : [];

  res.json({
    question,
    sources,
    // True only when the LLM actually ran and grounded a prose answer in the sources —
    // distinct from showSources, which also stays true when sources exist but no LLM
    // synthesis was available for infrastructure reasons (no key, network, API error).
    grounded: llmResult.ok && llmResult.grounded !== false,
    showFullEvidenceTable: false,
    synthesis: llmResult.ok ? llmResult.text : null,
    synthesisUnavailable: llmResult.ok ? null : { reason: llmResult.reason, message: llmResult.message },
  });
});

app.listen(PORT, () => {
  console.log(`CBP Evidence Platform listening on port ${PORT}`);
});
