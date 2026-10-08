/** Configuration problem with one or more human-readable (German) issue lines. */
export class ConfigError extends Error {
  readonly issues: string[];
  constructor(headline: string, issues: string[] = []) {
    super(
      issues.length > 0 ? `${headline}\n${issues.map((i) => `  - ${i}`).join('\n')}` : headline,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
