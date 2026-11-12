/**
 * Allowlist for the `entrypoint` argv on POST /runners (issue #238). Seeded from the worker's
 * configured SARDEENZ_RUNNER_ENTRYPOINT — never assumes `python3 -m`:
 *  - absent/empty argv → allowed (the launcher falls back to the configured vector,
 *    apptainer-launcher.ts);
 *  - the configured vector verbatim → allowed (covers non-`-m` operator overrides like
 *    ["python3","sardeenz_vllm_runner.py"]; such an override disables the `-m` family — only
 *    the override vector itself is then accepted);
 *  - ONLY when the configured vector has the canonical `[exec0, '-m', module0]` shape →
 *    `[exec0, '-m', m]` is allowed for m in the known shim modules (sardeenz_vllm_runner,
 *    sardeenz_mlserver_runner — the catalog's shims, runners.yaml) plus module0. A brand-new
 *    shim module beyond the known two needs it added to KNOWN_SHIM_MODULES (worker release);
 *    configuring SARDEENZ_RUNNER_ENTRYPOINT with the `-m` shape admits the two known shims plus
 *    the configured module, while a non-`-m` override admits only itself — and entrypoint-less
 *    catalog entries inherit the configured vector.
 */
export interface EntrypointAllowlist {
  /** The configured vector, accepted verbatim. */
  readonly exact: readonly string[];
  /** exec0 when the configured vector has the `[exec0, '-m', module0]` shape; else undefined. */
  readonly familyExec: string | undefined;
  /** Modules accepted after '-m': known shim modules + the configured module. */
  readonly familyModules: ReadonlySet<string>;
}

const KNOWN_SHIM_MODULES: readonly string[] = [
  'sardeenz_vllm_runner',
  'sardeenz_mlserver_runner',
];

export function buildEntrypointAllowlist(configured: readonly string[]): EntrypointAllowlist {
  const moduleForm = configured.length === 3 && configured[1] === '-m';
  return {
    exact: configured,
    familyExec: moduleForm ? configured[0] : undefined,
    familyModules: moduleForm ? new Set([...KNOWN_SHIM_MODULES, configured[2]]) : new Set(),
  };
}

export function isEntrypointAllowed(
  allowlist: EntrypointAllowlist,
  argv: readonly string[] | undefined,
): boolean {
  if (!argv || argv.length === 0) return true; // absent/empty → launcher uses the configured default
  if (argv.length === allowlist.exact.length && allowlist.exact.every((t, i) => t === argv[i])) {
    return true;
  }
  // The family matches the exact 3-token <exec> -m <module> form; extra flags are not part of it.
  if (
    allowlist.familyExec !== undefined &&
    argv.length === 3 &&
    argv[0] === allowlist.familyExec &&
    argv[1] === '-m'
  ) {
    return allowlist.familyModules.has(argv[2]);
  }
  return false;
}
