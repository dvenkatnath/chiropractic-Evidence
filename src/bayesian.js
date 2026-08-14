// Real inverse-variance-weighted Bayesian pooling over the per-region study inputs
// in data/bayesian-inputs.json. Two real studies per region (cervical, lumbar) are
// combined sequentially — the first acts as the "prior", the second as the incoming
// "likelihood" — producing a genuine posterior via normal-normal conjugate updating.
// Thoracic has only one usable degree-based study in this 9-paper set, so it is
// reported as a single-study estimate rather than a forced multi-study pool.

function normalUpdate(prior, likelihood) {
  // prior, likelihood: { mean, sd, n }
  // Treat each study's SE as sd (already representing the uncertainty on the mean effect).
  const w1 = 1 / (prior.sd * prior.sd);
  const w2 = 1 / (likelihood.sd * likelihood.sd);
  const mean = (prior.mean * w1 + likelihood.mean * w2) / (w1 + w2);
  const sd = Math.sqrt(1 / (w1 + w2));
  return { mean, sd, n: prior.n + likelihood.n };
}

// Standard normal CDF via Abramowitz-Stegun approximation (no external stats library needed).
function normCdf(x, mean, sd) {
  const z = (x - mean) / (sd * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  const erf = z < 0 ? -y : y;
  return 0.5 * (1 + erf);
}

function poolRegion(regionData) {
  const studies = regionData.studies;
  let posterior;
  let steps = [];

  if (studies.length === 0) {
    return null;
  } else if (studies.length === 1) {
    const s = studies[0];
    posterior = { mean: s.mean, sd: s.sd, n: s.n };
    steps.push({ label: "Single-study estimate (only one usable data point in this set)", ...posterior });
  } else {
    // Sequential Bayesian update across all studies in the region, oldest first.
    const sorted = [...studies].sort((a, b) => (a.year || 0) - (b.year || 0));
    let current = { mean: sorted[0].mean, sd: sorted[0].sd, n: sorted[0].n };
    steps.push({ label: `Prior: ${sorted[0].citation}`, ...current });
    for (let i = 1; i < sorted.length; i++) {
      const lik = { mean: sorted[i].mean, sd: sorted[i].sd, n: sorted[i].n };
      current = normalUpdate(current, lik);
      steps.push({ label: `+ Updated with: ${sorted[i].citation}`, ...current });
    }
    posterior = current;
  }

  // MCID (minimal clinically important difference) proxy for radiographic correction:
  // no formally published MCID exists for degrees of lordosis/kyphosis correction, so
  // we report probability the true effect exceeds a conservative 5-degree threshold —
  // labeled explicitly as a proxy, not a validated clinical MCID.
  const mcidThresholdDeg = 5;
  const probExceedsZero = 1 - normCdf(0, posterior.mean, posterior.sd);
  const probExceedsMcid = 1 - normCdf(mcidThresholdDeg, posterior.mean, posterior.sd);
  const ci95 = [
    +(posterior.mean - 1.96 * posterior.sd).toFixed(2),
    +(posterior.mean + 1.96 * posterior.sd).toFixed(2),
  ];

  return {
    region: regionData.region,
    label: regionData.label,
    unit: regionData.unit,
    steps,
    posterior: {
      mean: +posterior.mean.toFixed(2),
      sd: +posterior.sd.toFixed(2),
      n: posterior.n,
      ci95,
    },
    probExceedsZero: +(probExceedsZero * 100).toFixed(1),
    probExceedsMcidProxy: +(probExceedsMcid * 100).toFixed(1),
    mcidThresholdDeg,
  };
}

function computeAllRegions(bayesianInputs) {
  return bayesianInputs.regions.map(poolRegion).filter(Boolean);
}

module.exports = { poolRegion, computeAllRegions, normCdf, normalUpdate };
