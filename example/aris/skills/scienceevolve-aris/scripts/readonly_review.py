#!/usr/bin/env python3
"""One original read-only review call, not a research pipeline or adjudicator."""
import argparse
import json
from pathlib import Path
import subprocess


def command(binary, mode, cwd, output, resume=None, fallback=None):
    if mode == 'integrity':
        if resume or fallback: raise ValueError('Pinned integrity reviewers require fresh sessions and original settings')
        # Read from the actual Anti-Autoresearch pin, not ARIS's stale prose summary.
        model, effort = 'gpt-5.6-sol', 'xhigh'
    elif mode == 'proof':
        model, effort = ('gpt-6-astra','ultra') if fallback is None else (fallback,'xhigh')
        if fallback not in (None,'gpt-6-astra','gpt-5.5'): raise ValueError('Unknown upstream capability fallback')
    else: raise ValueError('Unknown audit mode')
    args=[binary,'exec']
    if resume: args+=['resume',resume]
    args+=['-c','sandbox_mode="read-only"','-c','approval_policy="never"',
           '-c',f'model_reasoning_effort="{effort}"','-m',model,
           '--json','--output-last-message',str(output),'--skip-git-repo-check']
    if not resume: args+=['-C',str(cwd)]
    # A fresh invocation creates a fresh thread. Persist it for the trace receipt;
    # integrity never resumes it, proof may resume its own prior obligations thread.
    args+=['-']
    return args,dict(model=model,reasoning=effort,sandbox='read-only',resume=resume)


def main():
    p=argparse.ArgumentParser();p.add_argument('--mode',choices=['integrity','proof'],required=True)
    p.add_argument('--cwd',type=Path,required=True);p.add_argument('--prompt',type=Path,required=True)
    p.add_argument('--output-dir',type=Path,required=True);p.add_argument('--bin',default='codex')
    p.add_argument('--resume');p.add_argument('--fallback',choices=['gpt-6-astra','gpt-5.5'])
    a=p.parse_args();out=a.output_dir.resolve();out.mkdir(parents=True,exist_ok=False)
    raw=a.prompt.read_bytes();(out/'prompt.txt').write_bytes(raw)
    args,meta=command(a.bin,a.mode,a.cwd.resolve(),out/'response.txt',a.resume,a.fallback)
    (out/'request.json').write_text(json.dumps(meta,indent=2)+'\n')
    with (out/'events.jsonl').open('wb') as stdout,(out/'stderr.txt').open('wb') as stderr:
        result=subprocess.run(args,input=raw,cwd=a.cwd,stdout=stdout,stderr=stderr,check=False)
    # Keep the complete transport output; thread IDs are evidence, never invented.
    thread_ids=[]
    for line in (out/'events.jsonl').read_text().splitlines():
        try:event=json.loads(line)
        except json.JSONDecodeError:continue
        if event.get('thread_id'):thread_ids.append(event['thread_id'])
    response=out/'response.txt'
    receipt=dict(**meta,thread_ids=thread_ids,exit_code=result.returncode,
                 response_present=response.is_file() and bool(response.read_text().strip()))
    (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    if result.returncode or not receipt['response_present']:
        raise SystemExit('Review unavailable; inspect preserved transport evidence. No verdict created.')
    print(json.dumps(receipt,indent=2))

if __name__=='__main__':main()
