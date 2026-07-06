import { describe, expect, it } from "vitest";
import {
  isTerminalPtyClose,
  parsePtyExit,
  ptyDataToBytes,
} from "../src/pty.ts";

describe("PTY WS helpers (§9.5)", () => {
  it("parses exit control frames and ignores everything else safely", () => {
    expect(
      parsePtyExit(JSON.stringify({ type: "exit", exitCode: 3, signal: null })),
    ).toBe(3);
    expect(
      parsePtyExit(
        JSON.stringify({ type: "exit", exitCode: null, signal: "SIGTERM" }),
      ),
    ).toBe(1);
    expect(
      parsePtyExit(JSON.stringify({ type: "resize", cols: 80, rows: 24 })),
    ).toBeUndefined();
    expect(parsePtyExit("not json {")).toBeUndefined();
  });

  it("classifies terminal close reasons", () => {
    expect(isTerminalPtyClose(1000, "pty ended")).toBe(true);
    expect(isTerminalPtyClose(1000, "pty not found")).toBe(true);
    expect(isTerminalPtyClose(1006, "")).toBe(false);
    expect(isTerminalPtyClose(1000, "client quit")).toBe(false);
  });

  it("normalizes every binary frame flavor to bytes", async () => {
    const bytes = new TextEncoder().encode("hi");
    expect(await ptyDataToBytes(bytes.buffer)).toEqual(bytes);
    expect(await ptyDataToBytes(bytes)).toEqual(bytes);
    expect(await ptyDataToBytes(new Blob([bytes]))).toEqual(bytes);
    expect(await ptyDataToBytes("hi")).toEqual(bytes);
  });
});
