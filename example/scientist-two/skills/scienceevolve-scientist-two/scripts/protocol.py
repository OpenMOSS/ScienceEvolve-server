#!/usr/bin/env python3
"""ScientistTwo control plane. Runs no models, searches or experiments.

Workers produce evidence; Main commits one response and dispatches next.role.
One atomically replaced state contains the complete journal and all counters.
"""
import argparse
import copy
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile

DEFAULTS = dict(seed_count=6, initial_candidates=3, experiment_rounds=4,
                evolved_per_round=1, seeds_per_round=1, successful_ideas=4,
                limitation_rounds=16, engineering_rounds=2, ablation_refinements=1,
                rebuttal_rounds=2, review_threshold=8, meta_refinements=1,
                draft_attempts=3, content_reflections=3, draft_review_ensemble=3, literature_expansions=3,
                novelty_questions=5, soundness_questions=5)
CODERS = {'baseline_coding', 'subset_coding', 'subset_engineering',
          'full_coding', 'full_engineering', 'ablation_coding', 'rebuttal_coding'}
PAPER = {'draft_sections', 'content_refine', 'format_fix', 'paper_enhancer', 'integrity_writer'}
FIELDS = {
    'task_setup': ['task'], 'limitation_extract': ['limitations'],
    'limitation_verify': ['decision'], 'seed_generate': ['idea'],
    'novelty_check': ['score', 'references'], 'idea_evolve': ['ideas'],
    'spec_filter': ['decision'], 'subset_critic': ['decision'], 'full_critic': ['decision'],
    'selector': ['candidate'], 'ablation_plan': ['plans'], 'ablation_critic': ['decision'],
    'result_comparison': ['decision'], 'draft_outline': ['outline'],
    'draft_literature': ['bibliography', 'citation_map', 'outline'],
    'draft_figures': ['figures'], 'draft_quality': ['metrics', 'review'],
    'draft_quality_merge': ['review'],
    'format_review': ['decision'], 'review_summary': ['context'],
    'review_literature': ['papers'], 'review_expand': ['papers'],
    'review_historian': ['history'], 'review_baselines': ['baselines'],
    'novelty_questions': ['questions'], 'soundness_questions': ['questions'],
    'novelty_answer': ['answer'], 'soundness_answer': ['answer'],
    'peer_review': ['score', 'review'], 'rebuttal_plan': ['plans'],
    'meta_review': ['decision'], 'reference_verify': ['decision'],
    'method_audit': ['decision'], 'score_reproduce': ['decision', 'results', 'logs', 'commands'],
    'final_spec_audit': ['decision'], 'export': ['bundle'],
}
for _role in CODERS:
    FIELDS[_role] = ['code', 'results', 'logs', 'commands', 'hypothesis']
for _role in PAPER:
    FIELDS[_role] = ['tex', 'pdf', 'compile_log', 'screenshots']
DECISIONS = {
    'limitation_verify': {'Sufficient', 'Expand'},
    'spec_filter': {'Pass', 'Reject'},
    'subset_critic': {'Good', 'Bad', 'Engineer'}, 'full_critic': {'Good', 'Bad', 'Engineer'},
    'ablation_critic': {'Good', 'Refine'}, 'result_comparison': {'Better', 'NotBetter'},
    'format_review': {'Clean', 'Fix'}, 'meta_review': {'Accept', 'Refine'},
    'reference_verify': {'Pass', 'Fix'}, 'method_audit': {'Pass', 'Fix'},
    'score_reproduce': {'Pass', 'Fail'}, 'final_spec_audit': {'Pass', 'Fail'},
}
REVIEW_LIMITS = dict(Originality=4, Quality=4, Clarity=4, Significance=4,
                     Soundness=4, Presentation=4, Contribution=4, Overall=10, Confidence=5)


def ensemble_metrics(reviews):
    # Same valid integer filtering, arithmetic mean and round-to-even as the
    # pinned autoraters/agent_review.py; no model-generated aggregate numbers.
    return {key: int(round(sum(r['metrics'][key] for r in reviews) / len(reviews)))
            for key in REVIEW_LIMITS}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    allow_nan=False).encode()).hexdigest()


