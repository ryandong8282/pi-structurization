"""Read-only PDF text/coordinate evidence for lot boundaries, with no OCR or model calls."""
import argparse
import hashlib
import json
from pathlib import Path

import fitz

parser = argparse.ArgumentParser()
parser.add_argument('--pdf', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
source, target = Path(args.pdf).resolve(), Path(args.out).resolve()
digest = hashlib.sha256(source.read_bytes()).hexdigest()
pages = []
with fitz.open(source) as document:
    for number, page in enumerate(document, 1):
        lines = [{'text': ''.join(span['text'] for span in line['spans']), 'bbox': list(line['bbox'])}
                 for block in page.get_text('dict')['blocks'] if 'lines' in block for line in block['lines']]
        pages.append({'page': number, 'width': page.rect.width, 'height': page.rect.height, 'lines': lines})
with target.open('x', encoding='utf-8') as output:
    json.dump({'schema_version': 'lot-split-pdf-text/v1', 'path': str(source), 'sha256': digest, 'pages': pages}, output, ensure_ascii=False)
print(json.dumps({'path': str(target), 'pdf_sha256': digest, 'pages': len(pages)}))
