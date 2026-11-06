import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { ApiError, api, type Health } from "./apiClient.ts";
import { processingModeChoices } from "./projectionPort.ts";
import { ENTITY_TYPE_LABEL, MODE_LABEL } from "./ui/labels.ts";
import { MODE_SHORT_LABEL } from "./ui/ProcessingModePicker.tsx";
import { isModeAvailable, modeUnavailableReason } from "./modeDefaults.ts";
import { DisclosureNote, KeyValue, StatusLine } from "./ui/bits.tsx";
import {
  LOCAL_LLM_BLANK_DRAFT,
  LOCAL_LLM_LOOPBACK_HINT,
  localLlmDraftFromTier,
  localLlmFailureHeadline,
  localLlmSubmitBody,
  localLlmTestResultText,
} from "./localLlmSettings.ts";
import type {
  LocalLlmTestResultDto,
  ModelConnectionTestResultDto,
  ModelProfileDto,
  ModelPrivacyConfigDto,
  ProcessingDefaultsDto,
  ProcessingModeAvailabilityDto,
  UpdateLocalLlmProfileDto,
  UpdateModelConfigDto,
  UpdateModelProfileDto,
  UpdateProcessingDefaultsDto,
  VocabularyEntityDto,
} from "../shared/dto.ts";

/**
 * 设置页：整理方式、模型配置、隐私与发送。数据与备份由调用方作为孩子传入，
 * 技术详情统一挂在所有分组之后，避免排障字段重新爬回首层。
 *
 * M5-6 起「整理方式」可编辑：普通记录与睡前记录各有默认，「记住上次」只是覆盖开关；
 * 独立保存走 PATCH，不重启即影响下一次进入入口页。模型配置支持直接输入密钥，
 * 密钥写入用户私有文件且永不回显；模型参数变化仍需重启，密钥更新可在当前进程立即生效。
 * 原型的「调试」开关仍不搬：当前没有 trace 读写端点，摆一个不生效的开关比不摆更坏。
 */

const CALL_PATH_OPTIONS = [
  { value: "sdk_structured", label: "结构化输出（SDK 兼容）" },
  { value: "http_json_lenient", label: "宽松 JSON" },
  { value: "ollama_openai_compatible", label: "Ollama / OpenAI 兼容" },
] as const;

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
  };
}

function editableConfig(config: ModelPrivacyConfigDto): UpdateModelConfigDto {
  return {
    localModel: editableProfile(config.localModel, "ollama_openai_compatible"),
    cloudModel: editableProfile(config.cloudModel, "http_json_lenient"),
  };
}

function apiKeySourceLabel(source: ModelProfileDto["apiKeySource"]): string {
  if (source === "saved") return "已保存";
  if (source === "environment") return "来自环境变量";
  return "未配置";
}

function connectionResultText(result: ModelConnectionTestResultDto): string {
  if (result.ok) return `连接成功 · ${result.latencyMs} ms`;
  return `连接失败：${result.message}${result.httpStatus === undefined ? "" : `（HTTP ${result.httpStatus}）`}`;
}

function editableProcessing(defaults: ProcessingDefaultsDto): UpdateProcessingDefaultsDto {
  return {
    recordDefaultMode: defaults.recordDefaultMode,
  };
}

/** 档位组；不可用档位禁用并写明原因。说明一律取共用表 `MODE_SHORT_LABEL`，不在这页另抄一份。 */
function ModeChoiceGroup(props: {
  readonly title: string;
  readonly name: string;
  readonly value: string | undefined;
  readonly availability: ModelPrivacyConfigDto["processingAvailability"];
  readonly onChange: (mode: string) => void;
}): React.ReactNode {
  return (
    <div className="stack">
      <p className="row-meta">
        <strong>{props.title}</strong>
      </p>
      <ul className="list">
        {processingModeChoices()
          .map((choice) => {
            // 键集合来自 DTO（四值），不是这里抄的字面量：抄一份就等于新档位一上线就被投成「不可用」。
            const available = props.availability[choice.key as keyof ProcessingModeAvailabilityDto];
            return (
              <li key={choice.key} className="item">
                <label className="row-btn">
                  <input
                    type="radio"
                    name={props.name}
                    checked={props.value === choice.key}
                    disabled={!available}
                    onChange={() => props.onChange(choice.key)}
                  />
                  <span className="row-title">{choice.label}</span>
                  <span className="row-meta">
                    {available ? MODE_SHORT_LABEL[choice.key] ?? "" : modeUnavailableReason(choice.key)}
                  </span>
                </label>
              </li>
            );
          })}
      </ul>
    </div>
  );
}

