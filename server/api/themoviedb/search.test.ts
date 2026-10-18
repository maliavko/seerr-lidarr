import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import TheMovieDb from '@server/api/themoviedb';

type Getter = { get: (...args: unknown[]) => Promise<unknown> };
const proto = ExternalAPI.prototype as unknown as Getter;

const EMPTY = { page: 1, results: [], total_pages: 1, total_results: 0 };

const METHODS = [
  ['searchMulti', '/search/multi'],
  ['searchMovies', '/search/movie'],
  ['searchTvShows', '/search/tv'],
  ['searchPerson', '/search/person'],
] as const;

describe("TheMovieDb's search methods and failOnError (F2-D-401)", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  for (const [method, endpoint] of METHODS) {
    it(`${method} answers an empty page 1 of 1 where TMDB fails, by default and with failOnError off`, async () => {
      mock.method(proto, 'get', async () => {
        throw new Error('TMDB is down');
      });

      assert.deepStrictEqual(
        await new TheMovieDb()[method]({ query: 'keanu', page: 3 }),
        EMPTY
      );
      assert.deepStrictEqual(
        await new TheMovieDb()[method]({
          query: 'keanu',
          page: 3,
          failOnError: false,
        }),
        EMPTY
      );
    });

    it(`${method} throws what failed with failOnError on`, async () => {
      const failure = new Error('TMDB is down');
      mock.method(proto, 'get', async () => {
        throw failure;
      });

      await assert.rejects(
        new TheMovieDb()[method]({ query: 'keanu', failOnError: true }),
        (e) => e === failure
      );
    });

    it(`${method} answers what TMDB answers with failOnError on, and does not send the option to TMDB`, async () => {
      const answer = {
        page: 2,
        total_pages: 9,
        total_results: 170,
        results: [{ id: 1 }],
      };
      const get = mock.method(proto, 'get', async () => answer);

      const res = await new TheMovieDb()[method]({
        query: 'keanu',
        page: 2,
        failOnError: true,
      });

      assert.deepStrictEqual(res, answer);
      assert.strictEqual(get.mock.calls[0].arguments[0], endpoint);
      assert.ok(
        !(
          'failOnError' in
          (get.mock.calls[0].arguments[1] as { params: object }).params
        )
      );
    });
  }
});
