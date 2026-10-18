import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { assistantIdSchema, assistantTargetSchema } from "./explainer-assistant.js";
import { ProjectExplainerBusyError, ProjectExplainerHarnessSwitchConfirmationError, type ProjectExplainerPort,
  type ProjectExplainerAssistantPort, type ProjectExplainerEvent } from "./project-explainer.js";
import { projectExplainerConfigSchema, projectExplainerQuestionSchema } from "./validation.js";
import { redactTrace } from "./utils.js";

export function registerExplainerAssistantRoutes(app: Express, explainer?: ProjectExplainerPort & Partial<ProjectExplainerAssistantPort>) {
  const ready = () => {
    if (!explainer?.assistant || !explainer.createAssistantContext) throw Object.assign(new Error("Project Explainer 交互助手尚未配置。"), { status: 503 });
    return { agent: explainer, store: explainer.assistant, create: explainer.createAssistantContext.bind(explainer) };
  };
  const handle = (run: (request: Request, response: Response) => Promise<unknown>) => async (request: Request, response: Response, next: NextFunction) => {
    try { await run(request, response); }
    catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ProjectExplainerHarnessSwitchConfirmationError) {
        response.status(409).json({ error: error.message, code: "explainer_harness_switch_confirmation_required" }); return;
      }
      if (error instanceof ProjectExplainerBusyError) { response.status(409).json({ error: error.message }); return; }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { response.status(404).json({ error: "Explainer 会话不存在。" }); return; }
      if ((error as { status?: number }).status) { response.status((error as { status: number }).status).json({ error: redactTrace((error as Error).message) }); return; }
      next(error);
    }
  };
  const id = (request: Request) => assistantIdSchema.parse(request.params.id);
  app.post("/api/explainer/conversations", handle(async (request, response) => response.status(201).json(await ready().create(assistantTargetSchema.parse(request.body)))));
  app.get("/api/explainer/conversations/:id/context", handle(async (request, response) => response.json(await ready().store.get(id(request)))));
  app.patch("/api/explainer/conversations/:id/context", handle(async (request, response) => {
    const input = z.object({ expectedRevision: z.number().int().nonnegative(), draft: z.unknown().optional(), taskId: z.string().regex(/^task_[a-f0-9]{32}$/).optional(),
      workflowBase: z.object({ revision: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).strict().parse(request.body);
    response.json(await ready().store.sync(id(request), input));
  }));
  app.get("/api/explainer/conversations/:id/history", handle(async (request, response) => response.json(await ready().agent.history(id(request)))));
  app.get("/api/explainer/conversations/:id/config", handle(async (request, response) => response.json(await ready().agent.getConfig(id(request)))));
  app.patch("/api/explainer/conversations/:id/config", handle(async (request, response) => response.json(await ready().agent.updateConfig(id(request), projectExplainerConfigSchema.parse(request.body)))));
  app.post("/api/explainer/conversations/:id/cancel", handle(async (request, response) => { await ready().agent.cancel(id(request)); response.status(204).end(); }));
  app.post("/api/explainer/conversations/:id/reset", handle(async (request, response) => { await ready().agent.reset(id(request)); response.status(204).end(); }));
  app.post("/api/explainer/conversations/:id/undo", handle(async (request, response) => {
    const input = z.object({ expectedRevision: z.number().int().nonnegative(), operationId: z.string() }).strict().parse(request.body);
    response.json(await ready().store.call(id(request), "undo_draft", input));
  }));
  app.post("/api/explainer/conversations/:id/turns", handle(async (request, response) => {
    const { agent, store } = ready();
    const conversationId = id(request), input = projectExplainerQuestionSchema.parse(request.body);
    await store.get(conversationId);
    if (agent.isActive(conversationId)) throw new ProjectExplainerBusyError();
    response.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    const controller = new AbortController();
    let expired = "";
    const expire = (message: string) => { if (!controller.signal.aborted) { expired = message; controller.abort(); } };
    const idle = setTimeout(() => expire("连续 5 分钟未收到模型进度，已停止等待。现有草稿保留，可继续重试。"), 300_000);
    const total = setTimeout(() => expire("本次对话超过 10 分钟，已停止等待。已完成的草稿操作保留，请查看执行结果。"), 600_000);
    const heartbeat = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write("\n"); }, 15_000);
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", disconnect); response.once("close", disconnect);
    const send = async (event: ProjectExplainerEvent) => {
      if (event.kind === "assistant" || event.kind === "tool" || event.kind === "tool_output" || event.data?.modelActivity) idle.refresh();
      if (!response.destroyed && !response.writableEnded) response.write(JSON.stringify(event) + "\n");
    };
    try { await agent.ask(conversationId, input.question, send, controller.signal); }
    finally {
      clearTimeout(idle); clearTimeout(total); clearInterval(heartbeat); request.off("aborted", disconnect); response.off("close", disconnect);
      if (expired) await send({ id: `timeout_${Date.now()}`, projectId: conversationId, turnId: "timeout", kind: "error", text: expired, phase: "completed", ts: new Date().toISOString() });
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }));
}
