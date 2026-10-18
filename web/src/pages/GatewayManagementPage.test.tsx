import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGateway,
  deleteGateway,
  discoverGatewayModels,
  getCatalog,
  refreshGatewayModels,
  revealGatewayCredential,
  setDefaultGateway,
  testGateway,
  testGatewayMatrix,
  updateGateway
} from "../api";
import type {
  AgentHarness,
  GatewayRecord,
  GatewayTestState,
  HarnessCatalogEntry
} from "../types";
import { GatewayManagementPage, redactGatewayFailure } from "./GatewayManagementPage";

vi.mock("../api", () => ({
  createGateway: vi.fn(),
  deleteGateway: vi.fn(),
  discoverGatewayModels: vi.fn(),
  getCatalog: vi.fn(),
  refreshGatewayModels: vi.fn(),
  revealGatewayCredential: vi.fn(),
  setDefaultGateway: vi.fn(),
  testGateway: vi.fn(),
  testGatewayMatrix: vi.fn(),
  updateGateway: vi.fn()
}));

const harnesses: HarnessCatalogEntry[] = [
  {
    id: "codex",
    label: "Codex",
    adapterVersion: "1",
    nativeProtocol: "responses",
    purposes: ["workflow", "explainer", "probe"],
    mode: "workflow",
    notes: "embedded",
    capabilities: {
      durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true,
      readOnlyExplainer: true, webSearch: true, skills: true, mcp: true
    },
    available: true
  },
  {
    id: "dsh",
    label: "dsh",
    adapterVersion: "1",
    nativeProtocol: "chat-completions",
    purposes: ["workflow", "probe"],
    mode: "workflow",
    notes: "embedded",
    capabilities: {
      durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true,
      readOnlyExplainer: false, webSearch: true, skills: true, mcp: true
    },
    available: true
  },
  {
    id: "pi",
    label: "pi",
    adapterVersion: "1",
    nativeProtocol: "chat-completions",
    purposes: ["workflow", "probe"],
    mode: "workflow",
    notes: "embedded",
    capabilities: {
      durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true,
      readOnlyExplainer: false, webSearch: true, skills: true, mcp: true
    },
    available: true
  },
  {
    id: "claude-code",
    label: "Claude Code",
    adapterVersion: "1",
    nativeProtocol: "anthropic-messages",
    purposes: ["workflow", "probe"],
    mode: "workflow",
    notes: "embedded",
    capabilities: {
      durableSession: true, officialEvents: true, toolEvents: true, usageEvents: true,
      readOnlyExplainer: false, webSearch: true, skills: true, mcp: true
    },
    available: true
  }
];

const gateway: GatewayRecord = {
  id: "gwy_0123456789abcdef0123456789abcdef",
  name: "验收网关",
  url: "https://gateway.example.test/v1",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  protocol: "responses",
  revision: 1,
  apiKeyConfigured: true,
  test: { status: "passed", protocol: "responses", model: "model-a", testedAt: "2026-09-14T00:00:00.000Z" },
  tests: [],
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z"
};

const passedStageResults: NonNullable<GatewayRecord["test"]["stageResults"]> = [
  { stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 2800, httpStatus: 200 },
  { stage: "text_stream", label: "文本流式", expectation: "text", stream: true, status: "passed", durationMs: 2200, httpStatus: 200 },
  { stage: "tool_ordinary", label: "工具调用普通", expectation: "tool", stream: false, status: "passed", durationMs: 11000, httpStatus: 200 },
  { stage: "tool_stream", label: "工具调用流式", expectation: "tool", stream: true, status: "passed", durationMs: 3600, httpStatus: 200 },
  { stage: "adapter_smoke", label: "Harness 真实探测", expectation: "harness", stream: false, status: "passed", durationMs: 800 }
];

function matrixResults(model = "model-a"): GatewayRecord["test"][] {
  return [
    { status: "passed", protocol: gateway.protocol, model, harness: "codex", durationMs: 1200, stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 1200, httpStatus: 200 }] },
    { status: "passed", protocol: gateway.protocol, model, harness: "dsh", durationMs: 900, stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 900, httpStatus: 200 }] },
    { status: "passed", protocol: gateway.protocol, model, harness: "pi", durationMs: 1000, stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 1000, httpStatus: 200 }] },
    { status: "failed", protocol: gateway.protocol, model, harness: "claude-code", error: "authorization: Bearer sk-secret-value", durationMs: 60000, stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "failed", durationMs: 60000, error: "authorization: Bearer sk-secret-value" }] }
  ];
}

