import { describe, expect, it } from "vitest";

import { explainError } from "./replyErrors";

describe("explainError", () => {
  it.each([
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "retry", /busy/],
    ["Rate limit exceeded (429)", "retry", /busy/],
    ["fetch failed: ECONNREFUSED", "retry", /internet connection/],
    ["API Error: 500 Internal Server Error", "retry", /problem of its own/],
    ["Invalid API key · Please run /login", "signIn", /not signed in/],
    ["API Error: 401 authentication_error", "signIn", /not signed in/],
    ["prompt is too long: 210000 tokens > 200000 maximum", "compact", /too long for the model/],
    ["Claude AI usage limit reached|1700000000", "model", /plan allows/],
    ["The model `gpt-9` does not exist or you do not have access to it", "model", /not available/],
  ])("explains %s", (raw, action, text) => {
    const explained = explainError(raw, "claude");
    expect(explained?.action).toBe(action);
    expect(explained?.text).toMatch(text);
  });

  it("names the agent to sign in to, and the command that does it", () => {
    expect(explainError("401 Unauthorized", "codex")).toMatchObject({
      text: expect.stringContaining("Codex is not signed in"),
      command: "codex",
    });
    expect(explainError("Not logged in", "copilot")?.command).toBe("copilot");
  });

  it("leaves an error it does not know to be shown as it came", () => {
    expect(explainError("The agent reported an error.", "claude")).toBeNull();
    expect(explainError("Codex disconnected", "codex")).toBeNull();
  });
});
