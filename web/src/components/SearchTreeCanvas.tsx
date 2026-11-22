import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronRight, FlaskConical, GitBranch, Hand, LayoutGrid, Maximize2, Minus, Plus, Sprout } from "lucide-react";
import { CanvasWorld } from "./workflow-canvas/CanvasWorld";
import { canvasContentBounds, fitCanvasViewport, zoomCanvasViewportAt } from "./workflow-canvas/core/canvas-viewport";
import { MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from "./workflow-canvas/core/canvas-layout";
import type { CanvasPoint, CanvasViewport } from "./workflow-canvas/core/canvas-model";

export interface SearchTreeSummaryNode {
  id: string;
  kind: "root" | "direction" | "candidate";
  parentId?: string;
  name: string;
}
export const treeKindLabels = { root: "根", direction: "方向", candidate: "候选" };
const NODE_WIDTH = 232, NODE_HEIGHT = 104;

/** Exclude the selected node and all descendants when choosing a new parent. */
export function searchTreeDescendants(nodes: readonly SearchTreeSummaryNode[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of nodes) if (node.parentId) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id); children.set(node.parentId, siblings);
  }
  const found = new Set<string>(), pending = [id];
  while (pending.length) {
    const next = pending.pop()!;
    if (found.has(next)) continue;
    found.add(next);
    pending.push(...(children.get(next) ?? []));
  }
  return found;
}

type Gesture = {
  pointerId: number; startX: number; startY: number; moved: boolean;
  viewport: CanvasViewport; nodeId?: string; origin?: CanvasPoint; prior?: CanvasPoint;
};

