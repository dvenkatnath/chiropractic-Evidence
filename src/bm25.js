// Minimal, transparent BM25 lexical retrieval over the chunked corpus.
// No external services, no vector DB — deterministic, explainable term-frequency scoring.
// Standard parameters: k1=1.5, b=0.75.

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","is","are","was","were",
  "be","by","as","at","from","that","this","these","those","it","its","which","who",
  "we","our","their","has","have","had","not","but","also","after","before","over",
  "than","then","there","such","into","within","between","across","per","using",
  "study","studies","paper","review","et","al"
]);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+(?:['°][a-z0-9]+)?/g) || []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

class BM25Index {
  constructor(chunks, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.chunks = chunks;
    this.docTokens = chunks.map((c) => tokenize(c.text));
    this.docLen = this.docTokens.map((t) => t.length);
    this.avgDocLen = this.docLen.reduce((a, x) => a + x, 0) / (this.docLen.length || 1);

    this.df = new Map(); // term -> number of docs containing it
    this.tf = this.docTokens.map((tokens) => {
      const counts = new Map();
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      return counts;
    });

    const N = chunks.length;
    this.idf = new Map();
    for (const [term, df] of this.df.entries()) {
      this.idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }
  }

  score(queryTokens, docIndex) {
    const tf = this.tf[docIndex];
    const dl = this.docLen[docIndex];
    let s = 0;
    for (const term of queryTokens) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = this.idf.get(term) || 0;
      const denom = f + this.k1 * (1 - this.b + (this.b * dl) / this.avgDocLen);
      s += idf * ((f * (this.k1 + 1)) / denom);
    }
    return s;
  }

  search(query, topK = 5) {
    const qTokens = [...new Set(tokenize(query))];
    if (qTokens.length === 0) return [];
    const scored = this.chunks.map((chunk, i) => ({
      chunk,
      score: this.score(qTokens, i),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0).slice(0, topK);
  }
}

module.exports = { BM25Index, tokenize };