def initial(config=None):
    c = DEFAULTS | (config or {})
    require(not (set(c) - set(DEFAULTS)), 'unknown configuration field')
    require(all(type(v) is int and v > 0 for v in c.values()), 'budgets must be positive integers')
    require(c['seed_count'] >= c['initial_candidates'] +
            (c['experiment_rounds'] - 1) * c['seeds_per_round'], 'not enough unused seeds')
    require(c['review_threshold'] <= 10, 'review threshold must be <= 10')
    return dict(config=c, role='task_setup', seq=0, events=[], seeds=[], queue=[],
                candidates={}, good=[], round=0, limitation_round=0, meta_used=0,
                terminal=None, blocked=None)


def go(s, role):
    require(role in FIELDS or role is None, f'unknown role: {role}')
    s['role'] = role


def start_candidate(s):
    c = s['config']
    if len(s['good']) >= c['successful_ideas']:
        go(s, 'selector')
    elif s['queue']:
        s['candidate'] = s['queue'].pop(0)
        s['subset_engineering_used'] = s['full_engineering_used'] = 0
        go(s, 'subset_coding')
    elif s['round'] + 1 < c['experiment_rounds']:
        s['round'] += 1
        go(s, 'idea_evolve')
    elif s['good']:
        go(s, 'selector')
    else:
        s['terminal'] = 'no_successful_idea'
        go(s, None)


def candidate_end(s, decision):
    row = s['candidates'][s['candidate']]
    row.update(decision=decision, round=s['round'], experiment=s.get('experiment'))
    if decision == 'Good':
        s['good'].append(s['candidate'])
    start_candidate(s)


def downstream(s):
    s['ablation_used'] = 0
    go(s, 'ablation_plan')


def drafting(s):
    s['draft_attempt'] = 1
    s['rebuttal_used'] = 0
    go(s, 'draft_outline')


def peer(s):
    s['review_start'] = len(s['events'])
    s['expansions'] = 0
    go(s, 'review_summary')


def integrity(s, next_role):
    s['integrity_return'] = next_role
    go(s, 'reference_verify')


def finish(s, outcome):
    s['outcome'] = outcome
    go(s, 'score_reproduce')


def batch_next(s):
    if s['plans']:
        s['plan'] = s['plans'].pop(0)
        go(s, s['batch'] + '_coding')
    else:
        go(s, 'ablation_critic' if s['batch'] == 'ablation' else 'paper_enhancer')


def refinement_failed(s):
    if s['refinement'] == 'meta':
        finish(s, 'retained_previous_best')
    else:
        drafting(s)


