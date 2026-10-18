#!/usr/bin/env python3
"""Record a trial and apply the authorized train.py-only Git keep/discard decision."""
import argparse
import csv
import io
import json
import math
import os
from pathlib import Path
import subprocess

HEADER = 'commit\tval_bpb\tmemory_gb\tstatus\tdescription\n'


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def finish(root, candidate, parent, status, val_bpb, peak_vram_mb, description):
    root = Path(root).resolve()
    candidate = git(root, 'rev-parse', '--verify', candidate+'^{commit}')
    parent = git(root, 'rev-parse', '--verify', parent+'^{commit}')
    if not git(root, 'branch', '--show-current').startswith('autoresearch/'):
        raise ValueError('Use a dedicated autoresearch/<tag> branch')
    if candidate == parent or git(root, 'merge-base', candidate, parent) != parent:
        raise ValueError('Candidate must descend from the recorded incumbent')
    if git(root, 'status', '--porcelain', '--untracked-files=no'):
        raise ValueError('Uncommitted tracked changes; refusing to overwrite them')
    changed = git(root, 'diff', '--name-only', parent, candidate).splitlines()
    if changed != ['train.py']:
        raise ValueError('Only train.py may change in a trial')
    if status not in ('keep', 'discard', 'crash'):
        raise ValueError('Invalid status')
    if not description.strip() or any(x in description for x in '\t\r\n'):
        raise ValueError('Provide a single-line decision explanation')
    if status == 'crash': val_bpb, peak_vram_mb = 0.0, 0.0
    if not all(math.isfinite(x) and x >= 0 for x in (val_bpb, peak_vram_mb)):
        raise ValueError('Invalid actual training metrics')
    results = root/'results.tsv'
    if git(root, 'ls-files', '--', 'results.tsv'):
        raise ValueError('results.tsv must remain untracked')
    if results.exists() and results.read_text().splitlines()[0] != HEADER.strip():
        raise ValueError('Unexpected results.tsv schema')
    head = git(root, 'rev-parse', 'HEAD')
    journal = root/'.autoresearch'/('decision-'+candidate+'.json')
    data = dict(candidate=candidate,parent=parent,status=status,val_bpb=val_bpb,
                peak_vram_mb=peak_vram_mb,description=description)
    if journal.exists() and json.loads(journal.read_text()) != data:
        raise ValueError('A recorded decision cannot be rewritten')
    if head != candidate and not (journal.exists() and status != 'keep' and head == parent):
        raise ValueError('HEAD changed since the trial')
    journal.parent.mkdir(parents=True,exist_ok=True)
    if not journal.exists():
        with journal.open('x') as f: json.dump(data,f); f.flush(); os.fsync(f.fileno())
    short = git(root,'rev-parse','--short=7',candidate)
    line = f'{short}\t{val_bpb:.6f}\t{peak_vram_mb/1024:.1f}\t{status}\t{description}\n'
    existing = results.read_text() if results.exists() else HEADER
    rows = list(csv.DictReader(io.StringIO(existing), delimiter='\t'))
    matching = [r for r in rows if r['commit']==short]
    if matching and line not in existing.splitlines(keepends=True):
        raise ValueError('Conflicting trial record')
    if not matching:
        with results.open('a' if results.exists() else 'w') as f:
            if not results.exists() or not existing: f.write(HEADER)
            elif f.tell() == 0: f.write(HEADER)
            f.write(line); f.flush(); os.fsync(f.fileno())
    if status != 'keep' and head != parent:
        subprocess.run(['git','-C',str(root),'reset','--hard',parent],check=True,capture_output=True)
    return dict(**data,head=git(root,'rev-parse','HEAD'))


def main():
    p=argparse.ArgumentParser();p.add_argument('--workspace',type=Path,required=True)
    for name in ('candidate','parent','status','description'): p.add_argument('--'+name,required=True)
    p.add_argument('--val-bpb',type=float,default=0);p.add_argument('--peak-vram-mb',type=float,default=0)
    a=p.parse_args();print(json.dumps(finish(a.workspace,a.candidate,a.parent,a.status,a.val_bpb,a.peak_vram_mb,a.description),indent=2))

if __name__=='__main__': main()
