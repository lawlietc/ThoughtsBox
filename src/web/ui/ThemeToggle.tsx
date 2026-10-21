/**
 * 主题切换：浅色「晨雾」/ 深色「夜灯」。
 *
 * 三条约束决定了这一份实现长这样：
 *
 * 1. **首帧就得是对的主题。** 所以在模块加载时立刻把 `data-theme` 钉到 `<html>` 上 ——
 *    等 React 挂完再设，用户会先看到一屏另一种光线再闪一下。
 * 2. **没有显式选择时跟随系统，选了就以选择为准。** 只存用户明确点过的那一次：
 *    「跟随系统」= 这一格里没有值，而不是存一个字符串叫「auto」。
 * 3. **只用眼睛看不到的东西一律不许存在。** 原生 `button`：可聚焦、Enter/Space 可触发，
 *    `aria-label` 说清点下去会切到哪个主题，不做 hover 才出现的控件。
 *
 * `localStorage` 读写包了 try/catch：隐私模式下它会直接抛，主题不该因此把整页弄崩。
 */

import { useState } from "react";
import { MoonStar, Sun } from "lucide-react";

import type { ThemeName } from "./types.ts";

const STORAGE_KEY = "tb-theme";

function systemTheme(): ThemeName {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): ThemeName | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function paint(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}

/** 模块加载即上色，早于任何一次渲染。 */
if (typeof document !== "undefined") {
  paint(storedTheme() ?? systemTheme());
}

export function ThemeToggle(): React.ReactNode {
  const [theme, setTheme] = useState<ThemeName>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light");

  const next: ThemeName = theme === "dark" ? "light" : "dark";
  const nextLabel = next === "dark" ? "深色" : "浅色";

  const toggle = (): void => {
    paint(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不进去只意味着下次打开回到跟随系统，这一屏的切换仍然生效。
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`切换到${nextLabel}主题`}
      title={`当前：${theme === "dark" ? "夜灯（深色）" : "晨雾（浅色）"} · 点击切换到${nextLabel}主题`}
      onClick={toggle}
    >
      {theme === "dark" ? <MoonStar aria-hidden="true" size={19} /> : <Sun aria-hidden="true" size={19} />}
    </button>
  );
}
