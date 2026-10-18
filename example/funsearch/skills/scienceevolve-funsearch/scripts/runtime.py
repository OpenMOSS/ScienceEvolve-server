#!/usr/bin/env python3
"""Atomic operations for the original FunSearch algorithm, without its outer loop."""
import argparse
import dataclasses
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pickle
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'upstream'))
import numpy as np
from funsearch.implementation import code_manipulation, config, evaluator, funsearch, programs_database


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, state):
    state['rng'] = np.random.get_state()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            pickle.dump(state, f)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def load(path):
    with path.open('rb') as f: state = pickle.load(f)  # trusted, run-local state only
    np.random.set_state(state['rng'])
    if sha(state['sandbox_path']) != state['sandbox_sha256']:
        raise ValueError('Frozen Sandbox adapter changed')
    return state


def sandbox(state, directory):
    spec = importlib.util.spec_from_file_location('task_sandbox', state['sandbox_path'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    backend = module.create_sandbox()
    directory.mkdir(parents=True, exist_ok=True)

    class LoggedSandbox:
        call_index = 0

        def run(self, program, function_to_run, test_input, timeout_seconds):
            key = hashlib.sha256(json.dumps([self.call_index, program, function_to_run, test_input, timeout_seconds]).encode()).hexdigest()
            self.call_index += 1
            log = directory / (key + '.json')
            if log.exists():
                record = json.loads(log.read_text())
                return record['score'], record['success']
            score, success = backend.run(program, function_to_run, test_input, timeout_seconds)
            record = dict(input=test_input, timeout_seconds=timeout_seconds, function=function_to_run,
                          program_sha256=hashlib.sha256(program.encode()).hexdigest(), score=score, success=success)
            # Log before registration, so a restart can reuse completed test execution.
            log.write_text(json.dumps(record, indent=2)+'\n')
            return score, success
    return LoggedSandbox()


def analyse(state, sample, island, version, logs):
    runner = evaluator.Evaluator(state['database'], state['template'], state['evolve'], state['run'],
                                 state['inputs'], state['timeout'])
    runner._sandbox = sandbox(state, logs)
    runner.analyse(sample, island, version)


def initialize(path, spec_path, inputs_path, sandbox_path, seed=42, config_path=None, timeout=30):
    if path.exists(): raise ValueError('State already exists; resume it instead of reinitializing')
    options = json.loads(Path(config_path).read_text()) if config_path else {}
    db_options = options.pop('programs_database', {})
    cfg = config.Config(programs_database=config.ProgramsDatabaseConfig(**db_options), **options)
    if min(cfg.samples_per_prompt, cfg.num_evaluators, cfg.programs_database.num_islands) < 1:
        raise ValueError('Positive sampler, evaluator and island counts required')
    text = Path(spec_path).read_text()
    inputs = json.loads(Path(inputs_path).read_text())
    if not inputs or any(not isinstance(x, (str, int, float, bool)) for x in inputs):
        raise ValueError('Provide nonempty JSON scalar test inputs (upstream uses them as score keys)')
    evolve, run = funsearch._extract_function_names(text)
    template = code_manipulation.text_to_program(text)
    np.random.seed(seed)
    state = dict(config=cfg, database=programs_database.ProgramsDatabase(cfg.programs_database, template, evolve),
                 template=template, evolve=evolve, run=run, inputs=inputs, timeout=timeout,
                 sandbox_path=str(Path(sandbox_path).resolve()), sandbox_sha256=sha(sandbox_path),
                 spec_sha256=sha(spec_path), pending=None, completed_prompts=0)
    analyse(state, template.get_function(evolve).body, None, None, path.parent/'baseline')
    if any(x is None for x in state['database']._best_program_per_island):
        raise ValueError('Baseline has no valid test scores; cannot sample from empty islands')
    save(path, state)
    manifest = dict(spec_sha256=state['spec_sha256'], sandbox_sha256=state['sandbox_sha256'], seed=seed,
                    config=dataclasses.asdict(cfg), inputs=inputs, timeout_seconds=timeout)
    (path.parent/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    return manifest


def prompt(path):
    state = load(path)
    if state['pending'] is None:
        item = state['database'].get_prompt()
        state['pending'] = dict(id=state['completed_prompts'], code=item.code,
                                island_id=item.island_id, version_generated=item.version_generated, evaluated={})
        save(path, state)
    return {**state['pending'], 'samples_per_prompt':state['config'].samples_per_prompt}


def evaluate(path, sample_path, index, prompt_id):
    state = load(path); pending = state['pending']
    if pending is None or pending['id'] != prompt_id:
        completed = path.parent/'prompts'/str(prompt_id)/'completed.json'
        if 0 <= prompt_id < state['completed_prompts'] and completed.is_file():
            old = json.loads(completed.read_text())
            if old['evaluated'].get(str(index)) == sha(sample_path):
                return dict(status='already_evaluated', index=index)
        raise ValueError('Missing or stale prompt ID')
    if not 0 <= index < state['config'].samples_per_prompt: raise ValueError('Sample index out of range')
    key = str(index); code_hash = sha(sample_path)
    if key in pending['evaluated']:
        if pending['evaluated'][key] != code_hash: raise ValueError('An evaluated sample index cannot be replaced')
        return dict(status='already_evaluated', index=index)
    if index != len(pending['evaluated']):
        raise ValueError('Evaluate samples in original sampler order')
    run_dir = path.parent/'prompts'/str(pending['id'])/str(index)
    run_dir.mkdir(parents=True, exist_ok=True)
    candidate = run_dir/'sample.txt'
    if candidate.exists() and sha(candidate) != code_hash: raise ValueError('Pending sample was changed')
    candidate.write_bytes(Path(sample_path).read_bytes())
    (run_dir/'prompt.json').write_text(json.dumps(pending, indent=2)+'\n')
    # This draw is present in the original sampler, even in the serial backend.
    chosen_evaluator = int(np.random.choice(state['config'].num_evaluators))
    analyse(state, candidate.read_text(), pending['island_id'], pending['version_generated'], run_dir/'tests')
    pending['evaluated'][key] = code_hash
    complete = len(pending['evaluated']) == state['config'].samples_per_prompt
    if complete:
        (run_dir.parent/'completed.json').write_text(json.dumps(pending, indent=2)+'\n')
        state['pending'] = None; state['completed_prompts'] += 1
    save(path, state)
    return dict(status='evaluated', index=index, evaluator=chosen_evaluator, prompt_complete=complete)


def export(path):
    state = load(path); db = state['database']
    return dict(completed_prompts=state['completed_prompts'], pending=state['pending'],
                islands=[dict(score=score, program=str(program), scores=scores) for score,program,scores in
                         zip(db._best_score_per_island, db._best_program_per_island, db._best_scores_per_test_per_island)])


def main():
    p=argparse.ArgumentParser(); p.add_argument('--state',type=Path,required=True)
    sub=p.add_subparsers(dest='command',required=True)
    q=sub.add_parser('init'); q.add_argument('--spec',required=True); q.add_argument('--inputs',required=True)
    q.add_argument('--sandbox',required=True); q.add_argument('--seed',type=int,default=42); q.add_argument('--config'); q.add_argument('--timeout',type=int,default=30)
    sub.add_parser('prompt'); sub.add_parser('export')
    q=sub.add_parser('evaluate');q.add_argument('--sample',required=True);q.add_argument('--index',type=int,required=True);q.add_argument('--prompt-id',type=int,required=True)
    a=p.parse_args()
    if a.command=='init': result=initialize(a.state,a.spec,a.inputs,a.sandbox,a.seed,a.config,a.timeout)
    elif a.command=='prompt':result=prompt(a.state)
    elif a.command=='evaluate':result=evaluate(a.state,a.sample,a.index,a.prompt_id)
    else:result=export(a.state)
    print(json.dumps(result,indent=2))

if __name__=='__main__': main()
