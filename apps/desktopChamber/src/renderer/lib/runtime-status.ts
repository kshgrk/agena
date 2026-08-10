import type { SessionUsage, SubscriptionUsage } from "@agena/protocol";

export function formatUsageStatus(
  subscription: SubscriptionUsage | undefined,
  session: SessionUsage | undefined,
): string | null {
  if (subscription) {
    const reset = subscription.resetsAt
      ? ` (${new Intl.DateTimeFormat(undefined, {
          day: "numeric",
          month: "short",
        }).format(new Date(subscription.resetsAt))})`
      : "";
    return `${subscription.remainingPercent}% Weekly${reset}`;
  }
  if (!session) return null;
  return `$${session.costUsd.toFixed(session.costUsd < 1 ? 3 : 2)}`;
}
