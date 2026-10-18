"""Offline protocol/algorithm tests. Synthetic fixtures are NOT research results."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILL = Path(__file__).resolve().parents[1] / 'rrsi/skills/scienceevolve-rrsi'
sys.path[:0] = [str(SKILL / 'scripts'), str(SKILL / 'upstream')]
import protocol as P
from roles import Replay, Pending, submit
from rrsi import analyst, critic
from rrsi.domain import Domain
from rrsi.evaluate import TaskResult, aggregate
from rrsi.selection import Candidate, select_round, cost_rule
from rrsi.config import RRSIConfig
from rrsi.history import History
from task_domain import TaskDomain


class Fixture:
    def __init__(self, root, T=2):
        self.root = root
        harness = root / 'original'
        harness.mkdir(); (harness / 'agent.py').write_text('VALUE = 0.5\n')
        runner = root / 'fixture_evaluator.py'
        # Explicit synthetic integration fixture with invocation counter.
        runner.write_text('''import json,sys,pathlib,runpy
r=json.load(open(sys.argv[1]));o=pathlib.Path(r['output_dir'])
f=o/'invocations';f.write_text(str(int(f.read_text())+1) if f.exists() else '1')
v=runpy.run_path(str(pathlib.Path(r['harness_dir'])/'agent.py'))['VALUE']
rows=[]
for tid in r['task_ids']:
 for n in range(r['k']):
  tr=o/f'{tid}-{n}.txt';tr.write_text('SYNTHETIC TEST FIXTURE trace')
  gr=o/f'{tid}-{n}-grader.txt';gr.write_text('SYNTHETIC TEST FIXTURE grader')
  rows.append(dict(task_id=tid,trial=n,reward=v,tokens=100,trace=str(tr),grader_evidence=str(gr),live=True))
(o/'trials.json').write_text(json.dumps(rows))
''')
        task = {'description':'Synthetic protocol test only', 'harness_source':str(harness),
                'evaluate_argv':[sys.executable,str(runner)],'evaluate_cwd':str(root),
                'evolve_ids':['a','b'],'heldout_ids':['c'],'smoke_ids':['a'],
                'constitution':'Generic harness; no benchmark specialization.',
                'patterns':'No hardcoded answers.', 'policy_model':'fixture-not-a-model',
                'component_signals':[['config',[r'VALUE']]]}
        self.spec = {'environment':{},'task':task,'policy_model':task['policy_model'],
            'substitutions':['SYNTHETIC OFFLINE TEST ONLY'],
            'frozen_files':[{'path':str(runner),'sha256':P.sha(runner)}],
            'heldout':[{'name':'test','ids':['c'],'k':1}],
            'parameters':{'T':T,'k':2,'m':2,'w':1,'delta':0.01,'n_fail_traces':1,'n_success_traces':1}}
        P.init(root, 'eng')
        P.Protocol(root).configure(self.spec)
        self.run = P.Protocol(root)

    def next(self):
        self.run = P.Protocol(self.root)
        return self.run.next()

    def execute(self, ticket):
        self.run.execute(ticket['id'])

    def reply(self, ticket, data):
        submit(ticket, json.dumps(data))


def model_answer(f, ticket):
    role = ticket['role']
    if role == 'analyst':
        return {'action':'report','failure_modes':[], 'capability_gaps':[], 'success_habits':[]}
    if role == 'critic':
        return {'verdict':'accept','reasons':[], 'risk_notes':[]}
    if role == 'proposer':
        if ticket['payload']['turn'] == 0:
            old = (f.run.d.harness_dir(f.run.wt) / 'agent.py').read_text()
            # Both candidates independently see the same incumbent.
            new = 'VALUE = ' + str(.7 if f.run.vid == 'A' else .6) + '\n'
            if old == new:
                new = old.replace('0.7','0.8')
            return {'action':'edit_file','path':'agent.py','old':old,'new':new}
        return {'action':'done','mechanism':'fixture','edits':[{
            'id':'E1','component':'config','hypothesis':'fixture','targets_mode':'fixture',
            'predicted_affected':['a'],'retroactive_check':'compare frozen receipts'}]}
    raise AssertionError(role)


class RRSITests(unittest.TestCase):
    def test_source_integrity(self):
        P.verify_vendor()

    def test_complete_run_and_resume_do_not_repeat_measurements(self):
        with tempfile.TemporaryDirectory() as td:
            f = Fixture(Path(td))
            original_prompts = {}
            for _ in range(150):
                ticket = f.next()
                if ticket.get('terminal') == 'complete':
                    break
                if ticket['kind'] == 'model':
                    # Re-entering next without submit yields identical ticket.
                    self.assertEqual(ticket['id'], f.next()['id'])
                    if ticket['role'] == 'proposer' and ticket['payload']['turn'] == 0:
                        original_prompts[(f.run.s['t'],f.run.vid)] = (f.run.d.harness_dir(f.run.wt)/'agent.py').read_text()
                    f.reply(ticket, model_answer(f,ticket))
                else:
                    f.execute(ticket)
                    self.assertIn(ticket['id'], P.Protocol(Path(td)).s['completed_operations'])
            else:
                self.fail('protocol failed to terminate')
            report = P.read(Path(td)/'.rrsi/report.json')
            self.assertEqual(len(report['frontier']['trajectory']), 3)
            self.assertEqual(report['frontier']['incumbent']['S'], .8)
            self.assertEqual(len(report['heldout']), 2)
            self.assertEqual(original_prompts[(0,'A')], original_prompts[(0,'B')])
            for counter in (Path(td)/'rrsi-runs').rglob('invocations'):
                self.assertEqual(counter.read_text(), '1', str(counter))
            h = History(Path(td)/'rrsi-runs/research/history.jsonl').records()
            self.assertEqual([r['outcome'] for r in h if r.get('edit_id')], ['ACCEPTED','LOST','ACCEPTED','REJECTED'])

    def test_proposal_replay_restores_attempt_start(self):
        with tempfile.TemporaryDirectory() as td:
            f=Fixture(Path(td),1)
            t=f.next();f.execute(t)
            t=f.next();f.reply(t,model_answer(f,t))
            t=f.next();f.reply(t,model_answer(f,t))
            a=f.next(); source=(f.run.d.harness_dir(f.run.wt)/'agent.py').read_text()
            b=f.next()
            self.assertEqual(a['id'],b['id'])
            self.assertEqual(source,(f.run.d.harness_dir(f.run.wt)/'agent.py').read_text())
            self.assertIn('0.7',source)

    def test_repair_bound_is_five(self):
        with tempfile.TemporaryDirectory() as td:
            f=Fixture(Path(td),1)
            # 6 reviews total: initial + 5 repaired candidates.
            seen=[]
            for _ in range(100):
                t=f.next()
                if f.run.s['variant'] == 1: break
                if t['kind']=='operation':f.execute(t);continue
                if t['role']=='critic':
                    seen.append(f.run.s['attempt']);f.reply(t,{'verdict':'reject','reasons':['fixture reject']})
                elif t['role']=='proposer':
                    if t['payload']['turn']==0:
                        old=(f.run.d.harness_dir(f.run.wt)/'agent.py').read_text()
                        f.reply(t,{'action':'edit_file','path':'agent.py','old':old,'new':old+'# repaired\n'})
                    else:f.reply(t,model_answer(f,t))
                else:f.reply(t,model_answer(f,t))
            self.assertEqual(seen,list(range(6)))
            p=P.read(Path(td)/'rrsi-runs/research/r0/A/prep.json')
            self.assertEqual(p['gate_failure'],'critic_reject')
            self.assertFalse((Path(td)/'rrsi-runs/research/jobs/r0A').exists())

    def test_selection_strict_boundaries_and_historical_floor(self):
        cfg=RRSIConfig(w_s=0,w_c=15,w_n=.5)
        self.assertFalse(cost_rule(0,0,0,.01,cfg)[0])
        self.assertTrue(cost_rule(0,0,1,.01,cfg)[0])
        inc=aggregate('inc',1,{'x':TaskResult([.8],tokens=[100])})
        ev=aggregate('new',1,{'x':TaskResult([.79],tokens=[10])})
        c=Candidate('A',[{'component':'skill'}],ev)
        winner,_=select_round([c],inc,.85,.02,cfg,{})
        self.assertIsNone(winner)
        winner,_=select_round([c],inc,.8,.02,cfg,{})
        self.assertIs(winner,c) # no invented monotonic-improvement condition

    def test_independent_digester_scopes_and_batch_barrier(self):
        class D(Domain):
            briefs={'analyst':'task','digester':'task'}
            def render_trace(self,r,detail=False):return r
            def task_row(self,task_id,r,tr):return task_id
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);d=D();roles=[]
            acts=[{'action':'digest_many','requests':[{'task_id':'a','lens':'failure'},
                {'task_id':'a','lens':'capability_gap'},{'task_id':'b','lens':'success'}]},
                *[{'action':'return','digest':{'summary':'fixture'}}]*3,
                {'action':'report','failure_modes':[],'capability_gaps':[],'success_habits':[]}]
            def run():
                return Replay(root/'calls','scope').run('analyst',analyst.analyze,d,
                    {'a':'failed','b':'passed'},{'a':TaskResult([0]),'b':TaskResult([1])},root/'round')
            for act in acts:
                with self.assertRaises(Pending) as ctx:run()
                t=ctx.exception.ticket;roles.append(t['role']);submit(t,json.dumps(act))
            self.assertEqual(roles,['analyst','digester','digester','digester','analyst'])
            self.assertEqual(run()['n_digests'],3)

    def test_raw_response_is_immutable_and_context_checked(self):
        with tempfile.TemporaryDirectory() as td:
            replay=Replay(td,'scope')
            with self.assertRaises(Pending) as ctx:replay.generate('critic')('prompt')
            t=ctx.exception.ticket;submit(t,'not json')
            with self.assertRaises(ValueError):submit(t,'different')
            with self.assertRaises(RuntimeError):Replay(td,'scope').generate('critic')('changed')
            self.assertEqual(Replay(td,'scope').generate('critic')('prompt'),'not json')

    def test_frozen_evaluator_and_split_are_enforced(self):
        with tempfile.TemporaryDirectory() as td:
            f=Fixture(Path(td),1)
            (Path(td)/'fixture_evaluator.py').write_text('# changed')
            with self.assertRaises(ValueError):f.execute(f.next())

    def test_missing_trials_preserve_weighted_denominator(self):
        with tempfile.TemporaryDirectory() as td:
            f=Fixture(Path(td),1);t=f.next();f.execute(t)
            job=f.run.r.runs/'jobs/base/trials.json';rows=P.read(job)
            job.write_text(json.dumps([r for r in rows if r['task_id']=='a']))
            f.run.d.spec['weights']={'a':1,'b':3}
            per,extra=f.run.d.score(f.run.r.runs,'base',['a','b'],2)
            ev=aggregate('base',2,per,extra)
            self.assertEqual(ev.S,.125)
            self.assertEqual(ev.missing,2)

    def test_selection_transaction_recovers_after_git_and_history_write(self):
        with tempfile.TemporaryDirectory() as td:
            f=Fixture(Path(td),1)
            for _ in range(60):
                t=f.next()
                if t['role']=='selector':break
                if t['kind']=='model':f.reply(t,model_answer(f,t))
                else:f.execute(t)
            else:self.fail('selector not reached')
            with patch.object(f.run, 'save', side_effect=RuntimeError('simulated crash before checkpoint')):
                with self.assertRaises(RuntimeError):f.execute(t)
            history=f.run.r.history.path.read_text()
            frontier=f.run.r.frontier()
            f.run=P.Protocol(Path(td))
            f.execute(f.next())
            self.assertEqual(history,f.run.r.history.path.read_text())
            self.assertEqual(frontier,f.run.r.frontier())
            self.assertEqual(f.run.s['t'],1)

    def test_invalid_candidate_retries_exactly_once_and_is_not_selected(self):
        with tempfile.TemporaryDirectory() as td:
            f=Fixture(Path(td),1)
            for _ in range(60):
                t=f.next()
                if t['kind']=='operation' and t['payload']['name']=='evaluate':break
                if t['kind']=='model':f.reply(t,model_answer(f,t))
                else:f.execute(t)
            else:self.fail('candidate evaluation not reached')
            ev=aggregate('invalid',2,{'a':TaskResult([0,0],missing=2),'b':TaskResult([0,0],missing=2)})
            with patch('rrsi.loop.evaluate',return_value=ev) as measure:
                f.execute(t)
                self.assertEqual(measure.call_count,2)
            prep=P.read(Path(td)/'rrsi-runs/research/r0/A/prep.json')
            self.assertEqual(prep['gate_failure'],'eval_invalid')
            self.assertFalse((Path(td)/'rrsi-runs/research/r0/A/eval.json').exists())

    def test_task_configuration_cannot_change_after_baseline_freeze(self):
        with tempfile.TemporaryDirectory() as td:
            f=Fixture(Path(td),1)
            config=Path(td)/'.rrsi/environment.json'
            data=P.read(config);data['task']['policy_model']='different'
            config.write_text(json.dumps(data))
            with self.assertRaises(ValueError):P.Protocol(Path(td))

    def test_critic_deterministic_leak_reject_never_calls_model(self):
        class D(Domain):
            briefs={'critic':'frozen task'}
            critic_patterns=[('SECRET_TASK_ANSWER','leak')]
        with tempfile.TemporaryDirectory() as td:
            result=Replay(td,'critic').run('critic',critic.review,D(),'+SECRET_TASK_ANSWER','x','x')
            self.assertEqual(result['verdict'],'reject')
            self.assertEqual(list(Path(td).rglob('*.json')),[])

if __name__=='__main__':unittest.main()
