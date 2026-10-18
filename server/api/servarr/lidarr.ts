import ServarrBase from './base';

export interface MetadataProfile {
  id: number;
  name: string;
  // which album types and release statuses the profile lets Lidarr list
  primaryAlbumTypes?: {
    albumType: { id: number; name: string };
    allowed: boolean;
  }[];
  secondaryAlbumTypes?: {
    albumType: { id: number; name: string };
    allowed: boolean;
  }[];
  releaseStatuses?: {
    releaseStatus: { id: number; name: string };
    allowed: boolean;
  }[];
}

export interface LidarrStatistics {
  trackFileCount: number;
  trackCount: number;
  totalTrackCount: number;
  sizeOnDisk: number;
  percentOfTracks: number;
}

export interface LidarrArtistStatistics extends LidarrStatistics {
  albumCount: number;
}

export interface LidarrImage {
  coverType: string;
  url: string;
  remoteUrl?: string;
}

export interface LidarrLink {
  url: string;
  name: string;
}

export interface LidarrRelease {
  // the MusicBrainz release id
  foreignReleaseId: string;
  title?: string;
  status?: string;
  monitored: boolean;
  // the number of tracks across its media
  trackCount?: number;
}

export interface LidarrTrack {
  id: number;
  albumId: number;
  foreignTrackId?: string;
  title: string;
  // the number as the release gives it ('A1', '7')
  trackNumber: string;
  // the position within its medium
  absoluteTrackNumber: number;
  mediumNumber: number;
  // milliseconds
  duration: number;
  hasFile: boolean;
  // the file Lidarr holds of the track (0 or absent where it holds none)
  trackFileId?: number;
}

// One event of Lidarr's history (GET /history, GET /history/artist); only the
// fields Seerr reads are typed.
export interface LidarrHistoryEvent {
  id: number;
  // when Lidarr recorded the event (ISO 8601)
  date: string;
  // trackFileImported, trackFileDeleted, grabbed, ...
  eventType: string;
  artistId?: number;
  albumId?: number;
  trackId?: number;
  // the event's own data; a trackFileDeleted says why in reason (Upgrade,
  // ManualOverride, MissingFromDisk, Manual, ...), a trackFileImported names
  // the file it imported in fileId (Lidarr writes it as a string)
  data?: { reason?: string; fileId?: string | number } & Record<
    string,
    unknown
  >;
}

// one page of Lidarr's history, as GET /history answers it
export interface LidarrHistoryPage {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: LidarrHistoryEvent[];
}

// A file Lidarr holds of an album (GET /trackfile); only the fields Seerr reads
// are typed.
export interface LidarrTrackFile {
  id: number;
  albumId: number;
  artistId?: number;
  // when Lidarr gained the file (ISO 8601)
  dateAdded: string;
}

// Lidarr answers a track-file read for as many albums as one request names;
// the longer list is read in batches of this many.
const TRACK_FILE_BATCH = 50;

export type LidarrMonitor = 'none' | 'all';

// what Lidarr monitors of the albums of an artist it adds: 'existing' monitors
// the albums that already have a file, none on an artist just added, so that
// albumsToMonitor alone says which album is monitored
export type LidarrAddMonitor = LidarrMonitor | 'existing';

export interface LidarrArtist {
  // Lidarr's own id: present only for an artist Lidarr holds
  id?: number;
  foreignArtistId: string;
  artistName: string;
  overview?: string;
  images: LidarrImage[];
  links: LidarrLink[];
  artistType?: string;
  disambiguation?: string;
  genres: string[];
  monitored: boolean;
  monitorNewItems: LidarrMonitor | string;
  qualityProfileId?: number;
  metadataProfileId?: number;
  rootFolderPath?: string;
  path?: string;
  statistics?: LidarrArtistStatistics;
}

export interface LidarrAlbum {
  // Lidarr's own id: present only for an album Lidarr holds
  id?: number;
  // the MusicBrainz release-group id
  foreignAlbumId: string;
  artistId?: number;
  artist?: LidarrArtist;
  title: string;
  disambiguation?: string;
  overview?: string;
  releaseDate?: string;
  albumType?: string;
  secondaryTypes: string[];
  genres?: string[];
  images: LidarrImage[];
  // the lookup's cover, where it has one
  remoteCover?: string;
  // the lookup's releases of the album, one marked monitored
  releases?: LidarrRelease[];
  monitored: boolean;
  statistics?: LidarrStatistics;
}

