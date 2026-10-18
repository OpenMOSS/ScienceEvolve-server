"""Replay the pinned role protocols, yielding *every* LLM call to SCIENCEEVOLVE.

No upstream model client is invoked. A fresh invocation replays accepted action
strings, including parser errors and tool feedback, up to the next model turn.
The caller restores the proposal-attempt snapshot before replaying source edits.
"""
from __future__ import annotations

import hashlib
import json
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     default=str).encode()).hexdigest()


def write_json(path, value):
    import os
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Pending(BaseException):
    """Not caught by upstream role handlers for ordinary tool exceptions."""
    def __init__(self, ticket):
        self.ticket = ticket


class OrderedExecutor:
    """Independent digesters with the same batch barrier, serialized for replay."""
    def __init__(self, **kwargs):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def map(self, fn, values):
        return map(fn, values)


class Replay:
    def __init__(self, root, scope):
        self.root, self.scope = Path(root), scope
        self.counters = {}
        self.digester_call = 0

    def generate(self, role, sub=""):
        def call(prompt, **kwargs):
            key = role + sub
            n = self.counters.get(key, 0)
            self.counters[key] = n + 1
            payload = {"role": role, "scope": self.scope, "sub": sub,
                       "turn": n, "prompt": prompt, **kwargs}
            identity = digest(payload)
            target = self.root / self.scope / key / f"{n:03d}.json"
            ticket = {"id": identity, "role": role, "kind": "model",
                      "request": str(target), "payload": payload}
            if target.exists():
                saved = json.loads(target.read_text())
                if saved["id"] != identity:
                    raise RuntimeError(f"replay context changed: {target}")
                if "response" in saved:
                    from rrsi.llm import extract_json
                    return extract_json(saved["response"]) if kwargs.get("json_only") else saved["response"]
            write_json(target, ticket)
            raise Pending(ticket)
        return call

    def run(self, role, fn, *args, **kwargs):
        from rrsi import analyst, critic, digester, propose, llm
        def forbidden(*a, **kw):
            raise RuntimeError("upstream search-model calls are forbidden; route through workflow")
        original_digest = digester.digest_task

        def digest_call(*a, **kw):
            n = self.digester_call
            self.digester_call += 1
            with patch.object(digester, "generate", self.generate("digester", f"-{n:03d}")):
                return original_digest(*a, **kw)

        with ExitStack() as stack:
            stack.enter_context(patch.object(llm, "generate", forbidden))
            for name, module in (("analyst", analyst), ("critic", critic),
                                 ("digester", digester), ("proposer", propose)):
                stack.enter_context(patch.object(module, "generate", self.generate(name)))
            stack.enter_context(patch.object(analyst, "digest_task", digest_call))
            stack.enter_context(patch.object(analyst, "ThreadPoolExecutor", OrderedExecutor))
            return fn(*args, **kwargs)


def submit(ticket, raw):
    path = Path(ticket["request"])
    saved = json.loads(path.read_text())
    if saved["id"] != ticket["id"]:
        raise ValueError("stale model ticket")
    if "response" in saved and saved["response"] != raw:
        raise ValueError("response already submitted; immutable")
    saved["response"] = raw
    write_json(path, saved)