export function SearchTreeCanvas({ root, nodes, selectedId, onSelect }: {
  root: SearchTreeSummaryNode;
  nodes: readonly SearchTreeSummaryNode[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 32, y: 32, zoom: 1 });
  const [positions, setPositions] = useState<Record<string, CanvasPoint>>({});
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const frame = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture>();
  const fitted = useRef(false);
  const revealedSelection = useRef<string>();
  const expandedSelection = useRef<string>();
  const parents = useMemo(() => new Map(nodes.map(node => [node.id, node.parentId])), [nodes]);
  useEffect(() => {
    if (!selectedId || expandedSelection.current === selectedId) return;
    if (selectedId !== root.id && !parents.has(selectedId)) return;
    expandedSelection.current = selectedId;
    setCollapsed(current => {
      const next = new Set(current), visited = new Set([selectedId]);
      let parent = parents.get(selectedId);
      while (parent && !visited.has(parent)) {
        visited.add(parent); next.delete(parent); parent = parents.get(parent);
      }
      return next.size === current.size ? current : next;
    });
  }, [selectedId, parents, root.id]);
  const layout = useMemo(() => {
    const children = new Map<string, SearchTreeSummaryNode[]>();
    for (const node of nodes) if (node.parentId) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node); children.set(node.parentId, siblings);
    }
    const result = new Map<string, { node: SearchTreeSummaryNode; x: number; y: number; width: number; height: number; count: number }>();
    const pending = [{ node: root, depth: 0, visited: false }];
    let row = 0;
    while (pending.length) {
      const item = pending.pop()!;
      const branch = collapsed.has(item.node.id) ? [] : children.get(item.node.id) ?? [];
      if (!item.visited && branch.length) {
        pending.push({ ...item, visited: true });
        for (const child of [...branch].reverse()) pending.push({ node: child, depth: item.depth + 1, visited: false });
        continue;
      }
      const y = branch.length ? (result.get(branch[0].id)!.y + result.get(branch.at(-1)!.id)!.y) / 2 : row++ * 156;
      result.set(item.node.id, { node: item.node, x: item.depth * 320, y, width: NODE_WIDTH, height: NODE_HEIGHT, count: children.get(item.node.id)?.length ?? 0 });
    }
    return result;
  }, [root, nodes, collapsed]);
  const display = useMemo(() => new Map([...layout].map(([id, item]) => [id, { ...item, ...positions[id] }])), [layout, positions]);
  const bounds = useMemo(() => canvasContentBounds([...display.values()]), [display]);
  const latestBounds = useRef(bounds);
  latestBounds.current = bounds;

  useEffect(() => {
    const element = frame.current!;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize(current => current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    if (!size.width || !size.height) return;
    setViewport(fitCanvasViewport(size, latestBounds.current, { padding: 36, boundsPadding: 12, maxZoom: 1 }));
    fitted.current = true;
  }, [size]);
  useEffect(() => {
    if (!fitted.current || revealedSelection.current === selectedId) return;
    const selected = selectedId ? display.get(selectedId) : undefined;
    if (!selected) return;
    revealedSelection.current = selectedId;
    setViewport(current => {
      const left = selected.x * current.zoom + current.x, top = selected.y * current.zoom + current.y;
      if (left >= 20 && top >= 20 && left + NODE_WIDTH * current.zoom <= size.width - 20 && top + NODE_HEIGHT * current.zoom <= size.height - 20) return current;
      return { ...current, x: size.width / 2 - (selected.x + NODE_WIDTH / 2) * current.zoom, y: size.height / 2 - (selected.y + NODE_HEIGHT / 2) * current.zoom };
    });
  }, [selectedId, display, size]);
  useEffect(() => {
    const element = frame.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (gesture.current) return;
      const rect = element.getBoundingClientRect();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const delta = Math.max(-240, Math.min(240, event.deltaY * scale));
      setViewport(current => zoomCanvasViewportAt(current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, current.zoom * Math.exp(-delta * .0015)));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || gesture.current || (event.target as HTMLElement).closest(".search-tree-collapse")) return;
    const nodeId = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-node-id]")?.dataset.treeNodeId;
    const node = nodeId ? display.get(nodeId) : undefined;
    gesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewport, moved: false,
      ...(node ? { nodeId, origin: { x: node.x, y: node.y }, prior: positions[nodeId!] } : {}) };
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.startX, dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < 4) return;
    active.moved = true; setDragging(true);
    if (active.nodeId && active.origin) {
      const position = { x: active.origin.x + dx / active.viewport.zoom, y: active.origin.y + dy / active.viewport.zoom };
      setPositions(current => ({ ...current, [active.nodeId!]: position }));
    } else setViewport({ ...active.viewport, x: active.viewport.x + dx, y: active.viewport.y + dy });
  }
  function finish(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (cancel) {
      if (active.nodeId) setPositions(current => { const next = { ...current }; if (active.prior) next[active.nodeId!] = active.prior; else delete next[active.nodeId!]; return next; });
      else setViewport(active.viewport);
    } else {
      move(event);
      if (!active.moved && active.nodeId) onSelect(active.nodeId);
    }
    gesture.current = undefined; setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function fit(tidy = false) {
    if (tidy) setPositions({});
    setViewport(fitCanvasViewport(size, tidy ? canvasContentBounds([...layout.values()]) : bounds, { padding: 36, boundsPadding: 12, maxZoom: 1 }));
  }
  function zoom(next: number) { setViewport(current => zoomCanvasViewportAt(current, { x: size.width / 2, y: size.height / 2 }, next)); }
  return <section className="search-tree-canvas" aria-label="搜索树画布">
    <div className="search-tree-canvas-toolbar">
      <div className="search-tree-legend"><span className="root">起点</span><span className="direction">方向</span><span className="candidate">候选</span></div>
      <div className="search-tree-zoom">
        <button type="button" aria-label="整理搜索树布局" title="整理布局" onClick={() => fit(true)}><LayoutGrid size={15} /></button>
        <i aria-hidden="true" />
        <button type="button" aria-label="缩小搜索树" title="缩小" disabled={viewport.zoom <= MIN_CANVAS_ZOOM} onClick={() => zoom(viewport.zoom - .15)}><Minus size={15} /></button>
        <button type="button" className="search-tree-zoom-value" aria-label="重置搜索树缩放" title="重置为 100%" onClick={() => zoom(1)}>{Math.round(viewport.zoom * 100)}%</button>
        <button type="button" aria-label="放大搜索树" title="放大" disabled={viewport.zoom >= MAX_CANVAS_ZOOM} onClick={() => zoom(viewport.zoom + .15)}><Plus size={15} /></button>
        <button type="button" aria-label="适应搜索树画布" title="适应画布" onClick={() => fit()}><Maximize2 size={15} /></button>
      </div>
    </div>
    <CanvasWorld ref={frame} className="search-tree-viewport" viewport={viewport} worldWidth={Math.max(1, bounds?.maxX ?? 1)} worldHeight={Math.max(1, bounds?.maxY ?? 1)}
      aria-label="搜索树交互画布" cornerLabel="SEARCH TREE" panning={dragging} onPointerDown={begin} onPointerMove={move}
      onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const deltas: Record<string, CanvasPoint> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 }, ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } };
        const delta = deltas[event.key];
        if (delta) { event.preventDefault(); setViewport(current => ({ ...current, x: current.x + delta.x, y: current.y + delta.y })); }
      }}>
      <svg className="search-tree-links" width="100%" height="100%" aria-hidden="true">
        {[...display.values()].map(({ node, x, y }) => {
          const parent = node.parentId ? display.get(node.parentId) : undefined;
          if (!parent) return null;
          const startX = parent.x + NODE_WIDTH, startY = parent.y + NODE_HEIGHT / 2;
          const bend = Math.max(40, Math.abs(x - startX) / 2);
          return <path key={node.id} className={selectedId === node.id || selectedId === parent.node.id ? "is-selected" : ""}
            d={`M ${startX} ${startY} C ${startX + bend} ${startY}, ${x - bend} ${y + NODE_HEIGHT / 2}, ${x} ${y + NODE_HEIGHT / 2}`} />;
        })}
      </svg>
      {[...display.values()].map(({ node, x, y, count }) => {
        const Icon = node.kind === "root" ? Sprout : node.kind === "direction" ? GitBranch : FlaskConical;
        return <div key={node.id} data-tree-node-id={node.id} className={`search-tree-node ${node.kind}${selectedId === node.id ? " is-selected" : ""}`} style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}>
          {node.kind !== "root" && <span className="search-tree-port" aria-hidden="true" />}
          <button type="button" className="search-tree-node-select" aria-label={`${treeKindLabels[node.kind]}：${node.name}`} aria-pressed={selectedId === node.id}
            onClick={event => { if (event.detail === 0) onSelect(node.id); }}>
            <span className="search-tree-node-heading"><span className="search-tree-node-icon"><Icon size={16} /></span><small>{{ root: "研究起点", direction: "探索方向", candidate: "候选方案" }[node.kind]}</small><span className="search-tree-node-count">{count ? `${count} 个分支` : "叶节点"}</span></span>
            <strong title={node.name}>{node.name || "未命名"}</strong>
          </button>
          {count > 0 && <button type="button" className="search-tree-collapse" aria-label={`${collapsed.has(node.id) ? "展开" : "折叠"} ${node.name}`} aria-expanded={!collapsed.has(node.id)} onClick={() => setCollapsed(current => {
            const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next;
          })}>{collapsed.has(node.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>}
        </div>;
      })}
    </CanvasWorld>
    <div className="search-tree-canvas-caption"><span><Hand size={13} />拖动平移 · 滚轮缩放 · 拖动节点调整布局</span><span>{display.size} / {nodes.length + 1} 个节点</span></div>
  </section>;
}
