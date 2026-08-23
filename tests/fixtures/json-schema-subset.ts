// A deliberately small draft-2020-12 subset validator, shared by every schema
// test. The kernel stays dependency-free, so the only way to prove that a
// published JSON schema still describes the artifact this code emits is to
// check it here. Any keyword a schema uses but this validator does not
// understand throws, so a check can never silently pass by ignoring a
// constraint.

export type Schema = Record<string, unknown>;

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "pattern",
  "format",
  "minLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "allOf",
  "if",
  "then",
  "else",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      throw new Error(`unsupported schema type: ${type}`);
  }
}

function resolve(root: Schema, schema: Schema): Schema {
  const reference = schema.$ref;
  if (typeof reference !== "string") return schema;
  if (!reference.startsWith("#/$defs/")) throw new Error(`unsupported $ref: ${reference}`);
  const defs = root.$defs;
  const target = isRecord(defs) ? defs[reference.slice("#/$defs/".length)] : undefined;
  if (!isRecord(target)) throw new Error(`unknown $ref: ${reference}`);
  const { $ref: _ignored, ...siblings } = schema;
  return { ...target, ...siblings };
}

export function validate(root: Schema, rawSchema: Schema, value: unknown, path: string): string[] {
  const schema = resolve(root, rawSchema);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported schema keyword at ${path}: ${keyword}`);
    }
  }
  const errors: string[] = [];

  if (typeof schema.type === "string" && !typeMatches(schema.type, value)) {
    return [`${path} must be ${schema.type}`];
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum)
    && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${path} is not an allowed value`);
  }
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path} does not match ${schema.pattern}`);
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} is shorter than ${schema.minLength}`);
    }
    // Checked rather than treated as an annotation, matching how
    // src/validate.ts accepts a date in the v0.1 contract.
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      errors.push(`${path} is not a date-time`);
    } else if (typeof schema.format === "string" && schema.format !== "date-time") {
      throw new Error(`unsupported schema format at ${path}: ${schema.format}`);
    }
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    errors.push(`${path} is below ${schema.minimum}`);
  }
  if (typeof value === "number" && typeof schema.maximum === "number" && value > schema.maximum) {
    errors.push(`${path} is above ${schema.maximum}`);
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(String(key) in value)) errors.push(`${path}.${String(key)} is required`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not an allowed property`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in value) || !isRecord(child)) continue;
      errors.push(...validate(root, child, value[key], `${path}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path} has fewer than ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path} has more than ${schema.maxItems} items`);
    }
    if (isRecord(schema.items)) {
      for (const [index, item] of value.entries()) {
        errors.push(...validate(root, schema.items, item, `${path}[${index}]`));
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      if (isRecord(child)) errors.push(...validate(root, child, value, path));
    }
  }
  if (isRecord(schema.if)) {
    const branch = validate(root, schema.if, value, path).length === 0 ? schema.then : schema.else;
    if (isRecord(branch)) errors.push(...validate(root, branch, value, path));
  }
  return errors;
}
