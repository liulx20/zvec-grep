export type LanguageResolutionSemantics = {
  lexicalBlocks: boolean;
  constructorInference: "explicit" | "python" | "go";
  ownerFieldInference?: "python" | "javascript";
  declarationStyle: "default" | "java" | "go";
  parameterStyle: "default" | "go" | "rust";
  genericBoundsStyle: "default" | "extends" | "go" | "cpp";
  packageVisibility: "file" | "directory";
  decoratedDefinitions: boolean;
  dynamicTraitObjects: boolean;
  virtualReturnDispatch: boolean;
  packageQualifiedCalls: boolean;
  sourceReceiverInference: boolean;
  transitivePreferredFiles: boolean;
  functionPointerDispatch: boolean;
  relativeImportMode?: "python" | "rust";
};

const DEFAULT_SEMANTICS: LanguageResolutionSemantics = {
  lexicalBlocks: true,
  constructorInference: "explicit",
  declarationStyle: "default",
  parameterStyle: "default",
  genericBoundsStyle: "default",
  packageVisibility: "file",
  decoratedDefinitions: false,
  dynamicTraitObjects: false,
  virtualReturnDispatch: false,
  packageQualifiedCalls: false,
  sourceReceiverInference: false,
  transitivePreferredFiles: false,
  functionPointerDispatch: false,
};

const LANGUAGE_SEMANTICS: Record<
  string,
  Partial<LanguageResolutionSemantics>
> = {
  c: { functionPointerDispatch: true },
  csharp: {
    genericBoundsStyle: "extends",
    packageVisibility: "directory",
    virtualReturnDispatch: true,
  },
  cpp: {
    functionPointerDispatch: true,
    genericBoundsStyle: "cpp",
    sourceReceiverInference: true,
    virtualReturnDispatch: true,
  },
  go: {
    constructorInference: "go",
    declarationStyle: "go",
    parameterStyle: "go",
    genericBoundsStyle: "go",
    packageVisibility: "directory",
    packageQualifiedCalls: true,
  },
  java: {
    declarationStyle: "java",
    genericBoundsStyle: "extends",
    packageVisibility: "directory",
    transitivePreferredFiles: true,
    virtualReturnDispatch: true,
  },
  python: {
    lexicalBlocks: false,
    constructorInference: "python",
    ownerFieldInference: "python",
    decoratedDefinitions: true,
    relativeImportMode: "python",
  },
  rust: {
    parameterStyle: "rust",
    dynamicTraitObjects: true,
    relativeImportMode: "rust",
  },
  tsx: {
    ownerFieldInference: "javascript",
    genericBoundsStyle: "extends",
    virtualReturnDispatch: true,
  },
  typescript: {
    ownerFieldInference: "javascript",
    genericBoundsStyle: "extends",
    virtualReturnDispatch: true,
  },
  javascript: { ownerFieldInference: "javascript" },
  jsx: { ownerFieldInference: "javascript" },
  dart: { virtualReturnDispatch: true },
  swift: { virtualReturnDispatch: true },
};

export function resolutionSemantics(
  language: string | null | undefined,
): LanguageResolutionSemantics {
  return {
    ...DEFAULT_SEMANTICS,
    ...(LANGUAGE_SEMANTICS[language ?? ""] ?? {}),
  };
}
