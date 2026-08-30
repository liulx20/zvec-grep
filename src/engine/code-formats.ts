export const STRUCTURED_CODE_FORMATS = [
  "c",
  "csharp",
  "cpp",
  "dart",
  "go",
  "java",
  "javascript",
  "jsx",
  "python",
  "rust",
  "swift",
  "tsx",
  "typescript",
] as const;

export type StructuredCodeFormat = (typeof STRUCTURED_CODE_FORMATS)[number];

export const COMPONENT_CODE_FORMATS = ["vue", "svelte"] as const;
