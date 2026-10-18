"""Offline protocol tests: real local algorithms/files/Git, no scientific claims."""
import ast
from datetime import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

EXAMPLES = Path(__file__).resolve().parents[1]


def module(method, script):
    path=EXAMPLES/method/'skills'/('scienceevolve-'+method)/'scripts'/script
    spec=importlib.util.spec_from_file_location(method.replace('-','_')+'_'+path.stem,path)
    mod=importlib.util.module_from_spec(spec);sys.modules[spec.name]=mod;spec.loader.exec_module(mod)
    return mod


class SourceIntegrity(unittest.TestCase):
    def test_all_vendored_sources_match_pins(self):
        manifests=list(EXAMPLES.glob('*/skills/*/UPSTREAM.json'))+list(EXAMPLES.glob('*/skills/*/INTEGRITY_UPSTREAM.json'))
        expected_methods = {
            'aris', 'metaharness', 'funsearch', 'agent-laboratory', 'sciagents',
            'robin', 'biomni', 'agentrxiv', 'scientist-two', 'rrsi', 'drugevolve',
        }
        self.assertEqual({p.relative_to(EXAMPLES).parts[0] for p in manifests}, expected_methods)
        self.assertEqual(len(manifests), len(expected_methods) + 1)  # ARIS also pins integrity sources.
        for p in manifests:
            data=json.loads(p.read_text())
            if 'commit' in data:
                self.assertRegex(data['commit'],r'^[0-9a-f]{40}$')
            else:
                # ScientistTwo pins both versioned papers and dependency code.
                self.assertEqual(p.relative_to(EXAMPLES).parts[0], 'scientist-two')
                self.assertEqual({s['name'] for s in data['sources']}, {'ScientistTwo', 'PaperOrchestra', 'ScholarPeer'})
                for source in data['sources']:
                    if 'commit' in source:
                        self.assertRegex(source['commit'], r'^[0-9a-f]{40}$')
                    else:
                        self.assertRegex(source['url'], r'arxiv.org/html/\d{4}\.\d+v\d+$')
            for entry in data['files']:
                path=p.parent/entry['path']
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),entry['sha256'],str(path))


