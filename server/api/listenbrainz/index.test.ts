import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';

import ListenBrainzAPI, {
  getListenBrainz,
  readFailureCause,
} from '@server/api/listenbrainz';
import { getMusicBrainzUserAgent } from '@server/api/musicbrainz';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import type {
  AxiosAdapter,
  AxiosInstance,
  InternalAxiosRequestConfig,
} from 'axios';

// ListenBrainz's answer, recorded once (the first 30 of the similar artists of
// Radiohead)
const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(join(__dirname, 'listenbrainz.fixtures', name), 'utf8')
  ) as T;

interface Similar {
  artist_mbid?: string | null;
  name?: string;
  score?: number;
}

const similar = fixture<Similar[]>('similar-artists-radiohead.json');

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';

interface Call {
  url: string;
  baseURL: string;
  params: Record<string, unknown>;
  headers: Record<string, unknown>;
}

// Replaces what the client sends over the wire: the requests it makes are
// recorded after its interceptors and answered by respond.
function wire(
  client: ListenBrainzAPI,
  respond: (call: Call) => { status?: number; data?: unknown; error?: Error }
): Call[] {
  const calls: Call[] = [];
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      url: config.url ?? '',
      baseURL: config.baseURL ?? '',
      params: (config.params ?? {}) as Record<string, unknown>,
      headers: config.headers.toJSON() as Record<string, unknown>,
    };
    calls.push(call);

    const { status = 200, data, error } = respond(call);

    if (error) {
      throw error;
    }

    const response = {
      data,
      status,
      statusText: String(status),
      headers: {},
      config,
    };

    if (status >= 400) {
      throw Object.assign(
        new Error(`Request failed with status code ${status}`),
        { response }
      );
    }

    return response;
  };

  (client as unknown as { axios: AxiosInstance }).axios.defaults.adapter =
    adapter;

  return calls;
}

