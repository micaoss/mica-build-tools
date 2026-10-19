// GitHub API requests against a stubbed fetch: a rate-limited answer is retried with the wait it asks for and
// a bounded number of tries; any other 403 is answered at once; a failure carries GitHub's message and headers.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { failure, githubFetch } from '../src/release/github.ts'
import { latestRelease } from '../src/release/latest.ts'

const URL = 'https://api.github.com/repos/micaoss/mica-core/releases?per_page=100&page=1'
const SECONDARY = '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}'

/** Replaces fetch with one answering `answers` in order, and records the URLs asked. */
function stubFetch(answers: (() => Response)[]): string[] {
  const asked: string[] = []
  spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    asked.push(String(input))
    const next = answers.shift()
    if (next === undefined) throw new Error('no answer left')
    return next()
  }) as typeof fetch)
  return asked
}

const answer = (status: number, body: string, headers: Record<string, string> = {}) => () => new Response(body, { status, headers })

/** A sleep that records its waits instead of waiting. */
function recorder(): { waits: number[], sleep: (ms: number) => Promise<void> } {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => { waits.push(ms) } }
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.()
})

describe('githubFetch', () => {
  test('a secondary rate limit is retried after retry-after, then answered', async () => {
    const asked = stubFetch([answer(403, SECONDARY, { 'retry-after': '30' }), answer(200, '[]')])
    const { waits, sleep } = recorder()
    const response = await githubFetch(URL, {}, 1000, sleep)
    expect([response.status, asked.length, waits]).toEqual([200, 2, [30000]])
  })

  test('429 and an exhausted primary limit wait for retry-after or the reset, each capped at a minute', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    stubFetch([answer(429, '', { 'retry-after': '600' }), answer(403, '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }), answer(200, '[]')])
    const { waits, sleep } = recorder()
    expect((await githubFetch(URL, {}, 1000, sleep)).status).toBe(200)
    expect(waits).toEqual([60000, 60000])
  })

  test('a rate limit without a wait doubles from 15 s; after three tries the last answer is returned with its body', async () => {
    const asked = stubFetch([answer(403, SECONDARY), answer(403, SECONDARY), answer(403, SECONDARY), answer(200, '[]')])
    const { waits, sleep } = recorder()
    const response = await githubFetch(URL, {}, 1000, sleep)
    expect([response.status, asked.length, waits]).toEqual([403, 3, [15000, 30000]])
    expect(await response.text()).toBe(SECONDARY)
  })

  test('a 403 that is no rate limit is answered at once', async () => {
    const asked = stubFetch([answer(403, '{"message":"Resource not accessible by integration"}', { 'x-ratelimit-remaining': '4999' })])
    const { waits, sleep } = recorder()
    expect((await githubFetch(URL, {}, 1000, sleep)).status).toBe(403)
    expect([asked.length, waits]).toEqual([1, []])
  })
})

describe('failure', () => {
  test('names the status, GitHub\'s message and the rate-limit headers', () => {
    const response = new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60' } })
    expect(failure(response, SECONDARY)).toBe(`HTTP 403: ${JSON.parse(SECONDARY).message} (x-ratelimit-remaining: 0, retry-after: 60)`)
    expect(failure(new Response('', { status: 502 }), 'bad gateway\n')).toBe('HTTP 502: bad gateway')
    expect(failure(new Response('', { status: 500 }), '')).toBe('HTTP 500')
  })
})

describe('the release listing', () => {
  test('rides out a rate limit, and fails at once on another 403 with its message', async () => {
    const env = process.env.MICA_GITHUB_API
    delete process.env.MICA_GITHUB_API
    try {
      stubFetch([answer(403, SECONDARY, { 'retry-after': '0' }), answer(200, JSON.stringify([{ tag_name: '20261017-1242', draft: false, prerelease: false, assets: [] }]))])
      expect(await latestRelease('mica-core')).toBe('20261017-1242')
      ;(globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore()
      const asked = stubFetch([answer(403, '{"message":"Forbidden"}')])
      await expect(latestRelease('mica-core')).rejects.toThrow(`${URL}: HTTP 403: Forbidden`)
      expect(asked).toEqual([URL])
    }
    finally {
      if (env !== undefined) process.env.MICA_GITHUB_API = env
    }
  })
})
