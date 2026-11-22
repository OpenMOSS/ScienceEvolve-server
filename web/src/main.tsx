import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import App from "./App";
import "./styles.css";
import "./vendor/opencode-ui/button.css";
import "./vendor/opencode-ui/text-field.css";
import "./vendor/opencode-ui/tabs.css";
import "./vendor/opencode-ui/icon-button.css";
import "./vendor/opencode-ui/switch.css";
import "./vendor/opencode-ui/select.css";
import "./chuangqi.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
