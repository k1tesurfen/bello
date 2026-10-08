/** Output sinks of the CLI (replaceable in tests). */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** Colours in terminal output. */
  color?: boolean;
}

export const processIo: CliIo = {
  out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
};

/** Exit codes (PLAN §2). */
export const EXIT = { gruen: 0, gelb: 1, rot: 2, fehler: 3 } as const;