interface ProfileEditorProps {
  readonly title: string;
  readonly description?: string;
  readonly cloud: boolean;
  readonly value: UpdateModelProfileDto;
  readonly status: ModelProfileDto;
  readonly onChange: (patch: Partial<UpdateModelProfileDto>) => void;
  readonly testing: boolean;
  readonly testResult: ModelConnectionTestResultDto | null;
  readonly onTest: () => void;
}

function ProfileEditor(props: ProfileEditorProps): React.ReactNode {
  const { value, status } = props;
  const pendingKey = value.apiKey?.trim() ?? "";
  const keyReady =
    pendingKey !== "" || (value.clearApiKey === true ? false : status.apiKeyConfigured);
  return (
    <fieldset className="model-profile">
      <legend>{props.title}</legend>
      <div className="model-profile-head">
        {props.description !== undefined && props.description !== "" && (
          <p className="hint">{props.description}</p>
        )}
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
            max={300000}
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
        <label className="model-field model-field-wide">
          <span>API 密钥</span>
          <input
            type="password"
            autoComplete="new-password"
            value={value.apiKey ?? ""}
            placeholder={status.apiKeyConfigured ? "已保存；留空表示不修改" : "直接输入服务密钥"}
            onChange={(event) =>
              props.onChange({ apiKey: event.target.value, clearApiKey: false })
            }
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
          密钥：{apiKeySourceLabel(status.apiKeySource)}
        </span>
      </div>

      <p className="hint">
        直接输入的密钥保存在当前用户目录，不写进配置文件、数据库、导出或备份；输入框永远不会回显已保存的密钥。
      </p>
      {status.apiKeySource === "saved" && (
        <div className="actions">
          <button
            className="btn"
            type="button"
            disabled={props.testing}
            onClick={() => props.onChange({ apiKey: "", clearApiKey: true })}
          >
            清除已保存密钥
          </button>
          {value.clearApiKey === true && <span className="hint">保存后删除这份已保存密钥。</span>}
        </div>
      )}
      {props.cloud && value.enabled && !keyReady && (
        <p className="warn">云端整理需要可用密钥，请在上方输入。</p>
      )}
      {!props.cloud && value.enabled && <p className="hint">密钥可选：服务本身要求鉴权时再填写。</p>}

      <div className="actions">
        <button
          className="btn"
          type="button"
          disabled={props.testing || value.model.trim() === ""}
          onClick={props.onTest}
        >
          {props.testing ? "测试中…" : "测试连接"}
        </button>
      </div>
      <p className="hint">测试会向该服务发送一条固定消息，不读取你的记录。</p>
      {props.testResult !== null && (
        <StatusLine {...(props.testResult.ok ? {} : { tone: "warn" as const })}>
          {connectionResultText(props.testResult)}
        </StatusLine>
      )}
    </fieldset>
  );
}

interface LocalLlmEditorProps {
  readonly value: UpdateLocalLlmProfileDto;
  /** 服务端那一档的读数；`null` = 配置文件里还没有这一档（不是「坏了」）。 */
  readonly tier: ModelPrivacyConfigDto["localLlm"];
  readonly onChange: (patch: Partial<UpdateLocalLlmProfileDto>) => void;
  readonly testing: boolean;
  readonly testResult: LocalLlmTestResultDto | null;
  readonly onTest: () => void;
}

/**
 * 本地模型辅助脱敏那一栏（M9-4d-1）。
 *
 * 与上面两档**互不影响**：这里的任何改动只进提交体的 `localLlm` 段，`local_model` /
 * `cloud_redacted` 两个键由 `save()` 从各自的 draft 出，两条路不交汇。
 * 没有密钥输入框：这一档本阶段不提供界面存 key，只从环境变量读（变量名不为界面而设，M9-4d-1b）。
 * 地址不是回环时**只提示、不拦保存、也不改写用户输入**——拦在保存路径里会让人改不回一个写错的配置。
 */
