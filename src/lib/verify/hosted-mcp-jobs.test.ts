import { describe, expect, test } from "bun:test";

import { parseHostedCreateJobInput } from "./hosted-mcp-jobs";

describe("parseHostedCreateJobInput", () => {
  test("maps a valid hosted request into an async workflow", () => {
    const result = parseHostedCreateJobInput({
      repo: " 0xheycat/example ",
      ref: " feature/test ",
      commands: [" bun install ", "bun run test"],
      continue_on_error: true,
      metadata: { source: "mcp" },
      expected_head: " abc1234 ",
      environment: " preview ",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        repo: "0xheycat/example",
        ref: "feature/test",
        workflow: {
          version: 1,
          commands: ["bun install", "bun run test"],
          continueOnError: true,
          metadata: { source: "mcp" },
          expectedHead: "abc1234",
          mode: "async",
        },
        environmentName: "preview",
      },
    });
  });

  test("rejects sync mode", () => {
    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "main",
      commands: ["bun test"],
      mode: "sync",
    })).toEqual({
      ok: false,
      message: "hosted verification jobs must use mode='async'",
    });
  });

  test("requires repository, ref, and a valid command array", () => {
    expect(parseHostedCreateJobInput({ ref: "main", commands: ["bun test"] })).toEqual({
      ok: false,
      message: "repo is required",
    });
    expect(parseHostedCreateJobInput({ repo: "0xheycat/example", commands: ["bun test"] })).toEqual({
      ok: false,
      message: "ref is required",
    });
    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "main",
      commands: [" ", 42],
    })).toEqual({
      ok: false,
      message: "command #1 rejected: empty command",
    });
  });

  test("rejects commands outside the verification allowlist", () => {
    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "main",
      commands: ["rm -rf ."],
    })).toEqual({
      ok: false,
      message: "command #1 rejected: command contains forbidden token: rm",
    });

    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "main",
      commands: Array.from({ length: 51 }, () => "bun test"),
    })).toEqual({
      ok: false,
      message: "too many commands (max 50)",
    });
  });

  test("drops invalid optional object values instead of persisting them", () => {
    const result = parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "main",
      commands: ["bun test"],
      metadata: ["not-an-object-map"],
      expected_head: " ",
      environment: " ",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        repo: "0xheycat/example",
        ref: "main",
        workflow: {
          version: 1,
          commands: ["bun test"],
          continueOnError: false,
          metadata: {},
          expectedHead: null,
          mode: "async",
        },
        environmentName: null,
      },
    });
  });

  test("rejects unsafe or oversized refs", () => {
    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "feature/../main",
      commands: ["bun test"],
    })).toEqual({ ok: false, message: "ref contains unsupported characters" });

    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "a".repeat(256),
      commands: ["bun test"],
    })).toEqual({ ok: false, message: "ref is too long (max 255 characters)" });
  });

  test("validates expected head and environment names", () => {
    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "main",
      commands: ["bun test"],
      expected_head: "not-a-sha",
    })).toEqual({
      ok: false,
      message: "expected_head must be a 7 to 40 character hexadecimal commit SHA",
    });

    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "main",
      commands: ["bun test"],
      environment: "preview environment",
    })).toEqual({ ok: false, message: "environment contains unsupported characters" });
  });

  test("rejects oversized metadata", () => {
    expect(parseHostedCreateJobInput({
      repo: "0xheycat/example",
      ref: "main",
      commands: ["bun test"],
      metadata: { payload: "x".repeat(16 * 1024) },
    })).toEqual({ ok: false, message: "metadata is too large (max 16384 bytes)" });
  });
});
