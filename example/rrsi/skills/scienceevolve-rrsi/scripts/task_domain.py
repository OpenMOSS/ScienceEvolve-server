"""A frozen, executable Task contract for capability-equivalent RRSI Tasks.

The evaluator is an actual program supplied with the research Task. It receives
only the selected harness, task IDs, sample count and output locations. RRSI
research roles and selection are never implemented inside that evaluator.
"""
import json
import subprocess
from pathlib import Path
from rrsi.domain import Domain
from rrsi.evaluate import TaskResult


class TaskDomain(Domain):
    name = 'research'
    harness_path = '../../task-harness'

    def __init__(self, repo, spec):
        self.root = Path(repo) / 'domains' / 'research'
        self.spec = spec
        self.briefs = spec.get('briefs', {r: spec.get('description', '') for r in
                                        ('analyst','digester','proposer','critic')})
        self.critic_patterns = [tuple(x) for x in spec.get('critic_patterns', [])]
        self.component_signals = [tuple(x) for x in spec.get('component_signals', [])]
        self.source_exts = set(spec.get('source_exts', ['.py','.md','.txt','.json']))

    def evolve_ids(self):
        return self.spec['evolve_ids']

    def heldout_ids(self):
        return self.spec['heldout_ids']

    def smoke_ids(self, incumbent_per_task=None):
        return self.spec['smoke_ids']

    def constitution(self, root):
        return self.spec['constitution'], self.spec['patterns']

    def run(self, root, runs_dir, job, ids, k, log_prefix=''):
        out = Path(runs_dir) / 'jobs' / job
        out.mkdir(parents=True, exist_ok=True)
        request = {'harness_dir': str(self.harness_dir(Path(root))), 'task_ids': ids,
                   'k': k, 'output_dir': str(out), 'job': job,
                   'policy_model': self.spec['policy_model']}
        rp = out / 'request.json'
        # Resume must re-use the same job and frozen input.
        if rp.exists() and json.loads(rp.read_text()) != request:
            raise ValueError('Task job identity changed')
        rp.write_text(json.dumps(request, indent=2))
        with (out / 'executor.log').open('a') as log:
            subprocess.run([*self.spec['evaluate_argv'], str(rp)],
                           cwd=self.spec['evaluate_cwd'], check=True,
                           stdout=log, stderr=subprocess.STDOUT)

    def records(self, runs_dir, job):
        p = Path(runs_dir) / 'jobs' / job / 'trials.json'
        records = json.loads(p.read_text()) if p.exists() else []
        keys = [(r['task_id'], r['trial']) for r in records]
        if len(set(keys)) != len(keys):
            raise ValueError('duplicate Task/trial receipt')
        return {(r['task_id'], r['trial']): r for r in records}

    def score(self, runs_dir, job, ids, k):
        import math
        rows = self.records(runs_dir, job)
        if set(rows) - {(tid, j) for tid in ids for j in range(k)}:
            raise ValueError('unexpected task/trial receipt outside frozen job')
        per = {}
        for tid in ids:
            rewards, weights, tokens, extras = [], [], [], []
            missing = 0
            for trial in range(k):
                row = rows.get((tid, trial))
                weight = self.spec.get('weights', {}).get(tid, 1)
                if not isinstance(weight, (int,float)) or not math.isfinite(weight) or weight <= 0:
                    raise ValueError('Task weights must be finite and positive')
                if not row:
                    rewards.append(0.0); weights.append(weight); tokens.append(None)
                    missing += 1; extras.append({})
                    continue
                reward, token = row['reward'], row['tokens']
                if not isinstance(reward, (int,float)) or not math.isfinite(reward) or not 0 <= reward <= 1:
                    raise ValueError('reward must be a finite fraction')
                if not isinstance(token, int) or isinstance(token, bool) or token <= 0:
                    raise ValueError('actual positive policy token accounting is required')
                for field in ('trace', 'grader_evidence'):
                    p = Path(row[field])
                    if not p.is_file():
                        raise ValueError(f'missing real {field}: {p}')
                rewards.append(reward); weights.append(weight); tokens.append(token)
                extras.append(row.get('extra', {}))
            per[tid] = TaskResult(rewards, weights, tokens, missing, {'trials': extras})
        extra = {}
        for guard in self.spec.get('guards', []):
            key = guard['metric']
            vals = [tr.extra['trials'][j].get(key, guard['missing_value'])
                    for tr in per.values() for j in range(k)]
            extra[key] = sum(vals) / len(vals)
        return per, extra

    def guards(self, incumbent, candidate):
        reasons = []
        for rule in self.spec.get('guards', []):
            key = rule['metric']
            change = candidate.extra[key] - incumbent.extra[key]
            bad = change if rule['direction'] == 'max_rise' else -change
            if bad > rule['limit']:
                reasons.append(f'{key} {rule["direction"]}: {bad} > {rule["limit"]}')
        return reasons

    def load_trial(self, runs_dir, job, task_id, trial):
        return self.records(runs_dir, job).get((task_id, trial))

    def render_trace(self, rec, detail=False):
        return Path(rec['trace']).read_text() + '\nGRADER EVIDENCE\n' + Path(rec['grader_evidence']).read_text()

    def task_row(self, task_id, rec, tr):
        return f'{task_id} | score={tr.mean} | {rec.get("summary", "")}'

    def smoke(self, root, runs_dir, job, ids):
        self.run(root, runs_dir, job, ids, 1)
        per, extra = self.score(runs_dir, job, ids, 1)
        missing = sum(r.missing for r in per.values())
        # The Task declares liveness independently of scientific success.
        rows = self.records(runs_dir, job)
        live = all(rows.get((tid,0), {}).get('live') is True for tid in ids)
        return missing == 0 and live, {'missing': missing, 'live': live, **extra}
