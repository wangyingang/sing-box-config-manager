export function countNativeCommands(commands: string[]) {
  const matches = commands.filter(command => command.startsWith('rule-set match '));
  return {
    compile: commands.filter(command => command.startsWith('rule-set compile ')).length,
    decompile: commands.filter(command => command.startsWith('rule-set decompile ')).length,
    sourceLoad: matches.filter(command => command.endsWith('--format source')).length,
    binaryLoad: matches.filter(command => command.endsWith('--format binary')).length,
  };
}
