# Synthetic seed notice

Every record in `synthetic-seed-v0.1.jsonl` is invented for software testing.

- It is **not legal ground truth**.
- It does not quote or summarize an actual statute, policy, decision, claim file, or client record.
- Names, section numbers, decision numbers, rules, dates, and remedies are synthetic fixtures.
- It contains no material from any private `Evidence` repository.
- It must not be cited in a legal submission or used to answer a real legal question.

The raw seed is immutable. A changed record requires a new versioned JSONL file and a new manifest checksum; do not overwrite this version.

Future non-synthetic benchmark data must be limited to public primary sources or records redacted with documented permission. Keep the frozen source bytes outside model prompts, record their SHA-256 hashes, and assign document-family groups before any model evaluation.