describe('the ListenBrainz client', () => {
  beforeEach(() => cacheManager.getCache('listenbrainz').flush());

  it('is one shared instance for the whole server', () => {
    assert.strictEqual(getListenBrainz(), getListenBrainz());
    assert.ok(getListenBrainz() instanceof ListenBrainzAPI);
  });

  it('times a request out after 5 seconds', () => {
    const client = new ListenBrainzAPI();

    assert.strictEqual(
      (client as unknown as { axios: AxiosInstance }).axios.defaults.timeout,
      5000
    );
  });

  describe('getSimilarArtists', () => {
    it('asks the labs similar-artists dataset for the artist with the session-based algorithm', async () => {
      const client = new ListenBrainzAPI();
      const calls = wire(client, () => ({ data: similar }));

      await client.getSimilarArtists(RADIOHEAD);

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(
        calls[0].url,
        'https://labs.api.listenbrainz.org/similar-artists/json'
      );
      assert.deepStrictEqual(calls[0].params, {
        artist_mbids: RADIOHEAD,
        algorithm:
          'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30',
      });
      assert.strictEqual(
        calls[0].headers['User-Agent'],
        getMusicBrainzUserAgent()
      );
    });

    it('answers every entry left, more than 20, each {mbid, name, score}, by score descending', async () => {
      const client = new ListenBrainzAPI();
      wire(client, () => ({ data: [...similar].reverse() }));

      const artists = await client.getSimilarArtists(RADIOHEAD);

      assert.ok(similar.length > 20, 'the fixture holds more than 20 entries');
      assert.strictEqual(artists.length, similar.length);
      const expected = [...similar].sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0)
      );
      assert.deepStrictEqual(
        artists,
        expected.map((a) => ({
          mbid: a.artist_mbid,
          name: a.name,
          score: a.score,
        }))
      );
      assert.strictEqual(artists[0].name, 'Nirvana');
      assert.strictEqual(artists[0].score, 11156);
    });

    it('answers a score that is a number, 0 where the entry gives none or one that is not a number', async () => {
      const client = new ListenBrainzAPI();
      wire(client, () => ({
        data: [
          { artist_mbid: 'a', name: 'A' },
          { artist_mbid: 'b', name: 'B', score: null },
          { artist_mbid: 'c', name: 'C', score: 'not a number' },
          { artist_mbid: 'd', name: 'D', score: 7 },
        ],
      }));

      assert.deepStrictEqual(await client.getSimilarArtists(RADIOHEAD), [
        { mbid: 'd', name: 'D', score: 7 },
        { mbid: 'a', name: 'A', score: 0 },
        { mbid: 'b', name: 'B', score: 0 },
        { mbid: 'c', name: 'C', score: 0 },
      ]);
    });

    it('drops the artist itself and entries without an artist_mbid', async () => {
      const client = new ListenBrainzAPI();
      wire(client, () => ({
        data: [
          { artist_mbid: RADIOHEAD, name: 'Radiohead', score: 99999 },
          { artist_mbid: null, name: 'No id', score: 5000 },
          { name: 'Missing id', score: 4000 },
          { artist_mbid: '', name: 'Empty id', score: 3000 },
          { artist_mbid: 'm-1', name: 'Kept', score: 10 },
        ],
      }));

      assert.deepStrictEqual(await client.getSimilarArtists(RADIOHEAD), [
        { mbid: 'm-1', name: 'Kept', score: 10 },
      ]);
    });

    it('drops an entry without a name, or with an empty one', async () => {
      const client = new ListenBrainzAPI();
      wire(client, () => ({
        data: [
          { artist_mbid: 'm-1', score: 50 },
          { artist_mbid: 'm-2', name: '', score: 40 },
          { artist_mbid: 'm-3', name: null, score: 30 },
          { artist_mbid: 'm-4', name: 'Kept', score: 1 },
        ],
      }));

      assert.deepStrictEqual(await client.getSimilarArtists(RADIOHEAD), [
        { mbid: 'm-4', name: 'Kept', score: 1 },
      ]);
    });

    it('keeps ListenBrainz order among equal scores', async () => {
      const client = new ListenBrainzAPI();
      wire(client, () => ({
        data: [
          { artist_mbid: 'a', name: 'A', score: 5 },
          { artist_mbid: 'b', name: 'B', score: 5 },
          { artist_mbid: 'c', name: 'C', score: 9 },
        ],
      }));

      assert.deepStrictEqual(
        (await client.getSimilarArtists(RADIOHEAD)).map((a) => a.mbid),
        ['c', 'a', 'b']
      );
    });

    it('answers [] for an artist ListenBrainz does not know, and keeps that answer once', async () => {
      const client = new ListenBrainzAPI();
      const calls = wire(client, () => ({ data: [] }));

      assert.deepStrictEqual(await client.getSimilarArtists(RADIOHEAD), []);
      assert.deepStrictEqual(await client.getSimilarArtists(RADIOHEAD), []);
      assert.strictEqual(calls.length, 1);
    });

    it('keeps its answer 24 hours: the call asks 86400 seconds', async () => {
      const client = new ListenBrainzAPI();
      wire(client, () => ({ data: similar }));
      const set = mock.method(
        cacheManager.getCache('listenbrainz').data,
        'set'
      );

      await client.getSimilarArtists(RADIOHEAD);
      set.mock.restore();

      assert.strictEqual(set.mock.callCount(), 1);
      assert.strictEqual(set.mock.calls[0].arguments[2], 86400);
    });

    it('keeps one answer per artist', async () => {
      const client = new ListenBrainzAPI();
      const calls = wire(client, () => ({ data: similar }));

      await client.getSimilarArtists(RADIOHEAD);
      await client.getSimilarArtists('other-artist');
      await client.getSimilarArtists(RADIOHEAD);

      assert.strictEqual(calls.length, 2);
    });

    for (const [name, respond] of [
      ['a network error', () => ({ error: new Error('connect ECONNREFUSED') })],
      ['a timeout', () => ({ error: new Error('timeout of 5000ms exceeded') })],
      ['a 500', () => ({ status: 500, data: 'oops' })],
      ['a 404', () => ({ status: 404, data: { error: 'no' } })],
      ['an object where a list belongs', () => ({ data: { error: 'x' } })],
      ['a body that is not JSON', () => ({ data: '<html>' })],
      ['a null body', () => ({ data: null })],
    ] as [string, () => { status?: number; data?: unknown; error?: Error }][]) {
      it(`answers [] on ${name}, never an error, and keeps nothing`, async () => {
        const client = new ListenBrainzAPI();
        const calls = wire(client, respond);

        assert.deepStrictEqual(await client.getSimilarArtists(RADIOHEAD), []);
        assert.deepStrictEqual(await client.getSimilarArtists(RADIOHEAD), []);
        assert.strictEqual(calls.length, 2, 'a failure is asked again');
      });
    }

    it('reads an entry it cannot read as no artist, the rest standing', async () => {
      const client = new ListenBrainzAPI();
      wire(client, () => ({
        data: [null, 'x', 7, { artist_mbid: 'm-1', name: 'Kept', score: 1 }],
      }));

      assert.deepStrictEqual(await client.getSimilarArtists(RADIOHEAD), [
        { mbid: 'm-1', name: 'Kept', score: 1 },
      ]);
    });
  });
});

