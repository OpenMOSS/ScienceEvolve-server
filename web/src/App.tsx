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
import { ChevronDown, Database, Menu, Network, Plus, Save, X } from "lucide-react";
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
const AgentPresetManagementPage = lazy(() =>
  import("./pages/AgentPresetManagementPage").then(module => ({ default: module.AgentPresetManagementPage }))
);
const GitHubAccountManagementPage = lazy(() =>
  import("./pages/GitHubAccountManagementPage").then((module) => ({
    default: module.GitHubAccountManagementPage
  }))
);

type Route =
  | { name: "projects" }
  | { name: "gateways" }
  | { name: "agent-presets" }
  | { name: "saved-tasks" }
  | { name: "github-accounts" }
  | { name: "new"; savedTaskId?: string }
  | { name: "workspace"; projectId: string };

function routeFromHash(): Route {
  const hash = (window.location.hash.replace(/^#/, "") || "/projects").split("?", 1)[0]!;
  if (hash === "/new") return { name: "new" };
  if (hash === "/gateways") return { name: "gateways" };
  if (hash === "/agent-presets") return { name: "agent-presets" };
  if (hash === "/saved-tasks") return { name: "saved-tasks" };
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
  if (route.name === "agent-presets") return "/agent-presets";
  if (route.name === "saved-tasks") return "/saved-tasks";
  if (route.name === "github-accounts") return "/github-accounts";
  return "/projects";
}

function GlobalHeader({ route }: { route: Route }) {
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const resourcesRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);

  function closeMenus() {
    setResourcesOpen(false);
    setMobileOpen(false);
  }

  useEffect(() => {
    function dismissOutside(event: Event) {
      if (!(event.target instanceof Node)) return;
      if (!headerRef.current?.contains(event.target)) {
        closeMenus();
      } else if (!resourcesRef.current?.contains(event.target)) {
        setResourcesOpen(false);
      }
    }
    const desktop = window.matchMedia("(min-width: 721px)");
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    window.addEventListener("hashchange", closeMenus);
    desktop.addEventListener("change", closeMenus);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      window.removeEventListener("hashchange", closeMenus);
      desktop.removeEventListener("change", closeMenus);
    };
  }, []);

  return (
    <header
      className="global-header"
      ref={headerRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (resourcesOpen) {
          setResourcesOpen(false);
          triggerRef.current?.focus();
        } else if (mobileOpen) {
          closeMenus();
          mobileTriggerRef.current?.focus();
        }
      }}
    >
      <div className="global-nav">
        <a className="global-nav-brand" href="#/projects" aria-label="ScienceEvolve 首页" onClick={closeMenus}>
          <Brand compact />
        </a>
        <button
          type="button"
          className="global-nav-toggle"
          ref={mobileTriggerRef}
          aria-label={mobileOpen ? "关闭导航" : "打开导航"}
          aria-expanded={mobileOpen}
          aria-controls="global-nav-links"
          onClick={() => mobileOpen ? closeMenus() : setMobileOpen(true)}
        >
          {mobileOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
        </button>
        <nav className="global-nav-links" id="global-nav-links" aria-label="主导航" data-open={mobileOpen}>
          <div className="global-nav-sections">
            <a className="global-header-link" href="#/projects" aria-current={route.name === "projects" ? "page" : undefined} onClick={closeMenus}>
              项目
            </a>
            <div
              className="global-nav-resources"
              ref={resourcesRef}
              onPointerEnter={(event) => {
                if (!mobileOpen && event.pointerType === "mouse") setResourcesOpen(true);
              }}
              onPointerLeave={(event) => {
                if (!mobileOpen && event.pointerType === "mouse" &&
                  !event.currentTarget.querySelector(":focus-visible")) {
                  setResourcesOpen(false);
                }
              }}
            >
              <button
                ref={triggerRef}
                type="button"
                className={`global-header-link ${route.name === "gateways" || route.name === "agent-presets" || route.name === "saved-tasks" ? "active" : ""}`}
                aria-expanded={resourcesOpen}
                aria-controls="global-nav-resource-links"
                onClick={(event) => {
                  const pointer = event.nativeEvent as PointerEvent;
                  setResourcesOpen(!mobileOpen && pointer.pointerType === "mouse" ? true : !resourcesOpen);
                }}
              >
                资源 <ChevronDown size={14} aria-hidden="true" />
              </button>
              <div className="global-nav-dropdown" id="global-nav-resource-links" hidden={!resourcesOpen}>
                <div className="global-nav-dropdown-panel">
                  <a
                    href="#/gateways"
                    aria-current={route.name === "gateways" ? "page" : undefined}
                    onClick={closeMenus}
                  >
                    <Network size={16} aria-hidden="true" /> 全局网关库
                  </a>
                  <a href="#/agent-presets" aria-current={route.name === "agent-presets" ? "page" : undefined} onClick={closeMenus}>
                    <Database size={16} aria-hidden="true" /> Agent 配置预设
                  </a>
                  <a href="#/saved-tasks" aria-current={route.name === "saved-tasks" ? "page" : undefined} onClick={closeMenus}>
                    <Save size={16} aria-hidden="true" /> 已保存任务
                  </a>
                </div>
              </div>
            </div>
          </div>
          <div className="global-nav-actions">
            <a className="global-header-link" href="#/github-accounts" aria-current={route.name === "github-accounts" ? "page" : undefined} onClick={closeMenus}>
              GitHub 账号
            </a>
            {route.name !== "new" && (
              <a className="global-nav-create" href="#/new" onClick={closeMenus}>
                <Plus size={16} aria-hidden="true" /> 新建课题
              </a>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
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
      {route.name !== "workspace" && <GlobalHeader route={route} />}

      <Suspense fallback={<PageLoader label="正在准备科研界面…" />}>
        {(route.name === "projects" || route.name === "saved-tasks" || preserveProjectsForGitHub) && (
          <div hidden={preserveProjectsForGitHub}>
          <ProjectListPage
            view={route.name === "saved-tasks" ? "saved-tasks" : "projects"}
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
              onBack={() => navigate(editorRoute.savedTaskId ? "/saved-tasks" : "/projects")}
              onCreated={(id) => navigate(`/projects/${encodeURIComponent(id)}`)}
              savedTaskId={editorRoute.savedTaskId}
            />
          </div>
        )}
        {route.name === "gateways" && (
          <GatewayManagementPage onBack={() => navigate(pathForRoute(gatewayReturnRouteRef.current))} />
        )}
        {route.name === "agent-presets" && <AgentPresetManagementPage onBack={() => navigate("/projects")} />}
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
