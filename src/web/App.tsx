import { useEffect, useState } from "react";

interface Health {
  app: string;
  status: string;
  schemaVersion: number;
  sqliteVersion: string;
  dataDir: string;
  boundTo: string;
}

type State = { kind: "loading" } | { kind: "ok"; health: Health } | { kind: "error"; message: string };

/**
 * M0 只有骨架：确认本地后端可达、schema 版本与数据目录即可。
 * 图谱、记录、睡前模式属于后续里程碑（ADR-012 规定了可视化层不持有业务数据）。
 */
export function App(): React.ReactNode {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    fetch("/api/health")
      .then((response) => (response.ok ? (response.json() as Promise<Health>) : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((health) => {
        if (active) setState({ kind: "ok", health });
      })
      .catch((error: Error) => {
        if (active) setState({ kind: "error", message: error.message });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="shell">
      <h1>思绪盒子</h1>
      <p className="lede">本地优先的思绪整理工具 · V0 工程骨架</p>
      {state.kind === "loading" && <p>正在连接本地后端…</p>}
      {state.kind === "error" && (
        <p className="warn">
          本地后端不可达（{state.message}）。请先启动 <code>npm run start:server</code>。
        </p>
      )}
      {state.kind === "ok" && (
        <dl className="facts">
          <div>
            <dt>状态</dt>
            <dd>{state.health.status}</dd>
          </div>
          <div>
            <dt>Schema 版本</dt>
            <dd>{state.health.schemaVersion}</dd>
          </div>
          <div>
            <dt>SQLite</dt>
            <dd>{state.health.sqliteVersion}</dd>
          </div>
          <div>
            <dt>监听</dt>
            <dd>{state.health.boundTo}</dd>
          </div>
          <div>
            <dt>数据目录</dt>
            <dd>{state.health.dataDir}</dd>
          </div>
        </dl>
      )}
    </main>
  );
}
