#!/usr/bin/env python3
"""Deterministic DrugEvolve steps. LLM work belongs to workflow.json Agents.

No Runner.run, creation(), evolve(), evaluation() or upstream outer loop is run.
Original sampling, prompt builders, schemas, trainer, metrics and stores are used.
"""
from __future__ import annotations
import argparse
import asyncio
import contextlib
import csv
import io
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import threading
import uuid
from datetime import datetime

UPSTREAM = Path(__file__).resolve().parents[1] / 'upstream'
sys.path[:0] = [str(UPSTREAM / 'pipeline'), str(UPSTREAM)]
ROLES = {
    'generator': ('Researcher.creator.generator.model', 'generator'),
    'inspector': ('Researcher.inspector.model', 'inspector'),
    'implementer': ('Researcher.implementer.model', 'implementer'),
    'debugger': ('Engineer.debugger.model', 'debugger'),
    'judger': ('Engineer.judger.model', 'judger'),
    'analyzer': ('Analyst.analyzer.model', 'analyzer'),
    'summarizer': ('Analyst.summarizer_evolve.model', 'summarizer_evolve'),
}
SETTINGS = {
    'MAX_RETRY_ATTEMPTS', 'MAX_CREATION_ATTEMPTS', 'MAX_DEBUG_ATTEMPT',
    'MAX_ANALYSIS_ATTEMPTS', 'MAX_SUMMARY_ATTEMPTS', 'ENTROPY_THRESHOLD',
    'DRUGEVOLVE_TRAINING_TIMEOUT', 'DRUGEVOLVE_OBJECTIVE_SCORE_WEIGHT',
    'DRUGEVOLVE_LLM_SCORE_WEIGHT', 'CUDA_DEVICE',
}

def module(name):
    return importlib.import_module('Creation.' + name)

def atomic(path, value):
    from drugevolve.state import _atomic_json_write
    _atomic_json_write(path, value)

def configure(settings, root):
    workspace = Path(settings['workspace']).resolve()
    def resolve(value):
        return (workspace / value).resolve()
    code = resolve(settings['code_dir'])
    if not code.is_relative_to(workspace):
        raise ValueError('code_dir must be inside the task workspace')
    source = resolve(settings['source_file'])
    if not source.is_relative_to(code) or not source.is_file():
        raise ValueError('source_file must be an existing launcher inside code_dir')
    spec_path = resolve(settings['run_spec'])
    from drugevolve.config import load_run_spec
    spec = load_run_spec(spec_path)
    spec.require_ready(workspace)
    from drugevolve.state import RunWorkspace
    RunWorkspace(root).ensure_allowed(code / 'algorithm', spec.mutation_scope.writable_paths, workspace)
    if not settings.get('baseline_content', '').strip():
        raise ValueError('baseline_content must identify the actual baseline and metrics')
    # The public compatibility score maximizes normalized numeric CSV columns.
    if spec.evaluation.direction != 'maximize':
        raise ValueError('Normalize task metrics to higher-is-better CSV values for the pinned compatibility scorer')
    environment = {
        'DRUGEVOLVE_ROOT': str(workspace), 'DRUGEVOLVE_RUN_DIR': str(root),
        'DRUGEVOLVE_RUN_SPEC': str(spec_path), 'DRUGEVOLVE_CODE_DIR': str(code),
        'DRUGEVOLVE_SOURCE_FILE': str(source), 'DRUGEVOLVE_LOGS_DIR': str(code),
        'DRUGEVOLVE_AGENT_LOG_DIR': str(root / 'agent-logs'),
        'DRUGEVOLVE_BASELINE_CONTENT': settings['baseline_content'],
        'DRUGEVOLVE_DATASET': settings.get('dataset', 'default'),
        'DRUGEVOLVE_PROMPT_DIR': str(resolve(settings['prompt_dir'])) if settings.get('prompt_dir') else '',
    }
    unknown = set(settings.get('settings', {})) - SETTINGS
    if unknown:
        raise ValueError(f'Unsupported settings: {sorted(unknown)}')
    environment.update({k: str(v) for k, v in settings.get('settings', {}).items()})
    os.environ.update(environment)
    from config import Config
    Config.SAMPLER_TYPE = spec.sampling.algorithm
    Config.SAMPLER_EXPLORATION_COEFFICIENT = spec.sampling.exploration_coefficient
    Config.SAMPLER_NUM_ISLANDS = spec.sampling.num_islands
    Config.SAMPLER_EXPLORATION_RATIO = spec.sampling.exploration_ratio
    Config.SAMPLER_EXPLOITATION_RATIO = spec.sampling.exploitation_ratio
    Config.SAMPLER_FEATURE_DIMENSIONS = spec.sampling.feature_dimensions
    Config.SAMPLER_FEATURE_BINS = spec.sampling.feature_bins
    for key in ['MAX_RETRY_ATTEMPTS', 'MAX_CREATION_ATTEMPTS', 'MAX_DEBUG_ATTEMPT', 'MAX_ANALYSIS_ATTEMPTS', 'MAX_SUMMARY_ATTEMPTS', 'TRAINING_TIMEOUT']:
        if getattr(Config, key) <= 0:
            raise ValueError(f'{key} must be positive')
    if min(Config.OBJECTIVE_SCORE_WEIGHT, Config.LLM_SCORE_WEIGHT) < 0 or Config.OBJECTIVE_SCORE_WEIGHT + Config.LLM_SCORE_WEIGHT <= 0:
        raise ValueError('Score weights must be nonnegative with positive sum')
    return Config, spec

