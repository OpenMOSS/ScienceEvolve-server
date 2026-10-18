import { Github, LogIn, ShieldCheck } from "lucide-react";
import type { GitHubAccountRecord } from "../types";

export function GitHubAccountSelector({
  accounts,
  selectedAccountId,
  onChange,
  loading = false,
  compact = false,
  disabled = false
}: {
  accounts: GitHubAccountRecord[];
  selectedAccountId?: string;
  onChange: (accountId: string) => void;
  loading?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  const readyAccounts = accounts.filter((account) => account.status === "ready");
  const selected = readyAccounts.find((account) => account.id === selectedAccountId);
  const unavailableSelection = selectedAccountId
    ? accounts.find((account) => account.id === selectedAccountId && account.status !== "ready")
    : undefined;
  return (
    <div className={`github-account-selector${compact ? " is-compact" : ""}`}>
      <div className="github-account-selector-head">
        <span><Github size={15} /><strong>项目 GitHub 账号</strong></span>
        <a href="#/github-accounts">管理账号库</a>
      </div>
      {loading ? (
        <small>正在读取已登录账号…</small>
      ) : readyAccounts.length ? (
        <>
          <label>
            <span className="sr-only">选择项目 GitHub 账号</span>
            <select
              aria-label="选择项目 GitHub 账号"
              value={selectedAccountId ?? ""}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
            >
              <option value="" disabled>请选择一个账号</option>
              {readyAccounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {account.login}{account.isDefault ? " · 默认" : ""}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <div className="github-account-selected" role="status">
              <ShieldCheck size={14} />
              <span><strong>{selected.login}</strong><small>仓库将创建在该个人账号下；项目创建后不可切换。</small></span>
            </div>
          )}
          {unavailableSelection && (
            <div className="github-account-selector-empty" role="alert">
              <span>{unavailableSelection.login} 的授权不可用，请重新登录或改选账号。</span>
              <a href="#/github-accounts"><LogIn size={14} />管理 GitHub 授权</a>
            </div>
          )}
        </>
      ) : (
        <div className="github-account-selector-empty" role="alert">
          <span>还没有可用的 GitHub 账号，启用 Git 机制后需要先授权账号才能启动项目。</span>
          <a href="#/github-accounts"><LogIn size={14} />前往登录 GitHub</a>
        </div>
      )}
    </div>
  );
}
