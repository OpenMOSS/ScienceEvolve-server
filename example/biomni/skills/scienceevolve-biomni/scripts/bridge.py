#!/usr/bin/env python3
"""Atomic A1 steps. SCIENCEEVOLVE supplies each model response; no A1.go/app invocation.

Run the server in the Task's E1 environment. Its persistent Python interpreter
is shared by execution steps, as in upstream A1. This is not an OS sandbox.
"""
import argparse
import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import sys
import tempfile

UPSTREAM = Path(__file__).resolve().parents[1] / 'upstream'


def atomic(path, value):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class NeedsResponse(Exception):
    def __init__(self, messages):
        self.messages = messages


class Relay:
    response = None

    def invoke(self, messages):
        from langchain_core.messages import AIMessage
        if self.response is None:
            raise NeedsResponse(messages)
        value, self.response = self.response, None
        return AIMessage(content=value)


def upstream():
    sys.path.insert(0, str(UPSTREAM))
    from biomni.agent import a1
    return a1


def check_data(module, path, commercial):
    if commercial:
        from biomni.env_desc_cm import data_lake_dict
    else:
        from biomni.env_desc import data_lake_dict
    lake = Path(path) / 'biomni_data' / 'data_lake'
    missing = [name for name in data_lake_dict if not (lake / name).exists()]
    if not (Path(path) / 'biomni_data' / 'benchmark' / 'hle').is_dir():
        missing.append('benchmark/hle')
    if missing:
        raise ValueError('Incomplete default data lake; run prepare-data: ' + ', '.join(missing))