class Captured(BaseException):
    def __init__(self, agent, content):
        self.agent, self.content = agent, content

async def capture(_name, agent, content, **kwargs):
    raise Captured(agent, content)

def install_task_adapter(settings):
    import utils.experiment
    # Public parse_train_log is a placeholder. Supply the task-facing CSV
    # implementation so the original entropy monitor is actually operative.
    def parse_csv_log(content, k=1):
        rows = list(csv.DictReader(io.StringIO(content)))
        if not rows or 'entropy' not in rows[0]:
            return {'train': '', 'test': ''}
        return {'train': content, 'test': ''}
    utils.experiment.parse_train_log = parse_csv_log
    if settings.get('task_adapter'):
        adapter_path = (Path(settings['workspace']) / settings['task_adapter']).resolve()
        if not adapter_path.is_relative_to(Path(settings['workspace']).resolve()):
            raise ValueError('task_adapter must be inside the task workspace')
        spec = importlib.util.spec_from_file_location('scienceevolve_drugevolve_task_adapter', adapter_path)
        adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adapter)
        for name in ('parse_train_log', 'evaluate_algorithm'):
            if hasattr(adapter, name):
                fn = getattr(adapter, name)
                if not callable(fn): raise ValueError(f'{name} must be callable')
                setattr(utils.experiment, name, fn)

def install_capture():
    # Install before importing any role infer module; every bound `run` is
    # non-networked. Capture escapes upstream Exception retry handlers.
    import utils.agent
    utils.agent.run = capture

