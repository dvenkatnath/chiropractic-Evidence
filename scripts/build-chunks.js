// Builds data/chunks.json from the raw OCR/pdftotext corpus.
// Each chunk: { id, paperId, page, text } — paragraph-level, tagged with real page numbers
// where available (OCR'd files carry explicit ===PAGE:pg-NN.txt=== markers; pdftotext files
// use the standard form-feed \f page separator).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CORPUS_DIR = path.join(ROOT, "corpus");
const papers = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "papers-meta.json"), "utf8"));

function splitIntoPages(raw) {
  if (raw.includes("===PAGE:")) {
    const parts = raw.split(/===PAGE:pg-(\d+)\.txt===/);
    // parts alternates: [preamble, pageNum, pageText, pageNum, pageText, ...]
    const pages = [];
    for (let i = 1; i < parts.length; i += 2) {
      pages.push({ page: parseInt(parts[i], 10), text: parts[i + 1] || "" });
    }
    return pages;
  }
  // pdftotext default output separates pages with form-feed \f
  const raw_pages = raw.split("\f");
  return raw_pages.map((text, idx) => ({ page: idx + 1, text }));
}

function splitIntoParagraphs(pageText) {
  // Split on blank lines; then re-merge short fragments (OCR/column artifacts) into
  // neighbors so chunks stay in a useful 40-400 word range for retrieval.
  const raw = pageText
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/\n/g, " ").trim())
    .filter((p) => p.length > 0);

  const merged = [];
  let buf = "";
  for (const p of raw) {
    if ((buf + " " + p).split(/\s+/).length < 35) {
      buf = (buf + " " + p).trim();
    } else {
      if (buf) merged.push(buf);
      buf = p;
    }
  }
  if (buf) merged.push(buf);
  return merged.filter((p) => p.split(/\s+/).length >= 6); // drop stray headers/footers
}

const chunks = [];
let chunkId = 0;

for (const paper of papers) {
  const filePath = path.join(CORPUS_DIR, paper.file);
  if (!fs.existsSync(filePath)) {
    console.error("MISSING corpus file:", paper.file);
    continue;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const pages = splitIntoPages(raw);
  for (const { page, text } of pages) {
    const paras = splitIntoParagraphs(text);
    for (const para of paras) {
      chunks.push({
        id: `c${++chunkId}`,
        paperId: paper.id,
        title: paper.title,
        year: paper.year,
        journal: paper.journal,
        page,
        text: para,
      });
    }
  }
}

fs.writeFileSync(
  path.join(ROOT, "data", "chunks.json"),
  JSON.stringify(chunks, null, 0)
);

console.log(`Built ${chunks.length} chunks from ${papers.length} papers.`);
const byPaper = {};
for (const c of chunks) byPaper[c.paperId] = (byPaper[c.paperId] || 0) + 1;
console.log(byPaper);
