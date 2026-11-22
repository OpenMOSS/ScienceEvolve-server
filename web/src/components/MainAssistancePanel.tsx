import type { MainAssistanceRecord } from "../types";
const requestLabels: Record<MainAssistanceRecord["status"], string> = {
  queued: "请求已保存，等待 Main", processing: "Main 处理中", replied: "答复已保存", failed: "Main 处理失败", unknown: "Main 执行结果未确认"
};
const deliveryLabels: Record<NonNullable<MainAssistanceRecord["delivery"]>["status"], string> = {
  queued: "答复等待原任务的接收边界", offered: "答复已发出，接收未确认", received: "原任务已收到答复",
  late: "原任务已结束，迟到答复已保留", unknown: "答复投递结果未确认"
};
export function MainAssistancePanel({ records }: { records: MainAssistanceRecord[] }) {
  return <section className="workflow-runtime-detail" aria-label="Main 求助记录">
    <h3>Main 求助记录</h3>
    {records.map(record => <details key={record.id}>
      <summary>{record.origin.agentId} · {requestLabels[record.status]}</summary>
      <p>原任务：{record.origin.taskId}</p>
      <p>Main {record.main?.receivedAt ? `已收到请求 · ${record.main.receivedAt}` : "尚无请求接收确认"}</p>
      <strong>请求</strong><pre>{record.question}</pre>
      {record.reply && <><strong>Main 答复</strong><pre>{record.reply.text}</pre><p>答复保存时间：{record.reply.savedAt}</p></>}
      {record.delivery && <p>{deliveryLabels[record.delivery.status]}{record.delivery.receivedAt ? ` · ${record.delivery.receivedAt}` : ""}</p>}
      {record.delivery?.reason && <p>{record.delivery.reason}</p>}
      {record.error && <p role="alert">{record.error}</p>}
      <details><summary>请求关联与接收证据</summary><pre>{JSON.stringify({ requestId: record.id, origin: record.origin, main: record.main, delivery: record.delivery }, null, 2)}</pre></details>
    </details>)}
  </section>;
}
