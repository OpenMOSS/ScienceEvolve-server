# ScienceEvolve Workflow Canvas Demo

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

来源：`feat/workflow-canvas-demo`，提交 `45996b7b83c928e46dc810a03599c7b6d6f2f689`。

## 课题运行画布

运行页点击 Workflow 缩略图后，由 `WorkflowCanvasLive` 在弹窗中加载
`index.html?runtime=1&project=<projectId>`。该模式用主页面提供的真实拓扑、执行状态和事件驱动原有画布动画，支持实时新增节点、状态更新、缩放、平移、节点详情与 Escape 关闭。

`runtime.js` 接收同源父窗口的快照，并向父窗口报告节点选择和关闭操作。
运行模式隐藏演示播放与编辑操作，既不使用预设演示事件，也不读写浏览器保存的草稿。
不带 `runtime=1` 的页面仍保留原有独立演示功能。第三方库的许可证保留在 `vendor/`。

独立的纯前端工作流画布示例，展示 Main Agent 在执行过程中创建、调整和连接业务 Agent。支持 30 秒 / 60 秒播放、分阶段播放、工作流 JSON 下载和 GIF 导出。

页面执行预设的演示流程；运行本示例无需配置模型网关或启动后端服务。

## 启动

在本目录执行（需要 Python 3）：

```bash
python3 -m http.server 4175 --bind 0.0.0.0
```

浏览器打开 <http://127.0.0.1:4175/index.html>。使用远程开发环境时，转发 `4175` 端口后访问。

## 文件

- `index.html`：页面入口。
- `app.js`：画布交互、工作流编辑和演示播放。
- `styles.css`：页面及画布样式。
- `vendor/`：随附的 ELK、html2canvas、omggif 及其许可证。

所有前端依赖均已随附，无需安装 npm 包。用户保存的工作流和模板存储在当前浏览器的本地存储中。
