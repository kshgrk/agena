// Connection status + per-session runtime controls (plan §8).
import type { RuntimeInfoAck } from "@agena/protocol";
import { create } from "zustand";
import type {
  BridgeConnectionState,
  ConnectedInfo,
} from "../../shared/bridge.ts";
import type { ConnectionSlice } from "./types.ts";

export type ConnectionStore = ConnectionSlice & {
  setStatus: (state: BridgeConnectionState, detail?: string) => void;
  setInfo: (info: ConnectedInfo | null) => void;
  /** Fill runtime controls lazily from a runtimeInfo() ack. */
  setRuntime: (sessionId: string, info: RuntimeInfoAck) => void;
};

export const connectionInitial: ConnectionSlice = {
  state: "connecting",
  detail: null,
  info: null,
  runtime: {},
};

export const useConnection = create<ConnectionStore>((set) => ({
  ...connectionInitial,
  setStatus: (state, detail) => set({ state, detail: detail ?? null }),
  setInfo: (info) => set({ info }),
  setRuntime: (sessionId, info) =>
    set((s) => ({
      runtime: {
        ...s.runtime,
        [sessionId]: {
          thinkingLevel: info.thinkingLevel,
          availableModels: info.availableModels,
          availableThinkingLevels: info.availableThinkingLevels,
          ...(info.model ? { model: info.model } : {}),
        },
      },
    })),
}));