class Engine:
    def __init__(self, root, config, *, agent=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        if (self.root / 'state.json').exists() or (self.root / 'inflight.json').exists():
            raise RuntimeError('Prior interpreter state exists. Do not replay tool calls. Reconcile jobs and start a new run directory.')
        self.module = upstream()
        self.relay = Relay()
        if agent is None:
            check_data(self.module, config['data_path'], config.get('commercial_mode', False))
            old = self.module.get_llm
            self.module.get_llm = lambda *a, **kw: self.relay
            try:
                # Upstream constructor prints configuration, including credential fields.
                with contextlib.redirect_stdout(io.StringIO()):
                    agent = self.module.A1(path=config['data_path'],
                        use_tool_retriever=config.get('use_tool_retriever', True),
                        timeout_seconds=config.get('timeout_seconds', 600),
                        commercial_mode=config.get('commercial_mode', False),
                        expected_data_lake_files=[])
            finally:
                self.module.get_llm = old
        self.agent = agent
        agent.llm = self.relay
        rounds = config.get('test_time_scale_round', 0)
        if not isinstance(rounds, int) or rounds < 0:
            raise ValueError('test_time_scale_round must be a nonnegative integer')
        self.critic = config.get('self_critic', False)
        agent.configure(self_critic=self.critic, test_time_scale_round=rounds)
        # Optional Task code registers atomic tools/MCP/data/software using A1's
        # original add_* methods. It must not launch another autonomous agent.
        if config.get('extension'):
            spec = importlib.util.spec_from_file_location('task_biomni_extension', config['extension'])
            extension = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = extension
            spec.loader.exec_module(extension)
            extension.configure(agent)
            agent.llm = self.relay
            agent.configure(self_critic=self.critic, test_time_scale_round=rounds)
        agent.critic_count = 0
        agent.user_task = config['task']
        self.state = dict(messages=[self.module.HumanMessage(content=config['task'])], next_step=None)
        self.phase = 'retrieve' if agent.use_tool_retriever else 'generate'
        self.steps = 0
        self.receipts = {}
        self.blocked = False
        # Reuse the pinned implementation's individual closures, not its graph.
        tree = ast.parse((UPSTREAM / 'biomni/agent/a1.py').read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'A1')
        configure = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'configure')
        functions = [n for n in configure.body if isinstance(n, ast.FunctionDef)
                     and n.name in ('generate', 'execute', 'execute_self_critic')]
        namespace = {**vars(self.module), 'self': agent, 'test_time_scale_round': rounds}
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'upstream/A1.configure', 'exec'), namespace)
        self.functions = namespace
        self.save()

    def save(self):
        from langchain_core.messages import messages_to_dict
        atomic(self.root / 'state.json', dict(phase=self.phase, steps=self.steps,
            messages=messages_to_dict(self.state['messages']), next_step=self.state['next_step'],
            critic_count=self.agent.critic_count, system_prompt=self.agent.system_prompt,
            execution_results=getattr(self.agent, '_execution_results', []),
            receipts=self.receipts, blocked=self.blocked))

    def step(self):
        if self.phase == 'retrieve':
            resources = self.agent._prepare_resources_for_retrieval(self.agent.user_task)
            self.agent.update_system_prompt_with_selected_resources(resources)
            atomic(self.root / 'resources.json', resources)
            self.phase = 'generate'
        elif self.phase == 'generate':
            self.functions['generate'](self.state)
            next_step = self.state['next_step']
            self.phase = ('critic' if self.critic else 'end') if next_step == 'end' else next_step
        elif self.phase == 'execute':
            # Upstream generate accepts mixed-case XML/code fences; execute only
            # accepts lowercase XML. Normalize the transport, preserve raw response.
            raw = self.state['messages'][-1].content
            m = re.search(r'<execute>(.*?)</execute>', raw, re.S | re.I)
            code = m[1] if m else None
            if m is None:
                m = re.search(r'```(python|bash|r)?\s*(.*?)```', raw, re.S)
                if m:
                    code = {'bash':'#!BASH\n', 'r':'#!R\n'}.get(m[1], '') + m[2]
            if code is None:
                raise ValueError('No executable block')
            original = self.state['messages'][-1]
            original_index = len(self.state['messages']) - 1
            self.state['messages'][-1] = self.module.AIMessage(content='<execute>' + code + '</execute>')
            previous_results = len(getattr(self.agent, '_execution_results', []))
            try:
                self.functions['execute'](self.state)
                if len(getattr(self.agent, '_execution_results', [])) > previous_results:
                    self.agent._execution_results[-1]['triggering_message'] = raw
            finally:
                # execute appends observation, and does not replace prior messages.
                self.state['messages'][original_index] = original
            self.phase = 'generate'
        elif self.phase == 'critic':
            self.functions['execute_self_critic'](self.state)
            self.phase = self.state['next_step']
        else:
            raise ValueError('Run already ended')
        self.steps += 1
        if self.steps >= 500 and self.phase != 'end':
            self.blocked = True  # Same graph recursion budget; not successful completion.

    def prompt(self):
        from langchain_core.messages import messages_to_dict
        if self.phase not in ('retrieve', 'generate', 'critic'):
            return dict(phase=self.phase, steps=self.steps)
        # A critic with no remaining rounds is a non-model transition.
        if self.phase == 'critic' and self.agent.critic_count >= self.functions['test_time_scale_round']:
            return dict(phase=self.phase, action='advance')
        try:
            if self.phase == 'retrieve':
                self.agent._prepare_resources_for_retrieval(self.agent.user_task)
            else:
                self.functions['generate' if self.phase == 'generate' else 'execute_self_critic'](self.state)
        except NeedsResponse as need:
            messages = messages_to_dict(need.messages)
            token = hashlib.sha256(json.dumps([self.phase, self.steps, messages], sort_keys=True).encode()).hexdigest()
            return dict(phase=self.phase, steps=self.steps, prompt_id=token, messages=messages)
        raise RuntimeError('Model handoff did not yield')

    def request(self, request):
        action = request['action']
        if action == 'status':
            return dict(phase=self.phase, steps=self.steps, blocked=self.blocked)
        if self.blocked:
            raise RuntimeError('Run blocked; inspect state/inflight and actual tool jobs before reconciliation')
        if action == 'prompt':
            return self.prompt()
        identifier = request['id']
        if identifier in self.receipts:
            entry = self.receipts[identifier]
            if entry['request'] != request:
                raise ValueError('Request ID reused with different input')
            return entry['result']
        if action == 'respond':
            prompt = self.prompt()
            if prompt.get('prompt_id') != request.get('prompt_id') or 'prompt_id' not in prompt:
                raise ValueError('Stale or absent model prompt')
            if not isinstance(request.get('response'), str) or not request['response'].strip():
                raise ValueError('A real model response is required')
        elif action == 'advance':
            if self.phase != 'execute' and not (self.phase == 'critic' and self.prompt().get('action') == 'advance'):
                raise ValueError('This phase requires a model response')
        elif action != 'export':
            raise ValueError('Unknown action')
        atomic(self.root / 'inflight.json', request)
        try:
            if action == 'export':
                if self.phase != 'end':
                    raise ValueError('Export final report only after the solution/critique loop ends')
                self.agent._conversation_state = self.state
                self.agent.log = [str(m.content) for m in self.state['messages']]
                (self.root / 'conversation.md').write_text(self.agent._generate_markdown_content(True))
                self.agent.save_conversation_history(str(self.root / 'conversation.md'), save_pdf=request.get('pdf', True))
                if request.get('pdf', True) and not (self.root / 'conversation.pdf').is_file():
                    raise RuntimeError('Upstream PDF conversion failed; Markdown and state are retained')
            else:
                self.relay.response = request.get('response')
                self.step()
            result = dict(phase=self.phase, steps=self.steps, blocked=self.blocked,
                          last_message=self.state['messages'][-1].content)
            self.receipts[identifier] = dict(request=request, result=result)
            self.save()
            (self.root / 'inflight.json').unlink()
            return result
        except Exception:
            self.blocked = True
            self.save()
            raise
        finally:
            self.relay.response = None


