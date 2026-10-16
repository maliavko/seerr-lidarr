import TheMovieDb from '@server/api/themoviedb';
import type { TmdbSearchMultiResponse } from '@server/api/themoviedb/interfaces';
import { MusicKind } from '@server/constants/media';
import Media from '@server/entity/Media';
import { searchMusic } from '@server/lib/music';
import { musicMediaInfo, resolveMusicItems } from '@server/lib/musicStatus';
import { findSearchProvider } from '@server/lib/search';
import logger from '@server/logger';
import type { MusicResults } from '@server/models/Search';
import {
  mapAlbumResult,
  mapArtistResult,
  mapSearchResults,
} from '@server/models/Search';
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
    const media = await Media.getRelatedMusicMedia([
      ...music.artists.map((artist) => ({
        mbid: artist.id,
        kind: MusicKind.ARTIST,
      })),
      ...music.albums.map((album) => ({
        mbid: album.id,
        kind: MusicKind.ALBUM,
      })),
    ]);
    const resolutions = await resolveMusicItems([
      ...music.artists.map((artist) => ({
        mbid: artist.id,
        kind: MusicKind.ARTIST,
      })),
      ...music.albums.map((album) => ({
        mbid: album.id,
        kind: MusicKind.ALBUM,
        artistMbid: album.artist?.id,
      })),
    ]);
    const rowOf = (mbid: string, kind: MusicKind) =>
      media.find((row) => row.musicBrainzId === mbid && row.musicKind === kind);

    return [
      ...music.artists.map((artist, index) => {
        const resolved = resolutions[index];

        return mapArtistResult(
          artist,
          resolved.decided
            ? musicMediaInfo(resolved, rowOf(artist.id, MusicKind.ARTIST))
            : rowOf(artist.id, MusicKind.ARTIST)
        );
      }),
      ...music.albums.flatMap((album, index) => {
        const resolved = resolutions[music.artists.length + index];

        return resolved.decided
          ? [
              mapAlbumResult(
                album,
                musicMediaInfo(resolved, rowOf(album.id, MusicKind.ALBUM))
              ),
            ]
          : [];
      }),
    ];
  } catch (e) {
    logger.debug('Something went wrong retrieving music search results', {
      label: 'API',
      errorMessage: e.message,
      query,
    });
    return [];
  }
}

searchRoutes.get('/', async (req, res, next) => {
  const queryString = req.query.query as string;
  const searchProvider = findSearchProvider(queryString.toLowerCase());
  let results: TmdbSearchMultiResponse;

  try {
    if (searchProvider) {
      const [id] = queryString
        .toLowerCase()
        .match(searchProvider.pattern) as RegExpMatchArray;
      results = await searchProvider.search({
        id,
        language: (req.query.language as string) ?? req.locale,
        query: queryString,
      });
    } else {
      const tmdb = new TheMovieDb();

      results = await tmdb.searchMulti({
        query: queryString,
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
      });
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
      !searchProvider && results.page === 1
        ? await findMusicResults(queryString)
        : [];

    return res.status(200).json({
      page: results.page,
      totalPages:
        music.length > 0
          ? Math.max(results.total_pages, 1)
          : results.total_pages,
      totalResults: results.total_results + music.length,
      results: [...mapSearchResults(results.results, media), ...music],
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
