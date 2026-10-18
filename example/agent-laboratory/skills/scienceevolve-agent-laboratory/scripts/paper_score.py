#!/usr/bin/env python3
"""Apply the unchanged upstream score formula to an actual review response."""
import argparse
import ast
import json
from pathlib import Path
import re


def score(response):
    source = Path(__file__).resolve().parents[1]/'upstream/agents.py'
    tree = ast.parse(source.read_text())
    wanted = {'extract_json_between_markers','get_score'}
    functions = [n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in wanted]
    if len(functions) != 2: raise ValueError('Pinned upstream scoring functions missing')
    # The reviewer has already run in its own SCIENCEEVOLVE role. This boundary supplies
    # that verbatim response to the original parser/formula, not a model surrogate.
    scope = dict(json=json,re=re,query_model=lambda **kwargs:response)
    exec(compile(ast.Module(body=functions,type_ignores=[]),str(source),'exec'),scope)
    value, detail, ok = scope['get_score']('', '', 'scienceevolve-review-file')
    if not ok: raise ValueError('Invalid original reviewer response: '+detail)
    return dict(score=value,raw_response=response)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('response',type=Path);a=p.parse_args()
    print(json.dumps(score(a.response.read_text()),indent=2))
