/**
 * Context required to resolve a module specifier to an absolute file path.
 */
export type ModuleResolutionOptions = {
  /** Directory containing the file that makes the import. */
  fileDir: string;
  /** Workspace root directories used to anchor bare package imports. */
  workspaceRoots: readonly string[];
  /** Extensions to try when the specifier omits one. */
  extensionPreference: readonly string[];
  /** Optional lookup table for package-name → directory overrides. */
  packageRoots?: Readonly<Record<string, string>>;
};

/**
 * Resolves a module specifier from source text to an absolute file path.
 *
 * Returns `undefined` when the specifier cannot be mapped to a file inside
 * the workspace (e.g. third-party packages, built-ins, or missing files).
 */
export function resolveModulePath(
  moduleSpecifier: string,
  options: ModuleResolutionOptions,
): string | undefined {
  void moduleSpecifier;
  void options;
  // TODO: implement relative/path mapping and extension trial.
  return undefined;
}
