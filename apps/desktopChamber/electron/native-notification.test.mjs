import assert from "node:assert/strict";
import test from "node:test";
import { notificationForEvent } from "./native-notification.mjs";

test("only live completion, failure, and approval events notify", () => {
  const event = { sessionId: "session-12345678", type: "run.completed" };
  assert.equal(notificationForEvent(event, true), null);
  assert.deepEqual(notificationForEvent(event, false), {
    title: "Agena finished",
    body: "Session 12345678 completed.",
  });
  assert.deepEqual(
    notificationForEvent({ ...event, type: "run.failed" }, false),
    {
      title: "Agena needs attention",
      body: "Session 12345678 failed.",
    },
  );
  assert.deepEqual(
    notificationForEvent({ ...event, type: "approval.requested" }, false),
    {
      title: "Agena needs approval",
      body: "Session 12345678 is waiting for you.",
    },
  );
  assert.equal(notificationForEvent({ type: "run.failed" }, false), null);
  assert.equal(
    notificationForEvent({ ...event, type: "message.user.created" }, false),
    null,
  );
});
