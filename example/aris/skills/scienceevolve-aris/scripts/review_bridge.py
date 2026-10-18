#!/usr/bin/env python3
"""File handoff for a real SCIENCEEVOLVE reviewer; no model invocation or fabricated verdicts."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'upstream/tools'))
from review_gate import derive_model_family, evaluate_transition


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def local(root, value):
    p = (root / value).resolve()
    if not p.is_relative_to(root.resolve()) or not p.is_file():
        raise ValueError('Expected an existing file inside the Task workspace: ' + str(value))
    return p


def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def request(root, workflow, requester, purpose, prompt, artifacts, continuation, cold=False):
    config = json.loads(Path(workflow).read_text())['agents']
    reviewer = 'paper_reviewer' if cold else 'reviewer'
    author_model, reviewer_model = config[requester]['model'], config[reviewer]['model']
    a, r = derive_model_family(author_model), derive_model_family(reviewer_model)
    if 'unknown' in (a, r) or a == r:
        raise ValueError('Cross-family reviewer is required; unknown/same-family cannot pass')
    if not continuation.strip() or not artifacts:
        raise ValueError('Review requires a continuation and concrete artifacts')
    prompt_path = local(root, prompt)
    review_id = uuid.uuid4().hex
    directory = root / '.aris/scienceevolve-reviews' / review_id
    directory.mkdir(parents=True)
    (directory / 'prompt.txt').write_bytes(prompt_path.read_bytes())
    data = dict(id=review_id, requester=requester, reviewer=reviewer, purpose=purpose,
                continuation=continuation, cold=cold, executor_model=author_model,
                reviewer_model=reviewer_model, identity_assurance='configured-models',
                prompt_sha256=digest(directory / 'prompt.txt'),
                artifacts={str(local(root, f).relative_to(root.resolve())): digest(local(root, f)) for f in artifacts})
    write_new(directory / 'request.json', data)
    return data


def review_directory(root, review_id):
    if not re.fullmatch(r'[0-9a-f]{32}', review_id):
        raise ValueError('Invalid review ID')
    return root / '.aris/scienceevolve-reviews' / review_id


def record(root, review_id, agent, response):
    directory = review_directory(root, review_id)
    req = json.loads((directory / 'request.json').read_text())
    if agent != req['reviewer']:
        raise ValueError('Response must come from the assigned reviewer role')
    for name, expected in req['artifacts'].items():
        if digest(local(root, name)) != expected:
            raise ValueError('Reviewed artifact changed; request a new review: ' + name)
    if digest(directory / 'prompt.txt') != req['prompt_sha256']:
        raise ValueError('Review prompt changed')
    response_path = local(root, response)
    raw = response_path.read_text()
    if not raw.strip():
        raise ValueError('Empty reviewer response')
    receipt = dict(request_id=review_id, request_sha256=digest(directory / 'request.json'),
                   reviewer=agent, identity_assurance=req['identity_assurance'],
                   response_sha256=digest(response_path))
    if req['purpose'] == 'research_loop':
        scores = re.findall(r'(?im)^\s*Score:\s*([0-9]+(?:\.[0-9]+)?)\s*/\s*10\s*$', raw)
        verdicts = re.findall(r'(?im)^\s*Verdict:\s*(ready|almost|not ready)\s*$', raw)
        if len(scores) != 1 or len(verdicts) != 1:
            raise ValueError('Require exactly one Score: n/10 and Verdict field')
        score = float(scores[0])
        if not math.isfinite(score) or not 0 <= score <= 10:
            raise ValueError('Invalid reviewer score')
        transition = evaluate_transition(round_backend='codex', score=score, verdict=verdicts[0].lower(),
                                         executor_model=req['executor_model'], reviewer_model=req['reviewer_model'])
        receipt.update(score=score, verdict=verdicts[0].lower(), decision=transition.decision)
    # The raw response is retained verbatim; no summarizer may replace it.
    with (directory / 'response.txt').open('xb') as f:
        f.write(response_path.read_bytes())
    write_new(directory / 'receipt.json', receipt)
    return receipt


def consume(root, review_id):
    directory = review_directory(root, review_id)
    req = json.loads((directory / 'request.json').read_text())
    receipt = json.loads((directory / 'receipt.json').read_text())
    if receipt['request_id'] != review_id or receipt['reviewer'] != req['reviewer']:
        raise ValueError('Review receipt identity mismatch')
    if digest(directory / 'prompt.txt') != req['prompt_sha256']:
        raise ValueError('Review prompt changed')
    if receipt['request_sha256'] != digest(directory / 'request.json') or receipt['response_sha256'] != digest(directory / 'response.txt'):
        raise ValueError('Review evidence changed')
    for name, expected in req['artifacts'].items():
        if digest(local(root, name)) != expected:
            raise ValueError('Stale review: ' + name)
    return dict(request=req, receipt=receipt, response=(directory / 'response.txt').read_text())


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--workspace', type=Path, required=True)
    sub = p.add_subparsers(dest='command', required=True)
    q = sub.add_parser('request')
    q.add_argument('--workflow', required=True); q.add_argument('--requester', required=True)
    q.add_argument('--purpose', required=True); q.add_argument('--prompt', required=True)
    q.add_argument('--artifact', action='append', required=True); q.add_argument('--continuation', required=True)
    q.add_argument('--cold', action='store_true')
    q = sub.add_parser('record'); q.add_argument('--id', required=True); q.add_argument('--agent', required=True); q.add_argument('--response', required=True)
    q = sub.add_parser('consume'); q.add_argument('--id', required=True)
    a = p.parse_args(); root = a.workspace.resolve()
    if a.command == 'request': result = request(root, a.workflow, a.requester, a.purpose, a.prompt, a.artifact, a.continuation, a.cold)
    elif a.command == 'record': result = record(root, a.id, a.agent, a.response)
    else: result = consume(root, a.id)
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
