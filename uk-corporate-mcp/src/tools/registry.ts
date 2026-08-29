import { capitalStructureTool } from "./capital-structure.js";
import { filingHistoryTool } from "./filing-history.js";
import { pscVerificationTool } from "./psc-verification.js";
import type { ToolDefinition } from "./types.js";

export const TOOLS: ToolDefinition[] = [filingHistoryTool, pscVerificationTool, capitalStructureTool];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
