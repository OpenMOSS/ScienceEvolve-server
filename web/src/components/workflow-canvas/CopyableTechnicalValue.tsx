import { Check, Clipboard } from "lucide-react";
import { useEffect, useState } from "react";

export function CopyableTechnicalValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
  };

  return <span className="copyable-technical-value">
    <code title={value}>{value}</code>
    <button type="button" onClick={() => void copy()} aria-label={`复制 ${value}`} title="复制技术字段">
      {copied ? <Check size={11} /> : <Clipboard size={11} />}
    </button>
  </span>;
}