class Steps:
    def __init__(self, root, state):
        self.root, self.state = root, state
        self.C, self.spec = configure(state['config'], root)
        install_capture()
        install_task_adapter(state['config'])
        from drugevolve.state import RunWorkspace
        self.workspace = RunWorkspace(root).initialize()

    def save(self):
        atomic(self.root / 'scienceevolve-state.json', self.state)

    def transition(self, phase):
        self.state['phase'] = phase
        self.state['request_id'] = uuid.uuid4().hex
        self.save()

    def algorithm(self):
        from utils.algorithm import Algorithm
        return Algorithm.from_value(self.state['candidate']['algorithm'])

    def end_round(self, success, error='', skipped=False):
        s = self.state
        self.workspace.complete_step(success=success)
        s['consecutive_failures'] = 0 if success else s['consecutive_failures'] + (not skipped)
        record = {k: v for k, v in s.items() if k != 'config'}
        record.update(success=success, error=error, skipped=skipped)
        atomic(self.root / 'scienceevolve-rounds' / f"{s['attempts']:04d}.json", record)
        current = self.workspace.load_state()
        stop = ('max_rounds' if s['attempts'] >= self.spec.budget.max_rounds else
                'consecutive_failures' if s['consecutive_failures'] >= self.spec.budget.max_consecutive_failures else
                'patience' if success and self.spec.budget.patience > 0 and current.rounds_without_improvement >= self.spec.budget.patience else None)
        s['stop_reason'] = stop
        s['last_error'] = error
        self.transition('finished' if stop else 'sample')

    def research_retry(self, error):
        s = self.state
        s['research_attempt'] += 1
        if s['research_attempt'] > self.C.MAX_RETRY_ATTEMPTS:
            self.end_round(False, error, skipped=True)
        else:
            s.update(creation_attempt=1, repeated=None)
            self.transition('generator')

    def generation_retry(self, error, repeated=None):
        s = self.state
        s['creation_attempt'] += 1
        s['repeated'] = repeated
        if s['creation_attempt'] > self.C.MAX_CREATION_ATTEMPTS:
            self.research_retry(error)
        else:
            self.transition('generator')

    def failure(self, error):
        phase = self.state['phase']
        if phase in ('generator', 'inspector'):
            self.generation_retry(error)
        elif phase == 'implementer':
            self.research_retry(error)
        elif phase in ('analyzer', 'summarizer'):
            key = phase + '_attempt'
            self.state[key] += 1
            limit = self.C.MAX_ANALYSIS_ATTEMPTS if phase == 'analyzer' else self.C.MAX_SUMMARY_ATTEMPTS
            if self.state[key] <= limit:
                self.transition(phase)
            else:
                self.end_round(False, error)
        else:
            self.end_round(False, error)

    async def sample(self):
        s = self.state
        s['attempts'] += 1
        upstream = self.workspace.load_state()
        upstream.attempts += 1
        self.workspace.save_state(upstream)
        s['candidate'] = {}
        self.transition('sampling')
        try:
            context, parent, island = await module('infer').sample()
        except Exception as error:
            self.end_round(False, str(error))
            return
        s.update(context=context, parent=parent, island=island, research_attempt=1,
                 creation_attempt=1, repeated=None, candidate={}, train_attempt=0,
                 analyzer_attempt=1, summarizer_attempt=1)
        self.transition('generator')

    async def prompt(self):
        s, phase = self.state, self.state['phase']
        if phase not in ROLES:
            raise ValueError('Current phase has no LLM prompt')
        agent = getattr(module(ROLES[phase][0]), ROLES[phase][1])
        candidate = s['candidate']
        if phase == 'generator':
            prompts = module('Researcher.creator.generator.prompt')
            content = prompts.generator_input(s['context'])
            if s.get('repeated'):
                duplicates = await module('Researcher.inspector.infer').get_repeated_context(s['repeated']['repeated_index'])
                content = prompts.generator_input_duplicate(s['context'], duplicates)
        elif phase == 'implementer':
            content = module('Researcher.implementer.prompt').implementer_input(candidate['name'], self.algorithm())
        else:
            try:
                if phase == 'inspector':
                    await module('Researcher.inspector.infer').check_repeated_motivation(self.algorithm())
                elif phase == 'debugger':
                    await module('Engineer.debugger.infer').debug(candidate['name'], self.algorithm(), candidate['log_file'])
                elif phase == 'judger':
                    await module('Engineer.judger.infer').judge(self.algorithm(), candidate['result'])
                elif phase == 'analyzer':
                    from Database import create_client
                    from utils.experiment import keep_header_and_final
                    refs = create_client().get_contextual_elements(s['parent']) if s['parent'] else []
                    result = '\n--- TEST CSV START ---\n\n' + keep_header_and_final(candidate['result'].get('test', '')) + '\n--- TEST CSV END ---'
                    await module('Analyst.analyzer.infer').analysis(candidate['name'], result, self.algorithm(), refs, candidate['case_study'])
                else:
                    await module('Analyst.summarizer_evolve.infer').summary_for_evolve(self.algorithm(), candidate['analysis'], candidate['cognition'])
            except Captured as captured:
                agent, content = captured.agent, captured.content
            else:
                raise RuntimeError('Upstream role did not request a model response')
        payload = dict(request_id=s['request_id'], role=phase, instructions=agent.instructions,
                       input=content, output_schema=agent.output_type.model_json_schema(),
                       candidate_directory=candidate.get('directory'),
                       tools=[tool.name for tool in agent.tools])
        atomic(self.root / 'requests' / f"{s['request_id']}.json", payload)
        return payload

    def submit(self, payload):
        s, phase = self.state, self.state['phase']
        agent = getattr(module(ROLES[phase][0]), ROLES[phase][1])
        value = agent.output_type.model_validate(payload)
        c = s['candidate']
        if phase == 'generator':
            if not re.fullmatch(r'[a-z][a-z0-9_]{0,79}', value.name):
                raise ValueError('Expected a safe snake_case candidate name')
            s['candidate'] = dict(name=value.name, algorithm={k: getattr(value, k) for k in ['motivation', 'explain', 'math']})
            self.transition('inspector')
        elif phase == 'inspector':
            if value.is_repeated:
                self.generation_retry('Repeated proposal', value.model_dump())
            else:
                from utils.copy_launch_script import generate_model_content
                directory = Path(self.C.CODE_DIR) / 'algorithm' / c['name']
                directory.mkdir(parents=True, exist_ok=False)
                (directory / 'model.py').write_text(generate_model_content())
                c['directory'] = str(directory)
                self.transition('implementer')
        elif phase == 'implementer':
            from utils.copy_launch_script import generate_model_content, generate_training_script
            model = Path(c['directory']) / 'model.py'
            if not value.success or model.read_text() == generate_model_content():
                raise ValueError('Implementer must successfully replace the starter model.py')
            compile(model.read_text(), str(model), 'exec')
            c['timestamped_name'] = datetime.now().strftime('%Y%m%d-%H:%M:%S-') + c['name']
            c['log_file'] = str(Path(self.C.LOGS_DIR) / (c['timestamped_name'] + '.log'))
            c['launcher'] = generate_training_script(c['name'], c['timestamped_name'], self.C.SOURCE_FILE)
            self.transition('train')
        elif phase == 'debugger':
            self.transition('train')
        elif phase == 'judger':
            c['llm_score'], c['complexity'] = value.final_score, value.complexity
            a, b = self.C.OBJECTIVE_SCORE_WEIGHT, self.C.LLM_SCORE_WEIGHT
            c['score'] = (a * c['objective'] + b * value.final_score) / (a + b)
            self.transition('analyzer')
        elif phase == 'analyzer':
            c['analysis'] = (f'Is the algorithm achieve its stated motivation? {value.get_expectation}\n'
                f'Is the algorithm better than the baseline? {value.better_than_baseline}\n'
                f'Component comparison analysis: {value.component_comparison_analysis}\n'
                f'Related element analysis: {value.related_element_analysis}\n'
                f'Existing problems: {value.existing_problems}\n'
                f'Generated case assessment: {value.case_assessment}\n')
            from drugevolve.cognition import CognitionStore
            matches = CognitionStore(self.root / 'cognition').search(' '.join(c['algorithm'].values()), top_k=3)
            c['cognition'] = '\n'.join('- ' + item.content for item, _ in matches) if matches else 'NULL'
            self.transition('summarizer')
        else:
            c['experience'] = value.summary
            self.transition('archive')

    async def train(self):
        c = self.state['candidate']
        self.state['train_attempt'] += 1
        # Persist before starting external work. A crash cannot silently rerun
        # training; `status` reports training until an operator records failure.
        self.transition('training')
        os.environ['DRUGEVOLVE_CURRENT_LOG'] = c['log_file']
        engineer = module('Engineer.main')
        kill = threading.Event()
        engineer._start_monitor_thread(c['name'], c['log_file'], kill)
        try:
            ok, error = await module('Engineer.trainer.infer').train(c['launcher'], cancel_event=kill)
            aborted = not ok and kill.is_set()
        finally:
            engineer._stop_monitor_thread(c['name'])
        atomic(self.root / 'training' / f"{self.state['attempts']:04d}-{self.state['train_attempt']}.json",
               dict(success=ok, error=error, entropy_abort=aborted))
        if not ok and not aborted:
            if self.state['train_attempt'] >= self.C.MAX_DEBUG_ATTEMPT:
                self.end_round(False, f'Training failed after {self.C.MAX_DEBUG_ATTEMPT} attempts: {error}')
            else:
                c['last_training_error'] = error
                self.transition('debugger')
            return
        target = Path(self.C.CODE_DIR) / 'algorithm' / c['timestamped_name']
        shutil.move(c['directory'], target)
        c['directory'] = str(target)
        from utils.experiment import read_py_files_in_dir, collect_algorithm_results, collect_score_detail, get_case, evaluate_algorithm
        c.update(program=read_py_files_in_dir(str(target)), result=collect_algorithm_results(str(target)),
                 score_detail=collect_score_detail(str(target)), case_study=get_case(str(target)),
                 objective=0.0 if aborted else (evaluate_algorithm(str(target)) or 0.0), entropy_abort=aborted)
        if aborted:
            c['result']['test'] = engineer._CRASH_MESSAGE
        self.transition('judger')

    async def archive(self):
        from Database import DataElement, create_client
        c = self.state['candidate']
        element = DataElement(index=0, parent=self.state['parent'], name=c['name'], mode='creation',
            result=c['result'], program=c['program'], algorithm=self.algorithm(), analysis=c['analysis'],
            cognition=c['cognition'], experience=c['experience'], ablation=None, enhancement=None,
            score=c['score'], score_detail=c['score_detail'], llm_score=c['llm_score'],
            complexity=c['complexity'], island=self.state['island'])
        self.transition('archiving')
        response = create_client().add_element(element.to_dict())
        c['node_id'] = response.data['index']
        self.end_round(True)

