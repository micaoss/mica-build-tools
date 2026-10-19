// The three ways a command ends other than success (design section 3): a refusal names the rule of the owner
// that states it, an error names the input, and a usage error is the caller's.

/** A rule broken: printed as `refused <rule>`. */
export class Refused extends Error {
  constructor(readonly rule: string, readonly detail = '') {
    super(detail ? `refused ${rule}: ${detail}` : `refused ${rule}`)
  }
}

/** A failure that is not a rule: printed as `error: <message>`. */
export class ToolError extends Error {}

/** A command called wrongly: printed with its usage, exit 2. */
export class UsageError extends Error {}
