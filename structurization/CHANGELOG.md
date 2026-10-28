# Changelog

## 0.1.1

- Integrate the engine changes from pdf_ex_code branch `codex/acceptance-validation-followup` through commit `dab8a17d89058be2412098fbc1ca25db3df2af68`.
- Preserve original PDF display names, resume sealed publications and checkpointed transport retries, and reconcile ledger gaps with their registered source context.
- Improve component authoring, continuation and isolated reference diagnostics while retaining source access boundaries and existing author records.
- Export `hasResumableTransportRetry` and its counter, limit and retry-window types for consuming applications.

## 0.1.0

- Extract the existing acceptance, catalog and template recognition engine from pdf_ex_code commit `368843d589cb6dbe288d520d484a6830fe519d66`.
- Retain existing function signatures, progress events, checkpoints and result formats. The import name is now `pi-structurization`.
- Include runtime skills, the PDF split evidence helper and the existing Pi 1.2.0 OAuth identity compatibility patch in the package.
- Build and test without the consuming application's source tree.