// F2-D-141: each failed read logs the cause of the failure, told apart.
describe('the failure log of the ListenBrainz client', () => {
  beforeEach(() => cacheManager.getCache('listenbrainz').flush());

  type Failure = { status?: number; data?: unknown; error?: Error };

  const axiosError = (
    message: string,
    extra: Record<string, unknown> = {}
  ): Error => Object.assign(new Error(message), { isAxiosError: true }, extra);

  const unreadable: Record<string, string> = {
    getSimilarArtists: 'unreadable answer: the answer is not a list',
  };

  const cases: [
    string,
    () => Failure,
    string | ((read: string) => string),
    Record<string, unknown>,
  ][] = [
    [
      'an HTTP 500',
      () => ({
        error: axiosError('Request failed with status code 500', {
          code: 'ERR_BAD_RESPONSE',
          response: { status: 500, statusText: 'Internal Server Error' },
        }),
      }),
      'HTTP 500 Internal Server Error',
      { status: 500 },
    ],
    [
      'an HTTP 404 without a status text',
      () => ({
        error: axiosError('Request failed with status code 404', {
          code: 'ERR_BAD_REQUEST',
          response: { status: 404 },
        }),
      }),
      'HTTP 404',
      { status: 404 },
    ],
    [
      'a timeout',
      () => ({
        error: axiosError('timeout of 5000ms exceeded', {
          code: 'ECONNABORTED',
        }),
      }),
      'timeout (ECONNABORTED)',
      { code: 'ECONNABORTED' },
    ],
    [
      'a timeout clarified as ETIMEDOUT',
      () => ({
        error: axiosError('connect ETIMEDOUT 1.2.3.4:443', {
          code: 'ETIMEDOUT',
        }),
      }),
      'timeout (ETIMEDOUT)',
      { code: 'ETIMEDOUT' },
    ],
    [
      'an error whose code is only in its cause',
      () => ({
        error: axiosError('', {
          cause: Object.assign(new Error(''), { code: 'ECONNRESET' }),
        }),
      }),
      'network error ECONNRESET',
      { code: 'ECONNRESET' },
    ],
    [
      'a connection refused with an empty message',
      () => ({ error: axiosError('', { code: 'ECONNREFUSED' }) }),
      'network error ECONNREFUSED',
      { code: 'ECONNREFUSED' },
    ],
    [
      'a host not found',
      () => ({
        error: axiosError('getaddrinfo ENOTFOUND api.listenbrainz.org', {
          code: 'ENOTFOUND',
        }),
      }),
      'network error ENOTFOUND',
      { code: 'ENOTFOUND' },
    ],
    [
      'an aggregate error without a code of its own',
      () => ({
        error: axiosError('', {
          errors: [
            Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
            Object.assign(new Error(''), { code: 'ENETUNREACH' }),
          ],
        }),
      }),
      'network error ECONNREFUSED, ENETUNREACH',
      { code: 'ECONNREFUSED, ENETUNREACH' },
    ],
    [
      'an answer not of the shape',
      () => ({ data: '<html>' }),
      (read) => unreadable[read],
      {},
    ],
    [
      'an error of no kind the client knows',
      () => ({ error: new TypeError('boom') }),
      'TypeError: boom',
      {},
    ],
    [
      'an error with no message and no code',
      () => ({ error: new RangeError('') }),
      'RangeError',
      {},
    ],
  ];

  const reads: [
    string,
    (client: ListenBrainzAPI) => Promise<unknown[]>,
    Record<string, unknown>,
  ][] = [
    [
      'getSimilarArtists',
      (client) => client.getSimilarArtists(RADIOHEAD),
      { mbid: RADIOHEAD },
    ],
  ];

  for (const [read, call, extra] of reads) {
    describe(read, () => {
      for (const [name, respond, cause, fields] of cases) {
        it(`logs the cause of ${name}, answers [] and keeps nothing`, async () => {
          const client = new ListenBrainzAPI();
          const calls = wire(client, respond);
          const error = mock.method(logger, 'error', () => logger);

          try {
            assert.deepStrictEqual(await call(client), []);
            assert.deepStrictEqual(await call(client), []);
          } finally {
            error.mock.restore();
          }

          assert.strictEqual(calls.length, 2, 'a failure is asked again');
          assert.strictEqual(error.mock.callCount(), 2, 'logged once a read');

          const [message, meta] = error.mock.calls[0].arguments as unknown as [
            string,
            Record<string, unknown>,
          ];
          assert.match(message, /^Failed to read the .* from ListenBrainz$/);
          assert.strictEqual(meta.label, 'ListenBrainz');
          assert.strictEqual(typeof meta.errorMessage, 'string');
          assert.strictEqual(
            meta.cause,
            typeof cause === 'function' ? cause(read) : cause
          );
          assert.ok((meta.cause as string).length > 0);
          for (const [key, value] of Object.entries({ ...fields, ...extra })) {
            assert.strictEqual(meta[key], value, key);
          }
          for (const key of ['status', 'code']) {
            if (!(key in fields)) {
              assert.strictEqual(meta[key], undefined, `no ${key}`);
            }
          }
        });
      }

      it('logs a different cause for each of the failures', async () => {
        const logged = new Set<string>();

        for (const [, respond] of cases) {
          const client = new ListenBrainzAPI();
          wire(client, respond);
          const error = mock.method(logger, 'error', () => logger);

          try {
            await call(client);
          } finally {
            error.mock.restore();
          }

          const meta = (error.mock.calls[0].arguments as unknown[])[1] as {
            cause: string;
          };
          assert.ok(meta.cause.length > 0);
          logged.add(meta.cause);
        }

        assert.strictEqual(logged.size, cases.length);
      });
    });
  }

  it('reads the unreadable answer by the transform message of each read', async () => {
    const seen: Record<string, string> = {};

    for (const [read, call] of reads) {
      const client = new ListenBrainzAPI();
      wire(client, () => ({ data: { nothing: true } }));
      const error = mock.method(logger, 'error', () => logger);

      try {
        await call(client);
      } finally {
        error.mock.restore();
      }

      seen[read] = (
        (error.mock.calls[0].arguments as unknown[])[1] as { cause: string }
      ).cause;
    }

    assert.strictEqual(
      seen.getSimilarArtists,
      'unreadable answer: the answer is not a list'
    );
  });

  it('reads the cause of a thrown non-error too, never empty', () => {
    for (const thrown of [undefined, null, 'x', 7, {}]) {
      assert.ok(readFailureCause(thrown).cause.length > 0);
    }
  });

  it('logs nothing for a read that succeeds', async () => {
    const client = new ListenBrainzAPI();
    wire(client, () => ({ data: similar }));
    const error = mock.method(logger, 'error', () => logger);

    try {
      await client.getSimilarArtists(RADIOHEAD);
    } finally {
      error.mock.restore();
    }

    assert.strictEqual(error.mock.callCount(), 0);
  });
});

describe('the listenbrainz cache', () => {
  it('is one of the caches the product lists, its stdTtl 86400 seconds (24 hours)', () => {
    const cache = cacheManager.getAllCaches().listenbrainz;

    assert.ok(cache);
    assert.strictEqual(cache.id, 'listenbrainz');
    assert.strictEqual(cache, cacheManager.getCache('listenbrainz'));
    assert.strictEqual(
      (cache.data as unknown as { stdTtl: number }).stdTtl,
      86400
    );
  });
});
