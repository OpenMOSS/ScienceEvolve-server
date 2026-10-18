import { AlertTriangle, Github, Globe2, LockKeyhole } from "lucide-react";
import { useId } from "react";
import type { GitHubAccountRecord, GitRepositoryVisibility } from "../types";
import { GitHubAccountSelector } from "./GitHubAccountSelector";

const REPOSITORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export function gitRepositoryNameError(value: string): string {
  const name = value.trim();
  if (!name) return "";
  if (name.length > 100) return "仓库名称不能超过 100 个字符";
  if (!REPOSITORY_NAME.test(name)) {
    return "仅支持字母、数字、点、短横线和下划线，且必须以字母或数字开头和结尾";
  }
  return "";
}

export function GitRepositorySettings({
  accounts,
  selectedAccountId,
  accountsLoading = false,
  repositoryName,
  visibility,
  onAccountChange,
  onRepositoryNameChange,
  onVisibilityChange,
  disabled = false,
  compact = false
}: {
  accounts: GitHubAccountRecord[];
  selectedAccountId?: string;
  accountsLoading?: boolean;
  repositoryName: string;
  visibility: GitRepositoryVisibility;
  onAccountChange: (accountId: string) => void;
  onRepositoryNameChange: (name: string) => void;
  onVisibilityChange: (visibility: GitRepositoryVisibility) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const visibilityGroupName = `git-repository-visibility-${useId()}`;
  const selected = accounts.find(
    (account) => account.id === selectedAccountId && account.status === "ready"
  );
  const nameError = gitRepositoryNameError(repositoryName);
  const repositoryLabel = repositoryName.trim() || "启动时自动生成";
  return (
    <div className={`git-repository-settings${compact ? " is-compact" : ""}`}>
      <GitHubAccountSelector
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        loading={accountsLoading}
        compact={compact}
        disabled={disabled}
        onChange={onAccountChange}
      />
      <div className="git-repository-fields">
        <label className="git-repository-name-field">
          <span><Github size={15} /><strong>仓库名称</strong></span>
          <input
            type="text"
            aria-label="GitHub 仓库名称"
            aria-invalid={Boolean(nameError)}
            value={repositoryName}
            maxLength={100}
            disabled={disabled}
            placeholder="留空则根据项目名称自动生成"
            onChange={(event) => onRepositoryNameChange(event.target.value)}
          />
          {nameError
            ? <small className="field-error" role="alert">{nameError}</small>
            : <small>名称留空时，系统会根据项目标题和项目 ID 生成唯一名称。</small>}
        </label>
        <fieldset className="git-repository-visibility">
          <legend>仓库可见性</legend>
          <label className={visibility === "private" ? "is-selected" : ""}>
            <input
              type="radio"
              name={visibilityGroupName}
              aria-label="Private 仓库"
              checked={visibility === "private"}
              disabled={disabled}
              onChange={() => onVisibilityChange("private")}
            />
            <LockKeyhole size={16} />
            <span><strong>Private</strong><small>仅授权成员可见，推荐用于研究过程。</small></span>
          </label>
          <label className={visibility === "public" ? "is-selected is-public" : ""}>
            <input
              type="radio"
              name={visibilityGroupName}
              aria-label="Public 仓库"
              checked={visibility === "public"}
              disabled={disabled}
              onChange={() => onVisibilityChange("public")}
            />
            <Globe2 size={16} />
            <span><strong>Public</strong><small>任何人都能查看仓库内容。</small></span>
          </label>
        </fieldset>
        {visibility === "public" && (
          <div className="git-public-warning" role="alert">
            <AlertTriangle size={15} />
            <span>Public 仓库会公开研究过程、提交记录和协作分支，请确认不含敏感资料。</span>
          </div>
        )}
        <div className="git-repository-preview" role="status">
          <span>启动项目时创建</span>
          <strong>{selected?.login ?? "未选择账号"}/{repositoryLabel}</strong>
          <small>{visibility === "private" ? "Private" : "Public"} · 不会在开启开关时立即创建</small>
        </div>
      </div>
    </div>
  );
}
