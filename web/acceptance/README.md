# Shared scoped canvas browser acceptance

[← Back to README](../../README.md) · [中文首页](../../README_zh-CN.md)

This isolated fixture imports the production `WorkflowCanvasEditor`, its shared
canvas components, and the actual application CSS. It does not call project
APIs, mutate Git/GitHub, run Agents, or use the live service's data directory.
All browser requests outside the specified Vite origin are blocked.

Start a separate loopback-only Vite process on an unused port:

```bash
npm run dev --workspace web -- --host 127.0.0.1 --port 54173
```

With Playwright and its Chromium runtime available as optional local acceptance
tooling, run from `web/`:

```bash
node acceptance/run-scoped-canvas.mjs \
  /absolute/path/to/playwright/index.mjs \
  http://127.0.0.1:54173 /tmp/openfars-canvas-acceptance
```

An optional fourth argument is the expected full Git commit SHA. When supplied,
the program also requires a clean tracked worktree and rejects a changed source
commit. Unrelated, untracked environment backups are not source changes.

The program uses real pointer/keyboard interaction to check parallel-edge
bundle selection, Input/Finish selection, Loop and connection editing/undo,
shared Agent edit cancellation/confirmation, child/parent navigation, layout,
and preservation of the outer Agent's configuration. It writes three PNGs and
a manifest containing the commit, tracked-tree state, image hashes, tested
viewports and browser errors. Inspect the PNGs separately; successful assertions
are not a substitute for visual inspection.

Stop the isolated Vite process after verification. Playwright is deliberately
not a production dependency. These results cover the shared editor, not live
Gateway, GitHub or native-Harness deployment acceptance.