function catalog(gateways: GatewayRecord[] = [gateway]) {
  return {
    gateways,
    harnesses,
    models: gateway.models,
    skills: [],
    agentPrompts: {},
    defaultGatewayId: gateways[0]?.id
  } as Awaited<ReturnType<typeof getCatalog>>;
}

function passedHarnessTests(model: string, harness: AgentHarness): GatewayTestState[] {
  const nativeProtocol = harnesses.find((entry) => entry.id === harness)!.nativeProtocol!;
  const routeMode = nativeProtocol === gateway.protocol ? "direct" as const : "proxy" as const;
  const routeDirection = routeMode === "proxy"
    ? `${nativeProtocol}->${gateway.protocol}` as const
    : undefined;
  return [
    {
      status: "passed",
      protocol: gateway.protocol,
      model,
      harness,
      nativeProtocol,
      routeMode,
      ...(routeDirection ? { routeDirection } : {}),
      probeKind: "route",
      gatewayRevision: gateway.revision,
      routerCompatibilityVersion: "1"
    },
    {
      status: "passed",
      protocol: gateway.protocol,
      model,
      harness,
      nativeProtocol,
      routeMode,
      ...(routeDirection ? { routeDirection } : {}),
      probeKind: "adapter-smoke",
      cacheKey: `${harness}-${model}`,
      adapterVersion: "1",
      executableFingerprint: `fixture-${harness}`,
      gatewayRevision: gateway.revision,
      routerCompatibilityVersion: "1"
    }
  ];
}

