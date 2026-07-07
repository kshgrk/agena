import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyHandle } from "../../../shared/bridge.ts";

const bridgeMock = vi.hoisted(() => ({
  openPty: vi.fn<() => Promise<PtyHandle>>(),
}));

vi.mock("../../lib/bridge.ts", () => ({
  getBridge: () => bridgeMock,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    clearDecorations() {}
    findNext() {}
    findPrevious() {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    onSelectionChange() {}
    getSelection() {
      return "";
    }
    onData() {}
    attachCustomKeyEventHandler() {}
    write() {}
    dispose() {}
    focus() {}
  },
}));

function fakePort(): MessagePort {
  return {
    postMessage: vi.fn(),
    close: vi.fn(),
  } as unknown as MessagePort;
}

describe("terminal store", () => {
  beforeEach(async () => {
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: () => "",
    }));
    bridgeMock.openPty.mockReset();
    const { useTerminals } = await import("./terminal-store.ts");
    useTerminals.setState({
      tabs: [],
      activeId: null,
      findFor: null,
    });
  });

  it("opens PTYs with an initial size before TerminalView sends the fitted resize", async () => {
    bridgeMock.openPty.mockResolvedValue({ ptyId: "pty_1", port: fakePort() });

    const { useTerminals } = await import("./terminal-store.ts");
    await useTerminals
      .getState()
      .open({ cwd: "/workspace/app", sessionId: "session_1" });

    expect(bridgeMock.openPty).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      cwd: "/workspace/app",
      sessionId: "session_1",
    });
  });
});
