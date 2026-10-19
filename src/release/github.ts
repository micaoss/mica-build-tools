// Requests to the GitHub API. A rate-limited answer (429, or a 403 that GitHub marks as a rate limit by
// x-ratelimit-remaining: 0, a retry-after header or its message) is retried, at most TRIES times, after the wait
// retry-after or x-ratelimit-reset asks for, else a doubling one, each capped at MAX_WAIT_MS; every other answer
// is returned at once. A failure is described with GitHub's message and the rate-limit headers.

const TRIES = 3
const MAX_WAIT_MS = 60000

/** The answer's message (GitHub's JSON `message`, else the text) and its rate-limit headers, for an error. */
export function failure(response: Response, body: string): string {
  let message = body.trim()
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message
  }
  catch { /* not JSON: the text itself */ }
  const headers = ['x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']
    .flatMap(h => response.headers.has(h) ? [`${h}: ${response.headers.get(h)}`] : [])
  return [`HTTP ${response.status}`, message === '' ? '' : `: ${message}`, headers.length === 0 ? '' : ` (${headers.join(', ')})`].join('')
}

function rateLimited(response: Response, body: string): boolean {
  if (response.status === 429) return true
  if (response.status !== 403) return false
  return response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit/i.test(body)
}

/** How long a rate-limited answer asks to wait before the next try (`attempt` from 0). */
function waitMs(response: Response, attempt: number, now: number): number {
  const after = Number(response.headers.get('retry-after') ?? NaN)
  const reset = Number(response.headers.get('x-ratelimit-reset') ?? NaN)
  let wait = 15000 * 2 ** attempt
  if (Number.isFinite(after)) wait = after * 1000
  else if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) wait = reset * 1000 - now
  return Math.min(Math.max(wait, 0), MAX_WAIT_MS)
}

/**
 * One API request, a fresh `timeoutMs` signal per try; a rejected fetch is rethrown. A 403 or 429 is returned
 * with its body still readable.
 */
export async function githubFetch(url: string, init: RequestInit, timeoutMs: number, sleep: (ms: number) => Promise<unknown> = Bun.sleep): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    if (response.status !== 403 && response.status !== 429) return response
    const body = await response.text()
    const answer = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    if (!rateLimited(response, body) || attempt + 1 >= TRIES) return answer
    const wait = waitMs(response, attempt, Date.now())
    process.stderr.write(`${url}: ${failure(response, body)}; rate limited, try ${attempt + 2} of ${TRIES} in ${Math.ceil(wait / 1000)}s\n`)
    await sleep(wait)
  }
}
