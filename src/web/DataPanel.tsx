import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, EXPORT_JSONL_PATH, formatBytes, type BackupListData } from "./apiClient.ts";
import { DisclosureNote } from "./ui/bits.tsx";
import type { DataCheckReport, RestoreResult } from "../shared/dto.ts";

type Busy = null | string;

/**
 * 设置页第三组「数据与备份」：备份、导出、导入、恢复、备份文件管理。
 * 全部走真实 API；隐私与恢复风险的表述与入档承诺对齐——不做「绝对删除/永久不可恢复」类无法证明的承诺。
 * 恢复的「整体替换 / 安全快照 / 确认勾选」是直接可见的行动信息，永远不折叠。
 */
export function DataPanel(): React.ReactNode {
  const [backups, setBackups] = useState<BackupListData | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [restoringName, setRestoringName] = useState<string | null>(null);
  const [restoreAck, setRestoreAck] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [checkReport, setCheckReport] = useState<DataCheckReport | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ records: number; revisions: number } | null>(null);
  const [importIssues, setImportIssues] = useState<string[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    try {
      setBackups(await api.listBackups());
      setListError(null);
    } catch (cause) {
      setListError(cause instanceof ApiError ? cause.detail : "备份列表加载失败");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: string, fn: () => Promise<void>): Promise<void> {
    if (busy !== null) return;
    setBusy(action);
    setNotice(null);
    try {
      await fn();
    } catch (cause) {
      setNotice(cause instanceof ApiError ? cause.detail : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function onPickImportFile(): Promise<void> {
    const file = fileRef.current?.files?.[0];
    if (file === undefined) {
      setImportError("请先选择一个 JSONL 导出文件。");
      return;
    }
    const text = await file.text();
    setImportText(text);
    setImportError(null);
    setImportResult(null);
    setImportIssues([]);
  }

  const statusBadge = (status: string | undefined) =>
    status === undefined
      ? { label: "未校验", cls: "badge" }
      : status === "ok"
        ? { label: "完整", cls: "badge ok" }
        : status === "ok_with_warning"
          ? { label: "完整（有警告）", cls: "badge warn-badge" }
          : { label: "损坏", cls: "badge fail" };

  return (
    <section className="card">
      <h2>数据与备份</h2>
      <p className="hint">备份、导出与导入都只在本机进行；恢复和导入仍会逐项确认，不使用静默覆盖。</p>
      {notice !== null && <p className="warn">{notice}</p>}

      <h3>备份与恢复</h3>
        {listError !== null && (
          <p className="warn">
            {listError} <button className="btn" onClick={() => void reload()}>重试</button>
          </p>
        )}
        {backups !== null && listError === null && (
          <>
            <p className="row-meta">
              共 {backups.backups.length} 份 · 总占用 {formatBytes(backups.totalBytes)} ·
              最近备份 {backups.lastBackupUtc ?? "无"} · 最近校验成功 {backups.lastSuccessUtc ?? "无"} ·
              磁盘 {backups.disk.available ? `剩余 ${formatBytes(backups.disk.freeBytes ?? 0)}` : `不可读（${backups.disk.reason ?? "平台限制"}）`}
            </p>
            <div className="actions">
              <button
                className="btn primary"
                disabled={busy !== null}
                onClick={() =>
                  void run("create", async () => {
                    const { backup } = await api.createBackup();
                    await reload();
                    setNotice(`已创建快照 ${backup.name}（校验：${statusBadge(backup.verification?.status).label}）。`);
                  })
                }
              >
                {busy === "create" ? "创建中…" : "创建备份快照"}
              </button>
            </div>
            {backups.backups.length === 0 && <p className="hint">还没有备份。</p>}
            <ul className="list">
              {backups.backups.map((entry) => {
                const badge = statusBadge(entry.verification?.status);
                const restorable = entry.verification !== null && entry.verification.status !== "failed";
                return (
                  <li key={entry.name} className="backup-row">
                    <div className="backup-main">
                      <code>{entry.name}</code>
                      <span className="row-meta">
                        {entry.kind === "prerestore" ? "恢复前安全快照" : "快照"} · {entry.createdAtUtc} ·{" "}
                        {formatBytes(entry.sizeBytes)} ·{" "}
                        <span className={badge.cls}>{badge.label}</span>
                        {entry.verification?.detail ? `：${entry.verification.detail}` : ""}
                      </span>
                    </div>
                    <div className="actions">
                      <button
                        className="btn"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(`verify:${entry.name}`, async () => {
                            await api.verifyBackup(entry.name);
                            await reload();
                          })
                        }
                      >
                        {busy === `verify:${entry.name}` ? "校验中…" : "重新校验"}
                      </button>
                      <button className="btn" disabled={!restorable || busy !== null} onClick={() => {
                        setRestoringName(entry.name);
                        setRestoreAck(false);
                        setRestoreResult(null);
                      }}>
                        恢复到此备份
                      </button>
                      {deletingName === entry.name ? (
                        <>
                          <span className="hint">确认删除该备份文件？此操作不可从界面撤销。</span>
                          <button
                            className="btn danger"
                            disabled={busy !== null}
                            onClick={() =>
                              void run(`delete:${entry.name}`, async () => {
                                await api.deleteBackup(entry.name);
                                setDeletingName(null);
                                await reload();
                              })
                            }
                          >
                            确认删除
                          </button>
                          <button className="btn" onClick={() => setDeletingName(null)}>取消</button>
                        </>
                      ) : (
                        <button className="btn danger" disabled={busy !== null} onClick={() => setDeletingName(entry.name)}>
                          删除
                        </button>
                      )}
                    </div>

                    {restoringName === entry.name && (
                      <div className="confirm">
                        <h3>恢复前须知</h3>
                        <ul className="bullets">
                          <li>备份包含本地个人记录，敏感程度与数据库相同。</li>
                          <li>V0 不提供应用层备份加密。</li>
                          <li>备份不自动上传到第三方服务。</li>
                          <li>删除当前记录不自动修改旧备份。</li>
                          <li>恢复旧备份可能重新引入此前删除的内容。</li>
                        </ul>
                        <p>
                          恢复会<strong>整体替换</strong>当前数据库为备份时刻的状态；
                          执行前系统会自动创建一份「恢复前安全快照」，恢复失败时用它兜底。
                        </p>
                        <label>
                          <input type="checkbox" checked={restoreAck} onChange={(e) => setRestoreAck(e.target.checked)} />
                          我已了解上述影响，确认用 {entry.name} 整体替换当前数据库
                        </label>
                        <div className="actions">
                          <button
                            className="btn danger"
                            disabled={!restoreAck || busy !== null}
                            onClick={() =>
                              void run(`restore:${entry.name}`, async () => {
                                const result = await api.restore(entry.name);
                                setRestoringName(null);
                                setRestoreResult(result);
                                await reload();
                              })
                            }
                          >
                            {busy === `restore:${entry.name}` ? "恢复中…" : "执行恢复"}
                          </button>
                          <button className="btn" onClick={() => setRestoringName(null)} disabled={busy !== null}>
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {restoreResult !== null && (
              <p className="flash">
                恢复完成：来自 {restoreResult.restoredFrom}（schema v{restoreResult.fromSchemaVersion} → v
                {restoreResult.schemaVersion}），记录 {restoreResult.records} 条、版本 {restoreResult.revisions} 个
                {restoreResult.searchIndexRebuilt ? "，搜索索引已重建" : ""}
                {restoreResult.maintenanceTasksFound > 0
                  ? `，恢复出 ${restoreResult.maintenanceTasksFound} 项存储维护任务${restoreResult.maintenanceOk ? `，已清理 ${restoreResult.maintenanceResolved} 项` : `，暂未清理（${restoreResult.maintenanceDetail ?? "原因未知"}）`}`
                  : ""}
                。恢复前安全快照：{restoreResult.safetyBackupName}
              </p>
            )}
          </>
        )}

      <h3>导出与导入</h3>
      <p className="hint">导出全部记录与版本历史（NDJSON），文件只保存在本机。</p>
      <div className="actions">
        <a className="btn primary" href={EXPORT_JSONL_PATH} download>
          导出 JSONL
        </a>
      </div>
      <DisclosureNote summary="说明">
        <p className="hint">导出含对象类型与版本引用；删除审计与运行期维护任务不随导出迁移。</p>
      </DisclosureNote>
      <p className="hint">仅支持导入空数据库；先全量校验，任何一行有错都不会写入。</p>
      <div className="actions">
        <input
          ref={fileRef}
          type="file"
          accept=".jsonl,application/x-ndjson,text/plain"
          onChange={() => void onPickImportFile()}
        />
        <button
          className="btn primary"
          disabled={busy !== null || importText === null}
          onClick={() =>
            void run("import", async () => {
              if (importText === null) return;
              try {
                const result = await api.importJsonl(importText);
                setImportResult(result);
                setImportIssues([]);
                setImportError(null);
                setImportText(null);
                if (fileRef.current) fileRef.current.value = "";
              } catch (cause) {
                // 逐行问题清单是导入拒绝的核心体验，不能被泛化成一句“失败”。
                setImportResult(null);
                if (cause instanceof ApiError) {
                  setImportError(cause.detail);
                  setImportIssues(cause.issues);
                } else {
                  setImportError("导入失败");
                  setImportIssues([]);
                }
              }
            })
          }
        >
          {busy === "import" ? "导入中…" : "导入所选文件"}
        </button>
      </div>
      {importError !== null && <p className="warn">{importError}</p>}
      {importResult !== null && (
        <p className="flash">导入成功：记录 {importResult.records} 条、版本 {importResult.revisions} 个。</p>
      )}
      {importIssues.length > 0 && (
        <div className="warn">
          <p>导入被拒绝，未写入任何数据：</p>
          <ul>
            {importIssues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <h3>本机存储与清理</h3>
      <div className="actions">
        <button
          className="btn"
          disabled={busy !== null}
          onClick={() =>
            void run("check", async () => {
              try {
                setCheckReport(await api.dataCheck());
                setCheckError(null);
              } catch (cause) {
                setCheckReport(null);
                if (cause instanceof ApiError && cause.code === "data_check_failed") {
                  setCheckError(`自检未通过〔${cause.step ?? "?"}〕：${cause.detail}`);
                } else {
                  setCheckError(cause instanceof ApiError ? cause.detail : "自检请求失败");
                }
              }
            })
          }
        >
          运行数据自检
        </button>
      </div>
      {checkReport !== null && (
        <p className="flash">
          通过：schema v{checkReport.schemaVersion}，{checkReport.passedSteps.length} 项检查
          {checkReport.searchIndexRebuilt
            ? `（搜索索引已自动重建：重建前幽灵 ${checkReport.desyncBeforeRebuild?.phantom ?? 0}、缺失 ${checkReport.desyncBeforeRebuild?.missing ?? 0}）`
            : ""}
          。
        </p>
      )}
      {checkError !== null && <p className="warn">{checkError}</p>}
      <div className="privacy-notes">
        <p>数据只在本机：服务仅监听 127.0.0.1，备份、导出文件与数据库同敏感度，请自行保管。</p>
        <p>清理是尽力而为，不保证物理副本绝对不可恢复。</p>
      </div>
      <DisclosureNote summary="说明">
        <p>
          清理针对数据文件、全文索引与日志文件实施尽力机制；一次字节扫描没有命中，不代表绝对安全 ——
          旧备份、操作系统缓存、SSD 磨损均衡及固件副本等不在承诺范围内。
        </p>
      </DisclosureNote>
    </section>
  );
}