export interface LidarrArtistOptions {
  foreignArtistId: string;
  artistName: string;
  qualityProfileId: number;
  metadataProfileId: number;
  rootFolderPath: string;
  monitored?: boolean;
  monitorNewItems: LidarrMonitor;
  // which of the artist's albums Lidarr monitors when it adds the artist
  monitor: LidarrAddMonitor;
  // release-group ids of the albums to monitor beside those of `monitor`
  albumsToMonitor?: string[];
  searchForMissingAlbums?: boolean;
}

export interface LidarrArtistChanges {
  monitored?: boolean;
  monitorNewItems?: LidarrMonitor;
}

// a command of Lidarr's queue (GET /command): its name, its status (queued,
// started, completed, failed, ...) and the body it was queued with, which names
// the artist a command works on by artistId or artistIds
export interface LidarrCommand {
  id: number;
  name: string;
  status: string;
  body: {
    artistId?: number;
    artistIds?: number[];
  } & Record<string, unknown>;
}

class LidarrAPI extends ServarrBase<{ albumId: number }> {
  constructor({
    url,
    apiKey,
    timeout,
  }: {
    url: string;
    apiKey: string;
    timeout?: number;
  }) {
    super({ url, apiKey, cacheName: 'lidarr', apiName: 'Lidarr' });

    if (timeout !== undefined) {
      this.axios.defaults.timeout = timeout;
    }
  }

  public async getMetadataProfiles(): Promise<MetadataProfile[]> {
    try {
      const data = await this.getRolling<MetadataProfile[]>(
        '/metadataprofile',
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[Lidarr] Failed to retrieve metadata profiles: ${e.message}`,
        { cause: e }
      );
    }
  }

  // one saved metadata profile, read afresh from Lidarr (not cached: the send
  // reads what the server holds now) with the types and statuses it allows
  public async getMetadataProfile(id: number): Promise<MetadataProfile> {
    try {
      const response =
        await this.axios.get<MetadataProfile[]>('/metadataprofile');
      const profile = response.data.find((p) => p.id === id);

      if (!profile) {
        throw new Error(`no metadata profile ${id}`);
      }

      return profile;
    } catch (e) {
      throw new Error(
        `[Lidarr] Failed to retrieve metadata profile: ${e.message}`,
        { cause: e }
      );
    }
  }

  public async lookupArtists(term: string): Promise<LidarrArtist[]> {
    try {
      const response = await this.axios.get<LidarrArtist[]>('/artist/lookup', {
        params: { term },
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to look up artists: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async lookupArtistByMbid(mbid: string): Promise<LidarrArtist | null> {
    const artists = await this.lookupArtists(`lidarr:${mbid}`);

    return artists[0] ?? null;
  }

  public async lookupAlbums(term: string): Promise<LidarrAlbum[]> {
    try {
      const response = await this.axios.get<LidarrAlbum[]>('/album/lookup', {
        params: { term },
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to look up albums: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async lookupAlbumByMbid(mbid: string): Promise<LidarrAlbum | null> {
    const albums = await this.lookupAlbums(`lidarr:${mbid}`);

    return albums[0] ?? null;
  }

  public async getArtists(): Promise<LidarrArtist[]> {
    try {
      const response = await this.axios.get<LidarrArtist[]>('/artist');

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to retrieve artists: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getArtist(id: number): Promise<LidarrArtist> {
    try {
      const response = await this.axios.get<LidarrArtist>(`/artist/${id}`);

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to retrieve artist: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getArtistByMbid(mbid: string): Promise<LidarrArtist | null> {
    const artists = await this.getArtists();

    return artists.find((artist) => artist.foreignArtistId === mbid) ?? null;
  }

  public async getAlbums({ artistId }: { artistId?: number } = {}): Promise<
    LidarrAlbum[]
  > {
    try {
      const response = await this.axios.get<LidarrAlbum[]>('/album', {
        params: artistId !== undefined ? { artistId } : undefined,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to retrieve albums: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async getTracks(albumId: number): Promise<LidarrTrack[]> {
    try {
      const response = await this.axios.get<LidarrTrack[]>('/track', {
        params: { albumId },
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to retrieve tracks: ${e.message}`, {
        cause: e,
      });
    }
  }

  // One album's history, every event type (GET /history/artist with the
  // artist's and the album's Lidarr ids).
  public async getAlbumHistory(
    artistId: number,
    albumId: number
  ): Promise<LidarrHistoryEvent[]> {
    try {
      const response = await this.axios.get<LidarrHistoryEvent[]>(
        '/history/artist',
        { params: { artistId, albumId } }
      );

      return response.data;
    } catch (e) {
      throw new Error(
        `[Lidarr] Failed to retrieve the history of an album: ${e.message}`,
        { cause: e }
      );
    }
  }

