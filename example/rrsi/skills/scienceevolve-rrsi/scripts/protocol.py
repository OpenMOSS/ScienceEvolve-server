#!/usr/bin/env python3
"""SCIENCEEVOLVE-owned RRSI state machine; never invokes Run.round/drive/_draft.

The upstream library supplies role protocols and atomic research operations.
Every model decision is a durable workflow ticket. Measurement and selection
are explicit workflow operations, not a nested autonomous research agent.
"""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import math

from roles import Pending, Replay, digest, submit, write_json
SKILL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL / 'upstream'))
from rrsi import gitops as G
from rrsi import analyst, propose, critic
from rrsi.config import RRSIConfig
from rrsi.evaluate import EvalResult, evaluate
from rrsi.history import History, exploration, stall_flag
from rrsi.loop import Run
from rrsi.schedule import edit_budget
from rrsi.components import normalize
from rrsi.selection import Candidate, select_round


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def jsonl(path, rows):
    tmp = Path(str(path) + '.tmp')
    tmp.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))
    os.replace(tmp, path)


def verify_vendor():
    for f in read(SKILL / 'UPSTREAM.json')['files']:
        if sha(SKILL / f['path']) != f['sha256']:
            raise ValueError('vendored source changed: ' + f['path'])


def init(root, profile):
    verify_vendor()
    meta = root / '.rrsi'
    if (meta / 'state.json').exists():
        raise ValueError('already initialized; use next/resume')
    repo = root / 'rrsi-task'
    if repo.exists():
        raise ValueError('rrsi-task exists; will not overwrite it')
    shutil.copytree(SKILL / 'upstream', repo,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    G.git(repo, 'init', '-q', check=True)
    G.git(repo, 'add', '.', check=True)
    G.git(repo, 'commit', '-qm', 'Pinned RRSI Task baseline', check=True)
    dom = repo / 'domains' / 'research'
    dom.mkdir()
    shutil.copy2(repo / 'domains' / profile / 'rrsi.json', dom / 'rrsi.json')
    state = {'version': 1, 'domain': 'research', 'profile': profile, 'config_sha256': sha(dom / 'rrsi.json'), 'phase': 'setup', 't': 0,
             'variant': 0, 'attempt': 0, 'completed_operations': [],
             'source': read(SKILL / 'UPSTREAM.json')['commit']}
    write_json(meta / 'state.json', state)


class Protocol:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.meta = self.root / '.rrsi'
        self.path = self.meta / 'state.json'
        self.s = read(self.path)
        self.repo = self.root / 'rrsi-task'
        self.spec = read(self.meta / 'environment.json') if (self.meta / 'environment.json').exists() else {}
        if self.s['phase'] != 'setup' and sha(self.meta / 'environment.json') != self.s['environment_sha256']:
            raise ValueError('frozen Task configuration changed')
        # Credentials remain in the launch environment, never in persisted JSON.
        os.environ.update(self.spec.get('environment', {}))
        from task_domain import TaskDomain
        self.d = TaskDomain(self.repo, self.spec.get('task', {}))
        self.cfg = RRSIConfig.load(self.d.root / 'rrsi.json')
        self.r = Run(self.d, self.cfg, self.repo, self.root / 'rrsi-runs')

    def save(self, **changes):
        self.s.update(changes)
        identity = getattr(self, '_executing', None)
        if identity and identity not in self.s['completed_operations']:
            self.s['completed_operations'].append(identity)
        write_json(self.path, self.s)

    @property
    def rd(self):
        return self.r.runs / f"r{self.s['t']}"

    @property
    def vid(self):
        return 'ABCDEFGH'[self.s['variant']]

    @property
    def vd(self):
        return self.rd / self.vid

    @property
    def wt(self):
        return self.r.wt_root / f"r{self.s['t']}{self.vid}"

    def operation(self, role, name, **context):
        payload = {'phase': self.s['phase'], 't': self.s['t'],
                   'variant': self.s['variant'], 'attempt': self.s['attempt'],
                   'name': name, **context}
        return {'id': digest(payload), 'role': role, 'kind': 'operation', 'payload': payload}

    def verify_frozen(self):
        if self.s['phase'] != 'setup' and sha(self.meta / 'split.json') != self.s['split_sha256']:
            raise ValueError('frozen split changed')
        if sha(self.d.root / 'rrsi.json') != self.s['config_sha256']:
            raise ValueError('frozen RRSI parameters changed')
        for f in self.spec.get('frozen_files', []):
            if sha(f['path']) != f['sha256']:
                raise ValueError('frozen environment changed: ' + f['path'])
        for f in read(SKILL / 'UPSTREAM.json')['files']:
            if not f['path'].startswith('upstream/'):
                continue
            rel = f['path'].removeprefix('upstream/')
            if sha(self.repo / rel) != f['sha256']:
                raise ValueError('immutable Task source changed: ' + rel)

    def configure(self, spec):
        if self.s['phase'] != 'setup':
            raise ValueError('environment is already frozen')
        for k in ('environment', 'frozen_files', 'policy_model', 'substitutions', 'heldout', 'task'):
            if k not in spec:
                raise ValueError('environment.json missing ' + k)
        if any(any(x in k.upper() for x in ('KEY', 'TOKEN', 'SECRET', 'PASSWORD'))
               for k in spec['environment']):
            raise ValueError('pass credentials via launch environment, not environment.json')
        if not spec['frozen_files']:
            raise ValueError('freeze actual data/split/verifier files before baseline')
        from heldout import validate_plan
        validate_plan(self, spec)
        parameters = spec.get('parameters', {})
        allowed = {'T','k','m','b_min','b_max','w','m_draft','delta','delta_z','beta0','beta1','w_s','w_c','w_n','n_prune','repair_rounds','invalid_missing_frac','n_fail_traces','n_success_traces'}
        if set(parameters) - allowed:
            raise ValueError('unknown RRSI parameter override')
        config = read(self.d.root / 'rrsi.json')
        config.update(parameters)
        for key in ('T','k','m','b_min','b_max','w','m_draft','n_prune','repair_rounds','n_fail_traces','n_success_traces'):
            if not isinstance(config[key], int) or isinstance(config[key], bool) or config[key] < 0:
                raise ValueError('invalid count parameter: ' + key)
        for key in ('delta','delta_z','beta0','beta1','w_s','w_c','w_n','invalid_missing_frac'):
            value = config[key]
            if key == 'delta' and value is None:
                continue
            if not isinstance(value, (int,float)) or not math.isfinite(value) or value < 0:
                raise ValueError('invalid numeric parameter: ' + key)
        if config['w'] < 1 or config['invalid_missing_frac'] >= 1 or config['n_fail_traces'] + config['n_success_traces'] == 0:
            raise ValueError('invalid noise/history/missing-trial protocol')
        if not (1 <= config['m'] <= 8 and 1 <= config['b_min'] <= config['b_max'] and config['T'] > 0 and config['k'] > 0 and 0 <= config['m_draft'] <= config['m']):
            raise ValueError('invalid RRSI horizon/candidate/edit budget')
        write_json(self.d.root / 'rrsi.json', config)
        self.save(config_sha256=sha(self.d.root / 'rrsi.json'))
        write_json(self.meta / 'environment.json', spec)
        # Reload adapters under frozen environment before checking the actual split.
        fresh = Protocol(self.root)
        ids = fresh.d.evolve_ids()
        if len(ids) != len(set(ids)):
            raise ValueError('duplicate evolve tasks')
        fresh.verify_frozen()
        write_json(self.meta / 'split.json', {'evolve': ids, 'heldout': fresh.d.heldout_ids()})
        harness = self.repo / 'task-harness'
        if not harness.exists():
            staging = self.meta / 'task-harness-staging'
            if staging.exists():
                shutil.rmtree(staging)
            shutil.copytree(spec['task']['harness_source'], staging,
                            ignore=shutil.ignore_patterns('.git', '__pycache__', '*.pyc'))
            os.replace(staging, harness)
        G.git(self.repo, 'add', 'task-harness', 'domains/research/rrsi.json', check=True)
        G.git(self.repo, 'commit', '--allow-empty', '-qm', 'Freeze research Task H_0 and RRSI profile', check=True)
        fresh.save(phase='baseline', environment_sha256=sha(self.meta / 'environment.json'),
                   split_sha256=sha(self.meta / 'split.json'))

    def replay(self, role, fn, *args, **kwargs):
        scope = f"r{self.s['t']}/{role}"
        if role in ('proposer', 'critic'):
            scope += f"/{self.vid}/a{self.s['attempt']}"
        return Replay(self.meta / 'calls', scope).run(role, fn, *args, **kwargs)

    def inputs(self):
        inc = self.r.incumbent_eval(self.r.frontier())
        return inc, read(self.rd / 'traces.json'), read(self.rd / 'directives.json')

    def candidate_done(self, gate=None, detail=''):
        prep = read(self.vd / 'prep.json') if (self.vd / 'prep.json').exists() else {}
        prop = read(self.vd / 'proposal.json') if (self.vd / 'proposal.json').exists() else {}
        prep.update(edits=prop.get('edits') or [], diff_path=str(self.vd / 'diff.patch'))
        if gate:
            prep.update(gate_failure=gate, detail=detail)
        write_json(self.vd / 'prep.json', prep)
        self.save(variant=self.s['variant'] + 1, attempt=0, phase='candidate')

    def begin_round(self):
        fr = self.r.frontier()
        if self.r.harness_tree(self.r.branch) != fr['incumbent']['harness_tree']:
            raise ValueError('incumbent Git tree differs from frontier')
        t = self.s['t']
        if len(fr['trajectory']) != t + 1:
            raise ValueError('round/trajectory mismatch')
        inc = self.r.incumbent_eval(fr)
        traces = self.r.build_traces(fr['incumbent']['job'], inc.per_task)
        if len(traces) < .5 * min(len(inc.per_task), self.cfg.n_fail_traces + self.cfg.n_success_traces):
            raise ValueError('not enough incumbent traces; restore actual evidence')
        self.rd.mkdir(exist_ok=True)
        write_json(self.rd / 'traces.json', traces)
        write_json(self.rd / 'prior.json', read(self.r.global_analysis) if self.r.global_analysis.exists() else {})
        self.save(phase='analysis')

    def directives(self):
        cfg, t, fr = self.cfg, self.s['t'], self.r.frontier()
        sigma = stall_flag([x['S'] for x in fr['trajectory']], t, cfg.w, self.r.delta())
        write_json(self.rd / 'directives.json', {
            'budget': edit_budget(t, cfg.T, cfg.b_min, cfg.b_max),
            'explore': exploration(t, sigma, self.r.history.tried(), cfg.m_draft),
            'prune': self.r.history.prune_set(t, cfg.n_prune), 'sigma': sigma,
            'history': self.r.history.render(), 'scoreboard': self.r.scoreboard()})
        self.save(phase='candidate', variant=0, attempt=0)

    def proposal(self):
        inc, traces, dr = self.inputs()
        hdir = self.d.harness_dir(self.wt)
        snap = self.vd / f"attempt-{self.s['attempt']}-start"
        if not snap.exists():
            temporary = snap.with_name(snap.name + '.tmp')
            if temporary.exists():
                shutil.rmtree(temporary)
            shutil.copytree(hdir, temporary, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            os.replace(temporary, snap)
        # Reapply saved JSON actions from a clean attempt-start snapshot, never
        # from a half-edited tree left by a paused/replayed proposer turn.
        shutil.rmtree(hdir)
        shutil.copytree(snap, hdir)
        skill, patterns = self.d.constitution(self.repo)
        reserved = bool(dr['sigma'] and dr['explore']['untried']
                        and self.s['variant'] >= self.cfg.m - self.cfg.m_draft)
        repair = read(self.vd / 'repair.json') if self.s['attempt'] else None
        result = self.replay('proposer', propose.propose, self.d, hdir,
            read(self.rd / 'analysis_report.json'), dr['history'], skill, patterns,
            dr['budget'], dr['explore'], reserved, dr['prune'], traces=traces,
            per_task=inc.per_task, findings=analyst.load_digests(self.rd),
            scoreboard=dr['scoreboard'], variant_brief=(
                f"You are variant {self.vid} of round {self.s['t']}. {self.cfg.m} variants are "
                'drafted independently from the same incumbent this round '
                f"and each is evaluated on the full evolve set; the best admissible one becomes H_{self.s['t'] + 1}."),
            repair_brief=repair, model=self.cfg.proposer_model)
        write_json(self.vd / f"proposal_a{self.s['attempt']}.json", result)
        write_json(self.vd / 'proposal.json', result)
        if result['status'] != 'done' or (self.s['attempt'] == 0 and result['n_edits'] == 0):
            self.candidate_done('critic_reject' if self.s['attempt'] else 'no_proposal',
                                str(result.get('reason') or result['status']))
        else:
            self.save(phase='critic')

    def review(self):
        prop = read(self.vd / 'proposal.json')
        diff = G.diff_with_new_files(self.wt, self.r.harness_rel)
        (self.vd / 'diff.patch').write_text(diff)
        verdict = self.replay('critic', critic.review, self.d, diff,
                              prop.get('mechanism') or '', prop.get('targets_mode') or '',
                              edits=prop.get('edits'), model=self.cfg.critic_model)
        dr = read(self.rd / 'directives.json')
        tagged = [normalize(e.get('component'), diff, self.d.component_signals) for e in prop['edits']]
        reserved = bool(dr['sigma'] and dr['explore']['untried']
                        and self.s['variant'] >= self.cfg.m - self.cfg.m_draft)
        if verdict.get('verdict') == 'accept' and reserved and not any(c in dr['explore']['untried'] for c in tagged):
            verdict = {'verdict': 'reject', 'reasons': [
                f"Reserved exploration slot requires diff evidence for {dr['explore']['untried']}"],
                'risk_notes': verdict.get('risk_notes')}
        write_json(self.vd / f"critic_a{self.s['attempt']}.json", verdict)
        write_json(self.vd / 'critic.json', verdict)
        if verdict.get('verdict') == 'accept':
            for e, tag in zip(prop['edits'], tagged):
                e['component'] = tag
            write_json(self.vd / 'proposal.json', prop)
            self.save(phase='commit_candidate')
        elif self.s['attempt'] < self.cfg.repair_rounds:
            write_json(self.vd / 'repair.json', {'reasons': verdict.get('reasons'),
                'risk_notes': verdict.get('risk_notes'), 'your_declared_edits': prop.get('edits')})
            self.save(phase='proposal', attempt=self.s['attempt'] + 1)
        else:
            self.candidate_done('critic_reject', str(verdict.get('reasons'))[:600])

    def next(self):
        while True:
            phase = self.s['phase']
            if phase == 'setup':
                ticket = self.operation('task_setup', 'configure', reference='references/environment.md')
            elif phase in ('baseline', 'smoke', 'evaluate'):
                ticket = self.operation('measurement', phase)
            elif phase == 'selection':
                ticket = self.operation('selector', 'selection')
            elif phase == 'heldout':
                ticket = self.operation('heldout', 'heldout', index=self.s.get('heldout_index', 0))
            elif phase == 'export':
                ticket = self.operation('audit', 'export')
            elif phase == 'complete':
                return {'role': None, 'terminal': 'complete', 'report': str(self.meta / 'report.json')}
            elif phase == 'begin':
                if (self.r.runs / 'STOP').exists():
                    return {'role': None, 'terminal': 'paused', 'reason': 'remove STOP then resume'}
                if self.s['t'] >= self.cfg.T:
                    write_json(self.meta / 'frozen_champion.json', self.r.frontier())
                    self.save(phase='heldout', heldout_index=0)
                else:
                    self.begin_round()
                continue
            elif phase == 'analysis':
                inc = self.r.incumbent_eval(self.r.frontier())
                prior = read(self.rd / 'prior.json')
                try:
                    report = self.replay('analyst', analyst.analyze, self.d,
                        read(self.rd / 'traces.json'), inc.per_task, self.rd,
                        prior_modes=prior.get('failure_modes'), prior_habits=prior.get('success_habits'),
                        model=self.cfg.analyst_model)
                except Pending as p:
                    ticket = p.ticket
                else:
                    write_json(self.rd / 'analysis_report.json', report)
                    write_json(self.r.global_analysis, {k: report.get(k) for k in ('failure_modes', 'success_habits')})
                    self.directives()
                    continue
            elif phase == 'candidate':
                if self.s['variant'] >= self.cfg.m:
                    self.save(phase='evaluate', variant=0)
                else:
                    self.vd.mkdir(exist_ok=True)
                    G.worktree_add(self.repo, self.wt, f'{self.d.name}/r{self.s["t"]}{self.vid}', self.r.branch)
                    self.save(phase='proposal')
                continue
            elif phase in ('proposal', 'critic'):
                try:
                    self.proposal() if phase == 'proposal' else self.review()
                except Pending as p:
                    ticket = p.ticket
                else:
                    continue
            elif phase == 'commit_candidate':
                prop = read(self.vd / 'proposal.json')
                # A previous process may have committed before saving the state.
                if G.is_clean(self.wt, self.r.harness_rel):
                    commit = G.head(self.wt)
                else:
                    commit = G.commit_path(self.wt, self.r.harness_rel, f'r{self.s["t"]}{self.vid}: {prop.get("mechanism")}')
                write_json(self.vd / 'prep.json', {'commit': commit,
                    'branch': f'{self.d.name}/r{self.s["t"]}{self.vid}', 'edits': prop['edits'],
                    'diff_path': str(self.vd / 'diff.patch')})
                self.save(phase='smoke')
                continue
            else:
                raise ValueError('unknown phase ' + phase)
            write_json(self.meta / 'pending.json', ticket)
            return ticket

    def execute(self, identity):
        ticket = self.next()
        if ticket.get('id') != identity or ticket.get('kind') != 'operation':
            raise ValueError('stale/non-operation ticket')
        self.verify_frozen()
        self._executing = identity
        phase = self.s['phase']
        if phase == 'baseline':
            # Reuse a complete, validated baseline receipt on crash/retry.
            ep = self.r.eval_path('base')
            self.r.ensure_branch()
            ev = EvalResult.load(ep) if ep.exists() else None
            if ev is None or ev.missing > self.cfg.invalid_missing_frac * ev.n_expected:
                wt = self.r.checkout('incumbent', self.r.branch)
                ev = evaluate(self.d, wt, self.r.runs, 'base', read(self.meta / 'split.json')['evolve'], self.cfg.k)
                ev.save(ep)
            if ev.missing > self.cfg.invalid_missing_frac * ev.n_expected:
                raise ValueError('baseline missing too many trials; repair infrastructure and rerun missing trials')
            commit = G.rev(self.repo, self.r.branch)
            inc = {'t': 0, 'commit': commit, 'harness_tree': self.r.harness_tree(commit),
                   'job': 'base', 'S': ev.S, 'C': ev.C, 'extra': ev.extra}
            write_json(self.r.frontier_path, {'domain': self.d.name, 'incumbent': inc,
                'S_star': ev.S, 'trajectory': [{k: inc[k] for k in ('t','S','C','commit','job')}],
                'config': self.cfg.dump()})
            jsonl(self.r.history.path, [{'t': 0, 'variant': '-', 'edit_id': None, 'component': None,
                'hypothesis': 'H_0 baseline', 'outcome': 'BASELINE', 'S': ev.S, 'C': ev.C,
                'accepted': True, 'delta_S': None, 'delta_C': None, 'bundle': 0}])
            self.r.calibrate(['base'])
            self.save(phase='begin')
        elif phase == 'smoke':
            dest = self.vd / 'smoke.json'
            if dest.exists():
                receipt = read(dest)
            else:
                inc = self.r.incumbent_eval(self.r.frontier())
                ok, detail = self.d.smoke(self.wt, self.r.runs, f'r{self.s["t"]}{self.vid}_smoke', self.d.smoke_ids(inc.per_task))
                receipt = {'ok': ok, **detail}
                write_json(dest, receipt)
            self.candidate_done(None if receipt['ok'] else 'smoke_fail', json.dumps(receipt)[:600])
        elif phase == 'evaluate':
            prep = read(self.vd / 'prep.json')
            if not prep.get('gate_failure'):
                c = Candidate(self.vid, prep['edits'], commit=prep.get('commit'), branch=prep.get('branch'))
                # Atomic benchmark operation only. The original retry/missing policy
                # is retained; no upstream research loop or search model is called.
                self.r._evaluate(self.s['t'], c, self.rd, read(self.meta / 'split.json')['evolve'])
                if c.gate_failure:
                    prep.update(gate_failure=c.gate_failure, detail=c.detail)
                    write_json(self.vd / 'prep.json', prep)
            v = self.s['variant'] + 1
            self.save(variant=v if v < self.cfg.m else 0,
                      phase='evaluate' if v < self.cfg.m else 'selection')
        elif phase == 'selection':
            self.select()
        elif phase == 'heldout':
            from heldout import execute_surface
            execute_surface(self)
        elif phase == 'export':
            self.export()
        else:
            raise ValueError('use configure --spec for setup')
        self.save()

    def select(self):
        transaction = self.rd / 'selection-transaction.json'
        if not transaction.exists():
            fr, t = self.r.frontier(), self.s['t']
            inc = self.r.incumbent_eval(fr)
            cs = []
            for vid in 'ABCDEFGH'[:self.cfg.m]:
                vd = self.rd / vid
                p = read(vd / 'prep.json')
                c = Candidate(vid, p['edits'], diff_path=p.get('diff_path'), branch=p.get('branch'),
                    commit=p.get('commit'), gate_failure=p.get('gate_failure'), detail=p.get('detail', ''))
                if not c.gate_failure and (vd / 'eval.json').exists():
                    c.ev = EvalResult.load(vd / 'eval.json')
                cs.append(c)
            winner, decisions = select_round(cs, inc, fr['S_star'], self.r.delta(), self.cfg,
                self.r.history.incumbent_component_counts(), guard_fn=self.d.guards)
            hp = self.rd / 'history-next.jsonl'
            jsonl(hp, self.r.history.records())
            history = History(hp)
            ap = self.rd / 'attribution-next.jsonl'
            ap.write_text(self.r.attribution_path.read_text() if self.r.attribution_path.exists() else '')
            old = self.r.attribution_path
            self.r.attribution_path = ap
            for c, dec in zip(cs, decisions):
                outcome = (c.gate_failure or 'not_evaluated') if c.ev is None else (
                    'ACCEPTED' if c is winner else ('LOST' if dec.admissible else 'REJECTED'))
                history.append_candidate(t, c.variant, c.edits, outcome, dec.delta_S, dec.delta_C,
                    c is winner, dec.S, dec.C, c.diff_path, dec.reason if c.ev else c.detail)
                if c.ev:
                    self.r.attribute(t, c.variant, c.edits, inc, c.ev)
            self.r.attribution_path = old
            if winner:
                ev = winner.ev
                fr['incumbent'] = {'t': t + 1, 'commit': winner.commit,
                    'harness_tree': self.r.harness_tree(winner.commit), 'job': ev.job,
                    'S': ev.S, 'C': ev.C, 'extra': ev.extra, 'variant': winner.variant}
                fr['S_star'] = max(fr['S_star'], ev.S)
            row = {k: fr['incumbent'][k] for k in ('S','C','commit','job')}
            fr['trajectory'].append({'t': t + 1, **row})
            write_json(transaction, {'frontier': fr, 'decisions': [d.to_json() for d in decisions],
                'history': history.records(), 'attribution': ap.read_text()})
        tx = read(transaction)
        G.fast_forward(self.repo, self.r.branch, tx['frontier']['incumbent']['commit'])
        write_json(self.rd / 'decisions.json', tx['decisions'])
        jsonl(self.r.history.path, tx['history'])
        self.r.attribution_path.write_text(tx['attribution'])
        write_json(self.r.frontier_path, tx['frontier'])
        self.save(t=self.s['t'] + 1, phase='begin', variant=0, attempt=0)

    def export(self):
        self.verify_frozen()
        fr = read(self.meta / 'frozen_champion.json')
        if fr != self.r.frontier() or self.s['t'] != self.cfg.T:
            raise ValueError('champion changed after heldout or horizon incomplete')
        from heldout import plan
        receipts = []
        for i, item in enumerate(plan(self)):
            rec = read(self.meta / 'heldout' / f'{i}.json')
            if rec['surface'] != item or rec['champion'] != fr['incumbent']['commit']:
                raise ValueError('heldout receipt mismatch')
            for f in rec['artifacts']:
                if sha(f['path']) != f['sha256']:
                    raise ValueError('heldout artifact changed')
            receipts.append(rec)
        evidence = []
        for p in sorted(self.r.runs.rglob('*')):
            if p.is_file() and 'wt' not in p.relative_to(self.r.runs).parts:
                evidence.append({'path': str(p), 'sha256': sha(p)})
        write_json(self.meta / 'report.json', {'method': 'RRSI', 'upstream': self.s['source'],
            'domain': self.d.name, 'config': self.cfg.dump(), 'environment': self.spec,
            'frontier': fr, 'heldout': receipts, 'evidence': evidence,
            'search_model_substitution': 'SCIENCEEVOLVE workflow agents (see workflow.json)',
            'status': 'measured; not a claim to reproduce published numeric gains'})
        self.save(phase='complete')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, default=Path.cwd())
    sub = p.add_subparsers(dest='cmd', required=True)
    q = sub.add_parser('init'); q.add_argument('--profile', choices=['eng','coding','workspace'], default='eng')
    sub.add_parser('next')
    q = sub.add_parser('configure'); q.add_argument('--spec', type=Path, required=True)
    q = sub.add_parser('submit'); q.add_argument('--id', required=True); q.add_argument('--response', type=Path, required=True)
    q = sub.add_parser('execute'); q.add_argument('--id', required=True)
    a = p.parse_args(); a.root = a.root.resolve()
    (a.root / '.rrsi').mkdir(parents=True, exist_ok=True)
    with (a.root / '.rrsi' / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if a.cmd == 'init':
            init(a.root, a.profile)
        run = Protocol(a.root)
        if a.cmd == 'configure':
            run.configure(read(a.spec)); run = Protocol(a.root)
        elif a.cmd == 'submit':
            ticket = run.next()
            if ticket.get('id') != a.id or ticket.get('kind') != 'model':
                raise ValueError('stale/non-model ticket')
            submit(ticket, a.response.read_text())
        elif a.cmd == 'execute':
            if a.id not in run.s['completed_operations']:
                run.execute(a.id)
        print(json.dumps(run.next(), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
