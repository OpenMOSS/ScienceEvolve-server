#!/usr/bin/env python3
"""Dispatch one Robin analysis stage; SCIENCEEVOLVE owns the inter-stage transition."""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import sys


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def plan(phase, kind, data, output, prompts, analysis_receipt=None):
    """Provider-independent exact arguments for the original Step primitive."""
    if phase == 'analysis':
        query = prompts.analysis_queries[kind]
        inputs = {str(Path(data).resolve()): 'flow_250508/'}
        outputs = {'flow_results.csv': 'flow_results/flow_results.csv'}
        parallel = 5
    elif phase == 'consensus':
        receipt = json.loads(Path(analysis_receipt).read_text())
        if receipt['phase'] != 'analysis' or receipt['kind'] != kind or len(receipt['task_ids']) != 5 or len(set(receipt['task_ids'])) != 5:
            raise ValueError('Consensus requires five independent completed analysis trajectories')
        if len(receipt['files']) != 5:
            raise ValueError('Missing analysis outputs')
        for f, sha in receipt['files'].items():
            if digest(f) != sha: raise ValueError('Analysis evidence changed')
        query = prompts.consensus_queries[kind]
        inputs = {str(Path(receipt['directory'])/'flow_results'): 'flow_results/'}
        outputs = {'consensus_results.csv': 'consensus_results.csv'}
        parallel = 1
    else:
        raise ValueError('Unknown phase')
    return dict(name='job-futurehouse-data-analysis-crow-high',
                prompt_template=f'Here is the user query to address:\n{prompts.cot}\n{prompts.guideline}\n<query>\n{query}\n</query>\n',
                cot_prompt=False, input_files=inputs, output_files=outputs, parallel=parallel,
                config=dict(language='R', max_steps=30, timeout=900))


async def execute(args):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'upstream'))
    from robin.configuration import RobinConfiguration
    from robin.multitrajectory_runner import Step, StepConfig
    cfg = RobinConfiguration(**json.loads(args.config.read_text()))
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    receipt_path = output/(args.phase+'.json')
    if receipt_path.exists():
        raise ValueError('Stage already has a receipt; inspect it instead of resubmitting')
    # An interrupted paid submission must be reconciled by remote task IDs before retry.
    marker = output/(args.phase+'-submitted.json')
    if marker.exists():
        raise ValueError('Unreconciled submission; recover original remote tasks before retry')
    spec = plan(args.phase, args.kind, args.data, output, cfg.prompts, args.analysis_receipt)
    step = Step(**{**spec, 'config':StepConfig(**spec['config'])})
    marker.write_text(json.dumps(step.model_dump(mode='json'), indent=2)+'\n')
    runner = cfg.get_da_client(); runner.add_step(step)
    await runner.run_pipeline(str(output))
    result = runner.results[step.step_id]
    if result['success_rate'] != 1 or len(result['task_ids']) != spec['parallel']:
        raise ValueError('Not all required trajectories succeeded; inspect saved remote results')
    directory = output/step.step_id
    paths = ([directory/'flow_results'/f'flow_results_{i}.csv' for i in range(5)]
             if args.phase == 'analysis' else [directory/'consensus_results.csv'])
    if any(not f.is_file() or not f.stat().st_size for f in paths):
        raise ValueError('Missing downloaded results; recover files from existing remote task IDs')
    receipt = dict(phase=args.phase, kind=args.kind, directory=str(directory),
                   task_ids=result['task_ids'], files={str(f):digest(f) for f in paths})
    receipt_path.write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt, indent=2))


def main():
    p=argparse.ArgumentParser(); p.add_argument('phase', choices=['analysis','consensus'])
    p.add_argument('--config',type=Path,required=True); p.add_argument('--kind',required=True,choices=['flow_cytometry','RNA_seq'])
    p.add_argument('--data'); p.add_argument('--output',type=Path,required=True); p.add_argument('--analysis-receipt',type=Path)
    a=p.parse_args()
    if a.phase=='analysis' and not a.data: p.error('analysis requires --data')
    if a.phase=='consensus' and not a.analysis_receipt: p.error('consensus requires --analysis-receipt')
    asyncio.run(execute(a))

if __name__=='__main__': main()
