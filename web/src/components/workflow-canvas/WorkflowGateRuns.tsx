import type { GateRun } from "../../../../server/src/internal/shared/workflow-gate.js";

const labels: Record<GateRun["status"], string> = { prepared: "输入已绑定，尚未检查", running: "检查已启动，结果待确认",
  result: "检查完成，等待选路", selected: "路径已选定，等待交付", delivered: "下游已触发", error: "检查执行或结果契约错误" };
export function WorkflowGateRuns({ runs }: { runs: GateRun[] }) {
  return <section className="workflow-runtime-detail" aria-label="Gate 执行记录">
    <h3>Gate 执行记录</h3>
    {!runs.length && <p>尚无 Gate 检查记录。</p>}
    {runs.map(run => <details key={run.id}>
      <summary>{run.gate.name} · {labels[run.status]}{run.selectedTarget ? ` → ${run.selectedTarget}` : ""}</summary>
      <p>执行 Agent：{run.executorAgentId} · 决策 Agent：{run.decisionAgentId}</p>
      <p>来源：{run.origin.nodeId} / {run.origin.sourceRunId} · Workflow {run.origin.workflowRevision}</p>
      {run.error && <p role="alert">{run.error}</p>}
      {run.result !== undefined && <><strong>实际反馈</strong><pre>{JSON.stringify(run.result, null, 2)}</pre></>}
      <details><summary>原始输入与执行证据</summary><pre>{JSON.stringify({ input: run.origin.input, evidence: run.evidence,
        configurationHash: run.configurationHash, inputHash: run.inputHash, deliveredTo: run.deliveredTo }, null, 2)}</pre></details>
    </details>)}
  </section>;
}
