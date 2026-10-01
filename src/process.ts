// Running other programs: git, docker and the like. Output is captured; stderr passes through unless asked.
export type Run = { ok: boolean, code: number, out: string, err: string }

export function run(argv: string[], options: { cwd?: string, env?: Record<string, string | undefined>, quiet?: boolean, stdin?: Uint8Array } = {}): Run {
  const r = Bun.spawnSync(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: options.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: options.quiet ? 'pipe' : 'inherit',
  })
  return { ok: r.exitCode === 0, code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr?.toString() ?? '' }
}

export function git(args: string[], options: Parameters<typeof run>[1] = {}): Run {
  return run(['git', ...args], { quiet: true, ...options, env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...options.env } })
}
