import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The MCP registry validates server.json on submission and rejects the whole
 * publish if anything is out of bounds. These are the constraints from the
 * 2025-12-11 schema that are easy to breach by writing a good description:
 * checked here so a rewrite fails locally rather than at the registry.
 */
const manifest = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

describe("the MCP registry manifest", () => {
  it("carries the schema version it was written against", () => {
    expect(manifest.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  });

  it("has the fields the registry requires", () => {
    for (const field of ["name", "description", "version"]) {
      expect(manifest[field], `${field} is required`).toBeTruthy();
    }
  });

  it("keeps the description inside the 100-character limit", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(100);
  });

  it("keeps the title inside the 100-character limit", () => {
    expect(manifest.title.length).toBeLessThanOrEqual(100);
  });

  it("uses a reverse-DNS name with exactly one slash, in the namespace GitHub auth grants", () => {
    expect(manifest.name.split("/")).toHaveLength(2);
    expect(manifest.name.startsWith("io.github.")).toBe(true);
    expect(manifest.name.length).toBeLessThanOrEqual(200);
  });

  it("declares the repository in the form the registry expects", () => {
    expect(manifest.repository).toMatchObject({ source: "github" });
    expect(manifest.repository.url).toMatch(/^https:\/\/github\.com\//);
  });

  it("advertises a streamable-http remote", () => {
    expect(manifest.remotes?.[0]?.type).toBe("streamable-http");
    expect(manifest.remotes?.[0]?.url).toMatch(/\/mcp$/);
  });

  it("still has its deployment placeholder, so publishing before deploying is caught", () => {
    // Fails deliberately once the real host is filled in — at which point
    // delete this test, because it has done its job.
    expect(manifest.remotes[0].url).toContain("REPLACE-WITH-DEPLOYED-HOST");
  });
});