function LocalLlmEditor(props: LocalLlmEditorProps): React.ReactNode {
  const { value, tier } = props;
  return (
    <fieldset className="model-profile">
      <legend>本地模型辅助脱敏</legend>
      <div className="model-profile-head">
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
            placeholder="ollama"
            onChange={(event) => props.onChange({ provider: event.target.value })}
          />
        </label>
        <label className="model-field">
          <span>模型 ID</span>
          <input
            type="text"
            value={value.model}
            required={value.enabled}
            placeholder="qwen3:8b"
            onChange={(event) => props.onChange({ model: event.target.value })}
          />
        </label>
        <label className="model-field model-field-wide">
          <span>接口地址</span>
          <input
            type="url"
            value={value.baseUrl}
            placeholder="http://127.0.0.1:11434/v1"
            onChange={(event) => props.onChange({ baseUrl: event.target.value })}
          />
        </label>
        {/* M9-6a：max 与配置层 schema 同一个上限（300000 对三档共享）；这里的缺省回落 90_000
            只属于本地脱敏档，另外两档的缺省见各自编辑器，未随本批改动。 */}
        <label className="model-field">
          <span>请求超时（毫秒）</span>
          <input
            type="number"
            min={1000}
            max={300000}
            step={1000}
            value={Number.isFinite(value.requestTimeoutMs) ? value.requestTimeoutMs : 90_000}
            onChange={(event) =>
              props.onChange({
                requestTimeoutMs: Number.isNaN(event.currentTarget.valueAsNumber)
                  ? 0
                  : event.currentTarget.valueAsNumber,
              })
            }
          />
        </label>
        <label className="model-field model-field-wide">
          <span className="model-check">
            <input
              type="checkbox"
              checked={value.supportsStructuredOutput ?? false}
              onChange={(event) => props.onChange({ supportsStructuredOutput: event.target.checked })}
            />
            <span>服务声明支持结构化输出</span>
          </span>
        </label>
      </div>

      <p className="hint">{LOCAL_LLM_LOOPBACK_HINT}</p>
      {tier !== null && tier.reason !== null && (
        // 分支只看 `reason` 那枚枚举（M9-D-4）；这一句是状态读数，不是从 `message` 里解析出来的。
        <p className="warn">当前状态：{localLlmFailureHeadline(tier.reason)}</p>
      )}

      <div className="actions">
        <button
          className="btn"
          type="button"
          disabled={props.testing}
          onClick={props.onTest}
        >
          {props.testing ? "测试中…" : "测试连接"}
        </button>
      </div>
      {props.testResult !== null && (
        <StatusLine {...(props.testResult.usable ? {} : { tone: "warn" as const })}>
          {localLlmTestResultText(props.testResult)}
        </StatusLine>
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
  const [procDraft, setProcDraft] = useState<UpdateProcessingDefaultsDto | null>(null);
  const [procSaving, setProcSaving] = useState(false);
  const [procError, setProcError] = useState<string | null>(null);
  const [procNotice, setProcNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"local" | "cloud" | null>(null);
  const [testResults, setTestResults] = useState<{
    local: ModelConnectionTestResultDto | null;
    cloud: ModelConnectionTestResultDto | null;
  }>({ local: null, cloud: null });
  /**
   * 本地脱敏档的 draft（M9-4d-1）。`null` 与「空白表单」是两件事：`null` 表示配置文件里
   * 还没有这一档，保存时**不带** `localLlm` 段（M9-D-2 的省缺语义）；动过一栏才物化成段。
   */
  const [localLlmDraft, setLocalLlmDraft] = useState<UpdateLocalLlmProfileDto | null>(null);
  const [localLlmTesting, setLocalLlmTesting] = useState(false);
  const [localLlmResult, setLocalLlmResult] = useState<LocalLlmTestResultDto | null>(null);
  /** Phase D / S10：词表与配置是两份独立的读取，词表读失败不该让整页配置显示成读不到。 */
  const [vocabulary, setVocabulary] = useState<readonly VocabularyEntityDto[] | null>(null);
  const [vocabError, setVocabError] = useState<string | null>(null);
  const [vocabBusyId, setVocabBusyId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setError(null);
    setSaveError(null);
    setNotice(null);
    try {
      const next = await api.ingestConfig();
      setConfig(next);
      setDraft(editableConfig(next));
      setProcDraft(editableProcessing(next.processingDefaults));
      setLocalLlmDraft(localLlmDraftFromTier(next.localLlm));
      setLocalLlmResult(null);
      setTestResults({ local: null, cloud: null });
    } catch (cause) {
      setConfig(null);
      setDraft(null);
      setProcDraft(null);
      setLocalLlmDraft(null);
      setError(cause instanceof ApiError ? cause.detail : "读取解析与隐私配置失败");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadVocabulary = useCallback(async (): Promise<void> => {
    setVocabError(null);
    try {
      const next = await api.entityVocabulary();
      setVocabulary(next.entities);
    } catch (cause) {
      setVocabulary(null);
      setVocabError(cause instanceof ApiError ? cause.detail : "读取词表失败");
    }
  }, []);

  useEffect(() => {
    void loadVocabulary();
  }, [loadVocabulary]);

  /**
   * 关闭一个词的自动遮蔽。服务端会顺手清掉这一版所有预览缓存——缓存里的载荷是用旧词表算的，
   * 不清就会「预览看不到它、真正发送仍用旧哈希」。已签发的授权不回收（它绑的是具体载荷），
   * 但下一次预览的载荷变了，那份授权自然不再命中。
   */
  async function toggleMask(row: VocabularyEntityDto): Promise<void> {
    if (vocabBusyId !== null) return;
    setVocabBusyId(row.entityId);
    setVocabError(null);
    try {
      const next = await api.entitySetMask(row.entityId, !row.maskEnabled);
      setVocabulary((current) =>
        current === null
          ? current
          : current.map((item) => (item.entityId === next.entityId ? next : item)),
      );
    } catch (cause) {
      setVocabError(cause instanceof ApiError ? cause.detail : "保存词表失败");
    } finally {
      setVocabBusyId(null);
    }
  }

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
    setTestResults((current) => ({ ...current, [key === "localModel" ? "local" : "cloud"]: null }));
    setSaveError(null);
    setNotice(null);
  }

  async function save(): Promise<void> {
    if (draft === null || saving) return;
    const missing: string[] = [];
    if (draft.localModel.enabled && draft.localModel.model.trim() === "") missing.push("本地模型 ID");
    if (draft.cloudModel.enabled && draft.cloudModel.model.trim() === "") missing.push("云端模型 ID");
    if (localLlmDraft?.enabled === true && localLlmDraft.model.trim() === "") {
      missing.push("本地脱敏模型 ID");
    }
    if (missing.length > 0) {
      setSaveError(`保存前请填写：${missing.join("、")}。`);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      // 这一档没被编辑过 ⇒ `localLlmSubmitBody` 给 `undefined` ⇒ 请求体里连键都不带，
      // 服务端逐字保留既有那一档（M9-D-2）。带着一个空白段去保存才是真正会抹配置的做法。
      const localLlmBody = localLlmSubmitBody(localLlmDraft);
      const next = await api.updateModelConfig({
        localModel: {
          ...draft.localModel,
          provider: draft.localModel.provider.trim(),
          model: draft.localModel.model.trim(),
          baseUrl: draft.localModel.baseUrl.trim(),
        },
        cloudModel: {
          ...draft.cloudModel,
          provider: draft.cloudModel.provider.trim(),
          model: draft.cloudModel.model.trim(),
          baseUrl: draft.cloudModel.baseUrl.trim(),
        },
        ...(localLlmBody === undefined ? {} : { localLlm: localLlmBody }),
      });
      setConfig(next);
      setDraft(editableConfig(next));
      setLocalLlmDraft(localLlmDraftFromTier(next.localLlm));
      setLocalLlmResult(null);
      setTestResults({ local: null, cloud: null });
      setNotice(
        "模型配置已保存。密钥后续请求会立即使用；服务地址、模型 ID 或调用方式变化后，重启本地后端后生效。",
      );
    } catch (cause) {
      setSaveError(cause instanceof ApiError ? cause.detail : "保存模型配置失败");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection(slot: "local" | "cloud"): Promise<void> {
    if (draft === null || testing !== null || saving) return;
    const profile = slot === "local" ? draft.localModel : draft.cloudModel;
    if (profile.model.trim() === "") {
      setTestResults((current) => ({
        ...current,
        [slot]: {
          ok: false,
          latencyMs: 0,
          code: "invalid_config",
          message: "请先填写模型 ID。",
        },
      }));
      return;
    }

    setTesting(slot);
    setTestResults((current) => ({ ...current, [slot]: null }));
    const typed = profile.apiKey?.trim();
    try {
      const result = await api.testModelConnection({
        profile: slot,
        provider: profile.provider.trim(),
        model: profile.model.trim(),
        baseUrl: profile.baseUrl.trim(),
        callPath: profile.callPath,
        supportsStructuredOutput: profile.supportsStructuredOutput,
        requestTimeoutMs: profile.requestTimeoutMs,
        ...(typed === undefined || typed === "" ? {} : { apiKey: typed }),
      });
      setTestResults((current) => ({ ...current, [slot]: result }));
    } catch (cause) {
      setTestResults((current) => ({
        ...current,
        [slot]: {
          ok: false,
          latencyMs: 0,
          code: "network",
          message: cause instanceof ApiError ? cause.detail : "无法完成连接测试。",
        },
      }));
    } finally {
      setTesting(null);
    }
  }

  /**
   * 改这一栏 ⇒ 物化出提交段。没配置过时从空白起点出发；已有那一档从服务端读数出发。
   * 只动这一段的 state，不碰 `draft`（另外两档因此不可能被这里的编辑牵连）。
   */
  function patchLocalLlm(patch: Partial<UpdateLocalLlmProfileDto>): void {
    setLocalLlmDraft((current) => ({ ...(current ?? LOCAL_LLM_BLANK_DRAFT), ...patch }));
    setLocalLlmResult(null);
    setSaveError(null);
    setNotice(null);
  }

  /** 连接测试测的是**当前草稿**（M9-4d-1b）：把表单里这一份发上去，服务端据此临时探测，不写盘。
   *  没编辑过这一栏（draft=null）时不带 profile ⇒ 服务端读已保存的那一档（M9-1 的现行行为）。 */
  async function testLocalLlmConnection(): Promise<void> {
    if (localLlmTesting || saving) return;
    setLocalLlmTesting(true);
    setLocalLlmResult(null);
    try {
      const draft = localLlmSubmitBody(localLlmDraft);
      setLocalLlmResult(await api.testLocalLlm(draft === undefined ? {} : { profile: draft }));
    } catch (cause) {
      // 传输层失败在 UI 上仍然是「不可用 + 一句人话」：`reason` 取探测失败类别里的 `network`，
      // 文案由这里自己给（服务端那句 message 此刻根本没回来）。
      setLocalLlmResult({
        usable: false,
        reason: "network",
        message: cause instanceof ApiError ? cause.detail : "无法完成连接测试。",
        structuredOutput: null,
        latencyMs: 0,
      });
    } finally {
      setLocalLlmTesting(false);
    }
  }

  /** 整理方式独立保存：走 PATCH，只写 processing 段；不改 Provider 装配，无需重启。 */
  async function saveProcessing(): Promise<void> {
    if (procDraft === null || config === null || procSaving || saving) return;
    setProcSaving(true);
    setProcError(null);
    setProcNotice(null);
    try {
      const saved = await api.updateProcessingDefaults(procDraft);
      setConfig({ ...config, processingDefaults: saved, defaultMode: saved.recordDefaultMode });
      setProcDraft(editableProcessing(saved));
      setProcNotice("整理方式已保存：下一次进入入口页就按新默认，不需要重启。");
    } catch (cause) {
      setProcError(cause instanceof ApiError ? cause.detail : "保存整理方式失败");
    } finally {
      setProcSaving(false);
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>整理方式</h2>
        {error !== null ? (
          <p className="warn">
            {error}{" "}
            <button className="btn" onClick={() => void reload()}>
              重试
            </button>
          </p>
        ) : config === null || procDraft === null ? (
          <p className="hint">读取中…</p>
        ) : (
          <>
            <p className="hint">
              这是<strong>写入页与睡前页共用的默认整理方式</strong>；在写入页/睡前页改档也会回写到这同一个值。
              单条记录在详情里单独改的整理方式只跟随那条记录，不影响这里。
            </p>
            <ModeChoiceGroup
              title="默认整理方式"
              name="record-default-mode"
              value={procDraft.recordDefaultMode}
              availability={config.processingAvailability}
              onChange={(mode) => {
                setProcDraft({ ...procDraft, recordDefaultMode: mode });
                setProcError(null);
                setProcNotice(null);
              }}
            />
            {(() => {
              const mode = procDraft.recordDefaultMode ?? "local_model";
              return isModeAvailable(mode, config.processingAvailability) ? null : (
                <p className="warn">
                  默认「{MODE_LABEL[mode] ?? mode}」当前不可用（{modeUnavailableReason(mode)}），写入页会按「仅保存」处理。
                </p>
              );
            })()}
            {procError !== null && <p className="warn">{procError}</p>}
            {procNotice !== null && <StatusLine>{procNotice}</StatusLine>}
            <div className="actions">
              <button
                className="btn primary"
                type="button"
                disabled={procSaving || saving}
                onClick={() => void saveProcessing()}
              >
                {procSaving ? "保存中…" : "保存整理方式"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={procSaving}
                onClick={() => {
                  setProcDraft(editableProcessing(config.processingDefaults));
                  setProcError(null);
                  setProcNotice(null);
                }}
              >
                撤销未保存修改
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card model-config-card">
        <h2>模型配置</h2>
        <p className="hint">地址、模型或调用方式变化后需重启本地后端。</p>

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
                cloud={false}
                value={draft.localModel}
                status={config.localModel}
                onChange={(patch) => patchProfile("localModel", patch)}
                testing={testing === "local"}
                testResult={testResults.local}
                onTest={() => void testConnection("local")}
              />
              <ProfileEditor
                title="云端模型"
                description="逐条确认后调用，发送的是脱敏文本。"
                cloud
                value={draft.cloudModel}
                status={config.cloudModel}
                onChange={(patch) => patchProfile("cloudModel", patch)}
                testing={testing === "cloud"}
                testResult={testResults.cloud}
                onTest={() => void testConnection("cloud")}
              />
            </div>

            <LocalLlmEditor
              value={localLlmDraft ?? LOCAL_LLM_BLANK_DRAFT}
              tier={config.localLlm}
              onChange={patchLocalLlm}
              testing={localLlmTesting}
              testResult={localLlmResult}
              onTest={() => void testLocalLlmConnection()}
            />

            {(config.restartRequired || notice !== null) && (
              <StatusLine tone="warn">
                {notice ??
                  "配置已保存。密钥后续请求会立即使用；模型参数变化需重启本地后端。"}
              </StatusLine>
            )}
            {saveError !== null && <p className="warn">{saveError}</p>}

            <div className="actions">
              <button className="btn primary" type="submit" disabled={saving || testing !== null}>
                {saving ? "保存中…" : "保存模型配置"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={saving || testing !== null}
                onClick={() => {
                  setDraft(editableConfig(config));
                  setLocalLlmDraft(localLlmDraftFromTier(config.localLlm));
                  setLocalLlmResult(null);
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

        <h3>词表管理</h3>
        <p className="hint">
          这里只列会被词表自动脱敏的人名、地名、组织。某一条被误脱敏时，把那一项移出词表：以后不再自动替换它；但本机模型进行脱敏处理仍有可能重新认出。
        </p>
        {vocabError !== null ? (
          <p className="warn">
            {vocabError}{" "}
            <button className="btn" type="button" onClick={() => void loadVocabulary()}>
              重试
            </button>
          </p>
        ) : vocabulary === null ? (
          <p className="hint">读取中…</p>
        ) : vocabulary.length === 0 ? (
          <p className="hint">词表里还没有会被自动脱敏的名字。</p>
        ) : (
          <ul className="list">
            {vocabulary.map((row) => (
              <li key={row.entityId} className="item">
                <div className="row-title">
                  {row.displayName}
                  <span className="row-meta">
                    {ENTITY_TYPE_LABEL[row.entityType] ?? row.entityType} ·{" "}
                    {row.maskEnabled ? "自动脱敏词表" : "已移出脱敏词表"}
                  </span>
                </div>
                {row.terms.length > 1 && (
                  <div className="row-meta">词面：{row.terms.join("、")}</div>
                )}
                <div className="actions">
                  <button
                    className="btn"
                    type="button"
                    disabled={vocabBusyId !== null}
                    onClick={() => void toggleMask(row)}
                  >
                    {vocabBusyId === row.entityId
                      ? "保存中…"
                      : row.maskEnabled
                        ? "这个词不再脱敏"
                        : "重新加入脱敏"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          改动后，这一条需要重新预览并确认发送。
        </p>
      </section>

      {props.children}

      {(config !== null || props.health !== null) && (
        <DisclosureNote summary="技术详情">
          {config !== null && (
            <>
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
                  ["本机密钥来源", apiKeySourceLabel(config.localModel.apiKeySource)],
                  ["云端密钥来源", apiKeySourceLabel(config.cloudModel.apiKeySource)],
                  [
                    "本地脱敏档",
                    config.localLlm === null
                      ? "未配置"
                      : `${config.localLlm.baseUrl} · ${config.localLlm.model ?? "无模型 ID"} · ${
                          config.localLlm.usable ? "可用" : "不可用"
                        }`,
                  ],
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
