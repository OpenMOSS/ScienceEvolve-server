---
name: scienceevolve-aris
description: 在 SCIENCEEVOLVE 中执行完整 ARIS 主线研究管线，使用随附上游阶段规范和工具，通过真实跨模型角色交接完成评审与验收。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# 完整 ARIS 的能力提供者与调度

本 Skill 的 `upstream/` 保留固定版本的主线全部 Skills、shared-references、工具和模板。先读 `upstream/skills/research-pipeline/SKILL.md`，W1 再读 `idea-discovery/SKILL.md`，W3 再读 `paper-writing/SKILL.md`，然后按当前角色读取其原始阶段 Skill。原阶段内容是执行规范，不是可忽略的历史快照。模型、Harness 与调度由 SCIENCEEVOLVE 提供；不得删减任何必需能力或把整条原管线作为外部进程运行。

## 命令与工具映射

- `/name` 或 `Skill(name)`：读取 `upstream/skills/name/SKILL.md` 并执行相应步骤。单阶段内部的子步骤继续在本角色执行；跨顶层阶段回 Main 调度。原工具必须真实执行，不能把读取脚本当成已经执行。
- 将本 Skill 的 `upstream/` **实际绝对路径**用于每条命令的 `ARIS_REPO`，上游 canonical resolver 即可找到工具/模板。不要写死安装目录，不覆盖用户已有工具。Python/LaTeX/Graphviz等依赖须先检查。
- 外部 reviewer 调用由 `reviewer` / `paper_reviewer` 承担。保持原始 prompt、材料、对话、独立性和验收规则；不要求安装 Codex MCP 再套一层 Agent。作者为 Anthropic、reviewer 为 OpenAI，若用户换模型，仍须已知且不同家族；不可用时 blocked，绝不退为 same-family/provisional。
- 普通reviewer也使用新SCIENCEEVOLVE会话，研究多轮对话按原逻辑thread由完整原文 transcript（含工具输入输出）续接；不同阶段/候选的新thread不得串入彼此历史；hard/nightmare 的记忆与反驳裁决照常保存。论文每轮与 zero-context audit 使用 `paper_reviewer` 新会话，不传作者修复叙述、历史评分或 style-ref。当前共享 workspace 不提供访问安全隔离；独立性遵循与原文件协议相同的材料白名单，不能宣称有沙箱盲评。
- lens fan-out 在无宿主 spawn 时使用上游明确提供的 Tier 3。实验并发由 Task 的运行/队列工具执行，保留上游预算、超时、OOM重试、依赖wave与进程状态；不能用讨论代替实验。已授权环境不足则停下报告，不降低要求。
- `request_user` 由 Main 执行。按 AUTO_PROCEED/HUMAN_CHECKPOINT/合同争议的上游规则决定是否请求；需要回答时必须真正暂停，不能把沉默当批准。
- 可选消息、付费服务、外部发布不因安装 Skill 自动授权；只有用户启用对应上游选项并授权时才执行。关闭这些可选项不删减默认研究流程。

## Reviewer 交接协议（不是模拟 review）

1. 请求角色写完整 prompt 文件，列出**当前真实文件**与用途（W2用 `research_loop`），保存具体 continuation。用本 Skill `scripts/review_bridge.py --workspace <绝对workspace> request --workflow <实际启动配置> --requester <角色> --purpose <用途> --prompt <相对文件> --artifact <相对材料> --continuation <原步骤>` 建立请求；冷审另加 `--cold`。多个材料重复 `--artifact`。模型身份来自实际启动配置，不凭角色自己声称。
2. 将返回的 request ID、requester、reviewer、continuation 写入 `aris/pending_review.json`，交 Main。此时阶段**尚未完成**。Main 路由到指定 reviewer；作者不得提前生成 receipt。
3. Reviewer 读取请求的原文与材料，执行真实审查，保存完整 response；W2 的原文包含单独一行 `Score: n/10` 和 `Verdict: ready|almost|not ready`。执行 `... record --id <ID> --agent <当前reviewer角色> --response <相对原文文件>`，返回 Main。
4. Main/请求角色执行 `... consume --id <ID>` 校验材料/响应未变，保留 receipt 与完整原文，再从 continuation 续跑。修改材料后旧review失效，须重审。W2的decision调用上游 `review_gate.evaluate_transition`，不另造阈值；其余用途依相应原审计合同判断。
5. 将真实request/response及receipt路径作为持久trace/verdict handle关联上游run_state记录；对应阶段仍按原工具区分 `done` 与 `accepted`。`identity_assurance=configured-models`只说明配置来源，不伪称服务端模型身份已独立认证。

## 不能跳过的收尾

W1包含研究合同和实验计划；W1.5包含代码审查、sanity、完整运行与结果回收；W2严格保留4轮上限和score/verdict合取门槛。W3包含接受合同、图表、逐节写作、编译、适用proof/claim审计、2轮改稿复编译、最终claim/logic/integrity/citation等assurance审计和 `verify_paper_audits.sh`。按照原assurance参数判断适用范围，不以文件存在代替验收。AUTO_WRITE=false是上游明确的分支，不能拿该分支证明AUTO_WRITE=true也已完成。

## 深审与完整性审计的额外协议

普通reviewer使用xhigh；不能用它的一次回复替代proof-checker或integrity-forensics。proof-checker的完整义务提取/推导修复/原线程复审仍由对应阶段执行，实际ultra调用由`scripts/readonly_review.py --mode proof --cwd <材料目录> --prompt <原完整prompt> --output-dir <新的trace目录>`完成，后续用receipt中的thread ID加`--resume`。只有真实能力错误才使用上游允许的`--fallback gpt-6-astra`，再按原链尝试gpt-5.5；错误及实际effort必须记录，不能默认降级。

完整性审计固定依赖已随`integrity-upstream/`下载，其65个文件与MIT许可见`INTEGRITY_UPSTREAM.json`。先按原launcher准备**专用**固定SHA checkout并执行`eval/run_eval.py`（原工具使用git根定位，所以归档目录不直接冒充该checkout）；不要对用户研究repo执行launcher里的reset/clean。再由paper_assurance逐步执行该审计Skill的inline模式，包含证据ledger、全部适用独立auditor、零裁决权重写作风格track、advisory/refutation、coverage与确定性adjudicator，禁止整条研究pipeline黑盒外包。

每个独立审计调用用`readonly_review.py --mode integrity`，固定原pin实际配置gpt-5.6-sol/xhigh、真正read-only sandbox、approval never、每维度/每引用新线程、串行调用；不复用paper_reviewer会话。ARIS launcher有一处说明文字声称此pin用gpt-6-astra，但下载的实际pin规范为gpt-5.6-sol，以实际源规范为准并记录该差异。原审计代码决定verdict，SCIENCEEVOLVE只记录后再执行ARIS forensics_gate；REVIEW_UNAVAILABLE/缺coverage不得冒充CLEAN。Codex CLI原生profile须支持这些模型/effort；此工具直接使用原生配置，不能假定SDK env网关自动传入。

readonly_review仅替换单次Codex MCP传输，保存完整prompt、JSONL、原始response、thread与exit状态；不自行生成任何审计结论。真实调用失败按上游处理，不能伪造receipt。首次审计需可获取固定SHA（或提供已验证专用缓存）；原bootstrap会再次校验固定版本与eval gate。
