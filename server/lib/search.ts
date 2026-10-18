import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbMovieResult,
  TmdbPersonDetails,
  TmdbPersonResult,
  TmdbSearchMovieResponse,
  TmdbSearchMultiResponse,
  TmdbSearchTvResponse,
  TmdbTvDetails,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import {
  mapMovieDetailsToResult,
  mapPersonDetailsToResult,
  mapTvDetailsToResult,
} from '@server/models/Search';
import {
  isMovie,
  isMovieDetails,
  isTvDetails,
} from '@server/utils/typeHelpers';

// A read of a source of several reads that failed (F2-D-401): the kind of
// result it would have given.
export interface SearchReadFailure {
  kind: 'movie' | 'tv' | 'person';
  error: unknown;
}

export type SearchProviderResult = TmdbSearchMultiResponse & {
  failures?: SearchReadFailure[];
};

// TMDB answers an id it does not hold with 404, read from the error or from
// the cause beneath it: that is a read that found nothing, never a failure.
export const isNotFound = (error: unknown): boolean => {
  let current = error as
    | { response?: { status?: number }; cause?: unknown }
    | undefined;

  for (let depth = 0; current && depth < 5; depth++) {
    if (current.response?.status === 404) {
      return true;
    }
    current = current.cause as typeof current;
  }

  return false;
};

interface SearchProvider {
  pattern: RegExp;
  search: ({
    id,
    language,
    query,
  }: {
    id: string;
    language?: string;
    query?: string;
  }) => Promise<SearchProviderResult>;
}

const searchProviders: SearchProvider[] = [];

export const findSearchProvider = (
  query: string
): SearchProvider | undefined => {
  return searchProviders.find((provider) => provider.pattern.test(query));
};

searchProviders.push({
  pattern: new RegExp(/(?<=tmdb:)\d+/),
  search: async ({ id, language }) => {
    const tmdb = new TheMovieDb();

    const moviePromise = tmdb.getMovie({ movieId: parseInt(id), language });
    const tvShowPromise = tmdb.getTvShow({ tvId: parseInt(id), language });
    const personPromise = tmdb.getPerson({ personId: parseInt(id), language });

    const responses = await Promise.allSettled([
      moviePromise,
      tvShowPromise,
      personPromise,
    ]);

    const successfulResponses = responses.filter(
      (r) => r.status === 'fulfilled'
    ) as (
      | PromiseFulfilledResult<TmdbMovieDetails>
      | PromiseFulfilledResult<TmdbTvDetails>
      | PromiseFulfilledResult<TmdbPersonDetails>
    )[];

    const results: (TmdbMovieResult | TmdbTvResult | TmdbPersonResult)[] = [];
    const failures: SearchReadFailure[] = [];
    (['movie', 'tv', 'person'] as const).forEach((kind, index) => {
      const response = responses[index];

      if (response.status === 'rejected' && !isNotFound(response.reason)) {
        failures.push({ kind, error: response.reason });
      }
    });

    if (successfulResponses.length) {
      results.push(
        ...successfulResponses.map((r) => {
          if (isMovieDetails(r.value)) {
            return mapMovieDetailsToResult(r.value);
          } else if (isTvDetails(r.value)) {
            return mapTvDetailsToResult(r.value);
          } else {
            return mapPersonDetailsToResult(r.value);
          }
        })
      );
    }

    return {
      page: 1,
      total_pages: 1,
      total_results: results.length,
      results,
      failures,
    };
  },
});

searchProviders.push({
  pattern: new RegExp(/(?<=imdb:)(tt|nm)\d+/),
  search: async ({ id, language }) => {
    const tmdb = new TheMovieDb();

    const responses = await tmdb.getByExternalId({
      externalId: id,
      type: 'imdb',
      language,
    });

    const results: (TmdbMovieResult | TmdbTvResult | TmdbPersonResult)[] = [];

    // set the media_type here since searching by external id doesn't return it
    results.push(
      ...(responses.movie_results.map((movie) => ({
        ...movie,
        media_type: 'movie',
      })) as TmdbMovieResult[]),
      ...(responses.tv_results.map((tv) => ({
        ...tv,
        media_type: 'tv',
      })) as TmdbTvResult[]),
      ...(responses.person_results.map((person) => ({
        ...person,
        media_type: 'person',
      })) as TmdbPersonResult[])
    );

    return {
      page: 1,
      total_pages: 1,
      total_results: results.length,
      results,
    };
  },
});

searchProviders.push({
  pattern: new RegExp(/(?<=tvdb:)\d+/),
  search: async ({ id, language }) => {
    const tmdb = new TheMovieDb();

    const responses = await tmdb.getByExternalId({
      externalId: parseInt(id),
      type: 'tvdb',
      language,
    });

    const results: (TmdbMovieResult | TmdbTvResult | TmdbPersonResult)[] = [];

    // set the media_type here since searching by external id doesn't return it
    results.push(
      ...(responses.movie_results.map((movie) => ({
        ...movie,
        media_type: 'movie',
      })) as TmdbMovieResult[]),
      ...(responses.tv_results.map((tv) => ({
        ...tv,
        media_type: 'tv',
      })) as TmdbTvResult[]),
      ...(responses.person_results.map((person) => ({
        ...person,
        media_type: 'person',
      })) as TmdbPersonResult[])
    );

    return {
      page: 1,
      total_pages: 1,
      total_results: results.length,
      results,
    };
  },
});

searchProviders.push({
  pattern: new RegExp(/(?<=year:)\d{4}/),
  search: async ({ id: year, query }) => {
    const tmdb = new TheMovieDb();

    const moviesPromise = tmdb.searchMovies({
      query: query?.replace(new RegExp(/year:\d{4}/), '') ?? '',
      year: parseInt(year),
      failOnError: true,
    });
    const tvShowsPromise = tmdb.searchTvShows({
      query: query?.replace(new RegExp(/year:\d{4}/), '') ?? '',
      year: parseInt(year),
      failOnError: true,
    });

    const responses = await Promise.allSettled([moviesPromise, tvShowsPromise]);
    const failures: SearchReadFailure[] = [];
    (['movie', 'tv'] as const).forEach((kind, index) => {
      const response = responses[index];

      if (response.status === 'rejected') {
        failures.push({ kind, error: response.reason });
      }
    });

    const successfulResponses = responses.filter(
      (r) => r.status === 'fulfilled'
    ) as (
      | PromiseFulfilledResult<TmdbSearchMovieResponse>
      | PromiseFulfilledResult<TmdbSearchTvResponse>
    )[];

    const results: (TmdbMovieResult | TmdbTvResult)[] = [];

    if (successfulResponses.length) {
      successfulResponses.forEach((response) => {
        response.value.results.forEach((result) =>
          // set the media_type here since the search endpoints don't return it
          results.push(
            isMovie(result)
              ? { ...result, media_type: 'movie' }
              : { ...result, media_type: 'tv' }
          )
        );
      });
    }

    return {
      page: 1,
      total_pages: 1,
      total_results: results.length,
      results,
      failures,
    };
  },
});
