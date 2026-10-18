"""Real local execution and original helper contracts; no scientific LLM claim."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/scienceevolve-drugevolve/scripts/steps.py'
class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='scienceevolve-drugevolve-test-')
        self.root = Path(self.temp.name)
        self.run_dir = self.root / 'run'
        self.code = self.root / 'task'
        self.code.mkdir()
        (self.code / 'run.sh').write_text('export MODEL_PATH="/placeholder/model.py"\n' + f'"{sys.executable}" "$MODEL_PATH"\n')
        spec = dict(objective='Deterministic integration fixture, not drug discovery evidence',
                    evaluation=dict(command='bash task/run.sh', core_score='accuracy', direction='maximize', timeout_secs=20, success_criteria=['real CSV']),
                    budget=dict(max_rounds=2, patience=0, max_consecutive_failures=2), stop_conditions=['two rounds'],
                    mutation_scope=dict(writable_paths=['task/algorithm'], primary_targets=['task/algorithm/model.py']),
                    sampling=dict(algorithm='ucb1'), cognition=dict(source_mode='none'), confirmed=True)
        # JSON is valid YAML, avoiding a test-only YAML serialization dependency.
        (self.root / 'run_spec.yaml').write_text(json.dumps(spec))
        config = dict(workspace=str(self.root), code_dir='task', source_file='task/run.sh', run_spec='run_spec.yaml', baseline_content='Fixture baseline accuracy 0.5', settings={'DRUGEVOLVE_TRAINING_TIMEOUT': 10})
        (self.root / 'config.json').write_text(json.dumps(config))
        self.call('init', str(self.root / 'config.json'))

    def tearDown(self):
        self.temp.cleanup()

    def call(self, *args):
        command = [sys.executable, str(SCRIPT), '--run-dir', str(self.run_dir), *args]
        result = subprocess.run(command, text=True, capture_output=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def submit(self, role, payload):
        prompt = self.call('prompt')
        self.assertEqual(prompt['role'], role)
        self.assertTrue(prompt['instructions'])
        self.assertIn('properties', prompt['output_schema'])
        self.assertTrue(prompt['input'])
        output = self.root / 'response.json'
        output.write_text(json.dumps(payload))
        return self.call('submit', str(output), '--request-id', prompt['request_id'])

    def propose(self, name):
        return self.submit('generator', dict(name=name, motivation='Fixture mechanism', explain='Fixture normalized accuracy', math='accuracy = correct / total'))

    def test_complete_round_debug_and_retrieval(self):
        self.assertEqual(self.call('advance')['phase'], 'generator')
        self.propose('fixture_candidate')
        self.submit('inspector', dict(is_repeated=False, repeated_index=[], reasoning='Fixture new mechanism'))
        model = self.code / 'algorithm/fixture_candidate/model.py'
        model.write_text('raise RuntimeError("Intentional training failure")\n')
        self.submit('implementer', dict(success=True, summary='Wrote fixture'))
        failed = self.call('advance')
        self.assertEqual(failed['phase'], 'debugger')
        self.assertEqual(failed['train_attempt'], 1)
        model.write_text('from pathlib import Path\nPath("default_test.csv").write_text("step,accuracy\\n1,0.8\\n")\n')
        self.submit('debugger', dict(changes_made=True, diagnosis='Fixture repaired', patch_or_file=model.read_text()))
        trained = self.call('advance')
        self.assertEqual(trained['phase'], 'judger')
        self.assertEqual(trained['candidate']['objective'], 8.0)
        self.submit('judger', dict(algorithm_score=7, final_score=6, complexity=2, reasoning='Fixture only'))
        self.submit('analyzer', dict(get_expectation=True, better_than_baseline=True, component_comparison_analysis='Fixture actual accuracy 0.8', related_element_analysis='Initial round', existing_problems='No science claim', case_assessment='No cases'))
        self.submit('summarizer', dict(summary='Fixture: validated local training and CSV parsing.'))
        archived = self.call('advance')
        self.assertEqual(archived['phase'], 'sample')
        self.assertEqual(archived['candidate']['score'], 8.0)  # LLM default weight 0
        self.assertTrue((self.run_dir / 'best/best.json').is_file())
        self.assertTrue((self.run_dir / 'scienceevolve-rounds/0001.json').is_file())
        sampled = self.call('advance')
        self.assertEqual(sampled['parent'], archived['candidate']['node_id'])
        self.assertIn('Parent Element', sampled['context'])
        self.assertIn('Fixture: validated', sampled['context'])
        self.propose('fixture_second')
        repeated = self.submit('inspector', dict(is_repeated=True, repeated_index=[sampled['parent']], reasoning='Same mechanism'))
        self.assertEqual(repeated['creation_attempt'], 2)
        self.assertEqual(repeated['phase'], 'generator')
        self.assertIn('REPEATED', self.call('prompt')['input'])

    def test_entropy_abort_is_scored_and_not_debugged(self):
        self.call('advance')
        self.propose('entropy_candidate')
        self.submit('inspector', dict(is_repeated=False, repeated_index=[], reasoning='Fixture'))
        model = self.code / 'algorithm/entropy_candidate/model.py'
        model.write_text('import os,time\nfrom pathlib import Path\nPath(os.environ["DRUGEVOLVE_CURRENT_LOG"]).write_text("step,entropy\\n1,3.5\\n")\ntime.sleep(30)\n')
        self.submit('implementer', dict(success=True, summary='Entropy fixture'))
        state = self.call('advance')
        self.assertEqual(state['phase'], 'judger')
        self.assertTrue(state['candidate']['entropy_abort'])
        self.assertEqual(state['candidate']['objective'], 0.0)
        self.assertIn('crashed', state['candidate']['result']['test'])
        self.assertEqual(state['train_attempt'], 1)

    def test_nested_creation_budget_and_stale_submission(self):
        state = self.call('advance')
        stale = state['request_id']
        for attempt in range(9):
            state = self.call('fail', 'Synthetic role failure', '--request-id', state['request_id'])
        self.assertEqual(state['phase'], 'sample')
        self.assertEqual(state['consecutive_failures'], 0)  # [SKIP], upstream outer counter
        record = json.loads((self.run_dir / 'scienceevolve-rounds/0001.json').read_text())
        self.assertTrue(record['skipped'])
        self.assertEqual(record['research_attempt'], 4)
        result = subprocess.run([sys.executable, str(SCRIPT), '--run-dir', str(self.run_dir), 'fail', 'stale', '--request-id', stale], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Stale request ID', result.stderr)
        state = self.call('advance')
        for attempt in range(9):
            state = self.call('fail', 'Synthetic role failure', '--request-id', state['request_id'])
        self.assertEqual(state['phase'], 'finished')
        self.assertEqual(state['stop_reason'], 'max_rounds')

if __name__ == '__main__':
    unittest.main()
