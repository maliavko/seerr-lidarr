import type {
  LidarrAlbum,
  LidarrArtist,
  MetadataProfile,
} from '@server/api/servarr/lidarr';
import LidarrAPI from '@server/api/servarr/lidarr';
import { MediaStatus, MediaType, MusicKind } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getDefaultLidarr } from '@server/lib/music';
import { albumInProfile } from '@server/lib/musicProfile';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { LidarrSettings } from '@server/lib/settings';

type SyncStatus = StatusBase & {
  currentServer?: LidarrSettings;
};

// An album is available where Lidarr holds a file for each of its tracks and
// it has a track at all (D-381).
const isAlbumComplete = (album: LidarrAlbum): boolean => {
  const statistics = album.statistics;

  return (
    !!statistics &&
    statistics.totalTrackCount > 0 &&
    statistics.trackFileCount >= statistics.totalTrackCount
  );
};

class LidarrScanner
  extends BaseScanner<LidarrArtist>
  implements RunnableScanner<SyncStatus>
{
  private currentServer?: LidarrSettings;
  private lidarrApi: LidarrAPI;
  private savedProfile: MetadataProfile;
  // one further run is marked, however many asks marked it (F2-D-41)
  private furtherRunMarked = false;

  constructor() {
    super('Lidarr Scan', { bundleSize: 10 });
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
    };
  }

  /**
   * Asks for a run: starts one where no scan runs, and otherwise marks one
   * further run, which the end of the running scan starts (F2-D-41).
   */
  public requestRun(): void {
    if (!this.running) {
      this.startFurtherRun();
      return;
    }

    this.furtherRunMarked = true;
    this.log(
      'A Lidarr scan is running. One further run is marked for when it ends.',
      'info'
    );
  }

  private startFurtherRun(): void {
    this.run().catch((e) => {
      this.log('Failed to start the Lidarr scan', 'error', {
        errorMessage: e.message,
      });
    });
  }

  public async run(): Promise<void> {
    const sessionId = this.startRun();
    this.items = [];
    this.progress = 0;
    this.currentServer = undefined;

    try {
      const server = getDefaultLidarr();

      if (!server) {
        this.log(
          'No default Lidarr server is configured. Nothing to scan.',
          'info'
        );
        return;
      }

      this.currentServer = server;
      this.log(`Beginning to process Lidarr server: ${server.name}`, 'info');

      this.lidarrApi = new LidarrAPI({
        apiKey: server.apiKey,
        url: LidarrAPI.buildUrl(server, '/api/v1'),
      });

      // read afresh from Lidarr, past the cache of its records (D-381): the
      // artists and, once a run, the saved metadata profile, which bounds the
      // albums an artist is counted on; either failing ends the run
      this.items = await this.lidarrApi.getArtists();
      this.savedProfile = await this.lidarrApi.getMetadataProfile(
        server.activeMetadataProfileId
      );

      await this.loop(this.processArtist.bind(this), { sessionId });
      this.log('Lidarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);

      // every run takes the mark as it ends; where another scan runs, that
      // scan's end takes it
      if (this.furtherRunMarked && !this.running) {
        this.furtherRunMarked = false;
        this.log('Starting the further Lidarr scan that was marked', 'info');
        this.startFurtherRun();
      }
    }
  }

  private async processArtist(artist: LidarrArtist): Promise<void> {
    // a cancel ends the run after the artist being scanned
    if (!this.running) {
      return;
    }

    try {
      if (artist.id === undefined || !artist.foreignArtistId) {
        return;
      }

      let albums: LidarrAlbum[];
      try {
        albums = await this.lidarrApi.getAlbums({ artistId: artist.id });
      } catch (e) {
        this.log(
          'Failed to read the albums of a Lidarr artist. Its rows are left as they were.',
          'error',
          { errorMessage: e.message, artist: artist.artistName }
        );
        return;
      }

      const mediaRepository = getRepository(Media);
      const artistRow = await this.findOrCreate(
        artist.foreignArtistId,
        MusicKind.ARTIST
      );

      // every listed album gets its row and its availability, under the saved
      // metadata profile or not (D-371); the artist is counted on those under
      // it alone, an album outside it counted neither way
      const countedRows: Media[] = [];

      for (const album of albums) {
        if (!album.foreignAlbumId) {
          continue;
        }

        const albumRow = await this.findOrCreate(
          album.foreignAlbumId,
          MusicKind.ALBUM,
          artist.foreignArtistId
        );

        // once AVAILABLE, an album row is never set back (R-13, BAR)
        if (
          isAlbumComplete(album) &&
          albumRow.status !== MediaStatus.AVAILABLE
        ) {
          albumRow.status = MediaStatus.AVAILABLE;
          await mediaRepository.save(albumRow);
        }

        if (albumInProfile(album, this.savedProfile)) {
          countedRows.push(albumRow);
        }
      }

      // the artist is counted on every run from its albums' rows (R-6)
      const available = countedRows.filter(
        (row) => row.status === MediaStatus.AVAILABLE
      ).length;
      let artistStatus: MediaStatus | undefined;

      if (countedRows.length > 0 && available === countedRows.length) {
        artistStatus = MediaStatus.AVAILABLE;
      } else if (available > 0) {
        artistStatus = MediaStatus.PARTIALLY_AVAILABLE;
      }

      if (artistStatus !== undefined && artistRow.status !== artistStatus) {
        artistRow.status = artistStatus;
        await mediaRepository.save(artistRow);
      }
    } catch (e) {
      this.log('Failed to process Lidarr artist', 'error', {
        errorMessage: e.message,
        artist: artist.artistName,
      });
    }
  }

  // the row of a music item, created as D-111 holds a music row where Seerr
  // lacks it; one a request created meanwhile (the unique index refusing the
  // second) is read and used
  private async findOrCreate(
    musicBrainzId: string,
    musicKind: MusicKind,
    artistMusicBrainzId?: string
  ): Promise<Media> {
    const mediaRepository = getRepository(Media);
    const where = { mediaType: MediaType.MUSIC, musicBrainzId, musicKind };

    const existing = await mediaRepository.findOne({ where });
    if (existing) {
      return existing;
    }

    try {
      return await mediaRepository.save(
        new Media({
          mediaType: MediaType.MUSIC,
          musicBrainzId,
          musicKind,
          artistMusicBrainzId:
            musicKind === MusicKind.ALBUM ? artistMusicBrainzId : undefined,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
        })
      );
    } catch (e) {
      const created = await mediaRepository.findOne({ where });
      if (created) {
        return created;
      }
      throw e;
    }
  }
}

export const lidarrScanner = new LidarrScanner();