async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', type=Path, required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init'); init.add_argument('config', type=Path)
    for name in ['status', 'prompt', 'advance']: sub.add_parser(name)
    submit = sub.add_parser('submit'); submit.add_argument('response', type=Path); submit.add_argument('--request-id', required=True)
    fail = sub.add_parser('fail'); fail.add_argument('reason'); fail.add_argument('--request-id', required=True)
    args = parser.parse_args(); root = args.run_dir.resolve(); root.mkdir(parents=True, exist_ok=True)
    # A second CLI must not race a training, sampling or archive operation.
    import fcntl
    with (root / '.scienceevolve.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_file = root / 'scienceevolve-state.json'
        if args.command == 'init':
            if state_file.exists(): raise ValueError('Already initialized; use status to resume')
            settings = json.loads(args.config.read_text())
            settings['workspace'] = str(Path(settings['workspace']).resolve())
            state = dict(config=settings, phase='sample', request_id=uuid.uuid4().hex,
                         attempts=0, consecutive_failures=0)
            steps = Steps(root, state)
            from drugevolve.cognition import CognitionStore
            for filename in steps.spec.cognition.seed_files:
                file = Path(settings['workspace']) / filename
                CognitionStore(root / 'cognition').add(file.read_text(), source=str(file))
            steps.save()
        else:
            steps = Steps(root, json.loads(state_file.read_text()))
            if args.command == 'prompt':
                print(json.dumps(await steps.prompt(), ensure_ascii=False)); return
            if args.command in ('submit', 'fail'):
                if args.request_id != steps.state['request_id']: raise ValueError('Stale request ID; inspect status')
                if args.command == 'fail':
                    if steps.state['phase'] in ('sample', 'finished'):
                        raise ValueError('No active round to fail; inspect status')
                    steps.failure(args.reason)
                else:
                    if steps.state['phase'] not in ROLES:
                        raise ValueError('Current phase does not accept a model response')
                    payload = json.loads(args.response.read_text())
                    atomic(root / 'responses' / f'{args.request_id}.json', payload)
                    try: steps.submit(payload)
                    except Exception as error: steps.failure(str(error))
            elif args.command == 'advance':
                phase = steps.state['phase']
                if phase not in ('sample', 'train', 'archive'): raise ValueError(f'Cannot advance phase {phase}')
                with contextlib.redirect_stdout(sys.stderr):
                    await getattr(steps, phase)()
        print(json.dumps({k: v for k, v in steps.state.items() if k != 'config'}, ensure_ascii=False))

if __name__ == '__main__':
    asyncio.run(main())
