---
name: scienceevolve-biomni
description: 执行 Biomni A1 / E1：资源检索与真实工具闭环 的完整流程，保留上游能力、状态、候选选择、失败处理和终止规则。
---

运行目录合同：本例使用 main Git-off，所有角色的 cwd 是同一个持久工作区。Task/W、协议状态和候选目录均以此为准。首次按需求中的授权输入清单准备 Task 并记录来源摘要；恢复时先读原有状态，不覆盖/重置。来源目录只读；缺输入时报告阻断。脚本路径从本次实际加载的 Skill 文件位置解析，不硬编码旧缓存路径；Skill 暂存副本可被刷新，运行状态必须写到共享 Task 目录。


# Biomni A1 / E1

本例完整拆开固定版本A1的资源检索→ReAct生成→代码/工具执行→观察→再次生成，以及可选自批评/test-time scaling。E1是真实工具、软件和数据环境，不是多个研究Agent；不设置Evolver。源码、22个领域工具模块/描述、know-how、环境配置、数据湖下载实现随Skill携带，UPSTREAM.json逐文件记录来源。不得调用A1.go/go_stream/app.stream把整套自治系统包在一个角色中。

## 环境与任务

先读upstream/README.md、biomni_env/README.md和license_info.md。在Task的独立环境用官方biomni_env/setup.sh准备完整E1，再安装随附Python包；不用最低环境冒充完整E1。数据文件由scripts/bridge.py prepare-data调用原S3机制下载。默认全数据湖；commercial_mode必须按实际许可选择并记录，沿用上游的商业模式子集语义。凭据在环境变量里。环境与数据服务可以外部提供，不能据此省略工具调用。

在workspace写config.json：task为用户完整任务，data_path为数据根目录，use_tool_retriever=true，timeout_seconds=600，commercial_mode=false，self_critic=false，test_time_scale_round=0。后三项按照上游用户配置启用，不强制额外循环。完整字段及启动命令见README。配置extension可指向Task Python模块，其configure(agent)注册自定义数据/软件/MCP/工具；现有A1.add_*原子API均保留。add_tool的schema生成需要模型时，由Task显式提供原子schema模型或预先给出schema注册，不启动另一个自治Agent。记录扩展工具及其真实调用方式。

## SCIENCEEVOLVE逐步交接

在实际E1环境/Task工作目录启动`python <skill>/scripts/bridge.py serve --root <workspace/biomni-run> --config <config.json>`，保持同一进程。所有角色以`bridge.py call --root ... --input request.json`通信。server.json保存本地Unix socket；不是新增共享科研服务。服务器仅执行所请求的一步。

1. Main发`{"action":"prompt"}`，按phase交retrieval/researcher/critic读取返回的**全部messages**（包括原system、资源与上下文）。角色把真实回复保存后发`{"action":"respond","id":"唯一ID","prompt_id":"返回的prompt_id","response":"真实模型回复"}`。禁止代码产生假模型响应。
2. retrieve复用原ToolRetriever解析，再把选中know-how全文、工具签名、数据和软件写入原A1系统提示。retriever关闭时保留原全资源提示。phase=generate时保留原标签解析和完整反馈历史，不用角色摘要替代原材料。
3. phase=execute时交execute发`{"action":"advance","id":"唯一ID"}`。直接执行固定A1.execute闭包和原run_python_repl/R/Bash；持久Python变量、工具结果、绘图、错误、超时和10K上下文截断均按原实现。执行原文/图片随state.json保存。状态里被截断的观察不可冒充完整外部文件；大数据由Task工具保存文件再分析。
4. phase=critic且action=advance表示已满足配置轮数，无需模型；其余critic读取原自批评提示、实际反馈并返回generate。Main不能把第一次solution当作已启用critic的最终终点。
5. phase=end发`{"action":"export","id":"唯一ID","pdf":true}`，原保存器输出conversation.md/PDF和图片。根据真实solution验收Task，若是依赖阻断/执行错误，不称为科研成功。500个原子研究步到限视为预算阻断，不伪造solution。

## 工具与物理实验

A1直接Python工具、数据库/文献检索、分析软件、定制MCP都需实际可调用。Task需求触发物理实验时，wetlab Agent使用外部接口运行；协议校验、提交、job ID、状态、原始文件、失败/重试与实验条件全部落盘，下一次A1.execute读取这些实际文件产生观察。模拟器输出必须标为simulation，尤其upstream lab_automation.test_pylabrobot_script的ChatterboxBackend不是硬件。

## 恢复与已知源实现差异

各修改请求有不可复用内容的ID，已完成ID重试不重复执行，pending写入inflight.json。SCIENCEEVOLVE角色/调度暂停可重连同一活解释器。解释器死亡后不能仅恢复JSON冒充完整Python namespace，更不能自动重放含物理副作用的代码；报告中断，核对外部jobs/已存文件后开新run。原A1内存REPL同样不是持久进程checkpoint，这不声称实现了Agent回退。

保持固定源码不变；适配器只修正原generate允许大小写标签/代码块而execute只接受小写标签的传输不一致，保留原模型回复。原无标签重试由原解析处理并受500步上限约束。线程超时与REPL不是OS沙箱。测试覆盖协议/真实本地执行，未宣称生物学或湿实验结果已复现。
