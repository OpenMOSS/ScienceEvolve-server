import { CircleStop } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "./Common";

export function ProjectStopDialog({ title, loading, onCancel, onConfirm }: {
  title: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dismiss = () => { if (!loading) onCancel(); };
  // Card hover transforms create a containing block for fixed descendants.
  // Keep the viewport modal outside that subtree so hover cannot move it.
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={dismiss}>
      <div className="confirm-dialog" role="dialog" aria-modal="true"
        aria-labelledby="project-stop-title" onMouseDown={event => event.stopPropagation()}>
        <span className="dialog-danger-icon"><CircleStop size={23} /></span>
        <h2 id="project-stop-title">停止这个科研项目？</h2>
        <p>「{title}」的当前智能体进程将被终止。停止完成后可归档，已经生成的轨迹与产物仍会保留。</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={dismiss} disabled={loading}>暂不停止</Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>确认停止</Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
