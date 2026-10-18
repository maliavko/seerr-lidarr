import { MusicKind } from '@server/constants/media';
import Media from '@server/entity/Media';
import {
  getAlbum,
  getArtist,
  getArtistAlbumIds,
  getDefaultLidarr,
  isMusicConfigured,
  searchInLidarr,
} from '@server/lib/music';
import { lidarrPageUrl } from '@server/lib/musicDetails';
import { buildMusicResults } from '@server/lib/musicResults';
import {
  getRecentlyAddedAlbums,
  getSimilarArtistSummaries,
  getSimilarToLibrarySummaries,
} from '@server/lib/musicSliders';
import type { MusicResolved } from '@server/lib/musicStatus';
import { musicMediaInfo, resolveMusicItems } from '@server/lib/musicStatus';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { MusicResults } from '@server/models/Search';
import type { Request, RequestHandler } from 'express';
import { Router } from 'express';

const musicRoutes = Router();

// The music sliders' routes (F2-D-92): at most 20 music items as search
// answers them, with the status the server computes; no default Lidarr server,
// or a source failing, is an empty list and the failure logged.
const sliderRoute = (
  name: string,
  read: (req: Request) => Promise<MusicResults[]>
): RequestHandler => {
  return async (req, res) => {
    if (!isMusicConfigured()) {
      return res.status(200).json({ results: [] });
    }

    try {
      return res.status(200).json({ results: await read(req) });
    } catch (e) {
      logger.error(`Failed to read the ${name} music slider`, {
        label: 'Music',
        errorMessage: e.message,
      });

      return res.status(200).json({ results: [] });
    }
  };
};

musicRoutes.get(
  '/recentlyadded',
  sliderRoute('recently added', async () =>
    buildMusicResults([], await getRecentlyAddedAlbums())
  )
);

musicRoutes.get(
  '/library/similar',
  sliderRoute('similar to your library', async () =>
    buildMusicResults(await getSimilarToLibrarySummaries(), [])
  )
);

musicRoutes.get(
  '/artist/:mbid/similar',
  sliderRoute('similar artists', async (req) =>
    buildMusicResults(
      await getSimilarArtistSummaries(String(req.params.mbid)),
      []
    )
  )
);

musicRoutes.get('/artist/:mbid', async (req, res, next) => {
  try {
    const artist = await getArtist(req.params.mbid);

    // an id the source does not know, or no default Lidarr server
    if (!artist) {
      return next({ status: 404, message: 'Artist not found.' });
    }

    const media = await Media.getMusicMedia(artist.id, MusicKind.ARTIST);
    const albumMedia = await Media.getRelatedMusicMedia(
      artist.albums.map((album) => ({ mbid: album.id, kind: MusicKind.ALBUM }))
    );
    // the status of the artist and of each album of its page, each by its own
    // covering (D-362): where Lidarr holds the artist, an album of its list is
    // covered by the artist's whole-artist request only where it falls under the
    // saved metadata profile; before, the page's albums are the artist's albums
    const resolutions = await resolveMusicItems([
      { mbid: artist.id, kind: MusicKind.ARTIST },
      ...artist.albums.map((album) => ({
        mbid: album.id,
        kind: MusicKind.ALBUM,
        artistMbid: artist.id,
        listedUnderArtist: !artist.inLidarr,
      })),
    ]);

    // a whole-artist request of the artist stands and the artist's albums or
    // the saved metadata profile cannot be read: the covering of its albums is
    // undecided, so the page says so and offers no request the API would not
    // accept (D-362, R-14)
    // the page's own list of albums is empty where the source failed to list
    // them (D-201's soft failure of a page), so where a whole-artist request of
    // the artist stands its albums are read for the covering too, and not being
    // readable is the same undecided covering (F-1806)
    let undecided = resolutions.some((resolved) => !resolved.decided);

    if (
      !undecided &&
      resolutions[0].decided &&
      resolutions[0].requests.length > 0
    ) {
      try {
        await getArtistAlbumIds(artist.id);
      } catch {
        undecided = true;
      }
    }

    if (undecided) {
      return next({
        status: 500,
        message:
          "Unable to determine which albums the artist's whole-artist request covers.",
      });
    }

    const [artistStatus, ...albumStatuses] = resolutions as MusicResolved[];

    return res.status(200).json({
      id: artist.id,
      name: artist.name,
      overview: artist.overview,
      imageUrl: artist.imageUrl,
      backdropUrl: artist.backdropUrl,
      artistType: artist.artistType,
      disambiguation: artist.disambiguation,
      genres: artist.genres,
      inLidarr: artist.inLidarr,
      albums: artist.albums.map((album, index) => {
        const resolved = albumStatuses[index];
        const row = albumMedia.find(
          (r) => r.musicBrainzId === album.id && r.musicKind === MusicKind.ALBUM
        );

        return {
          id: album.id,
          title: album.title,
          releaseDate: album.releaseDate,
          albumType: album.albumType,
          trackCount: album.trackCount,
          secondaryTypes: album.secondaryTypes,
          coverUrl: album.coverUrl,
          mediaInfo: musicMediaInfo(resolved, row),
        };
      }),
      mediaInfo: musicMediaInfo(artistStatus, media?.filter(req.user)),
      links: artist.links,
      rating: artist.rating,
      facts: artist.facts,
      lidarrUrl: managerLidarrUrl(req, 'artist', artist.id, artist.inLidarr),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving artist', {
      label: 'API',
      errorMessage: e.message,
      mbid: req.params.mbid,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve artist.',
    });
  }
});

