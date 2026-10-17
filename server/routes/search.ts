import TheMovieDb from '@server/api/themoviedb';
import type { TmdbSearchMultiResponse } from '@server/api/themoviedb/interfaces';
import Media from '@server/entity/Media';
import type { KindShown } from '@server/lib/kindsShown';
import { getKindsShown } from '@server/lib/kindsShown';
import { searchMusic } from '@server/lib/music';
import { buildMusicResults } from '@server/lib/musicResults';
import { findSearchProvider } from '@server/lib/search';
import logger from '@server/logger';
import type { MusicResults } from '@server/models/Search';
import { mapSearchResults } from '@server/models/Search';
import { Router } from 'express';

const searchRoutes = Router();

// The music a search shows (R-3): the artists and then the albums Lidarr's
// lookup found, with their media rows and the status R-6 gives them (D-362).
// An album whose covering is undecided is left out, the rest standing; Lidarr
// failing, or no default Lidarr server, is no music and nothing else (R-14,
// D-8).
async function findMusicResults(query: string): Promise<MusicResults[]> {
  try {
    const music = await searchMusic(query);
    return await buildMusicResults(music.artists, music.albums);
  } catch (e) {
    logger.debug('Something went wrong retrieving music search results', {
      label: 'API',
      errorMessage: e.message,
      query,
    });
    return [];
  }
}

// The kind a search result is of, for the kinds shown (F2-D-31): artists and
// albums are music; a result of no kind (a collection) is of none.
const kindOfResult = (mediaType: string): KindShown | undefined => {
  switch (mediaType) {
    case 'movie':
    case 'tv':
    case 'person':
      return mediaType;
    case 'artist':
    case 'album':
      return 'music';
    default:
      return undefined;
  }
};

const isKindShown = (value: unknown): value is KindShown =>
  value === 'movie' ||
  value === 'tv' ||
  value === 'music' ||
  value === 'person';

searchRoutes.get('/', async (req, res, next) => {
  const queryString = req.query.query as string;
  const language = (req.query.language as string) ?? req.locale;
  const kindsShown = getKindsShown();
  // a type whose kind is not shown is read as no type (F2-D-31)
  let type = isKindShown(req.query.type) ? req.query.type : undefined;
  if (type && !kindsShown.includes(type)) {
    type = undefined;
  }
  const searchProvider = findSearchProvider(queryString.toLowerCase());
  let results: TmdbSearchMultiResponse;

  try {
    if (!type && !kindsShown.includes('movie') && !kindsShown.includes('tv')) {
      // every TMDB result would be of a kind not shown: TMDB and the id
      // providers are not read (F2-D-21)
      if (kindsShown.includes('music')) {
        type = 'music';
      } else {
        return res
          .status(200)
          .json({ page: 1, totalPages: 1, totalResults: 0, results: [] });
      }
    }

    if (type === 'music') {
      // Lidarr's lookup is not paged: its whole answer is page 1 of 1, a
      // later page answers no results of 1 page
      const requestedPage = Number(req.query.page);
      const later = requestedPage > 1;
      const music = later ? [] : await findMusicResults(queryString);

      return res.status(200).json({
        page: later ? requestedPage : 1,
        totalPages: 1,
        totalResults: music.length,
        results: music.filter((result) =>
          kindsShown.includes(kindOfResult(result.mediaType) as KindShown)
        ),
      });
    }

    if (searchProvider) {
      const [id] = queryString
        .toLowerCase()
        .match(searchProvider.pattern) as RegExpMatchArray;
      results = await searchProvider.search({
        id,
        language,
        query: queryString,
      });

      if (type) {
        results = {
          ...results,
          results: results.results.filter(
            (result) => result.media_type === type
          ),
        };
      }
    } else {
      const tmdb = new TheMovieDb();
      const options = {
        query: queryString,
        page: Number(req.query.page),
        language,
      };

      if (type === 'movie') {
        const movies = await tmdb.searchMovies(options);
        results = {
          ...movies,
          results: movies.results.map((result) => ({
            ...result,
            media_type: 'movie' as const,
          })),
        };
      } else if (type === 'tv') {
        const shows = await tmdb.searchTvShows(options);
        results = {
          ...shows,
          results: shows.results.map((result) => ({
            ...result,
            media_type: 'tv' as const,
          })),
        };
      } else if (type === 'person') {
        const people = await tmdb.searchPerson(options);
        results = {
          ...people,
          results: people.results.map((result) => ({
            ...result,
            media_type: 'person' as const,
          })),
        };
      } else {
        results = await tmdb.searchMulti(options);
      }
    }

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: result.media_type,
      }))
    );

    // music stands on the first page only, after TMDB's results, and is never
    // found through an id search (D-101)
    const music =
      !type && !searchProvider && results.page === 1
        ? await findMusicResults(queryString)
        : [];

    // every result of a kind not shown is left out, the page and the page
    // count of the source read staying however few results are left
    const shown = [
      ...mapSearchResults(results.results, media),
      ...music,
    ].filter((result) => {
      const kind = kindOfResult(result.mediaType);
      return kind === undefined || kindsShown.includes(kind);
    });

    return res.status(200).json({
      page: results.page,
      totalPages:
        music.length > 0
          ? Math.max(results.total_pages, 1)
          : results.total_pages,
      totalResults: results.total_results + music.length,
      results: shown,
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve search results.',
    });
  }
});

searchRoutes.get('/keyword', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchKeyword({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving keyword search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve keyword search results.',
    });
  }
});

searchRoutes.get('/company', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchCompany({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving company search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve company search results.',
    });
  }
});

export default searchRoutes;
