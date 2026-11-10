/** Built-in research preset shared by the creation form and preset API. */
export const DEFAULT_RESEARCH_WORKFLOW = {
  schemaVersion: 3,
  agents: [
    { name: "main", template: "main", description: "范围、派单和最终验收" },
    { name: "文献研究员", template: "idea", description: "检索、阅读文献并整理原文证据" },
    { name: "因果裁判", template: "review", description: "评估证据，自主选择补证或写作" },
    { name: "证据复核员", template: "review", description: "复核证据缺口和补证结果" },
    { name: "定点补证员", template: "idea", description: "围绕缺口定点检索和核查原文" },
    { name: "研究总编", template: "writing", description: "整合研究报告、图表和证据局限" }
  ],
  collaborations: [],
  scopedWorkflow: { schemaVersion: 1,
    rootAgentIds: ["main", "文献研究员", "因果裁判", "证据复核员", "定点补证员", "研究总编"], groups: [] },
  input: { source: "input", target: "main" },
  routes: {
    main: ["文献研究员", "因果裁判", "证据复核员", "定点补证员", "研究总编"].map(target => ({ target, kind: "weak" })),
    文献研究员: [{ target: "因果裁判", kind: "strong" }],
    因果裁判: [{ target: "证据复核员", kind: "weak" }, { target: "研究总编", kind: "weak" }],
    证据复核员: [{ target: "定点补证员", kind: "strong" }],
    定点补证员: [{ target: "证据复核员", kind: "strong" }],
    研究总编: [{ target: "main", kind: "strong" }]
  },
  loops: [{ id: "evidence_refinement", from: "定点补证员", to: "证据复核员", maxIterations: 2, exitTo: "研究总编" }],
  canvas: {
    schemaVersion: 1,
    layoutMode: "layered",
    nodes: {
      input: { x: 20, y: 200 }, main: { x: 330, y: 200 },
      文献研究员: { x: 640, y: 120 }, 因果裁判: { x: 950, y: 120 },
      证据复核员: { x: 1260, y: 40 }, 定点补证员: { x: 1260, y: 240 },
      研究总编: { x: 950, y: 440 }, finish: { x: 330, y: 440 }
    },
    edges: {
      "input->main:0": { sourcePort: "right", targetPort: "left" },
      "main->文献研究员:0": { sourcePort: "right", targetPort: "left" },
      "main->因果裁判:1": { sourcePort: "top", targetPort: "top" },
      "main->证据复核员:2": { sourcePort: "top", targetPort: "top" },
      "main->定点补证员:3": { sourcePort: "right", targetPort: "bottom" },
      "main->研究总编:4": { sourcePort: "bottom", targetPort: "left" },
      "文献研究员->因果裁判:0": { sourcePort: "right", targetPort: "left" },
      "因果裁判->证据复核员:0": { sourcePort: "right", targetPort: "left" },
      "因果裁判->研究总编:1": { sourcePort: "bottom", targetPort: "top" },
      "证据复核员->定点补证员:0": { sourcePort: "bottom", targetPort: "top" },
      "定点补证员->证据复核员:0": { sourcePort: "right", targetPort: "right" },
      "研究总编->main:0": { sourcePort: "left", targetPort: "right" },
      "main->finish:0": { sourcePort: "bottom", targetPort: "top" }
    },
    viewport: { x: 0, y: 0, zoom: 0.82 },
    connections: { input: true, termination: true }
  },
  decisionPlans: {
    main: "明确研究范围，启动文献研究；由因果裁判自主选择直接写作或两轮补证 Loop，最终读取真实交付文件验收。",
    文献研究员: "按课题要求检索并阅读全文，整理可追溯的证据与关键论断，完成后交因果裁判。",
    因果裁判: "依据原文证据自主沿弱边选择证据复核员或研究总编，记录具体理由，区分相关性、因果证据及尚未解决的问题。",
    证据复核员: "按当前轮次复核关键缺口及前轮修正，将明确的问题交定点补证员。",
    定点补证员: "完成当轮原文核查；第一轮回证据复核员，第二轮由 Loop 退出到研究总编，保留无法补齐的证据局限。",
    研究总编: "整合真实文献、分支决策及触发时的两轮补证记录，完成报告和图表，交 Main 验收，避免绝对化结论。"
  },
  allowUserIntervention: true,
  allowMainReconfiguration: true,
  termination: { agent: "main", condition: "按用户要求完成文献证据、研究报告及图表交付，核验引用、结论边界和实际执行记录后结束。", decisionBy: "main", automatic: false },
  resultFormat: { presets: ["报告", "图表"], custom: "可追溯的文献证据、研究报告、图表，以及实际发生的分支选择和补证记录。" }
} as const;

export const DEFAULT_RESEARCH_AGENT_OVERRIDES = Object.fromEntries(
  DEFAULT_RESEARCH_WORKFLOW.agents.map(({ name }) => [name, {
    instructions: DEFAULT_RESEARCH_WORKFLOW.decisionPlans[name],
    decisionBy: name === "因果裁判" ? "agent" as const : "main" as const
  }])
);
