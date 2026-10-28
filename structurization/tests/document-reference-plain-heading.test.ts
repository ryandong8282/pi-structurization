import { describe, expect, test } from "vitest";

import { resolveDocumentReferenceTarget } from "../src/document-reference.js";

describe("plain numbered reference section headings", () => {
  test("a section between the endpoints of a range resolves separately and closes the preceding section", () => {
    const markdown = [
      "# 2 Neutral provisions",
      "## 2.2 First process",
      "2.2.1 First requirement.",
      "2.3 Middle process",
      "2.3.1 Middle requirement A.",
      "2.3.2 Middle requirement B.",
      "## 2.4 Last process",
      "2.4.1 Last requirement.",
      "# 3 Other provisions",
    ].join("\n");
    const section = (number: string) =>
      resolveDocumentReferenceTarget(markdown, "neutral-source", { kind: "section", number });

    const first = section("2.2");
    const middle = section("2.3");
    const last = section("2.4");
    expect(first.ok).toBe(true);
    expect(middle.ok).toBe(true);
    expect(last.ok).toBe(true);
    if (!first.ok || !middle.ok || !last.ok) return;

    const firstText = first.evidence.map((record) => record.text).join("\n");
    const middleText = middle.evidence.map((record) => record.text).join("\n");
    const lastText = last.evidence.map((record) => record.text).join("\n");
    expect(firstText).toContain("2.2.1 First requirement.");
    expect(firstText).not.toContain("2.3 Middle process");
    expect(middleText).toContain("2.3 Middle process");
    expect(middleText).toContain("2.3.2 Middle requirement B.");
    expect(middleText).not.toContain("2.4 Last process");
    expect(lastText).toContain("2.4.1 Last requirement.");
    expect(lastText).not.toContain("# 3 Other provisions");
  });

  test("a plain two-part number without descendant clauses is not promoted", () => {
    const markdown = [
      "# 2 Neutral provisions",
      "## 2.2 First process",
      "2.2.1 First requirement.",
      "2.3 Numbered note without subordinate clauses.",
      "## 2.4 Last process",
      "2.4.1 Last requirement.",
    ].join("\n");

    expect(resolveDocumentReferenceTarget(markdown, "neutral-source", {
      kind: "section", number: "2.3",
    })).toMatchObject({ ok: false, error: "not_found" });
  });
});
