import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Text, sha256Json } from "./canonical.js";
import type { DocumentContextNote, DocumentEvidence, DocumentTargetPlan } from "./document-discovery.js";

/** Read-only bridge to the existing sealed plan; never rewrites a target's frozen manifest. */
export async function readDiscoveryContextNotes(root: string, jobId: string, sourceSha256: string): Promise<{
  status: "available" | "unavailable" | "stale_or_invalid";
  plan_sha256?: string;
  entries: Array<{ note: DocumentContextNote; start: number; end: number }>;
}> {
  const files = await Promise.all(["manifest.json", "document-target-plan.json", "document-evidence.json"]
    .map(name => readFile(join(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })));
  if (files.some(file => file === null)) return { status: "unavailable" as const, entries: [] };
  try {
    const [manifestText, planText, evidenceText] = files as string[];
    const manifest = JSON.parse(manifestText!);
    const plan = JSON.parse(planText!) as DocumentTargetPlan;
    const evidence = JSON.parse(evidenceText!) as DocumentEvidence;
    if (manifest.job_id !== jobId || plan.job_id !== jobId
      || manifest.files?.plan_sha256 !== sha256Text(planText!)
      || manifest.files?.evidence_sha256 !== sha256Json(evidence)
      || evidence.source.sha256 !== sourceSha256
      || plan.document_fingerprint !== evidence.evidence_fingerprint) {
      return { status: "stale_or_invalid" as const, entries: [] };
    }
    const atoms = new Map(evidence.atoms.map(atom => [atom.atom_id, atom]));
    const entries: Array<{ note: DocumentContextNote; start: number; end: number }> = [];
    for (const note of plan.context_notes) {
      for (const fragment of note.evidence_fragments) {
        const atom = atoms.get(fragment.atom_id);
        const offset = atom?.text.indexOf(fragment.text) ?? -1;
        if (!atom || !fragment.text || offset < 0 || atom.text.indexOf(fragment.text, offset + 1) >= 0
          || sha256Text(atom.text) !== atom.text_sha256) {
          return { status: "stale_or_invalid" as const, entries: [] };
        }
        entries.push({ note, start: atom.start_offset + offset, end: atom.start_offset + offset + fragment.text.length });
      }
    }
    return { status: "available" as const, plan_sha256: manifest.files.plan_sha256 as string, entries };
  } catch {
    return { status: "stale_or_invalid" as const, entries: [] };
  }
}
