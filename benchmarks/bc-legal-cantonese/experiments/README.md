# Experiment convention

Use one directory per hypothesis:

```text
experiments/
  EXP001-rule-baseline/
    README.md
    config.json
    metrics.json
    predictions.jsonl
    environment.txt
  EXP002-first-semantic-checker/
  EXP003-version-aware-checker/
```

Rules:

1. Run and record `EXP001-rule-baseline` before any model experiment.
2. One experiment tests one stated hypothesis. Record failures and crashes as well as successes.
3. Freeze the raw-data manifest and split manifest before looking at test labels.
4. Record the Git commit, command, random seed, package versions, input SHA-256 values, item counts, group counts, and all metric confidence intervals.
5. Tune on train/dev only. Run test once after the decision rule and thresholds are locked.
6. Report false-pass rate first, followed by coverage, safe-pass precision, abstention rate, decision accuracy, and per-error/per-language slices.
7. Use Wilson 95% intervals for binomial rates. On a real benchmark, also use a fixed-seed cluster bootstrap over authority families.
8. Never copy private legal, employment, medical, privileged, or third-party evidence into an experiment directory.

Generated metrics and predictions are derived artifacts, not raw data. They may be replaced only within the same experiment while its status is `running`; once marked `complete`, create a new experiment directory.
