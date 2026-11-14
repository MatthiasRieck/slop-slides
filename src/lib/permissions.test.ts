import { describe, expect, it } from "vitest";

import { type Approval, approvalOutcome, sessionScopeLine } from "./permissions";

const approval: Approval = {
  id: "a",
  title: "Run a command",
  reason: null,
  details: "ls",
  acceptLabel: "Allow once",
  decisions: ["accept", "acceptForSession", "decline"],
};

describe("approvalOutcome", () => {
  it("says how a request was answered", () => {
    expect(approvalOutcome({ approval, status: "resolved", decision: "accept" })).toBe("Allowed once");
    expect(
      approvalOutcome({
        approval: { ...approval, acceptLabel: "Allow for this turn" },
        status: "resolved",
        decision: "accept",
      }),
    ).toBe("Allowed for this turn");
    expect(approvalOutcome({ approval, status: "resolved", decision: "acceptForSession" })).toBe(
      "Always allowed in this chat",
    );
    expect(approvalOutcome({ approval, status: "resolved", decision: "decline" })).toBe("Denied");
  });

  it("says a request was not answered, or answered without knowing how", () => {
    expect(approvalOutcome({ approval, status: "expired" })).toBe("Not answered");
    expect(approvalOutcome({ approval, status: "resolved" })).toBe("Answered");
  });
});

describe("sessionScopeLine", () => {
  it("says what allowing for the chat covers, as the agent said it, or in general", () => {
    expect(sessionScopeLine({ ...approval, sessionScope: "the commands `ls`" })).toBe(
      '"Always allow in this chat" covers the commands `ls`, until you start a new chat.',
    );
    expect(sessionScopeLine(approval)).toContain("covers requests like this one");
  });
});
