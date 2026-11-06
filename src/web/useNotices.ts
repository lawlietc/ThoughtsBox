/**
 * 提示的归属地（web-redesign 批 2 · 事项 I）。
 *
 * 全应用只有这一份提示队列：页面把要说的话交给它，外壳把它画在滚动区之外。
 * 「谁都能自己 setTimeout 藏掉自己的提示」正是旧的口径 —— 错误被时间冲走，
 * 提示被滚上去，两处同时冒出来各说各的。这里定的规则只有三条：
 *
 * 1. `ok`（做完一件事的回执）6 秒自己走 —— 它只是确认「按到了」，不该长期占位；
 * 2. `error` 与 `status` **不会自己走**，错误必须被看见或被关掉；
 * 3. 版面上**同时最多一条 error 加一条 ok**：新的回执/失败顶掉旧的同类，长期状态按 key 各占一格。
 *    叠十条提示不会让用户更谨慎，只会让第一屏变成日志。
 *
 * 计时器统一由这里管：组件卸载时清干净，条目被撤或被取代时随状态收敛。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { NoticeItem } from "./ui/types.ts";

/** 调用方给的内容：`id` 由这里生成，页面不需要关心。 */
export type NoticeInput = Omit<NoticeItem, "id">;

/** `ok` 回执的存活时间。沿用「全部记录」页原本那 6 秒，不另定一个新数。 */
const OK_TTL_MS = 6000;

export interface NoticeApi {
  readonly notices: readonly NoticeItem[];
  push: (input: NoticeInput) => void;
  dismiss: (id: string) => void;
  /** 换记录时清掉属于上一条记录的提示。 */
  clearScope: (scope: string) => void;
}

export function useNotices(): NoticeApi {
  const [notices, setNotices] = useState<readonly NoticeItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const dismiss = useCallback((id: string): void => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearScope = useCallback((scope: string): void => {
    setNotices((prev) => prev.filter((n) => n.scope !== scope));
  }, []);

  const push = useCallback((input: NoticeInput): void => {
    seq.current += 1;
    const item: NoticeItem = { ...input, id: `notice-${seq.current}` };
    setNotices((prev) => {
      // 同时最多一条 `error` + 一条 `ok`：再来一句就换掉前一句，不叠成一摞、不互相挤位置。
      // `status` 各占一格，按 `key` 去重 —— 「后端不可达」与「清理待办」是两件事，不该互相顶掉。
      const kept = prev.filter((n) =>
        n.tone === "status" ? n.key !== item.key : n.tone !== item.tone,
      );
      return [item, ...kept];
    });
  }, []);

  // 计时器跟着状态走：在册的 `ok` 起一个，不在册的收掉。
  useEffect(() => {
    const living = new Set(notices.filter((n) => n.tone === "ok").map((n) => n.id));
    for (const [id, timer] of timers.current) {
      if (!living.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    for (const notice of notices) {
      if (notice.tone !== "ok" || timers.current.has(notice.id)) continue;
      timers.current.set(
        notice.id,
        setTimeout(() => {
          timers.current.delete(notice.id);
          setNotices((prev) => prev.filter((n) => n.id !== notice.id));
        }, OK_TTL_MS),
      );
    }
  }, [notices]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  return { notices, push, dismiss, clearScope };
}
