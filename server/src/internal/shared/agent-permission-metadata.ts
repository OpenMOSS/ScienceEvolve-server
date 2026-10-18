// These legacy identifiers describe filesystem scope, not business capabilities.
// Runtime authorization remains in the filesystem broker and invocation policy;
// selecting a broader scope must never assign experimental tools on its own.
export const AGENT_PERMISSION_METADATA = {
  workspace: {
    label: "当前任务工作区",
    description: "可修改当前任务分配的工作目录；其他目录按实际只读授权访问。"
  },
  compute: {
    label: "项目内工作区",
    description: "可修改当前任务及本项目登记的工作目录，不包括其他项目或受保护系统目录。"
  },
  yolo: {
    label: "原生完全访问",
    description: "使用所选 Harness 的原生权限模式，实际访问受操作系统和当前调用条件约束。"
  }
} as const;

export const AGENT_PERMISSION_NAMES = ["workspace", "compute", "yolo"] as const;
export const AGENT_PERMISSION_OPTIONS = AGENT_PERMISSION_NAMES.map(value => ({
  value, label: AGENT_PERMISSION_METADATA[value].label
}));

export function agentPermissionLabel(permission: string): string {
  return AGENT_PERMISSION_NAMES.includes(permission as typeof AGENT_PERMISSION_NAMES[number])
    ? AGENT_PERMISSION_METADATA[permission as typeof AGENT_PERMISSION_NAMES[number]].label
    : permission;
}
