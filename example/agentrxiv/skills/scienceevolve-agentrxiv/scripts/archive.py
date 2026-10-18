#!/usr/bin/env python3
"""Actual IO for the pinned AgentRxiv service; models perform the summaries."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.parse
import urllib.request


def get(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def results(url, query):
    return json.loads(get(url.rstrip('/') + '/api/search?' + urllib.parse.urlencode({'q': query})))['results']


def search(url, query, root, num_papers=5):
    from PyPDF2 import PdfReader
    records = []
    for result in results(url, query)[:num_papers]:
        identifier = str(result['id'])
        if not re.fullmatch(r'[A-Za-z0-9_-]+', identifier):
            raise ValueError('Unsafe archive ID')
        raw = get(result['pdf_url'])
        if not raw.startswith(b'%PDF-'):
            raise ValueError('Archive returned non-PDF content')
        text = '\n'.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(raw)).pages)
        if not text.strip():
            raise ValueError('No full text extracted; supply an actual PDF/OCR reader before summarizing')
        folder = Path(root) / ('AgentRxiv_' + identifier) / sha(raw)
        save(folder / 'paper.pdf', raw)
        save(folder / 'fulltext.txt', text.encode())
        record = dict(**result, source='AgentRxiv:' + identifier, sha256=sha(raw),
                      fulltext=str(folder / 'fulltext.txt'), pdf=str(folder / 'paper.pdf'))
        save(folder / 'metadata.json', json.dumps(record, ensure_ascii=False, indent=2).encode())
        records.append(record)
    save(Path(root) / 'search.json', json.dumps(dict(query=query, results=records), ensure_ascii=False, indent=2).encode())
    return records


def publish(url, uploads, pdf, lab, paper, root):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', lab) or not isinstance(paper, int) or paper < 1:
        raise ValueError('Use a safe lab ID and a positive paper index')
    raw = Path(pdf).read_bytes()
    if not raw.startswith(b'%PDF-'):
        raise ValueError('Publish an actual compiled PDF')
    filename = f'{lab}-{paper}-{sha(raw)}.pdf'
    target = Path(uploads) / filename
    if not target.parent.is_dir():
        raise ValueError('Configure the actual service shared uploads directory')
    if target.exists() and target.read_bytes() != raw:
        raise ValueError('Publication path conflicts with existing content')
    if not target.exists():
        save(target, raw)
    # /update acknowledges a refresh attempt, not necessarily successful indexing.
    # Confirm actual discoverability and downloaded bytes before recording success.
    get(url.rstrip('/') + '/update')
    found = next((r for r in results(url, filename) if r['filename'] == filename), None)
    if found is None or sha(get(found['pdf_url'])) != sha(raw):
        raise ValueError('No verified archive receipt yet; retry the same publication after service recovery')
    receipt = dict(lab=lab, paper=paper, filename=filename, sha256=sha(raw), archive=found)
    save(Path(root) / (filename + '.receipt.json'), json.dumps(receipt, ensure_ascii=False, indent=2).encode())
    return receipt


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['search', 'publish'])
    p.add_argument('--url', required=True)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--query')
    p.add_argument('--uploads', type=Path)
    p.add_argument('--pdf', type=Path)
    p.add_argument('--lab')
    p.add_argument('--paper', type=int)
    a = p.parse_args()
    value = search(a.url, a.query, a.root) if a.command == 'search' else publish(a.url, a.uploads, a.pdf, a.lab, a.paper, a.root)
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
