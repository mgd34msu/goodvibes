export function renderCompletion(shell: string | undefined, binary: string, vocabulary: { readonly commands: readonly string[]; readonly options: readonly string[] }): string {
  const normalized = (shell ?? 'bash').toLowerCase();
  const words = [...vocabulary.commands, ...vocabulary.options].join(' ');

  if (normalized === 'zsh') {
    return [
      `#compdef ${binary}`,
      `_${binary}() {`,
      `  compadd -- ${words}`,
      '}',
      `_${binary} "$@"`,
    ].join('\n');
  }

  if (normalized === 'fish') {
    return [...vocabulary.commands, ...vocabulary.options]
      .map((word) => `complete -c ${binary} -a ${JSON.stringify(word)}`)
      .join('\n');
  }

  return [
    `_${binary}() {`,
    '  local cur',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )`,
    '}',
    `complete -F _${binary} ${binary}`,
  ].join('\n');
}
