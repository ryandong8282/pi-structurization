import { expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAgentScopedEvidenceManifest, type DocumentEvidence } from '../src/document-discovery.js';
import { RevisionWorkspace } from '../src/workspace.js';
import { ToolController } from '../src/tools.js';
import { buildSelectorStageScenario } from './selector-stage-fixture.js';
import { modelSourceDocumentContext, sourceDocumentSessionNote } from '../src/source-document-context.js';
import { selectorSessionContractContext } from '../src/selector-session-contract.js';

test('target context exposes source basenames as navigation information', async () => {
  const { controller, manifest } = await buildSelectorStageScenario();
  const result = await controller.dispatch('get_target_context', {});
  expect(result).toMatchObject({ ok: true, source_document: {
    markdown_file_name: manifest.source.file_name,
    instruction: expect.stringContaining('必须核对正文'),
  } });
  expect(result.source_document).not.toHaveProperty('pdf_file_name');
});

test('legacy display override updates the resume note without changing the frozen source identity', () => {
  const source = Object.freeze({ file_name: '01_GB50203-2011_.md', pdf_file_name: 'input.pdf',
    sha256: 'frozen-markdown-hash', pdf_sha256: 'frozen-pdf-hash' });
  const before = JSON.stringify(source);
  const context = modelSourceDocumentContext(source, 'GB50203-2011.pdf');
  const note = sourceDocumentSessionNote(source, 'GB50203-2011.pdf');
  expect(context.pdf_file_name).toBe('GB50203-2011.pdf');
  expect(note).toContain('"pdf_file_name":"GB50203-2011.pdf"');
  expect(note).toContain('不改变原文、证据身份、检查点或已有识别结果');
  expect(note).not.toContain('input.pdf');
  expect(JSON.stringify(source)).toBe(before);
  expect(modelSourceDocumentContext(source).pdf_file_name).toBe('input.pdf');
  expect(sourceDocumentSessionNote(source)).toBe('');
  const history = [{ role: 'toolResult', content: '{"source_document":{"pdf_file_name":"input.pdf"}}' }];
  const originalHistory = JSON.stringify(history);
  const requestContext = selectorSessionContractContext(note, history);
  expect(requestContext.prompt).toContain('"pdf_file_name":"GB50203-2011.pdf"');
  expect(requestContext.prompt).not.toContain('input.pdf');
  expect(JSON.stringify(history)).toBe(originalHistory);
});

test('original PDF basename reaches model context through the evidence manifest without exposing its host directory', async () => {
  const fixture = await buildSelectorStageScenario();
  const root = await mkdtemp(join(tmpdir(), 'source-document-context-'));
  try {
    const markdownPath = join(root, '设备验收说明.md');
    const pdfName = '设备验收标准 2026（试行）.PDF';
    const pdfPath = join(root, pdfName);
    await writeFile(markdownPath, await readFile(fixture.workspace.sourceMarkdownPath));
    await writeFile(pdfPath, '%PDF fixture bytes');
    const document = JSON.parse(await readFile(join(dirname(fixture.workspace.documentLedgerPath), 'document-evidence.json'), 'utf8')) as DocumentEvidence;
    const prepared = await buildAgentScopedEvidenceManifest(markdownPath, fixture.manifest.job_id, fixture.target, document, pdfPath);
    const workspace = await RevisionWorkspace.createFromEvidence(join(root, 'artifacts'), prepared.manifest.job_id, prepared.manifest.target_id, prepared);
    const controller = await ToolController.create(workspace);
    const result = await controller.dispatch('get_target_context', {});
    expect(result).toMatchObject({ ok: true, source_document: {
      markdown_file_name: '设备验收说明.md', pdf_file_name: pdfName,
    } });
    expect(JSON.stringify(result.source_document)).not.toContain(root);
    const frozenManifest = await readFile(workspace.evidenceManifestPath, 'utf8');
    const savedSelectors = await readFile(workspace.workingSelectorPath, 'utf8');
    const resumedController = await ToolController.create(workspace);
    resumedController.sourcePdfDisplayName = 'GB50203-2011.pdf';
    const renamedContext = await resumedController.dispatch('get_target_context', {});
    expect(renamedContext).toMatchObject({ source_document: { pdf_file_name: 'GB50203-2011.pdf' } });
    expect(await readFile(workspace.evidenceManifestPath, 'utf8')).toBe(frozenManifest);
    expect(await readFile(workspace.workingSelectorPath, 'utf8')).toBe(savedSelectors);
    expect(controller.evidence.source.pdf_file_name).toBe(pdfName);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
