# EXP001 — citation/date/quote baseline

**Hypothesis:** a deterministic closure, effective-date, and quote-only baseline should avoid false passes and quote laundering on the synthetic safety cases, while exposing low coverage on semantic Cantonese cases.

**Status:** scaffolded. Any observed seed result is descriptive only and does not meet a legal benchmark acceptance gate. The immutable seed's nominal exact-quote PASS fixture contains wrapper text, so zero baseline coverage is partly a fixture-contract mismatch rather than a measured capability result.

Run:

```bash
node benchmarks/bc-legal-cantonese/scripts/run-baseline.mjs
```

Before marking this experiment complete, save its stdout as `metrics.json`, record the repository commit and Node version in `environment.txt`, and copy the exact run configuration into `config.json`. Those generated artifacts are intentionally not pre-populated here.
