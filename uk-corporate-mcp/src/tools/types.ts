import type { ChClient } from "../companies-house/client.js";
import type { Env } from "../env.js";
import type { ToolPrice } from "../x402/pricing.js";
import type { HandlerOutcome } from "../x402/gate.js";

export interface ToolContext {
  env: Env;
  client: ChClient;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  price: ToolPrice;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<HandlerOutcome<unknown>>;
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

export const SOURCE_ATTRIBUTION = {
  provider: "Companies House",
  api: "https://api.company-information.service.gov.uk",
  licence: "Contains public sector information licensed under the Open Government Licence v3.0.",
  note: "Live pass-through of the Companies House public data API. No Companies House data is stored by this service beyond a short edge cache.",
} as const;

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolArgumentError(`"${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ToolArgumentError(`"${key}" must be a boolean.`);
}

export function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ToolArgumentError(`"${key}" must be an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw new ToolArgumentError(`"${key}" must be between ${min} and ${max}.`);
  }
  return parsed;
}

export function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const list = Array.isArray(value) ? value : [value];
  const cleaned = list.map((v) => String(v).trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}
