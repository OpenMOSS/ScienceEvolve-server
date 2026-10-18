import { useId } from "react";
import { FlaskConical } from "lucide-react";

interface Props {
  agentName: string;
  selected: boolean;
  disabled?: boolean;
  onChange: (selected: boolean) => void;
}

/** Select business tools explicitly; the runtime resolves each current role. */
export function ExperimentMcpControl({ agentName, selected, disabled, onChange }: Props) {
  const descriptionId = useId();
  if (agentName === "main") return null;
  return <label className="experiment-mcp-control" data-enabled={selected} data-disabled={disabled === true}>
    <span className="experiment-mcp-copy">
      <span className="experiment-mcp-heading"><FlaskConical size={16} aria-hidden="true" /><strong>SII 实验工具</strong></span>
      <span className="experiment-mcp-description" id={descriptionId}>提交实验、接收监控通知和续接任务。</span>
    </span>
    <span className="experiment-mcp-switch">
      <input type="checkbox" checked={selected} disabled={disabled}
        aria-label={`${agentName} SII 实验工具`}
        aria-describedby={`${descriptionId} ${descriptionId}-scope`}
        onChange={(event) => onChange(event.target.checked)} />
      <span className="experiment-mcp-track" aria-hidden="true" />
      <span className="experiment-mcp-state" aria-hidden="true">{selected ? "已开启" : "未开启"}</span>
    </span>
    <small className="experiment-mcp-scope" id={`${descriptionId}-scope`}>沿用当前运行权限；作为 Leader 或协调者时不加载。</small>
  </label>;
}
