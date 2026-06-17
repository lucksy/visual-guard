import { describe, it, expect } from "vitest";
import {
  FIGMA_MCP_MESSAGES,
  interpretFigmaMcp,
  type FigmaMcpObservation,
} from "../scripts/lib/figma/mcp";

const obs = (o: Partial<FigmaMcpObservation>): FigmaMcpObservation => ({
  serverPresent: false,
  fileOpen: false,
  ...o,
});

describe("interpretFigmaMcp", () => {
  it("reports 'ready' when the server is present and a file is open", () => {
    const result = interpretFigmaMcp(obs({ serverPresent: true, fileOpen: true }));
    expect(result).toEqual({
      ready: true,
      status: "ready",
      message: FIGMA_MCP_MESSAGES.ready,
    });
  });

  it("reports 'no-server' when the MCP server isn't present (dominates file state)", () => {
    // Even if fileOpen were somehow true, a missing server wins — you can't know a file is open.
    const result = interpretFigmaMcp(obs({ serverPresent: false, fileOpen: true }));
    expect(result.ready).toBe(false);
    expect(result.status).toBe("no-server");
    expect(result.message).toBe(FIGMA_MCP_MESSAGES["no-server"]);
  });

  it("reports 'no-file' when the server is present but no file is open", () => {
    const result = interpretFigmaMcp(obs({ serverPresent: true, fileOpen: false }));
    expect(result.ready).toBe(false);
    expect(result.status).toBe("no-file");
    expect(result.message).toBe(FIGMA_MCP_MESSAGES["no-file"]);
  });

  it("only 'ready' is ever ready", () => {
    expect(interpretFigmaMcp(obs({ serverPresent: false, fileOpen: false })).ready).toBe(false);
  });
});

describe("FIGMA_MCP_MESSAGES", () => {
  it("every status has a non-empty, actionable message", () => {
    for (const status of ["ready", "no-server", "no-file"] as const) {
      expect(FIGMA_MCP_MESSAGES[status].length).toBeGreaterThan(0);
    }
    // The not-ready messages tell the user what to do.
    expect(FIGMA_MCP_MESSAGES["no-server"]).toMatch(/open the figma desktop app/i);
    expect(FIGMA_MCP_MESSAGES["no-file"]).toMatch(/open your figma file/i);
  });

  it("no message mentions a token (this design has none)", () => {
    for (const status of ["ready", "no-server", "no-file"] as const) {
      expect(FIGMA_MCP_MESSAGES[status].toLowerCase()).not.toContain("token");
    }
  });
});
