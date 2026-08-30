import { createNameFieldAdapter } from "../families/name-field.js";

const TYPE_DECLARATIONS = [
  "class_declaration",
  "enum_declaration",
  "interface_declaration",
  "record_declaration",
  "record_struct_declaration",
  "struct_declaration",
] as const;
const SCOPE_DECLARATIONS = [
  ...TYPE_DECLARATIONS,
  "file_scoped_namespace_declaration",
  "namespace_declaration",
] as const;

export const CSHARP_ADAPTER = createNameFieldAdapter(
  "csharp",
  [...TYPE_DECLARATIONS, "constructor_declaration", "method_declaration"],
  SCOPE_DECLARATIONS,
);
