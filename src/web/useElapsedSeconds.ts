import { useEffect, useState } from "react";

import { elapsedSecondsSince } from "./redactionTier.ts";

/**
 * 每秒一跳的「已经等了多久」（整秒）。`since === null` 恒为 `0` 且**不起定时器**。
 *
 * 为什么值得单独一个文件：判据本体在 `redactionTier.ts` 的纯函数里，这一层只负责「一跳」这件事，
 * 于是 node 环境（没有 DOM）也能静态断言定时器成对出现、不泄漏。
 */
export function useElapsedSeconds(since: number | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (since === null) {
      setElapsed(0);
      return;
    }
    const tick = (): void => setElapsed(elapsedSecondsSince(since, Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);

  return elapsed;
}
