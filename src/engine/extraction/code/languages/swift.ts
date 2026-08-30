import { createNameFieldAdapter } from "../families/name-field.js";

const TYPE_DECLARATIONS = [
  "class_declaration",
  "protocol_declaration",
] as const;

export const SWIFT_ADAPTER = createNameFieldAdapter(
  "swift",
  [...TYPE_DECLARATIONS, "function_declaration"],
  TYPE_DECLARATIONS,
);