def validate(s, r):
    role = s['role']
    require(r.get('role') == role and r.get('ticket') == s['seq'], 'wrong role or stale ticket')
    require(isinstance(r.get('summary'), str) and r['summary'].strip(), 'evidence summary required')
    require(isinstance(r.get('artifacts'), list) and r['artifacts'], 'nonempty artifacts required')
    require(r.get('status', 'ok') in {'ok', 'blocked', 'failed'}, 'invalid status')
    if r.get('status') == 'failed' and role == 'content_refine':
        require(r.get('failure_kind') in {'compile', 'missing_tex', 'exception'},
                'content refinement failure requires compile/missing_tex/exception kind')
    if r.get('status') in {'blocked', 'failed'}:
        return
    for name in FIELDS[role]:
        require(name in r and r[name] is not None, f'{role} requires {name}')
    if role in DECISIONS:
        require(r['decision'] in DECISIONS[role], 'invalid decision')
    if role in CODERS | PAPER | {'score_reproduce'}:
        paths = (['code', 'results', 'logs', 'commands'] if role in CODERS else
                 ['tex', 'pdf', 'compile_log', 'screenshots'] if role in PAPER else
                 ['results', 'logs', 'commands'])
        require(all(isinstance(r[k], str) and r[k] in r['artifacts'] for k in paths),
                'all executable/measurement/manuscript paths must be hashed artifacts')
    if role in {'novelty_check', 'peer_review'}:
        require(type(r['score']) in (int, float) and math.isfinite(r['score']), 'finite score required')
        if role == 'peer_review':
            require(1 <= r['score'] <= 10, 'ICLR score must be 1..10')
            require(isinstance(r['review'], dict) and all(k in r['review'] for k in
                    ['summary', 'strengths', 'weaknesses', 'questions', 'confidence', 'rationale']),
                    'complete ScholarPeer review required')
            require(type(r['review']['confidence']) in (int, float) and
                    1 <= r['review']['confidence'] <= 5, 'confidence must be 1..5')
        else:
            require(isinstance(r['references'], list) and len(r['references']) == 2 and
                    len({x['url'] for x in r['references']}) == 2 and
                    all(x.get('retrieval_evidence') in r['artifacts'] for x in r['references']),
                    'novelty requires two distinct retrieved papers with evidence')
    if role == 'task_setup':
        require(isinstance(r['task'], dict), 'task must be an object')
        for k in ['problem', 'baseline', 'subset', 'full_benchmark', 'metrics',
                  'human_sota', 'constraints', 'resources', 'search', 'cutoff', 'novelty_rubric']:
            require(r['task'].get(k), f'task requires {k}')
    if role == 'limitation_extract':
        require(isinstance(r['limitations'], list) and r['limitations'], 'actionable limitations required')
        require(all(x in r['limitations'] for x in s.get('limitations', [])), 'cannot drop prior limitations')
    if role in {'seed_generate', 'idea_evolve'}:
        ideas = [r['idea']] if role == 'seed_generate' else r['ideas']
        expected = 1 if role == 'seed_generate' else s['config']['evolved_per_round']
        require(isinstance(ideas, list) and len(ideas) == expected, 'wrong idea count')
        ids = [x['id'] for x in ideas]
        require(len(set(ids)) == len(ids) and all(i not in s['candidates'] for i in ids), 'duplicate idea IDs')
        require(all(x.get('hypothesis') for x in ideas), 'hypotheses required')
    if role in {'ablation_plan', 'rebuttal_plan', 'novelty_questions', 'soundness_questions'}:
        key = 'plans' if role.endswith('_plan') else 'questions'
        rows = r[key]
        require(isinstance(rows, list) and rows, f'{key} must not be empty')
        require(len({x['id'] for x in rows}) == len(rows), 'duplicate plan/question ID')
        if key == 'questions':
            require(len(rows) == s['config'][role], 'wrong number of probing questions')
    if role == 'selector':
        require(r['candidate'] in s['good'], 'selector must select a full-set Good candidate')
    if role == 'export':
        require(isinstance(r['bundle'], str) and r['bundle'] in r['artifacts'],
                'export bundle must be a hashed artifact')
    if role == 'draft_quality':
        m = r['metrics']
        require(isinstance(m, dict) and m.keys() == REVIEW_LIMITS.keys(), 'all nine upstream review axes required')
        require(all(type(m[k]) is int and 1 <= m[k] <= limit for k, limit in REVIEW_LIMITS.items()),
                'invalid review axis')
    if role in {'draft_quality', 'draft_quality_merge'}:
        require(isinstance(r['review'], dict) and all(k in r['review'] for k in
                ['Summary', 'Strengths', 'Weaknesses', 'Questions', 'Limitations', 'Ethical Concerns', 'Decision']),
                'complete AgentReview feedback required')
        require(r['review']['Decision'] in {'Accept', 'Reject'}, 'invalid AgentReview Decision')


