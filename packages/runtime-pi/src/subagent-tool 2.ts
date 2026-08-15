import type { SubagentController } from "@agena/core";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const paramsSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      role: Type.String({
        description: "Short role name, such as scout or reviewer",
      }),
      task: Type.String({
        description: "A bounded, independently completable task",
      }),
      model: Type.Optional(
        Type.Object({ provider: Type.String(), id: Type.String() }),
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

type Params = Static<typeof paramsSchema>;

export function createSubagentTool(
  controller: SubagentController,
  parentSessionId: string,
) {
  return defineTool({
    name: "subagent",
    label: "Subagents",
    description:
      "Delegate one to four independent read-only tasks to durable child agents. Tasks run in parallel and return bounded summaries.",
    promptGuidelines: [
      "Delegate only when isolated parallel work is useful; handle small sequential work directly.",
      "Give every child a bounded task with a concrete expected result.",
      "Subagents cannot recursively delegate or write to the shared workspace.",
    ],
    parameters: paramsSchema,
    executionMode: "sequential",
    async execute(parentToolCallId, params: Params, signal) {
      const result = await controller.run({
        parentSessionId,
        parentToolCallId,
        tasks: params.tasks,
        ...(signal ? { signal } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: result.tasks
              .map((task) => {
                const summary = task.summary
                  .map((block) =>
                    block.type === "text" ? block.text : "[content]",
                  )
                  .join("\n");
                return `${task.role} (${task.status}, session ${task.childSessionId}):\n${summary}`;
              })
              .join("\n\n"),
          },
        ],
        details: result,
      };
    },
  });
}
