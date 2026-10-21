import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { ApiError, api, type Health } from "./apiClient.ts";
import { processingModeChoices } from "./projectionPort.ts";
import { MODE_LABEL } from "./ui/labels.ts";
import { DisclosureNote, KeyValue, StatusLine } from "./ui/bits.tsx";
import type {
  ModelProfileDto,
  ModelPrivacyConfigDto,
  UpdateModelConfigDto,
  UpdateModelProfileDto,
} from "../shared/dto.ts";

/**
 * 设置页：整理方式、模型配置、隐私与发送。数据与备份由调用方作为孩子传入，
 * 技术详情统一挂在所有分组之后，避免排障字段重新爬回首层。
 *
 * 模型配置只编辑配置文件和环境变量名。密钥值永不进 API、永不落盘；
 * 保存后当前进程不热换 Provider，界面明确提示重启后生效。
 * 原型的「调试」开关仍不搬：当前没有 trace 读写端点，摆一个不生效的开关比不摆更坏。
 */

const CALL_PATH_OPTIONS = [
  { value: "sdk_structured", label: "结构化输出（SDK 兼容）" },
  { value: "http_json_lenient", label: "宽松 JSON" },
  { value: "ollama_openai_compatible", label: "Ollama / OpenAI 兼容" },
] as const;

function modeNote(mode: string): string {
  if (mode === "cloud_redacted") return "整理得最准；发送前先换掉手机号、邮箱和已确认过的名字。";
  if (mode === "local_model") return "内容不出本机，整理慢一些。";
  if (mode === "manual_only") return "完全不送出去。";
  return "";
}

function editableProfile(
  profile: ModelProfileDto,
  fallbackCallPath: string,
): UpdateModelProfileDto {
  return {
    enabled: profile.enabled,
    provider: profile.provider,
    model: profile.model ?? "",
    baseUrl: profile.baseUrl,
    callPath: profile.callPath ?? fallbackCallPath,
    supportsStructuredOutput: profile.supportsStructuredOutput,
    requestTimeoutMs: profile.requestTimeoutMs,
    apiKeyEnv: profile.apiKeyEnv,
  };
}

function editableConfig(config: ModelPrivacyConfigDto): UpdateModelConfigDto {
  return {
    localModel: editableProfile(config.localModel, "ollama_openai_compatible"),
    cloudModel: editableProfile(config.cloudModel, "http_json_lenient"),
  };
}

interface ProfileEditorProps {
  readonly title: string;
  readonly description: string;
  readonly cloud: boolean;
  readonly value: UpdateModelProfileDto;
  readonly status: ModelProfileDto;
  readonly onChange: (patch: Partial<UpdateModelProfileDto>) => void;
}

function ProfileEditor(props: ProfileEditorProps): React.ReactNode {
  const { value, status } = props;
  return (
    <fieldset className="model-profile">
      <legend>{props.title}</legend>
      <div className="model-profile-head">
        <p className="hint">{props.description}</p>
        <label className="model-enable">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => props.onChange({ enabled: event.target.checked })}
          />
          <span>{value.enabled ? "已启用" : "未启用"}</span>
        </label>
      </div>

      <div className="model-fields">
        <label className="model-field">
          <span>服务名称</span>
          <input
            type="text"
            value={value.provider}
            placeholder={props.cloud ? "openai_compatible" : "ollama"}
            onChange={(event) => props.onChange({ provider: event.target.value })}
          />
        </label>
        <label className="model-field">
          <span>模型 ID</span>
          <input
            type="text"
            value={value.model}
            required={value.enabled}
            placeholder={props.cloud ? "gpt-4.1-mini" : "qwen3:8b"}
            onChange={(event) => props.onChange({ model: event.target.value })}
          />
        </label>
        <label className="model-field model-field-wide">
          <span>接口地址</span>
          <input
            type="url"
            value={value.baseUrl}
            placeholder={props.cloud ? "https://provider.example/v1" : "http://127.0.0.1:11434/v1"}
            onChange={(event) => props.onChange({ baseUrl: event.target.value })}
          />
        </label>
        <label className="model-field">
          <span>调用方式</span>
          <select
            value={value.callPath}
            onChange={(event) => props.onChange({ callPath: event.target.value })}
          >
            {CALL_PATH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="model-field">
          <span>请求超时（毫秒）</span>
          <input
            type="number"
            min={1000}
            max={120000}
            step={1000}
            value={Number.isFinite(value.requestTimeoutMs) ? value.requestTimeoutMs : 30000}
            onChange={(event) =>
              props.onChange({
                requestTimeoutMs: Number.isNaN(event.currentTarget.valueAsNumber)
                  ? 0
                  : event.currentTarget.valueAsNumber,
              })
            }
          />
        </label>
        <label className="model-field">
          <span>密钥环境变量名</span>
          <input
            type="text"
            value={value.apiKeyEnv}
            pattern="[A-Z][A-Z0-9_]{1,127}"
            title="只填环境变量名，例如 TB_MODEL_API_KEY；不要把密钥本身填进来。"
            onChange={(event) => props.onChange({ apiKeyEnv: event.target.value })}
          />
        </label>
        <label className="model-check model-field-wide">
          <input
            type="checkbox"
            checked={value.supportsStructuredOutput}
            onChange={(event) => props.onChange({ supportsStructuredOutput: event.target.checked })}
          />
          <span>服务声明支持结构化输出</span>
        </label>
      </div>

      <div className="model-profile-meta">
        <span className={`model-status${status.ready ? " is-ready" : ""}`}>
          当前实例：{status.ready ? "已就绪" : "未就绪"}
        </span>
        <span className={`model-status${status.apiKeyConfigured ? " is-ready" : ""}`}>
          {value.apiKeyEnv.trim() === ""
            ? "密钥：未填写环境变量名"
            : status.apiKeyConfigured
              ? "密钥变量：已设置"
              : "密钥变量：未设置"}
        </span>
      </div>

      {value.enabled && value.apiKeyEnv.trim() === "" && (
        <p className="warn">启用这一档前必须填写密钥环境变量名；密钥值不会写进配置文件。</p>
      )}
      {props.cloud && value.enabled && !status.apiKeyConfigured && (
        <p className="warn">
          当前进程读不到环境变量 {value.apiKeyEnv || "（未填写）"}。请先在启动环境中设置它，
          再重启本地后端；否则云端整理无法启用。
        </p>
      )}
      {!props.cloud && value.enabled && (
        <p className="hint">本地模型的接口地址必须是 127.0.0.1、localhost 或 ::1。</p>
      )}
    </fieldset>
  );
}

