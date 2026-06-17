/**
 * Figma-MCP availability classification (Component Studio P0). Pure — it does NOT call the MCP
 * (MCP tools are agent-callable only). A command's agent probes `mcp__figma-desktop`
 * (a cheap `get_metadata`), reduces what it saw to a {@link FigmaMcpObservation}, and passes it
 * here to get a single, canonical {@link FigmaMcpAvailability} (status + actionable message). This
 * keeps the "open Figma & re-run" wording in one tested place instead of scattered across commands.
 *
 * There is no token here and never will be: Figma auth lives entirely in the desktop app.
 */

export type FigmaMcpStatus = "ready" | "no-server" | "no-file";

/** What the probing agent observed when it called the Figma desktop MCP. */
export interface FigmaMcpObservation {
  /** The `mcp__figma-desktop` server responded at all (tool exists / didn't error as unavailable). */
  serverPresent: boolean;
  /** A file is open and `get_metadata` returned a usable node tree. */
  fileOpen: boolean;
}

export interface FigmaMcpAvailability {
  /** True only when the server is present AND a file is open — Studio can read the design now. */
  ready: boolean;
  status: FigmaMcpStatus;
  /** A user-facing, actionable one-liner for this status. */
  message: string;
}

/** Canonical, single-source-of-truth messages per status (kept terse + actionable). */
export const FIGMA_MCP_MESSAGES: Record<FigmaMcpStatus, string> = {
  ready: "Figma MCP is available and a file is open — Studio can read the design.",
  "no-server":
    "The Figma desktop MCP (mcp__figma-desktop) isn't available. Open the Figma desktop app, " +
    "enable its MCP / Dev Mode server, then re-run.",
  "no-file":
    "The Figma desktop app is connected but no file is open. Open your Figma file in the desktop " +
    "app, then re-run.",
};

/**
 * Reduce an {@link FigmaMcpObservation} to a {@link FigmaMcpAvailability}. Server-missing dominates
 * file-not-open (you can't tell a file is open if the server never answered), so the checks are
 * ordered: no server → no file → ready.
 */
export function interpretFigmaMcp(observation: FigmaMcpObservation): FigmaMcpAvailability {
  if (!observation.serverPresent) {
    return { ready: false, status: "no-server", message: FIGMA_MCP_MESSAGES["no-server"] };
  }
  if (!observation.fileOpen) {
    return { ready: false, status: "no-file", message: FIGMA_MCP_MESSAGES["no-file"] };
  }
  return { ready: true, status: "ready", message: FIGMA_MCP_MESSAGES.ready };
}
