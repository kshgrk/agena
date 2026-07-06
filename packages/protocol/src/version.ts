// Protocol version axis (§5.1). The per-event payload `v` is the other axis (§5.10).
export const PROTOCOL_VERSION = 1;
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

// Canonical WS endpoint (§3.2).
export const WS_PATH = "/v1/ws";
export const WS_SUBPROTOCOL = "agena.v1";
