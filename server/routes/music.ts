import { MusicKind } from '@server/constants/media';
import Media from '@server/entity/Media';
import { getAlbum, getArtist, getArtistAlbumIds } from '@server/lib/music';
import type { MusicResolved } from '@server/lib/musicStatus';
import { musicMediaInfo, resolveMusicItems } from '@server/lib/musicStatus';
import logger from '@server/logger';
import { Router } from 'express';

const musicRoutes = Router();

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
          secondaryTypes: album.secondaryTypes,
          coverUrl: album.coverUrl,
          mediaInfo: musicMediaInfo(resolved, row),
        };
      }),
      mediaInfo: musicMediaInfo(artistStatus, media?.filter(req.user)),
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

export default musicRoutes;