def serve(root, config):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # Independent SCIENCEEVOLVE runs cannot share an interpreter or overwrite its journal.
    import fcntl
    with (root / '.server.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with contextlib.redirect_stdout(io.StringIO()):
            engine = Engine(root, config)
        # Short local socket avoids AF_UNIX's 108-byte path limit.
        with tempfile.TemporaryDirectory(prefix='scienceevolve-biomni-') as temp:
            address = str(Path(temp) / 'socket')
            class Handler(socketserver.StreamRequestHandler):
                def handle(self):
                    try:
                        request = json.loads(self.rfile.readline())
                        with contextlib.redirect_stdout(io.StringIO()):
                            result = dict(ok=True, result=engine.request(request))
                    except Exception as e:
                        result = dict(ok=False, error=str(e))
                    self.wfile.write((json.dumps(result, ensure_ascii=False) + '\n').encode())
            with socketserver.UnixStreamServer(address, Handler) as server:
                os.chmod(address, 0o600)
                atomic(root / 'server.json', dict(socket=address, pid=os.getpid()))
                server.serve_forever()


def call(root, request):
    address = json.loads((Path(root) / 'server.json').read_text())['socket']
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(address)
        client.sendall((json.dumps(request) + '\n').encode())
        with client.makefile('r') as stream:
            return json.loads(stream.readline())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['serve', 'call', 'prepare-data'])
    p.add_argument('--root', type=Path)
    p.add_argument('--config', type=Path)
    p.add_argument('--input', type=Path)
    args = p.parse_args()
    if args.command == 'call':
        result = call(args.root, json.loads(args.input.read_text()))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if not result['ok']:
            sys.exit(1)
    else:
        config = json.loads(args.config.read_text())
        if args.command == 'serve':
            serve(args.root, config)
        else:
            module = upstream()
            if config.get('commercial_mode', False):
                from biomni.env_desc_cm import data_lake_dict
            else:
                from biomni.env_desc import data_lake_dict
            base = Path(config['data_path']) / 'biomni_data'
            for folder, files in [('data_lake', list(data_lake_dict)), ('benchmark', [])]:
                target = base / folder
                target.mkdir(parents=True, exist_ok=True)
                module.check_and_download_s3_files('https://biomni-release.s3.amazonaws.com', str(target), files, folder=folder)
            check_data(module, config['data_path'], config.get('commercial_mode', False))


if __name__ == '__main__':
    main()