export interface SettingsPanelProps {
  readonly health: Health | null;
  /** 数据与备份由 `DataPanel` 提供，技术详情仍统一落在页底。 */
  readonly children?: ReactNode;
}

export function SettingsPanel(props: SettingsPanelProps): React.ReactNode {
  const [config, setConfig] = useState<ModelPrivacyConfigDto | null>(null);
  const [draft, setDraft] = useState<UpdateModelConfigDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setError(null);
    setSaveError(null);
    setNotice(null);
    try {
      const next = await api.ingestConfig();
      setConfig(next);
      setDraft(editableConfig(next));
    } catch (cause) {
      setConfig(null);
      setDraft(null);
      setError(cause instanceof ApiError ? cause.detail : "读取解析与隐私配置失败");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function patchProfile(
    key: keyof UpdateModelConfigDto,
    patch: Partial<UpdateModelProfileDto>,
  ): void {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            [key]: { ...current[key], ...patch },
          },
    );
    setSaveError(null);
    setNotice(null);
  }

  async function save(): Promise<void> {
    if (draft === null || saving) return;
    const missing: string[] = [];
    if (draft.localModel.enabled && draft.localModel.model.trim() === "") missing.push("本地模型 ID");
    if (draft.cloudModel.enabled && draft.cloudModel.model.trim() === "") missing.push("云端模型 ID");
    if (draft.localModel.apiKeyEnv.trim() === "") missing.push("本地模型密钥环境变量名");
    if (draft.cloudModel.apiKeyEnv.trim() === "") missing.push("云端模型密钥环境变量名");
    if (missing.length > 0) {
      setSaveError(`保存前请填写：${missing.join("、")}。`);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const next = await api.updateModelConfig({
        localModel: {
          ...draft.localModel,
          provider: draft.localModel.provider.trim(),
          model: draft.localModel.model.trim(),
          baseUrl: draft.localModel.baseUrl.trim(),
          apiKeyEnv: draft.localModel.apiKeyEnv.trim(),
        },
        cloudModel: {
          ...draft.cloudModel,
          provider: draft.cloudModel.provider.trim(),
          model: draft.cloudModel.model.trim(),
          baseUrl: draft.cloudModel.baseUrl.trim(),
          apiKeyEnv: draft.cloudModel.apiKeyEnv.trim(),
        },
      });
      setConfig(next);
      setDraft(editableConfig(next));
      setNotice("模型配置已保存。当前实例仍在使用旧配置，重启本地后端后生效。");
    } catch (cause) {
      setSaveError(cause instanceof ApiError ? cause.detail : "保存模型配置失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>整理方式</h2>
        <p className="hint">决定新记录默认怎么整理；单条记录仍可在「全部记录」的详情里单独改。</p>
        {error !== null ? (
          <p className="warn">
            {error}{" "}
            <button className="btn" onClick={() => void reload()}>
              重试
            </button>
          </p>
        ) : config === null ? (
          <p className="hint">读取中…</p>
        ) : (
          <>
            <p className="row-meta">
              <strong>当前默认：</strong>
              {MODE_LABEL[config.defaultMode] ?? config.defaultMode}
            </p>
            <p className="hint">{modeNote(config.defaultMode)}</p>
            <p className="hint">默认模式由服务端的配置文件决定；这里只显示，不改。</p>
          </>
        )}
      </section>

      <section className="card model-config-card">
        <h2>模型配置</h2>
        <p className="hint">
          本地与云端分别配置。设置页只保存环境变量名，不接触密钥值；保存后重启本地后端生效。
        </p>

        {error !== null ? (
          <p className="warn">读取失败，暂时无法编辑模型配置。</p>
        ) : config === null || draft === null ? (
          <p className="hint">读取中…</p>
        ) : (
          <form
            className="model-config-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="model-profile-grid">
              <ProfileEditor
                title="本地模型"
                description="只允许回环地址；内容不会离开这台电脑。"
                cloud={false}
                value={draft.localModel}
                status={config.localModel}
                onChange={(patch) => patchProfile("localModel", patch)}
              />
              <ProfileEditor
                title="云端模型"
                description="只在逐条确认发送后调用，并使用脱敏后的文本。"
                cloud
                value={draft.cloudModel}
                status={config.cloudModel}
                onChange={(patch) => patchProfile("cloudModel", patch)}
              />
            </div>

            {(config.restartRequired || notice !== null) && (
              <StatusLine tone="warn">
                {notice ?? "配置已保存。当前实例仍在使用旧配置，重启本地后端后生效。"}
              </StatusLine>
            )}
            {saveError !== null && <p className="warn">{saveError}</p>}

            <div className="actions">
              <button className="btn primary" type="submit" disabled={saving}>
                {saving ? "保存中…" : "保存模型配置"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={saving}
                onClick={() => {
                  setDraft(editableConfig(config));
                  setSaveError(null);
                  setNotice(null);
                }}
              >
                撤销未保存修改
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="card">
        <h2>隐私与发送</h2>
        <ul className="checklist">
          <li>
            每一条新记录<strong>首次发送前</strong>都会停下来让你确认实际发出去的文本；
            这个确认<strong>不做默认勾选</strong>，也不能一次授权管到底。
          </li>
          <li>手机号、邮箱一律换成占位符；已确认的人名、地方、作品、组织换成带类型的代号。</li>
          <li>
            本机还不认识的名字会在发送前问你；你没点头的，<strong>按原话发出去</strong>。
            脱敏不等于匿名化。
          </li>
          <li>改动原文后，这条授权立即失效。</li>
        </ul>
        <DisclosureNote summary="说明">
          <ul className="checklist">
            <li>代号换回真名只在本机做。这张对照表不会发出去，也不会写进导出文件。</li>
            <li>每次云端发送前，都会先给你看一份「实际要发出去的那份文本」，那一步在「待整理」页里；你可以改、可以划掉、也可以直接不发。</li>
          </ul>
        </DisclosureNote>
      </section>

      {props.children}

      {(config !== null || props.health !== null) && (
        <DisclosureNote summary="技术详情">
          {config !== null && (
            <>
              <h3>可选整理方式</h3>
              <ul className="list">
                {processingModeChoices().map((choice) => (
                  <li key={choice.key} className="item">
                    <label className="row-btn">
                      <input
                        type="radio"
                        name="default-mode"
                        checked={config.defaultMode === choice.key}
                        disabled
                        title="默认模式由 config.local.json 决定：改它要写服务端的配置文件，不走界面（配置即代码）"
                      />
                      <span className="row-title">{choice.label}</span>
                      <span className="row-meta">{modeNote(choice.key)}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <StatusLine>
                {config.modelEnabled ? "模型已启用" : "模型未启用"} ·{" "}
                {config.cloudRedactedEnabled ? "云端通道可用" : "云端通道未开启"}
              </StatusLine>
              <KeyValue
                rows={[
                  ["模型服务", config.provider ?? "未装配"],
                  ["模型", config.model ?? "未装配"],
                  ["调用通道", config.callPath ?? "未装配"],
                  ["密钥", config.apiKeyConfigured ? "已配置" : "未配置"],
                  ["可发起整理", config.ingestReady ? "是" : "否"],
                  ["请求超时", `${config.requestTimeoutMs} ms`],
                  ["本机档案", config.localModel.enabled ? "已启用" : "未启用"],
                  ["云端档案", config.cloudModel.enabled ? "已启用" : "未启用"],
                ]}
              />
            </>
          )}
          {props.health !== null && (
            <KeyValue
              rows={[
                ["数据库版本", `schema v${props.health.schemaVersion}`],
                ["SQLite", props.health.sqliteVersion],
                ["绑定地址", props.health.boundTo],
                ["数据目录", props.health.dataDir],
              ]}
            />
          )}
        </DisclosureNote>
      )}
    </div>
  );
}
