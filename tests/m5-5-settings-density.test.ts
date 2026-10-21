import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const WEB = join(process.cwd(), "src", "web");

function source(name: string): string {
  return readFileSync(join(WEB, name), "utf8");
}

function visible(name: string): string {
  return source(name)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/<DisclosureNote[\s\S]*?<\/DisclosureNote>/g, "«折叠»");
}

function folded(name: string): string {
  return [...source(name).matchAll(/<DisclosureNote[\s\S]*?<\/DisclosureNote>/g)]
    .map((match) => match[0])
    .join("\n");
}

function headings(text: string, level: 2 | 3): string[] {
  return [...text.matchAll(new RegExp(`<h${level}>(.*?)</h${level}>`, "g"))].map(
    (match) => match[1]!,
  );
}

describe("M5-5 · 更多 / 设置 / 数据首层减量", () => {
  const app = source("App.tsx");

  it("更多页只留一个设置与数据入口，不再用两个按钮通向同一页", () => {
    expect([...app.matchAll(/onClick=\{props\.onOpenData\}/g)]).toHaveLength(1);
    expect(app).toContain("设置与数据管理");
    expect(app).toContain("解析与隐私 · 备份 · 导出 · 导入 · 恢复");
  });

  it("首层只有整理方式、模型配置、隐私与发送、数据与备份四组", () => {
    const settings = visible("SettingsPanel.tsx");
    const data = visible("DataPanel.tsx");

    expect(headings(settings, 2)).toEqual(["整理方式", "模型配置", "隐私与发送"]);
    expect(headings(data, 2)).toEqual(["数据与备份"]);
    expect(headings(data, 3).filter((heading) => heading !== "恢复前须知")).toEqual([
      "备份与恢复",
      "导出与导入",
      "本机存储与清理",
    ]);
  });

  it("技术详情统一落在数据组之后，同时收着模型配置与本机数据库信息", () => {
    const settingsSource = source("SettingsPanel.tsx");
    const settingsVisible = visible("SettingsPanel.tsx");
    const settingsFolded = folded("SettingsPanel.tsx");

    expect(app).toContain("<SettingsPanel health={health}>");
    expect(settingsSource.indexOf("{props.children}")).toBeLessThan(
      settingsSource.indexOf('<DisclosureNote summary="技术详情">'),
    );
    expect(settingsFolded).toContain("config.provider");
    expect(settingsFolded).toContain("apiKeyConfigured");
    expect(settingsFolded).toContain("schemaVersion");
    expect(settingsFolded).toContain("sqliteVersion");
    expect(settingsFolded).toContain("dataDir");
    expect(settingsVisible).not.toContain("config.provider");
    expect(settingsVisible).not.toContain("schemaVersion");
  });

  it("高风险动作的警告、整体替换与确认勾选仍留在首层可见区", () => {
    const data = visible("DataPanel.tsx");

    expect(data).toContain("恢复旧备份可能重新引入此前删除的内容");
    expect(data).toContain("整体替换");
    expect(data).toContain("恢复前安全快照");
    expect(data).toContain('type="checkbox"');
    expect(data).toContain("仅支持导入空数据库");
    expect(data).toContain("确认删除该备份文件？此操作不可从界面撤销。");
  });
});
