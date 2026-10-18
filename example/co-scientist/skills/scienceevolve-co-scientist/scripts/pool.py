#!/usr/bin/env python3
"""Durable hypothesis/review/proximity/tournament state for SCIENCEEVOLVE co-scientist."""
import argparse
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import random
import re
import tempfile
import uuid

REVIEWS = ('initial','full','deep_verification','observation','simulation','recurrent')
STRATEGIES = ('grounding','coherence_feasibility','inspiration','combination','simplification','out_of_box')
DEFAULTS = dict(initial_elo=1200,k_factor=32,elo_scale=400,top_fraction=.25,seed=42)


def digest(obj):return hashlib.sha256(json.dumps(obj,sort_keys=True,ensure_ascii=False).encode()).hexdigest()

def write(path,obj):
    fd,tmp=tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f:json.dump(obj,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)


@contextmanager
def transaction(root):
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    with (root/'.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        state=json.loads((root/'pool.json').read_text()) if (root/'pool.json').exists() else None
        if state:
            for h in state['hypotheses'].values():
                if digest(h['content']) != h['sha256']:raise ValueError('Immutable hypothesis was modified')
        yield state
        if state is not None:write(root/'pool.json',state)


def initialize(root,plan,options=None):
    root=Path(root)
    with transaction(root) as existing:
        if existing is not None:raise ValueError('Pool already exists')
        cfg={**DEFAULTS,**(options or {})}
        if set(cfg)!=set(DEFAULTS) or any(not isinstance(cfg[k],(int,float)) or not math.isfinite(cfg[k]) for k in DEFAULTS):raise ValueError('Unknown or nonfinite parameters')
        if cfg['initial_elo']!=1200 or not 0<cfg['top_fraction']<=1 or cfg['k_factor']<=0 or cfg['elo_scale']<=0:raise ValueError('Invalid Elo parameters')
        for k in ['goal','criteria','constraints','stop_condition']:
            if k not in plan:raise ValueError('Research plan missing '+k)
        write(root/'pool.json',dict(schema=1,epoch=0,plans=[plan],config=cfg,hypotheses={},reviews=[],graph={},matches={},feedback=[],events=[],rng=random.Random(cfg['seed']).getstate()))


def event(state,kind,payload):state['events'].append(dict(index=len(state['events']),epoch=state['epoch'],kind=kind,payload=payload))

def eligible(s,identifier):
    reviews=[r for r in s['reviews'] if r['hypothesis']==identifier and r['epoch']==s['epoch']]
    latest={r['kind']:r for r in reviews}
    return all(k in latest and latest[k]['decision'] in ('pass','not_applicable') for k in REVIEWS[:5]) and not any(r['decision']=='reject' for r in latest.values())


def add(root,content):
    with transaction(root) as s:
        for k in ['summary','category','mechanism','assumptions','evidence','test_plan','source']:
            if k not in content:raise ValueError('Hypothesis missing '+k)
        if content['source'] not in ('generation','evolution','expert'):raise ValueError('Unknown provenance')
        parents=content.get('parents',[])
        if any(x not in s['hypotheses'] for x in parents):raise ValueError('Unknown parent')
        if content['source']=='evolution' and (not parents or content.get('strategy') not in STRATEGIES):raise ValueError('Evolution needs parent IDs and a complete-method strategy')
        identifier=content.get('id') or 'h_'+uuid.uuid4().hex
        if not isinstance(identifier,str) or not re.fullmatch(r'[A-Za-z0-9_-]+',identifier):raise ValueError('Invalid hypothesis ID')
        if identifier in s['hypotheses']:
            if s['hypotheses'][identifier]['sha256']==digest(content):return identifier
            raise ValueError('Cannot overwrite a hypothesis; add a new ID')
        s['hypotheses'][identifier]=dict(content=copy.deepcopy(content),sha256=digest(content),rating=s['config']['initial_elo'],games=0,created=len(s['events']))
        event(s,'hypothesis_added',identifier);return identifier


def review(root,record):
    with transaction(root) as s:
        if record['hypothesis'] not in s['hypotheses'] or record['kind'] not in REVIEWS:raise ValueError('Unknown hypothesis/review type')
        if record['decision'] not in ('pass','reject','not_applicable') or not record.get('rationale'):raise ValueError('Review needs a decision and substantive rationale')
        if record['kind']=='initial' and record['decision']=='not_applicable':raise ValueError('Initial review is required')
        if record['kind'] not in ('initial','recurrent'):
            initial=[r for r in s['reviews'] if r['epoch']==s['epoch'] and r['hypothesis']==record['hypothesis'] and r['kind']=='initial']
            if not initial or initial[-1]['decision']!='pass':raise ValueError('Initial review must pass first')
        s['reviews'].append({**record,'epoch':s['epoch']});event(s,'review',s['reviews'][-1]);return eligible(s,record['hypothesis'])


def graph(root,edges):
    with transaction(root) as s:
        ids=s['hypotheses']
        for e in edges:
            a,b=e['a'],e['b'];value=e['similarity']
            if a==b or a not in ids or b not in ids or not isinstance(value,(int,float)) or not math.isfinite(value) or not 0<=value<=1 or not e.get('rationale'):raise ValueError('Invalid evidence-based proximity edge')
            s['graph']['|'.join(sorted((a,b)))]=dict(**e,epoch=s['epoch'])
        event(s,'graph_updated',edges)


def ranking(s):return sorted((i for i in s['hypotheses'] if eligible(s,i)),key=lambda i:s['hypotheses'][i]['rating'],reverse=True)

def pair(root):
    def tuples(x):return tuple(tuples(y) for y in x) if isinstance(x,list) else x
    with transaction(root) as s:
        ids=ranking(s)
        if len(ids)<2:raise ValueError('Need two fully reviewed hypotheses')
        pairs=list(itertools.combinations(ids,2));weights=[]
        for a,b in pairs:
            edge=s['graph'].get('|'.join(sorted((a,b))),{})
            if edge.get('epoch')!=s['epoch']:raise ValueError('Update proximity for every eligible pair before scheduling')
            near=edge.get('similarity',0) if edge.get('epoch')==s['epoch'] else 0
            fresh=sum(1/(1+s['hypotheses'][x]['games']) for x in (a,b))
            top=sum(1/(1+ids.index(x)) for x in (a,b))
            weights.append(1+3*near+fresh+top)
        rng=random.Random();rng.setstate(tuples(s['rng']));a,b=rng.choices(pairs,weights=weights,k=1)[0];s['rng']=rng.getstate()
        top=ids[:max(2,math.ceil(len(ids)*s['config']['top_fraction']))]
        result=dict(id='m_'+uuid.uuid4().hex,a=a,b=b,epoch=s['epoch'],mode='debate' if a in top and b in top else 'single_turn')
        event(s,'pair_selected',result);return result


def match(root,record):
    with transaction(root) as s:
        identifier=record['id']
        if identifier in s['matches']:
            if s['matches'][identifier]['record']==record:return s['matches'][identifier]
            raise ValueError('Cannot change an existing match')
        if record['epoch']!=s['epoch']:raise ValueError('Stale research goal epoch')
        selected=[e['payload'] for e in s['events'] if e['kind']=='pair_selected' and e['payload']['id']==identifier]
        if not selected or any(record[k]!=selected[-1][k] for k in ('a','b','mode','epoch')):raise ValueError('Match does not match scheduled pair')
        a,b=record['a'],record['b']
        if not eligible(s,a) or not eligible(s,b):raise ValueError('Filtered or insufficiently reviewed hypothesis')
        if record['winner'] not in (a,b,'tie') or not record.get('rationale'):raise ValueError('Missing actual comparison result')
        if record['mode']=='debate':
            if len(record.get('debate',[]))<4 or len(set(t['speaker'] for t in record['debate']))<2 or not record.get('order_swapped_check'):raise ValueError('Top pair requires multi-turn debate and ordering-bias check')
        expected=1/(1+10**((s['hypotheses'][b]['rating']-s['hypotheses'][a]['rating'])/s['config']['elo_scale']))
        score=.5 if record['winner']=='tie' else float(record['winner']==a)
        delta=s['config']['k_factor']*(score-expected)
        before={x:s['hypotheses'][x]['rating'] for x in (a,b)}
        for x,d in [(a,delta),(b,-delta)]:s['hypotheses'][x]['rating']+=d;s['hypotheses'][x]['games']+=1
        result=dict(record=record,before=before,after={x:s['hypotheses'][x]['rating'] for x in (a,b)})
        s['matches'][identifier]=result;event(s,'match_completed',identifier);return result


def feedback(root,record):
    with transaction(root) as s:
        for k in ['recurring_issues','agent_feedback','research_overview','experiments','contacts']:
            if k not in record:raise ValueError('Incomplete meta-review: '+k)
        s['feedback'].append(dict(**record,epoch=s['epoch'],version=len(s['feedback'])+1));event(s,'meta_review',len(s['feedback']));return s['feedback'][-1]


def replan(root,plan):
    for k in ['goal','criteria','constraints','stop_condition']:
        if k not in plan:raise ValueError('Incomplete updated plan')
    with transaction(root) as s:
        s['plans'].append(plan);s['epoch']+=1
        for h in s['hypotheses'].values():h['rating']=s['config']['initial_elo'];h['games']=0
        event(s,'goal_changed',plan)


def stats(root):
    with transaction(root) as s:
        ids=ranking(s);parent={i:i for i in s['hypotheses']}
        def find(x):
            while parent[x]!=x:x=parent[x]
            return x
        for e in s['graph'].values():
            if e['epoch']==s['epoch'] and e['similarity']>=.8:parent[find(e['a'])]=find(e['b'])
        clusters={}
        for i in parent:clusters.setdefault(find(i),[]).append(i)
        sources={}
        for i,h in s['hypotheses'].items():
            source=h['content']['source'];d=sources.setdefault(source,dict(count=0,eligible=0,wins=0))
            d['count']+=1;d['eligible']+=int(i in ids)
        for m in s['matches'].values():
            r=m['record']
            if r['epoch']==s['epoch'] and r['winner']!='tie':sources[s['hypotheses'][r['winner']]['content']['source']]['wins']+=1
        latest={}
        for r in s['reviews']:
            if r['epoch']==s['epoch']:latest[(r['hypothesis'],r['kind'])]=r
        rejected={i for (i,k),r in latest.items() if r['decision']=='reject'}
        return dict(epoch=s['epoch'],hypotheses=len(parent),requiring_review=len(parent)-len(ids)-len(rejected),filtered=sorted(rejected),
                    ranked=[dict(id=i,rating=s['hypotheses'][i]['rating'],games=s['hypotheses'][i]['games']) for i in ids],
                    generation_method_stats=sources,clusters=list(clusters.values()),
                    latest_feedback=next((f for f in reversed(s['feedback']) if f['epoch']==s['epoch']),None))


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True)
    p.add_argument('command',choices=['init','add','review','graph','pair','match','feedback','stats','replan']);p.add_argument('--input',type=Path);p.add_argument('--plan',type=Path);p.add_argument('--options',type=Path)
    a=p.parse_args();value=json.loads(a.input.read_text()) if a.input else None
    if a.command=='init':result=initialize(a.root,json.loads(a.plan.read_text()),json.loads(a.options.read_text()) if a.options else None)
    elif a.command in ('pair','stats'):result=globals()[a.command](a.root)
    elif a.command=='replan':result=replan(a.root,json.loads(a.plan.read_text()))
    else:result=globals()[a.command](a.root,value)
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
