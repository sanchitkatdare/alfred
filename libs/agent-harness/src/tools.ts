import { z } from "zod";
import type { Tool, ToolRegistry, ToolSpec } from "./agent";

/** Typed helper: infers argument types from the Zod schema. */
export function defineTool<Args, Result>(tool: Tool<Args, Result>): Tool<Args, Result> {
  return tool;
}

export function createToolRegistry(tools: Tool<any, any>[] = []): ToolRegistry {
  const byName = new Map<string, Tool<any, any>>();
  const registry: ToolRegistry = {
    register(tool) {
      if (byName.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
      byName.set(tool.name, tool);
    },
    get: (name) => byName.get(name),
    list: () => [...byName.values()],
    specs: (): ToolSpec[] =>
      [...byName.values()].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
      })),
  };
  tools.forEach((t) => registry.register(t));
  return registry;
}
