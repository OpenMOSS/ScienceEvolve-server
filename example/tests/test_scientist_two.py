"""Offline control fixtures, NEVER evidence of real scientific execution."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1] / 'scientist-two/skills/scienceevolve-scientist-two'
spec = importlib.util.spec_from_file_location('scientist_two_protocol', SKILL / 'scripts/protocol.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def response(s, **overrides):
    """Syntactically valid, explicitly synthetic responses for pure transitions."""
    role, ticket = s['role'], s['seq']
    base = f'fixture/{ticket}'
    r = dict(ticket=ticket, role=role, status='ok', summary='OFFLINE TEST FIXTURE',
             artifacts=[base + '/evidence.txt'])
    for k in p.FIELDS[role]:
        r[k] = base + '/' + k
    if role in p.CODERS:
        r['artifacts'] += [r[k] for k in ['code', 'results', 'logs', 'commands']]
    if role in p.PAPER:
        r['artifacts'] += [r[k] for k in ['tex', 'pdf', 'compile_log', 'screenshots']]
    if role == 'score_reproduce':
        r['artifacts'] += [r[k] for k in ['results', 'logs', 'commands']]
    if role == 'export':
        r['artifacts'].append(r['bundle'])
    if role == 'task_setup':
        r['task'] = {k: 'FIXTURE' for k in ['problem', 'baseline', 'subset', 'full_benchmark',
                     'metrics', 'human_sota', 'constraints', 'resources', 'search', 'cutoff', 'novelty_rubric']}
    elif role == 'limitation_extract':
        r['limitations'] = s.get('limitations', []) + [f'limitation-{ticket}']
    elif role == 'seed_generate':
        r['idea'] = dict(id=f'seed-{len(s["seeds"])}', hypothesis='fixture hypothesis')
    elif role == 'novelty_check':
        r.update(score=len(s['seeds']), references=[
            dict(url='https://example.invalid/' + str(i), retrieval_evidence=r['artifacts'][0]) for i in range(2)])
    elif role == 'idea_evolve':
        r['ideas'] = [dict(id=f'evolved-{ticket}-{i}', hypothesis='fixture hypothesis')
                      for i in range(s['config']['evolved_per_round'])]
    elif role == 'selector':
        r['candidate'] = s['good'][0]
    elif role.endswith('_plan'):
        r['plans'] = [dict(id=f'plan-{i}', command='fixture only') for i in range(3)]
    elif role.endswith('_questions'):
        r['questions'] = [dict(id=f'question-{i}', text='fixture?') for i in range(s['config'][role])]
    elif role == 'draft_quality':
        r['metrics'] = dict.fromkeys(p.REVIEW_LIMITS, 3) | dict(Overall=6, Confidence=4)
    if role in {'draft_quality', 'draft_quality_merge'}:
        r['review'] = dict(Summary='fixture', Strengths=[], Weaknesses=[], Questions=[],
                           Limitations=[], Decision='Accept', **{'Ethical Concerns': False})
    elif role == 'peer_review':
        r.update(score=8, review=dict(summary='fixture', strengths=[], weaknesses=[], questions=[],
                                      confidence=4, rationale='OFFLINE FIXTURE'))
    if role in p.DECISIONS:
        r['decision'] = {'limitation_verify': 'Sufficient', 'subset_critic': 'Good',
                         'full_critic': 'Good', 'ablation_critic': 'Good',
                         'result_comparison': 'NotBetter', 'format_review': 'Clean',
                         'meta_review': 'Accept'}.get(role, 'Pass')
    r.update(overrides)
    return r


def drive(s=None, policy=None, until=None):
    s = s or p.initial()
    for _ in range(3000):
        if not s['role'] or (until and until(s)):
            return s
        r = response(s)
        if policy:
            r.update(policy(s) or {})
        s = p.transition(s, r)
    raise AssertionError('fixture did not terminate')


def count(s, role):
    return sum(e['role'] == role for e in s['events'])


class ScientistTwoProtocol(unittest.TestCase):
    def test_default_complete_accept_all_nested_roles(self):
        s = drive()
        self.assertEqual(s['terminal'], 'meta_accept')
        self.assertEqual(len(s['good']), 4)
        self.assertEqual(s['round'], 1)
        self.assertEqual(count(s, 'subset_coding'), 4)
        self.assertEqual(count(s, 'idea_evolve'), 1)
        self.assertEqual(count(s, 'ablation_coding'), 3)
        self.assertEqual(count(s, 'content_refine'), 3)
        self.assertEqual(count(s, 'draft_quality'), 12)
        self.assertEqual(count(s, 'draft_quality_merge'), 4)
        self.assertEqual(count(s, 'review_expand'), 3)
        self.assertEqual(count(s, 'novelty_answer'), 5)
        self.assertEqual(count(s, 'soundness_answer'), 5)
        self.assertEqual(count(s, 'score_reproduce'), 1)
        self.assertEqual(count(s, 'export'), 1)
        evaluated = [i for i, c in s['candidates'].items() if 'decision' in c]
        self.assertEqual(evaluated[:3], ['seed-3', 'seed-4', 'seed-5'])
        self.assertEqual(s['unused_seeds'], ['seed-1', 'seed-0'])

    def test_zero_good_runs_four_total_rounds_nine_distinct_candidates(self):
        s = drive(policy=lambda s: {'decision': 'Bad'} if s['role'] == 'subset_critic' else {})
        self.assertEqual(s['terminal'], 'no_successful_idea')
        self.assertEqual(s['round'], 3)
        self.assertEqual(count(s, 'subset_coding'), 9)
        self.assertEqual(count(s, 'idea_evolve'), 3)
        self.assertEqual(count(s, 'draft_outline'), 0)
        self.assertEqual(s['unused_seeds'], [])

    def test_engineering_exactly_two_per_stage_then_prune(self):
        for critic, engineer in [('subset_critic', 'subset_engineering'), ('full_critic', 'full_engineering')]:
            with self.subTest(critic=critic):
                s = drive(policy=lambda s: {'decision': 'Engineer'} if s['role'] == critic else {})
                self.assertEqual(count(s, engineer), 18)
                self.assertEqual(count(s, critic), 27)
                self.assertEqual(s['terminal'], 'no_successful_idea')

    def test_limitations_expand_sixteen_times_keep_accumulation(self):
        s = drive(policy=lambda s: {'decision': 'Expand'} if s['role'] == 'limitation_verify' else {},
                  until=lambda s: s['role'] == 'seed_generate')
        self.assertEqual(s['limitation_round'], 16)
        self.assertEqual(len(s['limitations']), 16)
        r = response(p.initial())
        s0 = p.transition(p.initial(), r)
        s0 = p.transition(s0, response(s0))
        s0 = p.transition(s0, response(s0, decision='Expand'))
        with self.assertRaisesRegex(ValueError, 'cannot drop'):
            p.transition(s0, response(s0, limitations=['new only']))

    def test_ablation_better_replans_all_but_not_more_refinements(self):
        def policy(s):
            if s['role'] == 'ablation_critic': return {'decision': 'Refine'}
            if s['role'] == 'result_comparison': return {'decision': 'Better'}
        s = drive(policy=policy)
        self.assertEqual(count(s, 'ablation_plan'), 2)
        self.assertEqual(count(s, 'ablation_coding'), 6)
        self.assertEqual(count(s, 'result_comparison'), 1)
        self.assertEqual(s['best']['role'], 'full_engineering')

    def test_ablation_not_better_keeps_old_best(self):
        s = drive(policy=lambda s: {'decision': 'Refine'} if s['role'] == 'ablation_critic' else {})
        self.assertEqual(s['best']['role'], 'full_coding')
        self.assertEqual(count(s, 'ablation_plan'), 1)
        self.assertEqual(count(s, 'result_comparison'), 1)

    def test_low_peer_score_runs_all_supplementary_experiments_twice(self):
        s = drive(policy=lambda s: {'score': 6} if s['role'] == 'peer_review' else {})
        self.assertEqual(count(s, 'peer_review'), 3)
        self.assertEqual(count(s, 'rebuttal_plan'), 2)
        self.assertEqual(count(s, 'rebuttal_coding'), 6)
        self.assertEqual(count(s, 'paper_enhancer'), 2)
        self.assertEqual(count(s, 'review_expand'), 9)
        self.assertEqual(count(s, 'novelty_answer'), 15)
        self.assertEqual(s['review']['score'], 6)

    def test_meta_not_better_preserves_paper_and_code_pair(self):
        s = drive(until=lambda s: s['role'] == 'meta_review')
        best, paper = copy.deepcopy(s['best']), copy.deepcopy(s['paper'])
        s = p.transition(s, response(s, decision='Refine'))
        s = drive(s)
        self.assertEqual(s['terminal'], 'retained_previous_best')
        self.assertEqual(s['best'], best)
        self.assertEqual(s['paper'], paper)

    def test_meta_better_redoes_downstream_global_budget_not_reset(self):
        def policy(s):
            if s['role'] == 'meta_review': return {'decision': 'Refine'}
            if s['role'] == 'result_comparison': return {'decision': 'Better'}
        s = drive(policy=policy)
        self.assertEqual(s['terminal'], 'meta_budget_exhausted')
        self.assertEqual(count(s, 'meta_review'), 2)
        self.assertEqual(count(s, 'draft_outline'), 2)
        self.assertEqual(count(s, 'ablation_plan'), 2)
        self.assertEqual(s['meta_used'], 1)

    def test_draft_scoring_rejects_degradation_preserves_baseline(self):
        axes = dict.fromkeys(p.REVIEW_LIMITS, 3)
        for metric in [axes | dict(Overall=5, Confidence=4, Soundness=4, Presentation=4),
                       axes | dict(Overall=6, Confidence=4, Soundness=1, Presentation=4)]:
            def policy(s):
                if s['role'] == 'draft_quality' and s['content_used'] > 0: return {'metrics': metric}
            s = drive(policy=policy)
            self.assertEqual(count(s, 'content_refine'), 1)
            self.assertEqual(s['paper']['role'], 'draft_sections')

    def test_draft_compile_failures_consume_reflections_and_keep_paper(self):
        s = drive(policy=lambda s: {'status': 'failed', 'failure_kind': 'compile'} if s['role'] == 'content_refine' else {})
        self.assertEqual(count(s, 'content_refine'), 3)
        self.assertEqual(s['paper']['role'], 'draft_sections')
        self.assertEqual(s['terminal'], 'meta_accept')

    def test_missing_tex_stops_content_loop_and_outer_technical_retries_are_bounded(self):
        s = drive(policy=lambda s: {'status': 'failed', 'failure_kind': 'missing_tex'}
                  if s['role'] == 'content_refine' else {})
        self.assertEqual(count(s, 'content_refine'), 1)
        self.assertEqual(s['paper']['role'], 'draft_sections')
        s = drive(until=lambda s: s['role'] == 'draft_sections')
        for attempt in range(1, 4):
            self.assertEqual(s['draft_attempt'], attempt)
            s = p.transition(s, response(s, status='failed'))
            if attempt < 3:
                self.assertEqual(s['role'], 'draft_outline')
                s = drive(s, until=lambda s: s['role'] == 'draft_sections')
        self.assertTrue(s['blocked'])
        self.assertIsNone(s['terminal'])

    def test_failed_meta_execution_retains_previous_pair(self):
        s = drive(until=lambda s: s['role'] == 'meta_review')
        best, paper = copy.deepcopy(s['best']), copy.deepcopy(s['paper'])
        s = p.transition(s, response(s, decision='Refine'))
        s = p.transition(s, response(s, status='failed'))
        s = drive(s)
        self.assertEqual(s['terminal'], 'retained_previous_best')
        self.assertEqual(s['best'], best)
        self.assertEqual(s['paper'], paper)

    def test_format_failed_retains_old_and_only_one_repair(self):
        def policy(s):
            if s['role'] == 'format_review': return {'decision': 'Fix'}
            if s['role'] == 'format_fix': return {'status': 'failed'}
        s = drive(policy=policy)
        self.assertEqual(count(s, 'format_fix'), 1)
        self.assertEqual(s['paper']['role'], 'content_refine')

    def test_spec_reject_prunes_candidate_before_critic(self):
        def policy(s):
            if s['role'] == 'spec_filter' and s['coding_role'] != 'baseline_coding':
                return {'decision': 'Reject'}
        s = drive(policy=policy)
        self.assertEqual(s['terminal'], 'no_successful_idea')
        self.assertEqual(count(s, 'subset_critic'), 0)

    def test_failed_required_batch_item_not_skipped(self):
        s = drive(until=lambda s: s['role'] == 'ablation_coding')
        plan = copy.deepcopy(s['plan'])
        s = p.transition(s, response(s, status='failed'))
        self.assertEqual(s['role'], 'ablation_coding')
        self.assertEqual(s['plan'], plan)
        self.assertTrue(s['blocked'])
        s = drive(s)
        self.assertEqual(len(s['ablations']), 3)

    def test_blocked_does_not_consume_budget(self):
        s = drive(until=lambda s: s['role'] == 'subset_critic')
        before = s['subset_engineering_used']
        s = p.transition(s, response(s, status='blocked'))
        self.assertEqual(s['role'], 'subset_critic')
        self.assertEqual(s['subset_engineering_used'], before)

    def test_integrity_corrections_reverify_and_reproduction_failure_blocks(self):
        s = drive(until=lambda s: s['role'] == 'reference_verify')
        s = p.transition(s, response(s, decision='Fix'))
        self.assertEqual(s['role'], 'integrity_writer')
        s = p.transition(s, response(s))
        self.assertEqual(s['role'], 'reference_verify')
        s = drive(s, until=lambda s: s['role'] == 'score_reproduce')
        s = p.transition(s, response(s, decision='Fail'))
        self.assertEqual(s['role'], 'score_reproduce')
        self.assertIsNone(s['terminal'])

    def test_novelty_input_excludes_submission_and_other_answers(self):
        s = drive(until=lambda s: s['role'] == 'novelty_answer')
        packet = p.request(s)
        self.assertEqual(set(packet['context']), {'question', 'cutoff', 'sources'})
        self.assertNotIn('paper', packet['context'])
        self.assertNotIn('events', packet['context'])
        self.assertEqual({e['role'] for e in packet['context']['sources']},
                         {'review_summary', 'review_literature', 'review_expand', 'review_historian', 'review_baselines'})

    def test_inner_ensemble_is_independent_aggregated_and_falls_back(self):
        s = drive(until=lambda s: s['role'] == 'draft_quality')
        for score in [5, 6, 8]:
            self.assertEqual(set(p.request(s)['context']), {'paper_trial', 'review_index'})
            r = response(s); r['metrics']['Overall'] = score
            s = p.transition(s, r)
        self.assertEqual(s['role'], 'draft_quality_merge')
        self.assertEqual(len(p.request(s)['context']['reviews']), 3)
        first = s['quality_reviews'][0]['review']
        s = p.transition(s, response(s, status='failed'))
        self.assertEqual(s['draft_quality_best']['Overall'], 6)
        self.assertEqual(s['draft_review_best']['Summary'], first['Summary'])
        self.assertEqual(s['role'], 'content_refine')

    def test_contract_rejects_skips_bad_scores_stale_tickets(self):
        with self.assertRaisesRegex(ValueError, 'not enough'):
            p.initial({'seed_count': 3})
        s = p.initial()
        for change in [dict(ticket=1), dict(role='selector'), dict(task={})]:
            with self.assertRaises(ValueError): p.transition(s, response(s, **change))
        s = drive(until=lambda s: s['role'] == 'peer_review')
        for score in [0, 11, float('nan'), True]:
            with self.assertRaises(ValueError): p.transition(s, response(s, score=score))

    def test_artifact_integrity_duplicate_commit_and_atomic_cli_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'evidence').write_text('fixture')
            s = p.initial(); r = response(s, artifacts=['evidence'])
            committed = p.commit(root, s, r)
            self.assertEqual(p.commit(root, committed, r), committed)
            with self.assertRaisesRegex(ValueError, 'conflicting'):
                p.commit(root, committed, r | {'summary': 'different'})
            (root / 'evidence').write_text('changed')
            with self.assertRaisesRegex(ValueError, 'immutable'):
                p.verify(root, committed)
            (root / 'evidence').write_text('fixture')
            (root / 'response.json').write_text(json.dumps(r))
            command = ['python', str(SKILL / 'scripts/protocol.py')]
            def cli(*args):
                return json.loads(subprocess.check_output(command + list(args) + ['--root', str(root)]))
            self.assertEqual(cli('init')['role'], 'task_setup')
            after = cli('submit', '--response', str(root / 'response.json'))
            self.assertEqual(after['role'], 'limitation_extract')
            self.assertEqual(cli('next'), after)
            self.assertEqual(cli('submit', '--response', str(root / 'response.json')), after)
            self.assertEqual(cli('verify'), after)

    def test_directory_hash_detects_additions_and_escapes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'snapshot').mkdir()
            (root / 'snapshot/a').write_text('fixture')
            s = p.commit(root, p.initial(), response(p.initial(), artifacts=['snapshot']))
            (root / 'snapshot/b').write_text('new')
            with self.assertRaisesRegex(ValueError, 'immutable'): p.verify(root, s)
            with self.assertRaises(ValueError): p.hash_artifacts(root, ['../outside'])

    def test_roles_sources_hashes_and_complete_route_coverage(self):
        workflow = json.loads((SKILL.parent.parent / 'workflow.json').read_text())
        self.assertEqual(set(workflow['agents']), set(p.FIELDS) | {'main'})
        self.assertEqual({x['target'] for x in workflow['orchestration']['routes']['main']}, set(p.FIELDS))
        manifest = json.loads((SKILL / 'UPSTREAM.json').read_text())
        for entry in manifest['files']:
            self.assertEqual(p.hashlib.sha256((SKILL / entry['path']).read_bytes()).hexdigest(), entry['sha256'])
        for a in workflow['agents'].values():
            self.assertEqual(a['proxy']['mode'], 'direct')
            self.assertEqual(a['model'], 'gpt-6-sol')


if __name__ == '__main__':
    unittest.main()
