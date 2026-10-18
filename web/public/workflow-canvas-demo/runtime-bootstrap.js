// Runs before styles load and is compatible with the server's script-src 'self'.
if (new URLSearchParams(window.location.search).get("runtime") === "1") {
  document.documentElement.classList.add("runtime-mode");
  document.title = "运行 Workflow 画布";
}
