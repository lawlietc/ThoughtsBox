import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WINDOWS_LAUNCHERS = ["start-mock.cmd", "start-real.cmd"];

describe("Windows launchers stay cmd-safe", () => {
  for (const name of WINDOWS_LAUNCHERS) {
    it(`${name} uses CRLF and ASCII-only content`, () => {
      const bytes = readFileSync(join(ROOT, name));
      const text = bytes.toString("utf8");

      expect(text.startsWith("@echo off\r\n")).toBe(true);
      expect(text.replace(/\r\n/g, "")).not.toContain("\n");
      expect([...bytes].every((byte) => byte <= 0x7f), "cmd.exe misparses UTF-8 with LF-only endings").toBe(true);
    });
  }
});
