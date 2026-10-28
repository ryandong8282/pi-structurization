# Direct JSON format-only repair experiment

Independent research replay; it does not publish production products. Run from the repository root with workspace dependencies installed. The output directory must not exist, and its parent must exist. A model call, when needed, reads the saved `global` settings from `data/config/acceptance-pi.json` and requires the Go endpoint `https://opencode.ai/zen/go/v1`; saved settings are not modified.

```powershell
node --import tsx scripts/run-json-format-repair.ts FROZEN_DIRECT_RUN NEW_OUTPUT_DIR
```

Replay a frozen `muse-spark-1.3-contributor` / `high` / `direct` response from [the comparison runner](README.recognition-comparison.md). The input directory must contain `input.json` and `extract-submission-0.txt`, and the original `fixture` Markdown must still be available. Use a plain direct response, not a batch tool-submission run. Original source hash must match; extraction prompt and response remain unchanged. Valid JSON skips the model even if schema-invalid. Invalid JSON triggers at most one syntax-repair request, without source text or extraction instructions. Unclosed strings/unrecognized tokens are rejected before a call because original content cannot be reliably compared.

Acceptance requires JSON.parse success and identical ordered keys/primitive values. Only structural punctuation/whitespace may change. This is stronger than an instruction to preserve content but does not prove the intended nesting of an originally malformed response. Full result schema and literal citations are checked afterwards; missing fields are not fabricated, and residual errors exit nonzero. Original/repair responses and usage remain separate. No semantic review, source-location repair, retries, production publication, or schema default insertion.

Offline test: `npx vitest run --dir tests tests/json-format-repair.test.ts`. Historical experiment: local `data/json-format-repair-20260906/report.md` (not committed; availability depends on the local workspace).

2026-09-06 ingestion update: missing `uncertainties` is auxiliary metadata absence, recorded as `uncertainty_status: not_returned` plus a notice. The stored model result remains untouched; no empty uncertainty list is inserted into it. Existing row/schema/citation checks still run, and malformed present metadata is still rejected. This policy applies to the experimental format-repair ingestion boundary, not production or the frozen comparison runner's strict validator. Historical offline verification: local `data/shared-requirements-20260906/ingestion-check.json` (not committed). The date describes the original experiment, not a current production verification.
