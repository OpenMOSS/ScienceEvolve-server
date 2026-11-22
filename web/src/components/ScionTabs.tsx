import { useId, type ReactNode } from "react";

export function ScionTabs<Value extends string>({ label, value, tabs, onChange }: {
  label: string;
  value: Value;
  tabs: readonly { value: Value; label: ReactNode; content: ReactNode }[];
  onChange: (value: Value) => void;
}) {
  const id = useId();
  const tabId = (key: Value) => `${id}-tab-${key}`;
  const panelId = (key: Value) => `${id}-panel-${key}`;

  return <div className="scion-side-panel" data-component="tabs" data-variant="pill" data-orientation="horizontal" data-scope="conversation-side-panel">
    <div role="tablist" aria-label={label} data-slot="tabs-list">
      {tabs.map((tab, index) => {
        const selected = tab.value === value;
        return <div key={tab.value} data-slot="tabs-trigger-wrapper" data-value={tab.value}>
          <button type="button" role="tab" id={tabId(tab.value)} aria-selected={selected} aria-controls={panelId(tab.value)}
            data-slot="tabs-trigger" data-value={tab.value} data-selected={selected ? "" : undefined} tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)} onKeyDown={event => {
              const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)
                : offset ? tabs[(index + offset + tabs.length) % tabs.length] : undefined;
              if (!next) return;
              event.preventDefault();
              onChange(next.value);
              document.getElementById(tabId(next.value))?.focus();
            }}>
            {tab.label}
          </button>
        </div>;
      })}
    </div>
    {tabs.map(tab => <div key={tab.value} className="workspace-inspector-view" data-slot="tabs-content" role="tabpanel"
      id={panelId(tab.value)} aria-labelledby={tabId(tab.value)} hidden={tab.value !== value}>
      {tab.content}
    </div>)}
  </div>;
}
