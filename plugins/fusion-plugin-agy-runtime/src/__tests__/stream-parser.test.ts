import { describe, expect, it } from "vitest";
import { parseAgyStreamLine } from "../stream-parser.js";

describe("parseAgyStreamLine", () => {
  it("parses verified agy init, agent_response, and result events", () => {
    expect(parseAgyStreamLine('{"event":"init","conversation_id":"c","init":{"model":"gemini-3.7-flash-low","cwd":"/tmp"}}')).toEqual({
      kind: "system-init",
      conversationId: "c",
      cwd: "/tmp",
      model: "gemini-3.7-flash-low",
    });
    expect(parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"OK\\n"}}')).toEqual({
      kind: "assistant-text",
      text: "OK\n",
    });
    expect(parseAgyStreamLine('{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"OK\\n","usage":{"total_tokens":1}}}')).toMatchObject({
      kind: "result",
      conversationId: "c",
      text: "OK\n",
      isError: false,
      usage: { total_tokens: 1 },
    });
  });

  it("parses a tool ACTIVE/DONE pair into started/completed events", () => {
    expect(parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -1A"}}}}')).toMatchObject({
      kind: "tool-call-started",
      name: "run_command",
      args: { CommandLine: "ls -1A" },
      isError: false,
    });
    expect(parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -1A"},"output":"a.txt\\r\\n"}}}')).toMatchObject({
      kind: "tool-call-completed",
      name: "run_command",
      result: "a.txt\r\n",
      isError: false,
    });
  });

  it("parses a tool ERROR state into a completed event with isError true and the error payload", () => {
    expect(parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"finish","tool_info":{"name":"finish","error":{"type":"TOOL_ERROR","message":"invalid arguments"}}}}')).toMatchObject({
      kind: "tool-call-completed",
      name: "finish",
      isError: true,
      result: { type: "TOOL_ERROR", message: "invalid arguments" },
    });
  });

  it("parses a non-SUCCESS result as an error result carrying the error field", () => {
    expect(parseAgyStreamLine('{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection"}}')).toMatchObject({
      kind: "result",
      conversationId: "",
      isError: true,
      error: "invalid model selection",
    });
  });

  it("treats text-less agent_response and user_input steps as unknown", () => {
    expect(parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}')).toEqual({ kind: "unknown" });
    expect(parseAgyStreamLine('{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","usage":{"total_tokens":1}}}')).toEqual({ kind: "unknown" });
  });

  it("does not throw for incomplete or unknown lines", () => {
    expect(parseAgyStreamLine("{")).toEqual({ kind: "unknown" });
    expect(parseAgyStreamLine("")).toEqual({ kind: "unknown" });
    expect(parseAgyStreamLine('{"event":"new"}')).toEqual({ kind: "unknown" });
  });
});
