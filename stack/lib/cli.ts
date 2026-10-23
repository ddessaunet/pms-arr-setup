// stack/lib/cli.ts — the command line, and help from the script's own header.
//
// Each script takes a few long flags and maybe positionals, as the bash ones
// did with a `case`. -h/--help prints the script's header comment, so the help
// and the documentation are one text:
//
//   const cli = parseCli(argv, { flags: ['--check'], usage: 'usage: configure.sh [--check]' });
//   if (cli.help) { out(headerHelp(await Bun.file(import.meta.path).text())); return 0; }

import { UsageError } from './exit.ts';

export interface CliSpec<F extends string> {
  /** The flags it takes, spelled out: '--dry-run'. */
  flags: readonly F[];
  /** Whether bare words are allowed (service names, a subcommand). */
  positionals?: boolean;
  /** The line printed with a usage error. */
  usage: string;
}

export interface Cli<F extends string> {
  help: boolean;
  flags: Record<F, boolean>;
  positionals: string[];
}

/** Parses argv (without bun and the script); a word it does not know is a UsageError. */
export function parseCli<F extends string>(argv: readonly string[], spec: CliSpec<F>): Cli<F> {
  const flags = Object.fromEntries(spec.flags.map((f) => [f, false])) as Record<F, boolean>;
  const positionals: string[] = [];
  let help = false;
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') help = true;
    else if ((spec.flags as readonly string[]).includes(arg)) flags[arg as F] = true;
    else if (!arg.startsWith('-') && spec.positionals) positionals.push(arg);
    else throw new UsageError(spec.usage);
  }
  return { help, flags, positionals };
}

/**
 * The leading `//` comment of a source file, without the markers: the help text.
 * It ends at the first line that is not a comment.
 */
export function headerHelp(source: string): string {
  const lines: string[] = [];
  for (const line of source.split('\n')) {
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/ ?/, ''));
  }
  return lines.join('\n');
}
