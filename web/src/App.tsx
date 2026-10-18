import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode
} from "react";
import { Brand, Button, ErrorPanel, PageLoader } from "./components/Common";
import { ProjectListPage } from "./pages/ProjectListPage";
import { ProjectExplainerAssistantProvider } from "./components/ProjectExplainerAssistant";

const NewProjectPage = lazy(() =>
  import("./pages/NewProjectPage").then((module) => ({
    default: module.NewProjectPage
  }))
);
const WorkspacePage = lazy(() =>
  import("./pages/WorkspacePage").then((module) => ({
    default: module.WorkspacePage
  }))
);
const GatewayManagementPage = lazy(() =>
  import("./pages/GatewayManagementPage").then((module) => ({
    default: module.GatewayManagementPage
  }))
);
const GitHubAccountManagementPage = lazy(() =>
  import("./pages/GitHubAccountManagementPage").then((module) => ({
    default: module.GitHubAccountManagementPage
  }))
);

type Route =
  | { name: "projects" }
  | { name: "gateways" }
  | { name: "github-accounts" }
  | { name: "new"; savedTaskId?: string }
  | { name: "workspace"; projectId: string };

function routeFromHash(): Route {
  const hash = (window.location.hash.replace(/^#/, "") || "/projects").split("?", 1)[0]!;
  if (hash === "/new") return { name: "new" };
  if (hash === "/gateways") return { name: "gateways" };
  if (hash === "/github-accounts") return { name: "github-accounts" };
  const savedTaskEditMatch = hash.match(/^\/saved-tasks\/([^/]+)\/edit$/);
  if (savedTaskEditMatch) {
    return {
      name: "new",
      savedTaskId: decodeURIComponent(savedTaskEditMatch[1])
    };
  }
  const match = hash.match(/^\/projects\/([^/]+)$/);
  if (match) return { name: "workspace", projectId: decodeURIComponent(match[1]) };
  return { name: "projects" };
}

function navigate(path: string) {
  if (window.location.hash === `#${path}`) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = path;
  }
}

function pathForRoute(route: Route): string {
  if (route.name === "new") {
    return route.savedTaskId
      ? `/saved-tasks/${encodeURIComponent(route.savedTaskId)}/edit`
      : "/new";
  }
  if (route.name === "workspace") return `/projects/${encodeURIComponent(route.projectId)}`;
  if (route.name === "gateways") return "/gateways";
  if (route.name === "github-accounts") return "/github-accounts";
  return "/projects";
}

interface AppErrorBoundaryState {
  error?: Error;
}

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ScienceEvolve web interface crashed", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-fatal">
          <Brand />
          <ErrorPanel
            title="界面加载失败"
            message={this.state.error.message || "前端遇到了未预期的运行错误"}
            action={
              <div className="app-fatal-actions">
                <Button
                  variant="primary"
                  onClick={() => {
                    window.location.hash = "#/projects";
                    window.location.reload();
                  }}
                >
                  重新加载
                </Button>
              </div>
            }
          />
        </main>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [quickRequirementDraft, setQuickRequirementDraft] = useState("");
  const routeRef = useRef(route);
  const gatewayReturnRouteRef = useRef<Route>({ name: "projects" });
  const githubReturnRouteRef = useRef<Route>({ name: "projects" });

  useEffect(() => {
    const update = () => {
      const nextRoute = routeFromHash();
      if (nextRoute.name === "gateways" && routeRef.current.name !== "gateways") {
        gatewayReturnRouteRef.current = routeRef.current;
      }
      if (nextRoute.name === "github-accounts" && routeRef.current.name !== "github-accounts") {
        githubReturnRouteRef.current = routeRef.current;
      }
      routeRef.current = nextRoute;
      setRoute(nextRoute);
    };
    window.addEventListener("hashchange", update);
    if (!window.location.hash) window.history.replaceState(null, "", "#/projects");
    return () => window.removeEventListener("hashchange", update);
  }, []);

  // Keep the draft mounted while visiting the gateway library so every unsaved
  // field, workflow edit, and temporary draft remains intact on return.
  const editorRoute = route.name === "new"
    ? route
    : route.name === "gateways" && gatewayReturnRouteRef.current.name === "new"
      ? gatewayReturnRouteRef.current
      : route.name === "github-accounts" && githubReturnRouteRef.current.name === "new"
        ? githubReturnRouteRef.current
      : undefined;
  const preserveProjectsForGitHub = route.name === "github-accounts" &&
    githubReturnRouteRef.current.name === "projects";

  return (
    <ProjectExplainerAssistantProvider target={{ ...(route.name === "workspace" ? { projectId: route.projectId } : {}),
      ...(editorRoute ? { newProject: true, ...(editorRoute.savedTaskId ? { taskId: editorRoute.savedTaskId } : {}) } : {}) }}>
    <div className="app-shell">
      {route.name !== "workspace" && (
        <header className="global-header">
          <button
            className="brand-button"
            onClick={() => navigate("/projects")}
            aria-label="返回项目首页"
          >
            <Brand />
          </button>
          <div className="header-meta">
            <button
              type="button"
              className={`global-header-link ${route.name === "gateways" ? "active" : ""}`}
              onClick={() => navigate("/gateways")}
            >
              全局网关库
            </button>
            <button
              type="button"
              className={`global-header-link ${route.name === "github-accounts" ? "active" : ""}`}
              onClick={() => navigate("/github-accounts")}
            >
              GitHub 账号
            </button>
            <span className="system-health">
              <span className="health-dot" />
              多智能体编排就绪
            </span>
            <span className="version-pill">Research OS</span>
          </div>
        </header>
      )}

      <Suspense fallback={<PageLoader label="正在准备科研界面…" />}>
        {(route.name === "projects" || preserveProjectsForGitHub) && (
          <div hidden={route.name !== "projects"}>
          <ProjectListPage
            quickDraft={{
              requirement: quickRequirementDraft,
              onRequirementChange: setQuickRequirementDraft
            }}
            onCreate={() => navigate("/new")}
            onOpen={(id) => navigate(`/projects/${encodeURIComponent(id)}`)}
            onEditSavedTask={(id) =>
              navigate(`/saved-tasks/${encodeURIComponent(id)}/edit`)
            }
          />
          </div>
        )}
        {editorRoute && (
          <div hidden={route.name !== "new"}>
            <NewProjectPage
              key={editorRoute.savedTaskId ?? "new"}
              active={route.name === "new"}
              onBack={() => navigate("/projects")}
              onCreated={(id) => navigate(`/projects/${encodeURIComponent(id)}`)}
              savedTaskId={editorRoute.savedTaskId}
            />
          </div>
        )}
        {route.name === "gateways" && (
          <GatewayManagementPage onBack={() => navigate(pathForRoute(gatewayReturnRouteRef.current))} />
        )}
        {route.name === "github-accounts" && (
          <GitHubAccountManagementPage onBack={() => navigate(pathForRoute(githubReturnRouteRef.current))} />
        )}
        {route.name === "workspace" && (
          <WorkspacePage
            projectId={route.projectId}
            onBack={() => navigate("/projects")}
          />
        )}
      </Suspense>
    </div>
    </ProjectExplainerAssistantProvider>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AppContent />
    </AppErrorBoundary>
  );
}
