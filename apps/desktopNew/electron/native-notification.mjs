export function notificationForEvent(event, replayed) {
  if (replayed || typeof event?.sessionId !== "string") return null;
  const session = event.sessionId.slice(-8);
  if (event.type === "run.completed") {
    return { title: "Agena finished", body: `Session ${session} completed.` };
  }
  if (event.type === "run.failed") {
    return {
      title: "Agena needs attention",
      body: `Session ${session} failed.`,
    };
  }
  if (event.type === "approval.requested") {
    return {
      title: "Agena needs approval",
      body: `Session ${session} is waiting for you.`,
    };
  }
  return null;
}
