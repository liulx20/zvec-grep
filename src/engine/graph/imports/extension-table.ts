/**
 * Maps a language identifier to the file extensions that should be tried
 * when resolving a bare module specifier.
 *
 * The order matters: earlier extensions are preferred.
 */
export type LanguageExtensionTable = Record<string, readonly string[]>;

/**
 * Default extension preferences for the languages supported by zvec-grep.
 */
export const DEFAULT_EXTENSION_TABLE: LanguageExtensionTable = {
  typescript: [".ts", ".tsx", ".js", ".jsx"],
  javascript: [".js", ".jsx"],
  tsx: [".tsx", ".ts", ".js", ".jsx"],
  jsx: [".jsx", ".js", ".ts", ".tsx"],
  python: [".py"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".h"],
};

/**
 * Returns the extension preference list for a language tag, falling back to
 * an empty list when the language is unknown.
 */
export function extensionsForLanguage(
  language: string,
  table: LanguageExtensionTable = DEFAULT_EXTENSION_TABLE,
): readonly string[] {
  return table[language] ?? [];
}
