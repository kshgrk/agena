// Implicit send-mode logic (features.md §5.2, the ONE subtle part), kept pure
// so it tests without React or a bridge:
//   idle    → prompt;   SESSION_BUSY    → auto-convert to steer + notice
//   running → steer/followUp per the queue mode; TURN_NOT_ACTIVE → silently
//             resend as prompt (the turn ended while typing)
// Anything else rethrows for the caller's toast.

export type SendMode = "prompt" | "steer" | "followUp";

export type SendApi = Record<SendMode, (text: string) => Promise<unknown>>;

export type SendOutcome = {
  sentAs: SendMode;
  /** Info toast for the user when the mode auto-converted. */
  notice?: string;
};

export function errCode(e: unknown): string {
  return typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as { code: unknown }).code === "string"
    ? (e as { code: string }).code
    : "";
}

export function errText(e: unknown): string {
  return typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof (e as { message: unknown }).message === "string"
    ? (e as { message: string }).message
    : "Something went wrong";
}

export async function performSend(
  api: SendApi,
  opts: { active: boolean; queueMode: "steer" | "followUp"; text: string },
): Promise<SendOutcome> {
  const { active, queueMode, text } = opts;
  if (active) {
    try {
      await api[queueMode](text);
      return { sentAs: queueMode };
    } catch (e) {
      if (errCode(e) === "TURN_NOT_ACTIVE") {
        await api.prompt(text);
        return { sentAs: "prompt" };
      }
      throw e;
    }
  }
  try {
    await api.prompt(text);
    return { sentAs: "prompt" };
  } catch (e) {
    if (errCode(e) === "SESSION_BUSY") {
      await api.steer(text);
      return { sentAs: "steer", notice: "Turn already active — sent as steer" };
    }
    throw e;
  }
}