class ReviewBridge(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.m=module('aris','review_bridge.py')
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.workflow=EXAMPLES/'aris/workflow.json'
        (self.root/'paper.txt').write_text('actual current artifact')
        (self.root/'prompt.txt').write_text('review all evidence')
    def request(self):
        return self.m.request(self.root,self.workflow,'research_loop','research_loop','prompt.txt',['paper.txt'],'W2 decision')
    def test_cross_family_required(self):
        w=json.loads(self.workflow.read_text());w['agents']['reviewer']['model']=w['agents']['research_loop']['model']
        p=self.root/'workflow.json';p.write_text(json.dumps(w))
        with self.assertRaises(ValueError):self.m.request(self.root,p,'research_loop','research_loop','prompt.txt',['paper.txt'],'continue')
    def test_high_score_not_ready_cannot_stop_and_preserves_raw(self):
        req=self.request();raw='Evidence review.\nScore: 9/10\nVerdict: not ready\n'
        (self.root/'response.txt').write_text(raw)
        receipt=self.m.record(self.root,req['id'],'reviewer','response.txt')
        self.assertEqual(receipt['decision'],'continue')
        self.assertEqual(self.m.consume(self.root,req['id'])['response'],raw)
    def test_real_gate_positive_threshold(self):
        req=self.request();(self.root/'response.txt').write_text('Score: 6/10\nVerdict: almost\n')
        receipt=self.m.record(self.root,req['id'],'reviewer','response.txt')
        self.assertEqual(receipt['decision'],'stop')
    def test_stale_material_cannot_be_consumed(self):
        req=self.request();(self.root/'response.txt').write_text('Score: 8/10\nVerdict: ready\n')
        self.m.record(self.root,req['id'],'reviewer','response.txt')
        (self.root/'paper.txt').write_text('changed after review')
        with self.assertRaises(ValueError):self.m.consume(self.root,req['id'])
    def test_wrong_reviewer_and_invalid_id_rejected(self):
        req=self.request();(self.root/'response.txt').write_text('Score: 8/10\nVerdict: ready\n')
        with self.assertRaises(ValueError):self.m.record(self.root,req['id'],'research_loop','response.txt')
        with self.assertRaises(ValueError):self.m.consume(self.root,'../elsewhere')


class ReadonlyAudit(unittest.TestCase):
    def test_integrity_pin_and_readonly_cannot_be_downgraded(self):
        m=module('aris','readonly_review.py')
        args,meta=m.command('codex','integrity',Path('/tmp'),Path('/tmp/response'))
        self.assertEqual(meta['model'],'gpt-5.6-sol');self.assertEqual(meta['reasoning'],'xhigh')
        self.assertIn('sandbox_mode="read-only"',args);self.assertIn('approval_policy="never"',args)
        with self.assertRaises(ValueError):m.command('codex','integrity',Path('/tmp'),Path('/tmp/r'),resume='old')
        with self.assertRaises(ValueError):m.command('codex','integrity',Path('/tmp'),Path('/tmp/r'),fallback='gpt-5.5')
    def test_proof_preserves_effort_and_continuation(self):
        m=module('aris','readonly_review.py')
        args,meta=m.command('codex','proof',Path('/tmp'),Path('/tmp/r'),resume='proof-thread')
        self.assertEqual(meta['reasoning'],'ultra');self.assertEqual(args[2:4],['resume','proof-thread'])
        _,meta=m.command('codex','proof',Path('/tmp'),Path('/tmp/r'),fallback='gpt-6-astra')
        self.assertEqual(meta['reasoning'],'xhigh')


class FunSearch(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.m=module('funsearch','runtime.py')
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.state=self.root/'run/state.pkl'
        (self.root/'spec.py').write_text('@funsearch.evolve\ndef priority(x):\n    return x\n\n@funsearch.run\ndef evaluate(x):\n    return priority(x)\n')
        (self.root/'inputs.json').write_text('[1, 1, 2]')
        # Only known toy code is executed in this test. This is not a production sandbox.
        (self.root/'sandbox.py').write_text('''from pathlib import Path
from types import SimpleNamespace
class Backend:
 def run(self, program, function_to_run, test_input, timeout_seconds):
  with Path(__file__).with_name('calls.txt').open('a') as f: f.write('call\\n')
  scope={'funsearch':SimpleNamespace(run=lambda f:f,evolve=lambda f:f)};exec(program,scope)
  try: return scope[function_to_run](test_input),True
  except Exception: return None,False
def create_sandbox():return Backend()
''')
        self.m.initialize(self.state,self.root/'spec.py',self.root/'inputs.json',self.root/'sandbox.py')
    def calls(self): return len((self.root/'calls.txt').read_text().splitlines())
    def test_original_defaults_and_duplicate_input_execution(self):
        manifest=json.loads((self.state.parent/'manifest.json').read_text())
        self.assertEqual(manifest['config']['programs_database']['num_islands'],10)
        self.assertEqual(manifest['config']['samples_per_prompt'],4)
        self.assertEqual(self.calls(),3)
        self.assertTrue(all(i['score']==2 for i in self.m.export(self.state)['islands']))
    def test_prompt_is_exact_upstream_algorithm_with_saved_rng(self):
        state=self.m.load(self.state)
        expected=state['database'].get_prompt()
        actual=self.m.prompt(self.state)
        self.assertEqual((actual['code'],actual['island_id'],actual['version_generated']),
                         (expected.code,expected.island_id,expected.version_generated))
        self.assertEqual(actual,self.m.prompt(self.state))
    def test_four_samples_then_advance_and_idempotent_retry(self):
        p=self.m.prompt(self.state);sample=self.root/'sample.txt';sample.write_text('    return x + 7\n')
        with self.assertRaises(ValueError):self.m.evaluate(self.state,sample,1,p['id'])
        for index in range(4):
            result=self.m.evaluate(self.state,sample,index,p['id'])
            self.assertEqual(result['prompt_complete'],index==3)
        self.assertEqual(self.calls(),15)
        self.assertEqual(self.m.evaluate(self.state,sample,3,p['id'])['status'],'already_evaluated')
        self.assertEqual(self.calls(),15)
        self.assertEqual(self.m.prompt(self.state)['id'],1)
        self.assertTrue(any(i['score']==9 for i in self.m.export(self.state)['islands']))
    def test_original_rejects_ancestor_calls(self):
        p=self.m.prompt(self.state);sample=self.root/'bad.txt';sample.write_text('    return priority_v999(x)\n')
        self.m.evaluate(self.state,sample,0,p['id'])
        self.assertEqual(self.calls(),6)
        self.assertTrue(all(i['score']==2 for i in self.m.export(self.state)['islands']))
    def test_original_weak_half_reset(self):
        state=self.m.load(self.state);db=state['database'];program=state['template'].get_function(state['evolve'])
        for i in range(10): db.register_program(program,i,{1:float(10+i),2:float(10+i)})
        old=list(db._islands);db.reset_islands()
        self.assertTrue(all(db._islands[i] is not old[i] for i in range(5)))
        self.assertTrue(all(db._islands[i] is old[i] for i in range(5,10)))
        self.assertTrue(all(s>=15 for s in db._best_score_per_island))
    def test_frozen_backend_cannot_change(self):
        with (self.root/'sandbox.py').open('a') as f:f.write('\n# changed')
        with self.assertRaises(ValueError):self.m.prompt(self.state)


class GitTrials(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.m=module('autoresearch','finish_trial.py')
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.git('init','-q');self.git('config','user.email','test@example.invalid');self.git('config','user.name','Protocol Test')
        (self.root/'train.py').write_text('baseline');(self.root/'prepare.py').write_text('fixed evaluator')
        self.git('add','.');self.git('commit','-qm','baseline');self.parent=self.git('rev-parse','HEAD')
        self.git('checkout','-qb','autoresearch/test');(self.root/'train.py').write_text('candidate')
        self.git('add','train.py');self.git('commit','-qm','candidate');self.candidate=self.git('rev-parse','HEAD')
    def git(self,*args):return self.m.git(self.root,*args)
    def finish(self,status):return self.m.finish(self.root,self.candidate,self.parent,status,1.4,2048,'actual toy decision')
    def test_discard_restores_head_and_train_but_keeps_records(self):
        self.finish('discard');self.assertEqual(self.git('rev-parse','HEAD'),self.parent)
        self.assertEqual((self.root/'train.py').read_text(),'baseline')
        self.assertEqual((self.root/'prepare.py').read_text(),'fixed evaluator')
        self.assertIn('\t1.400000\t2.0\tdiscard\t',(self.root/'results.tsv').read_text())
        self.finish('discard');self.assertEqual(len((self.root/'results.tsv').read_text().splitlines()),2)
    def test_keep_and_crash_log_semantics(self):
        self.finish('keep');self.assertEqual(self.git('rev-parse','HEAD'),self.candidate)
        with self.assertRaises(ValueError):self.finish('crash')
    def test_crash_zero_sentinel_and_git_restore(self):
        self.finish('crash');self.assertIn('\t0.000000\t0.0\tcrash\t',(self.root/'results.tsv').read_text())
        self.assertEqual(self.git('rev-parse','HEAD'),self.parent)
    def test_uncommitted_user_change_prevents_rollback(self):
        (self.root/'prepare.py').write_text('user change')
        with self.assertRaises(ValueError):self.finish('discard')
        self.assertEqual((self.root/'prepare.py').read_text(),'user change')
    def test_committed_evaluator_change_prevents_acceptance(self):
        (self.root/'prepare.py').write_text('tampered');self.git('add','.');self.git('commit','-qm','bad')
        self.candidate=self.git('rev-parse','HEAD')
        with self.assertRaises(ValueError):self.finish('keep')


class LabScore(unittest.TestCase):
    def test_actual_upstream_formula(self):
        m=module('agent-laboratory','paper_score.py')
        review=dict(Overall=10,Soundness=4,Confidence=5,Contribution=4,Presentation=4,Clarity=4,Originality=4,Quality=4,Significance=4)
        self.assertAlmostEqual(m.score(json.dumps(review))['score'],10)
        review['Overall']=5
        self.assertAlmostEqual(m.score(json.dumps(review))['score'],10*(2.2-.5)/2.2)
        with self.assertRaises(ValueError):m.score('{}')


class RobinAnalysis(unittest.TestCase):
    def test_five_trajectories_and_consensus_barrier(self):
        m=module('robin','analysis_step.py')
        prompts=SimpleNamespace(analysis_queries={'flow_cytometry':'gating'},consensus_queries={'flow_cytometry':'consensus'},cot='original',guideline='guideline')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);spec=m.plan('analysis','flow_cytometry',tmp,tmp,prompts)
            self.assertEqual(spec['parallel'],5);self.assertEqual(spec['config'],dict(language='R',max_steps=30,timeout=900))
            paths=[]
            for i in range(5):
                p=root/'flow_results'/f'flow_results_{i}.csv';p.parent.mkdir(exist_ok=True);p.write_text('drug,result\nA,1\n');paths.append(p)
            receipt=dict(phase='analysis',kind='flow_cytometry',directory=tmp,task_ids=list('abcde'),files={str(p):m.digest(p) for p in paths})
            p=root/'analysis.json';p.write_text(json.dumps(receipt))
            self.assertEqual(m.plan('consensus','flow_cytometry',None,tmp,prompts,p)['parallel'],1)
            receipt['task_ids']=list('abcd');p.write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):m.plan('consensus','flow_cytometry',None,tmp,prompts,p)
            receipt['task_ids']=list('abcde');p.write_text(json.dumps(receipt));paths[0].write_text('changed')
            with self.assertRaises(ValueError):m.plan('consensus','flow_cytometry',None,tmp,prompts,p)


class MetaFinalize(unittest.TestCase):
    def test_original_union_and_incomplete_test_cannot_finalize(self):
        src=EXAMPLES/'metaharness/skills/scienceevolve-metaharness/upstream/meta_harness.py'
        tree=ast.parse(src.read_text());func=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='finalize_run')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);frontier=root/'frontier.json';final=root/'final.json'
            frontier.write_text(json.dumps({'_pareto':[{'system':'pareto'}],'dataset':{'best_system':'specialist'}}))
            called=[]
            def run(args):called.append(args);return SimpleNamespace(stdout='',returncode=0)
            env=dict(json=json,datetime=datetime,FRONTIER_VAL=frontier,FINALIZED=final,LOGS_DIR=root,RESULTS_DIR=root,
                     run_benchmark=run,load_results=lambda *a:{},_ts=lambda:'',_bold=str,_red=str)
            exec(compile(ast.Module(body=[func],type_ignores=[]),str(src),'exec'),env)
            with self.assertRaises(SystemExit):env['finalize_run'](['baseline'],['dataset'],'model')
            self.assertEqual(json.loads(final.read_text())['status'],'in_progress')
            self.assertEqual(json.loads(final.read_text())['systems'],['baseline','pareto','specialist'])
            env['load_results']=lambda *a:{('model','dataset',s):{} for s in ['baseline','pareto','specialist']}
            env['finalize_run'](['baseline'],['dataset'],'model')
            self.assertEqual(json.loads(final.read_text())['status'],'complete')

if __name__=='__main__':unittest.main()
