// Project-local pre-tool guard. Keep this self-contained: hooks are loaded in
// every issue worktree, while the Claude Code handover assets are gitignored.
const blockedCommands = [
  [
    /\bgit(?:\s+-C\s+\S+)?\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|-f\b)/i,
    'Force pushes are forbidden',
  ],
  [/\bgit(?:\s+-C\s+\S+)?\s+reset\s+--hard\b/i, 'Hard reset is forbidden'],
  [/\bgit(?:\s+-C\s+\S+)?\s+clean\s+(?:-[a-z]*f[a-z]*\b|--force\b)/i, 'Force clean is forbidden'],
  [/\bgit(?:\s+-C\s+\S+)?\s+branch\s+-D(?=\s|$|[;&|])/, 'Force branch deletion is forbidden'],
  [/\bgit\s+(?:checkout|restore)\s+\.(?=\s|$|[;&|])/i, 'Discarding all changes is forbidden'],
  [/\bgit\s+stash\s+(?:drop|clear)\b/i, 'Discarding a stash is forbidden'],
  [
    /\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\s+(?:\/|\*|~)(?=\s|$|[;&|])/i,
    'Recursive deletion of /, * or ~ is forbidden',
  ],
  [/\bchmod\s+-R\s+777\b/i, 'Recursive world-writable permissions are forbidden'],
  [/\b(?:curl|wget)\b[\s\S]*?\|\s*(?:ba)?sh\b/i, 'Piping a download to a shell is forbidden'],
  [/\bdd\b[^\n]*\bof=\/dev\//i, 'Writing to a block device is forbidden'],
  [/\bmkfs\./i, 'Formatting a filesystem is forbidden'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*;/, 'Fork bomb is forbidden'],
  [/\bfork\s*\(\s*\)/i, 'Fork bomb is forbidden'],
  [/\bkubectl\b[^\n;|]*\bdelete\b/i, 'kubectl delete is owner-run only in this project'],
];

export function commandDenial(command) {
  for (const [pattern, reason] of blockedCommands) {
    if (pattern.test(command)) return reason;
  }
  return undefined;
}

function protectedPath(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  const basename = parts.at(-1);
  return (
    parts.includes('.git') ||
    basename === 'package-lock.json' ||
    basename === '.env' ||
    basename?.startsWith('.env.')
  );
}

export function editDenial(input) {
  const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])];
  const patch = typeof input.input === 'string' ? input.input : '';
  for (const match of patch.matchAll(
    /^\[([^#\r\n]+)#[0-9A-F]{4}\]|^\*\*\* (?:Add|Update|Delete|Move to) File: (.+)$|^MV\s+(.+)$/gm,
  )) {
    paths.push(match[1] ?? match[2] ?? match[3]);
  }
  const target = paths.find((path) => typeof path === 'string' && protectedPath(path));
  return target ? `Protected file cannot be edited: ${target}` : undefined;
}

export default function safety(pi) {
  pi.on('tool_call', (event) => {
    const { toolName, input } = event;
    if (toolName === 'bash' || toolName === 'eval') {
      const reason = commandDenial(
        String(toolName === 'bash' ? (input.command ?? '') : (input.code ?? '')),
      );
      if (reason) return { block: true, reason };
    }
    if (
      toolName === 'write' ||
      toolName === 'edit' ||
      toolName === 'apply_patch' ||
      toolName === 'ast_edit'
    ) {
      const reason = editDenial(input);
      if (reason) return { block: true, reason };
    }
  });
}
