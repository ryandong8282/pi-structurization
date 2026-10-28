import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentDiscoveryWorkspace } from "../src/document-discovery.js";
import { compileIssuesWorklist } from "../src/batch.js";

describe("复核无进展工作清单", () => {
  test("last-compile-issues 汇总为收敛导向的摘要，包含窗口进度与覆盖原子", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-worklist-"));
    try {
      const markdownPath = join(root, "source.md");
      await writeFile(markdownPath, "## 4.3 砂和砂石地基\n砂和砂石地基的质量检验应符合规定。\n", "utf8");
      const workspace = await DocumentDiscoveryWorkspace.openOrCreate(root, "worklist-job", markdownPath);
      expect(await compileIssuesWorklist(workspace)).toBe("");
      await workspace.recordLastCompileIssues(false, [
        {
          code: "selector_discovery_window_unclassified",
          path: "/targets",
          message: "可靠发现窗口尚未被 target 或有证据的 context 明确归类，不能静默遗漏。",
          details: {
            window: { window_id: "window:4.3", number: "4.3", title: "砂和砂石地基", start_line: 1, end_exclusive_line: 3 },
            covering_atoms: [{ atom_id: "a1", start_line: 1, end_line: 2, first_line: "## 4.3 砂和砂石地基" }],
            window_classification_progress: { classified_windows: 4, total_windows: 49 },
          },
        },
        { code: "selector_zero_targets", path: "/no_target_reason", message: "零目标需明确说明全文为何没有可验收对象。" },
      ]);
      const worklist = await compileIssuesWorklist(workspace);
      expect(worklist).toContain("selector_discovery_window_unclassified ×1");
      expect(worklist).toContain("selector_zero_targets ×1");
      expect(worklist).toContain("窗口归类进度：4/49");
      expect(worklist).toContain("window:4.3 [1,3)");
      expect(worklist).toContain("4.3 砂和砂石地基");
      expect(worklist).toContain("atoms:a1");
      await workspace.recordLastCompileIssues(true);
      expect(await compileIssuesWorklist(workspace)).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
