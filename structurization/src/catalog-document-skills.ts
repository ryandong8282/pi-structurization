import { fileURLToPath } from 'node:url';

/** Explicit project resources only; never discover the host user's personal skills. */
export const CATALOG_DOCUMENT_SKILL_PATHS = ['document-exploration', 'mineru-reading']
  .map((name) => fileURLToPath(new URL(`./skills/${name}/SKILL.md`, import.meta.url)));
