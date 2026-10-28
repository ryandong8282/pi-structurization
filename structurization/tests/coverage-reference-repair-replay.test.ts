import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import type { EvidenceManifest } from "../src/contracts.js";
import { CoverageReviewController } from "../src/coverage-review.js";
import { coverageReferenceRepairOptions } from "../src/coverage-reference-repair.js";
import { documentReferenceTargetReadIdentity } from "../src/document-reference.js";
import { materialize } from "../src/materializer.js";
import type { SourceSpanRegistry } from "../src/source-span-registry.js";
import type { TargetSelectorPlan } from "../src/target-selector-compiler.js";
import { ToolController } from "../src/tools.js";
import { validatePlanText } from "../src/validator.js";
import { RevisionWorkspace } from "../src/workspace.js";

const sourceRoot = resolve("data/jobs/20260830-190700-cleanbuild-50204/pi-agent/jobs/20260830-190700-cleanbuild-50204/targets/target_3A838cd984ce9a1468f61f1e03/revisions/000002");

test.runIf(existsSync(join(sourceRoot, "last-valid.target-selectors.json")))(
  "replays deletion and reference migration through the real compiler, repair guard and delta scope",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "coverage-reference-repair-replay-"));
    try {
      const evidence = JSON.parse(await readFile(join(sourceRoot, "evidence/evidence.json"), "utf8")) as EvidenceManifest;
      const selectors = JSON.parse(await readFile(join(sourceRoot, "last-valid.target-selectors.json"), "utf8")) as TargetSelectorPlan;
      const registry = JSON.parse(await readFile(join(sourceRoot, "source-span-registry.json"), "utf8")) as SourceSpanRegistry;
      const sourceText = await readFile(join(sourceRoot, "last-valid.semantic-source-plan.json"), "utf8");
      const validation = validatePlanText(sourceText, evidence);
      expect(validation.ok, JSON.stringify(validation.issues)).toBe(true);
      const sourcePlan = validation.plan!;
      const ownerKey = "ledger-clause:5.5.3";
      const option = coverageReferenceRepairOptions(selectors, new Set([ownerKey]), registry)[0]!;
      expect(option).toBeDefined();
      const ownerId = sourcePlan.reference_resolutions.find((entry) => entry.occurrence_id === option.occurrence_id)!
        .destination_bindings[0]!.item_id;
      const owner = sourcePlan.acceptance_items.find((item) => item.item_id === ownerId)!;
      const fragment = owner.field_bindings.requirement.source_fragments[0]!;
      const workspace = await RevisionWorkspace.createFromEvidence(root, evidence.job_id, evidence.target_id, {
        manifest: evidence, markdown: Buffer.from(evidence.evidence.map((entry) => entry.text).join("\n")),
      });
      await writeFile(workspace.sourceSpanRegistryPath, JSON.stringify(registry));
      await writeFile(workspace.lastValidPlanPath, sourceText);
      await writeFile(workspace.workingPlanPath, sourceText);
      await writeFile(workspace.lastValidSelectorPath, JSON.stringify(selectors));
      await writeFile(workspace.workingSelectorPath, JSON.stringify(selectors));
      await workspace.updateState((state) => {
        state.last_valid_fingerprint = validation.fingerprint!;
        state.last_valid_plan_sha256 = validation.plan_sha256!;
        state.selector_protocol.submissions = 1;
      });
      const review = await CoverageReviewController.create(workspace, validation.fingerprint!, {
        mode: "repair_delta", affected_item_ids: [ownerId], affected_evidence_ids: [fragment.evidence_id], finding_ids: [],
      });
      await review.dispatch("open_review_evidence", { evidence_id: fragment.evidence_id });
      for (const occurrence of evidence.reference_occurrences.filter((entry) => entry.status === "resolved")) {
        const target = documentReferenceTargetReadIdentity(occurrence);
        await review.dispatch("read_document_reference_evidence", { target_key: target.target_key, limit: 24 });
      }
      await review.dispatch("stage_coverage_review_draft", {
        status: "repair", summary: "Remove the generic table leaf; preserve its existing reference on related rows.",
        semantic_coverage_upserts: [{ coverage_id: "generic", disposition: "acceptance_item", judgment_id: "generic",
          item_ids: [ownerId], evidence_bindings: [{ evidence_id: fragment.evidence_id, exact_fragment: fragment.text }],
          reason: "Existing generic item was inspected, not approved." }],
        finding_upserts: [{ finding_id: "remove-generic", finding_type: "semantic_coverage_gap",
          evidence_id: fragment.evidence_id, exact_fragment: fragment.text, affected_item_ids: [ownerId],
          description: "The table criteria already exist as separate items; remove the generic table leaf.",
          reason: "The generic leaf repeats its concrete rows." }],
      });
      expect(await review.finalizeMechanicallyReady()).toMatchObject({ ok: true, status: "repair" });
      const controller = await ToolController.create(workspace);
      await controller.beginCoverageRepair(validation.fingerprint!);
      await controller.dispatch("read_target_selectors", { collection: "items" });
      await controller.dispatch("list_reference_occurrences", {});
      const worklist = await controller.dispatch("read_coverage_review", {});
      expect(worklist.reference_repair_options).toEqual(expect.arrayContaining([expect.objectContaining({
        source_item_key: ownerKey, eligible_receiver_keys: expect.arrayContaining([option.eligible_receiver_keys[0]]),
      })]));
      const receiver = structuredClone(selectors.items.find((item) => item.key === option.eligible_receiver_keys[0])!);
      const reference = structuredClone(selectors.references.find((entry) => entry.key === option.reference_key)!);
      reference.destinations = [{ item_key: receiver.key, target_field: option.target_field }];
      await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert", collection: "items", remove_keys: [ownerKey], draft: { items: [] },
      });
      const staged = await controller.dispatch("stage_target_selector_draft", {
        operation: "upsert", draft: { references: [reference] },
      });
      const committed = await controller.dispatch("commit_target_selector_draft", { draft_fingerprint: staged.draft_fingerprint });
      expect(committed).toMatchObject({
        ok: true,
        selector_transaction: "coverage_repair",
        automatic_reference_receiver_keys: [receiver.key],
      });
      const savedSelectors = JSON.parse(
        await readFile(workspace.lastValidSelectorPath, "utf8"),
      ) as TargetSelectorPlan;
      expect(savedSelectors.items.find((item) => item.key === receiver.key)!
        .fields[option.target_field].span_ids).toEqual([
          ...receiver.fields[option.target_field].span_ids,
          ...option.allowed_origin_span_ids,
        ]);
      const repaired = validatePlanText(await readFile(workspace.lastValidPlanPath, "utf8"), evidence).plan!;
      const finalItems = materialize(repaired, evidence, String(committed.fingerprint)).result.inspection_lots.flatMap((lot) => lot.items);
      expect(finalItems).toHaveLength(17);
      expect(finalItems.filter((item) => item.table_semantics)).toHaveLength(14);
      expect(finalItems.some((item) => item.item_id === ownerId)).toBe(false);
      const receiverId = repaired.acceptance_items.find((item) => item.name === receiver.name)!.item_id;
      expect((await workspace.readState()).coverage_recheck?.affected_item_ids).toContain(receiverId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000,
);
