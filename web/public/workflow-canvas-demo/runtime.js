(function () {
  "use strict";
  if (!document.documentElement.classList.contains("runtime-mode")) return;

  var projectId = new URLSearchParams(window.location.search).get("project");
  var canvasApi = window.ScienceEvolveRuntimeCanvas;
  var labels = { draft: "尚未开始", queued: "等待运行", running: "执行中", retrying: "重试中", interrupting: "正在中断", interrupted: "已中断", pausing: "正在暂停", paused: "已暂停", cancelling: "正在取消", cancelled: "已取消", stopping: "正在停止", stopped: "已停止", completed: "执行完成", failed: "运行失败" };
  var statusBar = document.getElementById("run-status-bar");
  var logList = document.getElementById("run-log-list");
  var logs = [];
  var expanded = false;
  var scopeId = null;

  function renderLogs() {
    logList.replaceChildren();
    document.getElementById("run-log-panel").classList.toggle("runtime-log-expanded", expanded);
    (expanded ? logs : logs.slice(-1)).forEach(function (record) {
      var row = document.createElement("div");
      row.className = "run-log-item";
      var time = document.createElement("time");
      time.textContent = "T+" + (record.at / 1000).toFixed(1) + "s";
      var message = document.createElement("span");
      message.textContent = record.message;
      row.append(time, message);
      logList.appendChild(row);
    });
    if (!logs.length) logList.textContent = "尚无实际运行事件";
    if (expanded) logList.scrollTop = logList.scrollHeight;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== "scienceevolve.workflow.runtime.snapshot") return;
    var snapshot = event.data.snapshot;
    if (!snapshot || snapshot.projectId !== projectId || !canvasApi) return;
    if (scopeId !== (snapshot.scopeId || null)) touchPan = null;
    scopeId = snapshot.scopeId || null;
    canvasApi.update(snapshot);
    document.documentElement.classList.add("runtime-ready");
    statusBar.hidden = false;
    document.getElementById("run-status-label").textContent = labels[snapshot.status] || snapshot.status;
    document.getElementById("run-status-detail").textContent = snapshot.workflow.name;
    document.getElementById("run-status-dot").className = "run-status-dot phase-" + snapshot.status;
    document.getElementById("run-scenario-label").textContent = "实时运行";
    document.getElementById("run-current-agent").textContent = "当前：" + (snapshot.currentNodeId || "--");
    document.getElementById("run-parallel-count").textContent = "执行中：" + Object.values(snapshot.nodeStates).filter(function (state) { return state === "running" || state === "retrying"; }).length;
    document.getElementById("run-version").textContent = "Cycle " + snapshot.cycle;
    document.getElementById("run-log-panel").hidden = false;
    logs = snapshot.logs;
    renderLogs();
  });

  // Capture before the demo's log toggle handler so live logs retain their source.
  document.getElementById("run-log-toggle").addEventListener("click", function (event) {
    event.stopImmediatePropagation();
    expanded = !expanded;
    event.currentTarget.textContent = expanded ? "收起日志" : "展开日志";
    renderLogs();
  }, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") window.parent.postMessage({ type: "scienceevolve.workflow.runtime.close" }, window.location.origin);
    if (event.key === "Enter" || event.key === " ") {
      if (event.target.closest("button, a, input, textarea, select")) return;
      var node = event.target.closest("[data-node]");
      if (node) { event.preventDefault(); canvasApi.select(node.dataset.node); }
    }
  });
  var touchPan = null;
  var canvas = document.getElementById("canvas");
  // Group controls belong to the host's read-only presentation state. Keep
  // them out of node selection and touch panning; no workflow is edited here.
  canvas.addEventListener("mousedown", function (event) {
    if (event.target.closest("[data-runtime-action]")) event.stopImmediatePropagation();
  }, true);
  canvas.addEventListener("click", function (event) {
    var button = event.target.closest("[data-runtime-action]");
    var node = button && button.closest("[data-node]");
    if (!node) return;
    event.stopImmediatePropagation();
    window.parent.postMessage({ type: "scienceevolve.workflow.runtime." + button.dataset.runtimeAction,
      nodeId: node.dataset.node, groupId: button.dataset.groupId, scopeId: scopeId }, window.location.origin);
  }, true);
  canvas.addEventListener("pointerdown", function (event) {
    if (event.pointerType !== "touch") return;
    if (event.target.closest("button, a, input, textarea, select")) return;
    touchPan = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, node: event.target.closest("[data-node]") };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", function (event) {
    if (!touchPan || touchPan.id !== event.pointerId) return;
    var dx = event.clientX - touchPan.x;
    var dy = event.clientY - touchPan.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) touchPan.moved = true;
    if (touchPan.moved) canvasApi.pan(dx, dy);
    touchPan.x = event.clientX;
    touchPan.y = event.clientY;
  });
  canvas.addEventListener("pointerup", function (event) {
    if (!touchPan || touchPan.id !== event.pointerId) return;
    if (!touchPan.moved && touchPan.node) canvasApi.select(touchPan.node.dataset.node);
    touchPan = null;
  });
  canvas.addEventListener("pointercancel", function () { touchPan = null; });
  window.parent.postMessage({ type: "scienceevolve.workflow.runtime.ready" }, window.location.origin);
})();
