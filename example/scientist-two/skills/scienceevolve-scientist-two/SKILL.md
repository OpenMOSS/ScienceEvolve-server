---
name: scienceevolve-scientist-two
description: Execute the ScientistTwo scientific workflow, including subset/full experiments, idea evolution, ablations, PaperOrchestra drafting, ScholarPeer reviews and meta refinement, through SCIENCEEVOLVE roles and a durable evidence-backed controller.
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# ScientistTwo

Read [the execution protocol](references/protocol.md) before doing any work, then your role's entry in [contracts.json](references/contracts.json). The contract includes required outputs, legal decisions and complete role instructions. Do not replace nested methods with a single writing/review prompt.

Main dispatches SCIENCEEVOLVE roles; [scripts/protocol.py](scripts/protocol.py) only manages counters, branches, version pointers and evidence. It never calls models or runs experiments. Do not launch the complete upstream PaperOrchestra or another autonomous system as a tool.

Task is the scientific problem, baseline code, data, benchmarks and execution resources. Candidate hypotheses/code evolve; the SCIENCEEVOLVE workflow does not. Never call `apply_workflow`.

## Main

Resolve this Skill's actual staged directory as `SCIENTIST_TWO_SKILL` (an absolute path). Run from the Task workspace:

```bash
python "$SCIENTIST_TWO_SKILL/scripts/protocol.py" init
python "$SCIENTIST_TWO_SKILL/scripts/protocol.py" next
# Dispatch next.role with its ticket, context and required_output.
python "$SCIENTIST_TWO_SKILL/scripts/protocol.py" submit \
  --response scientist-two/ticket-0000/response.json
```

Only initialize once. On resume run `verify` and `next`, reuse completed experiment artifacts, and commit an already-written worker response if needed. Repeating an identical submission is idempotent. A different response for a committed ticket is rejected. All committed artifacts are immutable and rehashed before further progress. The controller uses a file lock, atomic replacement and fsync; do not edit `.scientist-two/state.json` manually.

Default budgets are in [config.json](config.json). `init --config <file>` accepts explicit overrides at initialization only; preserve provenance and do not silently reduce paper budgets. This example uses the user-requested **3 initial candidates**.

`next.blocked` means resolve missing resources or investigate actual failure; it does not authorize skipping that role. Use SDK user intervention when necessary. A worker may resume the same pending role with a fresh ticket after a recorded failure. Long-running jobs retain their real job IDs and are polled instead of blindly resubmitted. A missing response after interruption means inspect that ticket's execution journal first.

For inner draft-quality ensemble members, provide only their cropped paper packet; each gets an independent session with no other member review. The merge role receives all three reviews. For novelty answering, provide only the cropped `next.context`; never append state, paper, prior reviews or unrelated handoff history. Each worker has `sessionPersistence:false`.

Only finish when `next.role` is null. Report the exact `terminal` value. `no_successful_idea` is a valid unsuccessful scientific outcome and produces a candidate/diagnostic report, not a fabricated paper. Other outcomes require the export bundle, `select_display` and then `complete_project`. Budget exhaustion/retaining an old best never means Meta Accept.

## Workers

Use `scientist-two/ticket-NNNN/` for new outputs; never edit files committed by prior tickets. Read only your assigned inputs. Snapshot source code and environment, keep results, scripts, command/job journals and raw logs together; successors make new copies. In particular a failed refinement cannot overwrite best code or its manuscript.

Return a UTF-8 `response.json` with:

```json
{
  "ticket": 0,
  "role": "task_setup",
  "status": "ok",
  "summary": "Evidence-backed account of the operation and decision",
  "artifacts": ["scientist-two/ticket-0000/task-evidence.json"],
  "task": {}
}
```

The example `task` is intentionally empty: fill all fields in the role contract from real resources. Every role requires a nonempty summary and existing evidence paths. Artifacts are workspace-relative files or nonempty directories; no symlinks, mutable workspace roots or controller files. Required code/results/logs/commands and tex/pdf/compile_log/screenshots must themselves appear in `artifacts`. A directory snapshot recursively hashes its files; additions, removals and modifications invalidate it. `status:blocked` includes a real diagnostic artifact, leaves the role pending and consumes no scientific budget. `status:failed` denotes an actual unsuccessful execution, with logs; its branch is defined in the protocol. No worker commits controller state: return the response path to Main.

## Sources and execution requirements

- [ScientistTwo v1](https://arxiv.org/html/2609.19644v1): §§3.1–3.6, §4.2, A.2.
- [PaperOrchestra](upstream/paper-orchestra/README.md): pinned official code, prompts, utilities and ICLR 2025 template, Apache-2.0. Read the role-specific source as a complete algorithm/prompt reference; use atomic utilities as needed, with installed dependencies. The ordinary writer entry is the selected reference pipeline.
- [ScholarPeer v2 Appendix G](upstream/scholarpeer-prompts.md): all eight published prompt sections, attributed CC BY 4.0. Read the corresponding subsection in full. Use three expansion rounds and ten questions (explicit 5 novelty + 5 soundness allocation).
- [UPSTREAM.json](UPSTREAM.json) records versions, source URLs and file hashes. ScientistTwo did not disclose its exact embedded dependency revisions. These are declared public reference versions, not claimed recovered private configuration.

All workflow roles use Codex native profile and `gpt-6-sol`, with direct Bash networking by default. This is a model/harness capability substitution for the paper's Gemini 3.6 Flash / Claude Code Opus 4.8. Actual search, experiments, PDF rendering and independent re-execution must work. No missing tool/data/GPU may be replaced by an invented observation. Offline protocol tests verify control behavior; they do not establish reproduction of the paper's experimental results.
