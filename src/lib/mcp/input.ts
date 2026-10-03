import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { McpToolDef } from "./kinds";

function safeProperties(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, child]) =>
    !["__proto__", "constructor", "prototype"].includes(key) && safeProperties(child));
}

/** Compile locally: no remote references, coercion, defaults, property removal, or data in errors. */
export function mcpInputValidator(schema: McpToolDef["inputSchema"], service = false) {
  // A turn-local compiler avoids registering unbounded fresh schema objects or colliding $ids.
  const Compiler = String(schema.$schema ?? "").includes("2020-12") ? Ajv2020 : Ajv;
  const ajv = addFormats(new Compiler({ strict: service, allErrors: false, ownProperties: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false }));
  const validate = ajv.compile(schema);
  return (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || !safeProperties(input) || !validate(input))
      throw new Error("Tool arguments do not match the reviewed input schema.");
  };
}
