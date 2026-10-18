"""Frozen, paired, never-fed-back generalization evaluation for a research Task."""
from pathlib import Path
import hashlib
import json
from rrsi.evaluate import evaluate, EvalResult
from roles import write_json


def validate_plan(run, spec):
    if run.d.name != 'research':
        raise ValueError('the complete SCIENCEEVOLVE template uses the research Task contract; see fidelity audit for original benchmark integration status')
    task = spec['task']
    required = ['description','harness_source','evaluate_argv','evaluate_cwd','evolve_ids',
                'heldout_ids','smoke_ids','constitution','patterns','policy_model']
    for field in required:
        if not task.get(field):
            raise ValueError('Task missing ' + field)
    evolve, held, smoke = map(set, [task['evolve_ids'], task['heldout_ids'], task['smoke_ids']])
    if evolve & held or not smoke <= evolve:
        raise ValueError('evolve/heldout must be disjoint; smoke must be inside evolve')
    if len(evolve) != len(task['evolve_ids']) or len(held) != len(task['heldout_ids']):
        raise ValueError('duplicate task IDs')
    if any(not isinstance(x, str) for x in evolve | held):
        raise ValueError('task IDs must be strings')
    if any('/' in x or '\\' in x or x in ('.','..') for x in evolve | held):
        raise ValueError('use safe flat task IDs; preserve original IDs in evaluator metadata')
    if task['policy_model'] != spec['policy_model']:
        raise ValueError('policy model mismatch')
    if not isinstance(task['evaluate_argv'], list) or not all(isinstance(x,str) for x in task['evaluate_argv']):
        raise ValueError('evaluate_argv must be a concrete argv array')
    if not Path(task['evaluate_cwd']).is_dir() or not Path(task['harness_source']).is_dir():
        raise ValueError('Task evaluator/harness directories do not exist')
    if not spec['heldout'] or any(not x.get('ids') for x in spec['heldout']):
        raise ValueError('freeze at least one complete heldout surface')
    surface_ids = set()
    names = []
    for surface in spec['heldout']:
        names.append(surface['name'])
        if len(set(surface['ids'])) != len(surface['ids']) or set(surface['ids']) - held:
            raise ValueError('invalid heldout surface IDs')
        if not isinstance(surface['k'], int) or surface['k'] < 1:
            raise ValueError('invalid heldout trial count')
        surface_ids.update(surface['ids'])
    if surface_ids != held or len(set(names)) != len(names):
        raise ValueError('all frozen heldout tasks must be covered; unique surface names required')
    for rule in task.get('guards', []):
        if rule['direction'] not in ('max_rise','max_drop') or rule['limit'] < 0:
            raise ValueError('invalid non-compensatory guard')


def plan(run):
    return [{'surface': s['name'], 'ids': s['ids'], 'k': s['k'], 'arm': arm}
            for s in run.spec['heldout'] for arm in ('base','champion')]


def execute_surface(run):
    frozen = json.loads((run.meta / 'frozen_champion.json').read_text())
    if frozen != run.r.frontier():
        raise ValueError('heldout evaluation cannot modify the champion')
    items = plan(run)
    i = run.s['heldout_index']
    item = items[i]
    target = run.meta / 'heldout' / f'{i}.json'
    if not target.exists():
        ref = (frozen['trajectory'][0]['commit'] if item['arm'] == 'base'
               else frozen['incumbent']['commit'])
        job = f'heldout_{i}_{item["arm"]}'
        wt = run.r.checkout(job, ref)
        ep = run.r.eval_path(job)
        if ep.exists():
            ev = EvalResult.load(ep)
        else:
            ev = evaluate(run.d, wt, run.r.runs, job, item['ids'], item['k'])
            ev.save(ep)
        # Missing trials retain zero reward in the FULL frozen denominator.
        # Report infrastructure separately; do not silently rerun/select subsets.
        paths = [p for p in ep.parent.rglob('*') if p.is_file()]
        for row in run.d.records(run.r.runs, job).values():
            paths.extend(Path(row[k]) for k in ('trace','grader_evidence'))
        artifacts = [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                     for p in sorted(set(paths))]
        write_json(target, {'surface': item, 'commit': ref,
            'champion': frozen['incumbent']['commit'], 'job': job,
            'S': ev.S, 'C': ev.C, 'missing': ev.missing, 'expected': ev.n_expected,
            'extra': ev.extra, 'artifacts': artifacts})
    run.save(heldout_index=i + 1, phase='export' if i + 1 == len(items) else 'heldout')