def advance(s, r):
    role, c = s['role'], s['config']
    status = r.get('status', 'ok')
    if status == 'blocked':
        s['blocked'] = r['summary']
        return
    s['blocked'] = None
    if status == 'failed':
        if role in {'subset_coding', 'subset_engineering', 'full_coding'} or (
                role == 'full_engineering' and s.get('refinement') is None):
            s['experiment'] = r
            candidate_end(s, 'Bad')
        elif role == 'full_engineering':
            refinement_failed(s)
        elif role == 'content_refine':
            if r['failure_kind'] == 'compile' and s['content_used'] < c['content_reflections']:
                s['content_used'] += 1
                go(s, 'content_refine')
            else:
                go(s, 'format_review')
        elif role == 'format_fix':
            integrity(s, 'review_summary')
        elif role == 'draft_quality_merge':
            # Upstream get_meta_review(None) falls back to the first review;
            # numerical axes are still aggregated from the whole ensemble.
            finish_draft_review(s, s['quality_reviews'][0]['review'])
        elif (role.startswith('draft_') or role == 'format_review') and s['draft_attempt'] < c['draft_attempts']:
            s['draft_attempt'] += 1
            go(s, 'draft_outline')
        else:
            s['blocked'] = r['summary']  # cannot skip a required experiment or audit
        return
    if role == 'task_setup':
        s['task'] = r['task']; go(s, 'limitation_extract')
    elif role == 'limitation_extract':
        s['limitations'] = r['limitations']; s['limitation_round'] += 1
        go(s, 'limitation_verify')
    elif role == 'limitation_verify':
        go(s, 'seed_generate' if r['decision'] == 'Sufficient' or
           s['limitation_round'] >= c['limitation_rounds'] else 'limitation_extract')
    elif role == 'seed_generate':
        s['pending_seed'] = r['idea']; go(s, 'novelty_check')
    elif role == 'novelty_check':
        idea = s['pending_seed'] | dict(novelty=r['score'], source='seed')
        s['seeds'].append(idea['id']); s['candidates'][idea['id']] = idea
        if len(s['seeds']) < c['seed_count']:
            go(s, 'seed_generate')
        else:
            s['unused_seeds'] = sorted(s['seeds'], key=lambda i: -s['candidates'][i]['novelty'])
            go(s, 'baseline_coding')
    elif role in CODERS:
        s['experiment'] = r
        s['coding_role'] = role
        go(s, 'spec_filter')
    elif role == 'spec_filter':
        coder = s['coding_role']
        if r['decision'] == 'Reject':
            if coder == 'baseline_coding' or coder in {'ablation_coding', 'rebuttal_coding'}:
                s['blocked'] = 'Specification violation: correct this execution, never use its results.'
                go(s, coder)
            elif coder == 'full_engineering' and s.get('refinement'):
                refinement_failed(s)
            else:
                candidate_end(s, 'Bad')
        elif coder == 'baseline_coding':
            s['baseline'] = s['experiment']
            s['queue'] = s['unused_seeds'][:c['initial_candidates']]
            del s['unused_seeds'][:c['initial_candidates']]
            start_candidate(s)
        elif coder.startswith('subset_'):
            go(s, 'subset_critic')
        elif coder == 'full_engineering' and s.get('refinement'):
            go(s, 'result_comparison')
        elif coder.startswith('full_'):
            go(s, 'full_critic')
        else:
            s['batch_results'].append(s['experiment']); batch_next(s)
    elif role in {'subset_critic', 'full_critic'}:
        level = role.split('_')[0]
        key = level + '_engineering_used'
        if r['decision'] == 'Engineer' and s[key] < c['engineering_rounds']:
            s[key] += 1; s['refinement'] = None; go(s, level + '_engineering')
        elif r['decision'] != 'Good':
            candidate_end(s, 'Bad')
        elif level == 'subset':
            s['subset_result'] = s['experiment']; go(s, 'full_coding')
        else:
            candidate_end(s, 'Good')
    elif role == 'idea_evolve':
        for idea in r['ideas']:
            s['candidates'][idea['id']] = idea | dict(source='evolved', round=s['round'])
        n = c['seeds_per_round']
        s['queue'] = [i['id'] for i in r['ideas']] + s['unused_seeds'][:n]
        del s['unused_seeds'][:n]
        start_candidate(s)
    elif role == 'selector':
        s['best'] = s['candidates'][r['candidate']]['experiment']; downstream(s)
    elif role in {'ablation_plan', 'rebuttal_plan'}:
        s['batch'] = role.split('_')[0]
        s['plans'] = copy.deepcopy(r['plans']); s['batch_results'] = []; batch_next(s)
    elif role == 'ablation_critic':
        s['ablations'] = s['batch_results']
        if r['decision'] == 'Refine' and s['ablation_used'] < c['ablation_refinements']:
            s['ablation_used'] += 1; s['refinement'] = 'ablation'; go(s, 'full_engineering')
        else:
            drafting(s)
    elif role == 'result_comparison':
        if r['decision'] == 'Better':
            s['best'] = s['experiment']
            if s['refinement'] == 'meta':
                downstream(s)
            else:
                go(s, 'ablation_plan')
        else:
            refinement_failed(s)
    elif role == 'draft_outline':
        s['draft_quality_best'] = None; go(s, 'draft_literature')
    elif role == 'draft_literature':
        go(s, 'draft_figures')
    elif role == 'draft_figures':
        go(s, 'draft_sections')
    elif role == 'draft_sections':
        s['paper_trial'] = r; s['content_used'] = 0; s['quality_reviews'] = []; go(s, 'draft_quality')
    elif role == 'content_refine':
        s['paper_trial'] = r; s['quality_reviews'] = []; go(s, 'draft_quality')
    elif role == 'draft_quality':
        s['quality_reviews'].append(r)
        if len(s['quality_reviews']) == c['draft_review_ensemble']:
            go(s, 'draft_quality_merge')
    elif role == 'draft_quality_merge':
        finish_draft_review(s, r['review'])
    elif role == 'format_review':
        if r['decision'] == 'Fix':
            go(s, 'format_fix')
        else:
            integrity(s, 'review_summary')
    elif role == 'format_fix':
        s['paper'] = r; integrity(s, 'review_summary')
    elif role == 'reference_verify':
        if r['decision'] == 'Fix':
            s['writer_return'] = 'reference_verify'; go(s, 'integrity_writer')
        else:
            go(s, 'method_audit')
    elif role == 'method_audit':
        if r['decision'] == 'Fix':
            s['writer_return'] = 'reference_verify'; go(s, 'integrity_writer')
        elif s['integrity_return'] == 'review_summary':
            peer(s)
        else:
            go(s, s['integrity_return'])
    elif role == 'integrity_writer':
        s['paper'] = r; go(s, s['writer_return'])
    elif role == 'review_summary':
        go(s, 'review_literature')
    elif role == 'review_literature':
        go(s, 'review_expand')
    elif role == 'review_expand':
        s['expansions'] += 1
        go(s, 'review_expand' if s['expansions'] < c['literature_expansions'] else 'review_historian')
    elif role == 'review_historian':
        go(s, 'review_baselines')
    elif role == 'review_baselines':
        go(s, 'novelty_questions')
    elif role in {'novelty_questions', 'soundness_questions'}:
        s['questions'] = copy.deepcopy(r['questions'])
        s['question'] = s['questions'].pop(0); go(s, role.replace('questions', 'answer'))
    elif role in {'novelty_answer', 'soundness_answer'}:
        if s['questions']:
            s['question'] = s['questions'].pop(0)
        else:
            go(s, 'soundness_questions' if role == 'novelty_answer' else 'peer_review')
    elif role == 'peer_review':
        s['review'] = r
        if r['score'] >= c['review_threshold'] or s['rebuttal_used'] >= c['rebuttal_rounds']:
            go(s, 'meta_review')
        else:
            s['rebuttal_used'] += 1; go(s, 'rebuttal_plan')
    elif role == 'paper_enhancer':
        s['paper'] = r; integrity(s, 'review_summary')
    elif role == 'meta_review':
        if r['decision'] == 'Accept':
            finish(s, 'meta_accept')
        elif s['meta_used'] < c['meta_refinements']:
            s['meta_used'] += 1; s['refinement'] = 'meta'; go(s, 'full_engineering')
        else:
            finish(s, 'meta_budget_exhausted')
    elif role == 'score_reproduce':
        if r['decision'] == 'Pass':
            go(s, 'final_spec_audit')
        else:
            s['blocked'] = 'Independent score reproduction failed; investigate before export.'
    elif role == 'final_spec_audit':
        if r['decision'] == 'Pass':
            integrity(s, 'export')
        else:
            s['blocked'] = 'Final specification audit failed; no valid scientific deliverable.'
    elif role == 'export':
        s['terminal'] = s['outcome']; s['bundle'] = r['bundle']; go(s, None)
    else:
        raise ValueError(f'unhandled role {role}')


