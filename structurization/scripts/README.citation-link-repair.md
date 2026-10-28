# Missing citation-field links: one bounded repair

Independent research replay; it does not publish production products. Run from the repository root with workspace dependencies installed. The output directory must not exist, and its parent must exist. A model call, when needed, reads the saved `global` settings from `data/config/acceptance-pi.json` and requires the Go endpoint `https://opencode.ai/zen/go/v1`; saved settings are not modified.

```powershell
node --import tsx scripts/run-citation-link-repair.ts ORIGINAL_INPUT_JSON RESULT_JSON NEW_OUTPUT_DIR
```

Use the original [comparison run](README.recognition-comparison.md) `input.json` containing `fixture`, `sourceHash`, `model`, `effort` and `maxTokens`, plus a parsed result JSON. Do not pass the format-repair runner's derived `input.json`, which has no `fixture`. The original source must still exist with the same hash; the model must be `muse-spark-1.3-contributor` and effort `high`. Only populated fields lacking a citation link are eligible. Other schema/range/quote errors are rejected without a model call. Healthy inputs make zero calls. At most one call receives the numbered source and flagged rows, returning source spans or explicit unresolved entries.

The program appends citations only to flagged fields; existing citations, row count/order, all business text and auxiliary metadata remain unchanged. Quotes come from the selected original lines. The program validates source ranges and complete accounting, then runs all existing ingestion checks. Nonempty source does not prove semantic entailment: the experiment report separately audits each added source span. Missing/unresolved errors do not trigger loops or deletion. No production changes/publication.

Artifacts: `input.json`, `original.json`, `patch.json`, `result.json`, `summary.json`/`failure.json`; `feedback.json`, `submission.txt` and `event.json` are written only when a model call reaches the corresponding step. Offline test: `npx vitest run --dir tests tests/citation-link-repair.test.ts`. Historical live replay: local `data/citation-link-repair-20260906/report.md` (not committed; this is not a current production verification).
