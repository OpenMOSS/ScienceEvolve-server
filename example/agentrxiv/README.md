# AgentRxiv workflow

[← 返回中文 README](../../README_zh-CN.md#examples) · [Back to English README](../../README.md#examples) · [示例目录](../README.md)

保留完整Agent Laboratory的七阶段和两个求解器，在每篇研究中加入共享预印本top5语义检索、全文读取、5句摘要、证据综合、最终PDF发布回读，以及跨论文累计研究。不同实验室是独立 ScienceEvolve 项目，共享服务外部提供。

## 网页使用

本目录仅提供静态流程文件与资源。Web 用户按[手动使用说明](../README.md#在-web-中手动查看和使用)导出副本，再通过主页通用 JSON 导入入口查看和使用；补全需求与真实网关后自行启动。SDK 运行见 [SDK 使用指南](https://github.com/OpenMOSS/ScienceEvolve/blob/main/sdk/README_zh-CN.md)。

## 实现与外部能力

[固定上游](https://github.com/SamuelSchmidgall/AgentLaboratory/tree/d9017d90e329112d2a80b7712f37ee9094d2cd27)源码、完整Lab执行Skill以及原app.py（API服务）已随本例携带。共享服务可以部署原Flask/SQLite/all-MiniLM-L6-v2实现，也可用同能力提供者；服务进程本身不算科研workflow。

准备实际 archive URL 和对应 shared uploads 目录。在网页中建立两个独立研究项目，分别使用本模板，需求中写相同 archive 信息、不同 lab ID 与 num_papers；两个项目各自使用 Server 管理的工作区。

SDK 命令行运行见 [SDK 使用指南](https://github.com/OpenMOSS/ScienceEvolve/blob/main/sdk/README_zh-CN.md)。当前 main 从网页载入示例并管理工作区。

archive角色使用真实IO脚本：

```bash
python example/agentrxiv/skills/scienceevolve-agentrxiv/scripts/archive.py search --url http://localhost:5000 --query '实际研究问题' --root /absolute/lab-a/archive
python example/agentrxiv/skills/scienceevolve-agentrxiv/scripts/archive.py publish --url http://localhost:5000 --uploads /absolute/shared/uploads --pdf /absolute/lab-a/tex/temp.pdf --lab lab-a --paper 1 --root /absolute/lab-a/archive
```

search保留实际PDF、全文、archive ID、哈希及排序；5句摘要由真实研究角色阅读全文后写入，并交PhD纳入原文献综述。publish沿用原共享目录传输，随后触发索引更新、检索和下载比对哈希才登记回执；失败可用相同内容重试，不覆盖其他lab的同名报告。原服务是外部可信实验部署配置，上传权限与凭据由运行环境提供。

每篇论文均执行完整Lab流程，保持原solver次数/命令/reward/三位审稿人/人工回环。每篇完成后重新进入下一篇研究并重新查询archive；仅发布或读取文件不算已经利用另一实验室成果，要在综述、计划与实验中记录实际引用链。

## 验证边界

交付完整公开科研流程、实际工具连接与执行协议；已进行本地算法/文件状态/真实本地执行或IO契约测试。尚未完成真实模型、完整领域环境和湿实验的端到端科研验收，不能声称论文科学结果已复现。外部共享服务不列为workflow缺失；实际运行仍必须连接并取得真实结果。

## Workflow 画布

真实前端组件的独立文档展示，不是完整应用窗口。单图仅代表一个实验室；archive 是客户端角色，多实验室需要独立项目共享服务，不能靠单次启动验收。

**[查看 3 张可读阶段图与总览](../../docs/readme/workflows/agentrxiv.md)** · [方法与部署映射](../METHODS.md#agentrxiv)。静态配置，未运行科研任务。

[原始 JSON](workflow.json) · [手动导入](../README.md#在-web-中手动查看和使用)
