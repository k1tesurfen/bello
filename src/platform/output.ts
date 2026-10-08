import pc from 'picocolors';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckLine {
  status: CheckStatus;
  label: string;
  detail?: string;
  /** German fix hint, shown indented below the line for warn/fail. */
  hint?: string;
}

export function formatCheck(c: CheckLine): string {
  const icon =
    c.status === 'ok' ? pc.green('✓') : c.status === 'warn' ? pc.yellow('!') : pc.red('✗');
  let s = `${icon} ${c.label}`;
  if (c.detail) s += pc.dim(` – ${c.detail}`);
  if (c.hint && c.status !== 'ok') {
    c.hint.split('\n').forEach((line, i) => {
      s += `\n    ${i === 0 ? pc.dim('→') : ' '} ${line}`;
    });
  }
  return s;
}

export function printCheck(c: CheckLine, out: (s: string) => void = console.log): void {
  out(formatCheck(c));
}
