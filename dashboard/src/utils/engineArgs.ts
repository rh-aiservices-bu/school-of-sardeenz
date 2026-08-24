// Reserved flags the platform controls (mirrors apptainer-launcher.ts RESERVED_ENGINE_FLAGS).
// Rejected here for fast UI feedback; the launcher re-checks as the real boundary.
export const RESERVED_ENGINE_FLAGS = [
  '--port',
  '--host',
  '--model',
  '--served-model-name',
  '--tensor-parallel-size',
  '--engine-port',
] as const;

export type EngineArgsParseResult =
  | { ok: true; args: string[] }
  | { ok: false; kind: 'prefix'; line: number; content: string }
  | { ok: false; kind: 'reserved'; line: number; flag: string; abbreviates?: string };

function stripOneQuoteLayer(v: string): string {
  if (
    v.length >= 2 &&
    (v[0] === '"' || v[0] === "'") &&
    v[v.length - 1] === v[0]
  ) {
    return v.slice(1, -1);
  }
  return v;
}

// One flag per line. Accepts --key=value (one token), --key value (two tokens, split on the FIRST
// whitespace run — value keeps internal spaces), and bare --switch. Skips blank lines and lines
// whose first non-whitespace char is `#`. Strips exactly one surrounding quote layer from the value.
// Preserves order. Rejects any non-empty line not starting with `--`, and any reserved flag.
export function parseEngineArgs(raw: string): EngineArgsParseResult {
  const out: string[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const m = /^(--[^\s=]+)(.*)$/.exec(trimmed);
    if (!m) {
      return { ok: false, kind: 'prefix', line: i + 1, content: trimmed };
    }
    const key = m[1];
    if ((RESERVED_ENGINE_FLAGS as readonly string[]).includes(key)) {
      return { ok: false, kind: 'reserved', line: i + 1, flag: key };
    }
    // vLLM's argparse-derived CLI expands unambiguous prefixes (allow_abbrev=True), so an
    // abbreviation like --hos or --tensor-parallel can silently resolve to a reserved flag
    // (--host, --tensor-parallel-size) once forwarded to `vllm serve`. Reject those here too,
    // mirroring apptainer-launcher.ts's RESERVED_ENGINE_FLAGS check — the launcher remains the
    // real enforcement boundary, this is just fast UI feedback. Only reject when the user's key
    // is a proper prefix of a reserved flag; a reserved flag being a prefix of a longer, distinct
    // user flag (e.g. --model-impl) is never expanded by argparse and must stay allowed.
    if (key.length > 2) {
      const abbreviated = RESERVED_ENGINE_FLAGS.find(
        (reserved) => reserved !== key && reserved.startsWith(key),
      );
      if (abbreviated) {
        return { ok: false, kind: 'reserved', line: i + 1, flag: key, abbreviates: abbreviated };
      }
    }
    const rest = m[2];
    if (rest === '') {
      out.push(key); // bare --switch
    } else if (rest[0] === '=') {
      out.push(`${key}=${stripOneQuoteLayer(rest.slice(1))}`); // --key=value (one token)
    } else {
      out.push(key, stripOneQuoteLayer(rest.replace(/^\s+/, ''))); // --key value (two tokens)
    }
  }
  return { ok: true, args: out };
}