musicRoutes.get('/album/:mbid', async (req, res, next) => {
  try {
    const album = await getAlbum(req.params.mbid);

    if (!album) {
      return next({ status: 404, message: 'Album not found.' });
    }

    const media = await Media.getMusicMedia(album.id, MusicKind.ALBUM);
    const [resolved] = await resolveMusicItems([
      {
        mbid: album.id,
        kind: MusicKind.ALBUM,
        artistMbid: album.artist.id,
      },
    ]);

    // a whole-artist request of the album's artist stands and the artist's
    // albums or the saved metadata profile cannot be read: the album's covering
    // is undecided, so the page says so and offers no request the API would not
    // accept (D-362, R-14)
    if (!resolved.decided) {
      return next({
        status: 500,
        message:
          "Unable to determine whether the album is covered by its artist's request.",
      });
    }

    return res.status(200).json({
      id: album.id,
      title: album.title,
      disambiguation: album.disambiguation,
      artist: album.artist,
      releaseDate: album.releaseDate,
      albumType: album.albumType,
      secondaryTypes: album.secondaryTypes,
      coverUrl: album.coverUrl,
      overview: album.overview,
      genres: album.genres,
      inLidarr: album.inLidarr,
      tracks: album.tracks,
      mediaInfo: musicMediaInfo(resolved, media?.filter(req.user)),
      links: album.links,
      rating: album.rating,
      facts: album.facts,
      files: album.files,
      lidarrUrl: managerLidarrUrl(req, 'album', album.id, album.inLidarr),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving album', {
      label: 'API',
      errorMessage: e.message,
      mbid: req.params.mbid,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve album.',
    });
  }
});

// The page of an artist or album in Lidarr, for a user who manages requests,
// where Lidarr holds it and the server has an external URL.
const managerLidarrUrl = (
  req: Request,
  kind: 'artist' | 'album',
  mbid: string,
  inLidarr: boolean
): string | undefined => {
  const server = getDefaultLidarr();

  return server &&
    inLidarr &&
    req.user?.hasPermission(Permission.MANAGE_REQUESTS)
    ? lidarrPageUrl(server, kind, mbid)
    : undefined;
};

// Ask Lidarr to search again for an artist's missing albums or for an album,
// one Lidarr holds; for a user who manages requests.
for (const kind of ['artist', 'album'] as const) {
  musicRoutes.post(
    `/${kind}/:mbid/search`,
    isAuthenticated(Permission.MANAGE_REQUESTS),
    async (req, res, next) => {
      try {
        const started = await searchInLidarr(kind, String(req.params.mbid));

        if (!started) {
          return next({
            status: 404,
            message: `Lidarr does not hold this ${kind}.`,
          });
        }

        return res.status(204).send();
      } catch (e) {
        logger.debug('Something went wrong asking Lidarr to search', {
          label: 'API',
          errorMessage: e.message,
          mbid: req.params.mbid,
        });
        return next({
          status: 500,
          message: 'Unable to start a search in Lidarr.',
        });
      }
    }
  );
}

export default musicRoutes;