def finish_draft_review(s, review):
    new, old = ensemble_metrics(s['quality_reviews']), s['draft_quality_best']
    accept = old is None or new['Overall'] > old['Overall'] or (
        new['Overall'] == old['Overall'] and
        sum(new[k] - old[k] for k in new if k not in {'Overall', 'Confidence'}) >= 0)
    if accept:
        s['paper'] = s['paper_trial']; s['draft_quality_best'] = new
        s['draft_review_best'] = review | new
    if accept and s['content_used'] < s['config']['content_reflections']:
        s['content_used'] += 1; go(s, 'content_refine')
    else:
        go(s, 'format_review')


def transition(state, response):
    """Pure transition; file integrity is enforced separately by commit()."""
    s = copy.deepcopy(state)
    validate(s, response)
    s['events'].append(copy.deepcopy(response))
    advance(s, response)
    s['seq'] += 1
    return s


def hash_artifacts(root, paths):
    result = {}
    for name in paths:
        require(isinstance(name, str) and not Path(name).is_absolute(), 'use workspace-relative artifact paths')
        p = root / name
        require(p.resolve().is_relative_to(root.resolve()) and p.exists(), f'missing/outside artifact: {name}')
        control = root / '.scientist-two'
        require(not p.is_symlink(), 'snapshot must contain no symlinks')
        require(not p.resolve().is_relative_to(control) and not control.is_relative_to(p.resolve()),
                'controller state and workspace roots are not immutable artifacts')
        files = sorted(p.rglob('*')) if p.is_dir() else [p]
        require(files, f'empty artifact: {name}')
        for f in files:
            require(not f.is_symlink(), 'snapshot must contain no symlinks')
            if f.is_file():
                result[str(f.relative_to(root))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return result


def verify(root, s):
    for event in s['events']:
        require(hash_artifacts(root, event['artifacts']) == event['hashes'],
                f"immutable evidence changed at ticket {event['ticket']}")


def commit(root, state, response):
    verify(root, state)
    ticket = response.get('ticket')
    if type(ticket) is int and 0 <= ticket < len(state['events']):
        old = {k: v for k, v in state['events'][ticket].items() if k != 'hashes'}
        require(digest(old) == digest(response), 'conflicting duplicate submission')
        return state
    r = copy.deepcopy(response)
    require('hashes' not in r, 'hashes are controller generated')
    r['hashes'] = hash_artifacts(root, r.get('artifacts', []))
    return transition(state, r)


def request(s):
    role = s['role']
    # Novelty answering intentionally excludes the submission and other reviews.
    if role == 'novelty_answer':
        allowed = {'review_summary', 'review_literature', 'review_expand', 'review_historian', 'review_baselines'}
        context = dict(question=s['question'], cutoff=s['task']['cutoff'],
                       sources=[e for e in s['events'][s['review_start']:] if e['role'] in allowed])
    elif role == 'draft_quality':
        context = dict(paper_trial=s['paper_trial'], review_index=len(s['quality_reviews']) + 1)
    elif role == 'draft_quality_merge':
        context = dict(reviews=s['quality_reviews'])
    else:
        context = s
    return dict(ticket=s['seq'], role=role, terminal=s['terminal'], blocked=s['blocked'],
                required_output=FIELDS.get(role, []), context=context)


def save(path, s):
    fd, name = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(s, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['init', 'next', 'submit', 'verify'])
    p.add_argument('--root', default='.', help='existing Task workspace')
    p.add_argument('--config', help='optional explicit budget overrides, only during init')
    p.add_argument('--response', help='worker response JSON, for submit')
    args = p.parse_args()
    root = Path(args.root).resolve()
    require(root.is_dir(), 'workspace must exist')
    directory = root / '.scientist-two'; directory.mkdir(exist_ok=True)
    path = directory / 'state.json'
    with (directory / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.command == 'init':
            require(not path.exists(), 'already initialized; use next/resume')
            s = initial(json.loads(Path(args.config).read_text()) if args.config else None)
            save(path, s)
        else:
            s = json.loads(path.read_text())
            verify(root, s)
            if args.command == 'submit':
                require(args.response, '--response required')
                s = commit(root, s, json.loads(Path(args.response).read_text()))
                save(path, s)
        print(json.dumps(request(s), ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