  // One page (1-based) of Lidarr's imports of track files, the latest first
  // (GET /history, trackFileImported only, by date descending).
  public async getImportHistory(
    page: number,
    pageSize: number
  ): Promise<LidarrHistoryPage> {
    try {
      const response = await this.axios.get<LidarrHistoryPage>('/history', {
        params: {
          page,
          pageSize,
          sortKey: 'date',
          sortDirection: 'descending',
          // Lidarr's EntityHistoryEventType.TrackFileImported
          eventType: 3,
        },
      });

      return response.data;
    } catch (e) {
      throw new Error(
        `[Lidarr] Failed to retrieve the import history: ${e.message}`,
        { cause: e }
      );
    }
  }

  // The track files of the given albums (Lidarr's ids), asked 50 albums at a
  // time; a batch failing fails the read.
  public async getTrackFiles(albumIds: number[]): Promise<LidarrTrackFile[]> {
    const files: LidarrTrackFile[] = [];

    try {
      for (let i = 0; i < albumIds.length; i += TRACK_FILE_BATCH) {
        const response = await this.axios.get<LidarrTrackFile[]>('/trackfile', {
          params: { albumId: albumIds.slice(i, i + TRACK_FILE_BATCH) },
          // albumId=1&albumId=2, as Lidarr reads a list
          paramsSerializer: { indexes: null },
        });

        files.push(...response.data);
      }

      return files;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to retrieve track files: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async addArtist(options: LidarrArtistOptions): Promise<LidarrArtist> {
    try {
      const response = await this.axios.post<LidarrArtist>('/artist', {
        foreignArtistId: options.foreignArtistId,
        artistName: options.artistName,
        qualityProfileId: options.qualityProfileId,
        metadataProfileId: options.metadataProfileId,
        rootFolderPath: options.rootFolderPath,
        monitored: options.monitored ?? true,
        monitorNewItems: options.monitorNewItems,
        addOptions: {
          monitor: options.monitor,
          albumsToMonitor: options.albumsToMonitor ?? [],
          searchForMissingAlbums: options.searchForMissingAlbums ?? false,
        },
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to add artist: ${e.message}`, {
        cause: e,
      });
    }
  }

  // adds an album Lidarr does not list for its artist: POST /album with
  // Lidarr's lookup of the album, monitored, addType 'manual' and no search on
  // add (Lidarr runs none for an album add, D-352): the caller starts AlbumSearch
  public async addAlbumFromLookup(album: LidarrAlbum): Promise<LidarrAlbum> {
    try {
      const response = await this.axios.post<LidarrAlbum>('/album', {
        ...album,
        monitored: true,
        addOptions: { addType: 'manual', searchForNewAlbum: false },
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to add album: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async updateArtist(
    id: number,
    changes: LidarrArtistChanges
  ): Promise<LidarrArtist> {
    try {
      const current = await this.axios.get<LidarrArtist>(`/artist/${id}`);
      const response = await this.axios.put<LidarrArtist>(`/artist/${id}`, {
        ...current.data,
        ...changes,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to update artist: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async monitorAlbums(
    albumIds: number[],
    monitored: boolean
  ): Promise<LidarrAlbum[]> {
    try {
      const response = await this.axios.put<LidarrAlbum[]>('/album/monitor', {
        albumIds,
        monitored,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to monitor albums: ${e.message}`, {
        cause: e,
      });
    }
  }

  // Lidarr's command queue: every command it lists, those finished included
  public async getCommands(): Promise<LidarrCommand[]> {
    try {
      const response = await this.axios.get<LidarrCommand[]>('/command');

      return response.data;
    } catch (e) {
      throw new Error(`[Lidarr] Failed to retrieve commands: ${e.message}`, {
        cause: e,
      });
    }
  }

  // whether a command naming the artist (its refresh among them) is queued or
  // started in Lidarr's queue, other than Lidarr's searches (a command whose
  // name ends in Search: ArtistSearch, AlbumSearch, MissingAlbumSearch and the
  // like), which set no monitoring and are never waited on (D-352)
  public async hasUnfinishedCommand(artistId: number): Promise<boolean> {
    const commands = await this.getCommands();

    return commands.some(
      (command) =>
        (command.status === 'queued' || command.status === 'started') &&
        !command.name.endsWith('Search') &&
        (command.body?.artistId === artistId ||
          (command.body?.artistIds ?? []).includes(artistId))
    );
  }

  public async searchAlbums(albumIds: number[]): Promise<void> {
    await this.runCommand('AlbumSearch', { albumIds });
  }

  public async searchArtist(artistId: number): Promise<void> {
    await this.runCommand('ArtistSearch', { artistId });
  }
}

export default LidarrAPI;