describe("GatewayManagementPage", () => {
  beforeEach(() => {
    vi.mocked(getCatalog).mockReset().mockResolvedValue(catalog());
    vi.mocked(createGateway).mockReset();
    vi.mocked(deleteGateway).mockReset().mockResolvedValue(undefined);
    vi.mocked(discoverGatewayModels).mockReset();
    vi.mocked(refreshGatewayModels).mockReset();
    vi.mocked(revealGatewayCredential).mockReset().mockResolvedValue("secret-value");
    vi.mocked(setDefaultGateway).mockReset();
    vi.mocked(updateGateway).mockReset();
    vi.mocked(testGateway).mockReset().mockImplementation(async (_id, model, harness) => {
      const tests = harness ? passedHarnessTests(model, harness) : gateway.tests ?? [];
      const test = harness
        ? { ...tests.at(-1)!, durationMs: 19600, stageResults: passedStageResults }
        : { ...gateway.test, model, durationMs: 19600, stageResults: passedStageResults };
      return { ...gateway, test, tests };
    });
    vi.mocked(testGatewayMatrix).mockReset().mockResolvedValue({
      gateway,
      results: matrixResults()
    });
  });

  it("renders shared resources and keeps credentials out of the list", async () => {
    render(<GatewayManagementPage onBack={vi.fn()} />);
    expect(await screen.findByText("验收网关")).toBeInTheDocument();
    expect(screen.getByText("服务端已配置")).toBeInTheDocument();
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();
  });

  it("adds a newly cataloged probe Harness to the matrix without page-specific code", async () => {
    const fixtureHarness: HarnessCatalogEntry = {
      ...harnesses[0]!,
      id: "fixture-fifth",
      label: "Fixture Fifth Harness",
      default: false
    };
    vi.mocked(getCatalog).mockResolvedValue({
      ...catalog(),
      harnesses: [...harnesses, fixtureHarness]
    });
    const user = userEvent.setup();

    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText("验收网关")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "验证全部 Harness" }));

    const dialog = screen.getByRole("dialog", { name: "网关真实测试" });
    expect(within(dialog).getByText("准备运行 5 个 Harness")).toBeVisible();
    expect(within(dialog).getByText("Fixture Fifth Harness")).toBeVisible();
  });

  it("summarizes the latest logical combination without treating route-only success as verified", async () => {
    const verified: GatewayRecord = {
      ...gateway,
      tests: [
        {
          status: "passed", protocol: "responses", model: "model-a",
          harness: "codex", nativeProtocol: "responses", routeMode: "direct",
          probeKind: "route", testedAt: "2026-09-14T00:00:00.000Z"
        },
        {
          status: "passed", protocol: "responses", model: "model-a",
          harness: "codex", nativeProtocol: "responses", routeMode: "direct",
          probeKind: "adapter-smoke", cacheKey: "codex-model-a", adapterVersion: "1",
          executableFingerprint: "fixture-codex", gatewayRevision: 1,
          routerCompatibilityVersion: "1", testedAt: "2026-09-14T00:00:01.000Z"
        },
        {
          status: "failed", protocol: "responses", model: "model-b",
          harness: "codex", nativeProtocol: "responses", routeMode: "direct",
          probeKind: "route", error: "model-b route failed", testedAt: "2026-09-14T01:00:00.000Z"
        }
      ]
    };
    vi.mocked(getCatalog).mockResolvedValue(catalog([verified]));

    render(<GatewayManagementPage onBack={vi.fn()} />);

    const card = (await screen.findByText("验收网关")).closest("article")!;
    expect(within(card).getByText("Codex · 未通过")).toBeInTheDocument();
    expect(within(card).getByText("dsh · 未验证")).toBeInTheDocument();
    expect(within(card).getByText("pi · 未验证")).toBeInTheDocument();
    expect(within(card).getByText("Claude Code · 未验证")).toBeInTheDocument();
    expect(within(card).queryByText(/\d+\s*通过/)).not.toBeInTheDocument();
  });

  it("validates and saves gateway fields in a modal", async () => {
    const user = userEvent.setup();
    vi.mocked(createGateway).mockResolvedValue({ ...gateway, id: "gwy_new", name: "新网关" });
    render(<GatewayManagementPage onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "新增网关" }));
    await user.click(screen.getByRole("button", { name: "保存网关" }));
    expect(await screen.findByText("请输入网关显示名称")).toBeInTheDocument();
    await user.type(screen.getByLabelText("网关显示名称"), "新网关");
    await user.clear(screen.getByLabelText("网关 URL"));
    await user.type(screen.getByLabelText("网关 URL"), "https://model.openapi-sj.sii.edu.cn/v1");
    await user.type(screen.getByLabelText("网关 API key"), "secret-value");
    await user.click(screen.getByRole("button", { name: "添加 model" }));
    await user.type(screen.getByLabelText("新 model 名称"), "model-a");
    await user.click(screen.getByRole("button", { name: "确认" }));
    expect(screen.getByLabelText("网关默认 model")).toHaveValue("model-a");
    expect(screen.getByLabelText("model-a 上下文长度")).toHaveValue(262144);
    await user.clear(screen.getByLabelText("model-a 上下文长度"));
    await user.type(screen.getByLabelText("model-a 上下文长度"), "1048576");
    await user.click(screen.getByLabelText("model-a 自定义网关思考强度"));
    await user.selectOptions(
      screen.getByLabelText("model-a 思考参数字段"),
      "chat_template_kwargs.reasoning_effort"
    );
    await user.click(screen.getByRole("button", { name: "添加选项" }));
    await user.click(screen.getByRole("button", { name: "保存网关" }));
    await waitFor(() => expect(createGateway).toHaveBeenCalled());
    expect(vi.mocked(createGateway).mock.calls[0]?.[0]).toMatchObject({
      url: "https://model.openapi-sj.sii.edu.cn/v1",
      modelContextWindows: { "model-a": 1_048_576 },
      modelReasoning: {
        "model-a": {
          parameter: "chat_template_kwargs.reasoning_effort",
          options: [{ id: "option-1", label: "选项 1", value: "high" }]
        }
      }
    });
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();
  });

  it("refreshes models inside the editor and selects the returned default model", async () => {
    const user = userEvent.setup();
    vi.mocked(refreshGatewayModels).mockResolvedValue({
      ...gateway,
      models: ["model-c", "model-d"],
      defaultModel: "model-d"
    });
    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText(gateway.name)).closest("article")!;

    expect(within(card).queryByRole("button", { name: /刷新 models/ })).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "编辑" }));
    const dialog = screen.getByRole("dialog", { name: "编辑全局网关" });
    expect(within(dialog).getByLabelText("网关默认 model")).toBeInstanceOf(HTMLSelectElement);
    expect(within(dialog).getByLabelText("网关默认 model")).toHaveValue("model-a");

    await user.click(within(dialog).getByRole("button", { name: "刷新网关 model 列表" }));

    await waitFor(() => expect(refreshGatewayModels).toHaveBeenCalledWith(gateway.id));
    expect(within(dialog).getByTitle("model-c")).toBeInTheDocument();
    expect(within(dialog).getByTitle("model-d")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("model-c 上下文长度")).toHaveValue(262144);
    expect(within(dialog).getByLabelText("网关默认 model")).toHaveValue("model-d");
    expect(within(dialog).getByText("已刷新 2 个 model。")).toHaveAttribute("role", "status");
  });

  it("discovers models for a new gateway and assigns the 256K default", async () => {
    const user = userEvent.setup();
    vi.mocked(discoverGatewayModels).mockResolvedValue(["model-discovered"]);
    render(<GatewayManagementPage onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "新增网关" }));
    await user.clear(screen.getByLabelText("网关 URL"));
    await user.type(screen.getByLabelText("网关 URL"), "https://gateway.example.test/v1");
    await user.type(screen.getByLabelText("网关 API key"), "secret-value");
    await user.click(screen.getByRole("button", { name: "刷新网关 model 列表" }));

    await waitFor(() => expect(discoverGatewayModels).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://gateway.example.test/v1",
      apiKey: "secret-value",
      protocol: "responses"
    })));
    expect(screen.getByTitle("model-discovered")).toBeInTheDocument();
    expect(screen.getByLabelText("model-discovered 上下文长度")).toHaveValue(262144);
    expect(screen.getByLabelText("网关默认 model")).toHaveValue("model-discovered");
  });

  it("runs all harness probes for one selected model through the unified endpoint", async () => {
    const user = userEvent.setup();
    vi.mocked(testGatewayMatrix).mockResolvedValue({ gateway, results: matrixResults("model-b") });
    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText("验收网关")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "验证全部 Harness" }));
    const matrixModelPicker = screen.getByLabelText("验证全部 Harness model") as HTMLSelectElement;
    expect(matrixModelPicker.value).toBe("model-a");
    await user.selectOptions(matrixModelPicker, "model-b");
    await user.click(screen.getByRole("button", { name: "开始真实测试" }));
    await waitFor(() => expect(testGatewayMatrix).toHaveBeenCalledTimes(1));
    expect(testGatewayMatrix).toHaveBeenCalledWith(gateway.id, {
      harnesses: ["codex", "dsh", "pi", "claude-code"],
      models: ["model-b"]
    }, expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }));
    expect(testGateway).not.toHaveBeenCalled();
    expect(await screen.findByText("真实探测完成：3/4 个组合通过。")).toBeInTheDocument();
    expect(screen.queryByText("sk-secret-value")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Claude Code.*model-b/s }));
    expect(await screen.findByText("文本普通")).toBeInTheDocument();
    expect(screen.getAllByText("60s").length).toBeGreaterThan(0);
    expect(redactGatewayFailure("authorization: Bearer sk-secret-value")).toContain("[REDACTED]");
  });

  it("runs a connection probe with the selected model-level Gateway reasoning option", async () => {
    const user = userEvent.setup();
    const configuredGateway: GatewayRecord = {
      ...gateway,
      modelReasoning: {
        "model-a": {
          parameter: "reasoning_effort",
          options: [{ id: "high", label: "高", value: "high" }]
        }
      }
    };
    vi.mocked(getCatalog).mockResolvedValue(catalog([configuredGateway]));
    vi.mocked(testGateway).mockResolvedValue(configuredGateway);

    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText("验收网关")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "测试连接" }));
    await user.selectOptions(screen.getByLabelText("测试网关思考强度"), "high");
    await user.click(screen.getByRole("button", { name: "开始真实测试" }));

    await waitFor(() => expect(testGateway).toHaveBeenCalledWith(
      gateway.id,
      "model-a",
      "codex",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
        gatewayReasoningOption: "high"
      })
    ));
  });

  it("does not report a route-only pass when the Adapter smoke probe failed", async () => {
    const user = userEvent.setup();
    const [route] = passedHarnessTests("model-a", "codex");
    const failedSmoke: GatewayTestState = {
      ...passedHarnessTests("model-a", "codex")[1]!,
      status: "failed",
      error: "real Adapter smoke failed",
      durationMs: 19600,
      stageResults: [
        ...passedStageResults.slice(0, -1),
        { ...passedStageResults.at(-1)!, status: "failed", error: "real Adapter smoke failed" }
      ]
    };
    const failedGateway = {
      ...gateway,
      test: failedSmoke,
      tests: [route!, failedSmoke]
    };
    vi.mocked(testGateway).mockResolvedValueOnce(failedGateway);
    vi.mocked(getCatalog)
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(catalog([failedGateway]));

    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText("验收网关")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "测试连接" }));
    await user.click(screen.getByRole("button", { name: "开始真实测试" }));

    expect(await screen.findByText("真实探测完成：0/1 个组合通过。")).toBeInTheDocument();
    expect(screen.getAllByText("real Adapter smoke failed")).toHaveLength(2);
  });

  it("lets connection probes choose one harness and one model with stage diagnostics", async () => {
    const user = userEvent.setup();
    let emitFirstStage!: () => void;
    let finishConnection!: () => void;
    const staleHarnesses = harnesses.map((entry) => entry.id === "dsh"
      ? { ...entry, executableFingerprint: "stale-dsh-executable" }
      : entry);
    const refreshedDshTests = passedHarnessTests("model-b", "dsh");
    const refreshedGateway: GatewayRecord = {
      ...gateway,
      test: { ...refreshedDshTests.at(-1)!, durationMs: 19600, stageResults: passedStageResults },
      tests: refreshedDshTests
    };
    vi.mocked(getCatalog)
      .mockResolvedValueOnce({ ...catalog(), harnesses: staleHarnesses })
      .mockResolvedValueOnce({
        ...catalog([refreshedGateway]),
        harnesses: harnesses.map((entry) => entry.id === "dsh"
          ? { ...entry, executableFingerprint: "fixture-dsh" }
          : entry)
      });
    vi.mocked(testGateway).mockImplementation(async (_id, model, harness, init) => {
      await new Promise<void>((resolve) => {
        emitFirstStage = () => {
          init?.onProgress?.({ type: "stage", stage: passedStageResults[0] });
        };
        finishConnection = resolve;
      });
      const tests = harness ? passedHarnessTests(model, harness) : [];
      const result: GatewayRecord["test"] = {
        ...(tests.at(-1) ?? { status: "passed", protocol: gateway.protocol, model, harness }),
        testedAt: "2026-09-14T00:00:00.000Z",
        durationMs: 19600,
        stageResults: passedStageResults
      };
      const checked: GatewayRecord = {
        ...gateway,
        test: result,
        tests: harness ? [tests[0]!, result] : []
      };
      init?.onProgress?.({ type: "result", result: checked.test });
      init?.onProgress?.({ type: "complete", gateway: checked, result: checked.test });
      return checked;
    });
    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText("验收网关")).closest("article")!;

    await user.click(within(card).getByRole("button", { name: "测试连接" }));
    const harnessPicker = screen.getByLabelText("测试连接 Harness") as HTMLSelectElement;
    expect(harnessPicker.value).toBe("codex");
    const modelPicker = screen.getByLabelText("测试连接 model") as HTMLSelectElement;
    expect(modelPicker.value).toBe("model-a");
    expect(screen.queryByText("准备运行 1 个 真实探测")).not.toBeInTheDocument();
    expect(document.querySelector(".gateway-test-progress")).toBeNull();

    await user.selectOptions(harnessPicker, "dsh");
    expect(harnessPicker.value).toBe("dsh");
    await user.selectOptions(modelPicker, "model-b");
    expect(modelPicker.value).toBe("model-b");

    await user.click(screen.getByRole("button", { name: /dsh.*model-b/s }));
    expect(await screen.findByText("文本普通")).toBeInTheDocument();
    expect(screen.getByText("文本流式")).toBeInTheDocument();
    expect(screen.getByText("工具调用普通")).toBeInTheDocument();
    expect(screen.getByText("工具调用流式")).toBeInTheDocument();
    expect(screen.getAllByText("等待中").length).toBeGreaterThanOrEqual(4);

    await user.click(screen.getByRole("button", { name: "开始真实测试" }));
    await waitFor(() => expect(testGateway).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText("测试中")).toHaveLength(1));
    expect(screen.getAllByText("等待中").length).toBeGreaterThanOrEqual(3);
    const [gatewayId, model, harness, init] = vi.mocked(testGateway).mock.calls[0];
    expect(gatewayId).toBe(gateway.id);
    expect(model).toBe("model-b");
    expect(harness).toBe("dsh");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.onProgress).toEqual(expect.any(Function));
    expect(document.querySelector(".gateway-test-progress")).toBeNull();

    await act(async () => {
      emitFirstStage();
    });
    expect(await screen.findByText("2.8s")).toBeInTheDocument();
    expect(screen.getAllByText("HTTP 200").length).toBeGreaterThan(0);

    await act(async () => {
      finishConnection();
    });
    expect(await screen.findByText("真实探测完成：1/1 个组合通过。")).toBeInTheDocument();
    expect(screen.getAllByText("HTTP 200").length).toBeGreaterThan(0);
    expect(within(card).getByText("dsh · 通过")).toBeInTheDocument();
  });

  it("updates matrix progress and stage details before the whole request finishes", async () => {
    const user = userEvent.setup();
    let sendFirstResult!: () => void;
    let finishMatrix!: () => void;
    const finalResults: GatewayRecord["test"][] = [
      { status: "passed", protocol: gateway.protocol, model: "model-a", harness: "codex", durationMs: 1200, stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 1200, httpStatus: 200 }] },
      { status: "passed", protocol: gateway.protocol, model: "model-a", harness: "dsh", durationMs: 900, stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 900, httpStatus: 200 }] },
      { status: "passed", protocol: gateway.protocol, model: "model-a", harness: "pi", durationMs: 1000, stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 1000, httpStatus: 200 }] },
      { status: "passed", protocol: gateway.protocol, model: "model-a", harness: "claude-code", durationMs: 1100, stageResults: [{ stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "passed", durationMs: 1100, httpStatus: 200 }] }
    ];
    vi.mocked(testGatewayMatrix).mockImplementation(async (_id, _options, init) => {
      init?.onProgress?.({
        type: "combination-start",
        harness: "codex",
        model: "model-a",
        stageResults: [
          { stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "queued" },
          { stage: "text_stream", label: "文本流式", expectation: "text", stream: true, status: "queued" }
        ]
      });
      init?.onProgress?.({ type: "stage", harness: "codex", model: "model-a", stage: { stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false, status: "running" } });
      await new Promise<void>((resolve) => {
        sendFirstResult = () => {
          init?.onProgress?.({ type: "result", harness: "codex", model: "model-a", result: finalResults[0] });
          resolve();
        };
      });
      await new Promise<void>((resolve) => {
        finishMatrix = () => {
          init?.onProgress?.({ type: "complete", gateway, results: finalResults });
          resolve();
        };
      });
      return { gateway, results: finalResults };
    });

    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText("验收网关")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "验证全部 Harness" }));
    await user.click(screen.getByRole("button", { name: "开始真实测试" }));
    await waitFor(() => expect(testGatewayMatrix).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /Codex.*model-a/s }));
    expect(await screen.findByText("文本普通")).toBeInTheDocument();
    expect(screen.getByText("测试中")).toBeInTheDocument();

    await act(async () => {
      sendFirstResult();
    });
    await waitFor(() => expect((document.querySelector("progress") as HTMLProgressElement).value).toBe(1));
    expect(screen.getByText("通过")).toBeInTheDocument();

    await act(async () => {
      finishMatrix();
    });
    expect(await screen.findByText("真实探测完成：4/4 个组合通过。")).toBeInTheDocument();
  });

  it.each([
    { mode: "connection", cancelled: false },
    { mode: "connection", cancelled: true },
    { mode: "matrix", cancelled: false },
    { mode: "matrix", cancelled: true }
  ] as const)("settles unfinished rows and stages on $mode interruption (cancelled=$cancelled)", async ({ mode, cancelled }) => {
    const user = userEvent.setup();
    let rejectRequest!: (reason: Error) => void;
    const pending = (signal?: AbortSignal | null) => new Promise<GatewayRecord>((_, reject) => {
      rejectRequest = reject;
      // Some transports reject cancellation with a TypeError rather than AbortError.
      signal?.addEventListener("abort", () => reject(new TypeError("stream closed")), { once: true });
    });
    if (mode === "connection") {
      vi.mocked(testGateway).mockImplementation(async (_id, _model, _harness, init) => {
        init?.onProgress?.({ type: "stage", stage: passedStageResults[0] });
        init?.onProgress?.({ type: "stage", stage: { ...passedStageResults[1], status: "running", durationMs: undefined, httpStatus: undefined } });
        return pending(init?.signal);
      });
    } else {
      vi.mocked(testGatewayMatrix).mockImplementation(async (_id, _options, init) => {
        init?.onProgress?.({ type: "stage", harness: "codex", model: "model-a", stage: passedStageResults[0] });
        init?.onProgress?.({ type: "stage", harness: "codex", model: "model-a", stage: { ...passedStageResults[1], status: "running", durationMs: undefined, httpStatus: undefined } });
        init?.onProgress?.({ type: "result", harness: "dsh", model: "model-a", result: { status: "passed", model: "model-a", harness: "dsh", stageResults: passedStageResults } });
        await pending(init?.signal);
        return { gateway, results: [] };
      });
    }
    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText("验收网关")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: mode === "matrix" ? "验证全部 Harness" : "测试连接" }));
    const dialog = screen.getByRole("dialog", { name: "网关真实测试" });
    await user.click(within(dialog).getByRole("button", { name: /Codex.*model-a/s }));
    await user.click(within(dialog).getByRole("button", { name: "开始真实测试" }));
    expect(await within(dialog).findByText("测试中")).toBeInTheDocument();

    if (cancelled) {
      await user.click(within(dialog).getByRole("button", { name: "取消测试" }));
    } else {
      await act(async () => { rejectRequest(new Error("network disconnected")); });
    }

    expect(await within(dialog).findByText(cancelled ? "已取消" : "已中断")).toBeInTheDocument();
    expect(within(dialog).queryByText("测试中")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("等待中")).not.toBeInTheDocument();
    expect(within(dialog).getAllByText("未执行")).toHaveLength(3);
    expect(within(dialog).getByText("2.8s")).toBeInTheDocument();
    expect(within(dialog).getByText("HTTP 200")).toBeInTheDocument();
    expect(dialog.querySelector(".gateway-test-step.running, .gateway-test-step.queued")).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Codex.*model-a/s })).toHaveClass(cancelled ? "cancelled" : "failed");
    expect(within(dialog).getByRole("button", { name: "重新测试" })).toBeEnabled();
    if (mode === "matrix") {
      expect(within(dialog).getByRole("button", { name: /dsh.*model-a/s })).toHaveClass("passed");
      await user.click(within(dialog).getByRole("button", { name: /pi.*model-a/s }));
      expect(within(dialog).queryByText("等待中")).not.toBeInTheDocument();
      expect(within(dialog).getAllByText("未执行")).toHaveLength(8);
    }
  });

  it("cancels a running matrix probe request", async () => {
    const user = userEvent.setup();
    let probeSignal: AbortSignal | undefined;
    vi.mocked(testGatewayMatrix).mockImplementation(async (_id, _options, init) => {
      probeSignal = init?.signal ?? undefined;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    render(<GatewayManagementPage onBack={vi.fn()} />);
    const card = (await screen.findByText("验收网关")).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "验证全部 Harness" }));
    await user.click(screen.getByRole("button", { name: "开始真实测试" }));
    await waitFor(() => expect(testGatewayMatrix).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "取消测试" }));

    await waitFor(() => expect(probeSignal?.aborted).toBe(true));
    expect(await screen.findByText(/真实探测已取消/)).toBeInTheDocument();
  });
});
