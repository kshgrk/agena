import { expect, it } from "vitest";
import { titleFromResponse } from "../src/session-name-extension.ts";

it("keeps title responses and rejects assistant replies", () => {
  expect(
    titleFromResponse(
      "Portfolio Theme Analysis",
      "what themes are present in this portfolio",
    ),
  ).toBe("Portfolio Theme Analysis");

  expect(
    titleFromResponse(
      "I don't see a portfolio attached or linked in your message. Could you please share it?",
      "what themes are present in this portfolio",
    ),
  ).toBe("What Themes Are Present In This Portfolio");
});
