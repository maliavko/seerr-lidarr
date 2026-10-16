import ExternalAPI from '@server/api/externalapi';
import { getMusicBrainzUserAgent } from '@server/api/musicbrainz';
import cacheManager from '@server/lib/cache';

// Every outside call of the music metadata service gives up after ten
// seconds (D-201).
const REQUEST_TIMEOUT = 10000;

// 24 hours, in seconds
const CACHE_TTL = 86400;

export interface LidarrMetadataImage {
  // 'Poster', 'Fanart', 'Banner', 'Logo' ...
  CoverType: string;
  // a URL on Lidarr's image cache
  Url: string;
  remoteUrl?: string;
}

// Only the fields the music service reads are typed; others pass through.
export interface LidarrMetadataArtist {
  id: string;
  artistname: string;
  overview?: string;
  images?: LidarrMetadataImage[];
}

// Lidarr's metadata service, the keyless server Lidarr's own lookup reads:
// it answers an artist by its MusicBrainz id whether or not Lidarr holds it
// (D-181, D-201).
class LidarrMetadataAPI extends ExternalAPI {
  constructor() {
    super(
      'https://api.lidarr.audio/api/v0.4',
      {},
      {
        nodeCache: cacheManager.getCache('lidarrmetadata').data,
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': getMusicBrainzUserAgent() },
      }
    );
  }

  // An artist by its MusicBrainz id: null where the service does not know the
  // id (a 404, not kept), a stated error on any other failure.
  public async getArtist(mbid: string): Promise<LidarrMetadataArtist | null> {
    try {
      return await this.get<LidarrMetadataArtist>(
        `/artist/${encodeURIComponent(mbid)}`,
        undefined,
        CACHE_TTL
      );
    } catch (e) {
      if (e?.response?.status === 404) {
        return null;
      }

      throw new Error(
        `[Lidarr Metadata] Failed to retrieve artist: ${e.message}`,
        { cause: e }
      );
    }
  }
}

let shared: LidarrMetadataAPI | undefined;

// One client for the whole server.
export const getLidarrMetadata = (): LidarrMetadataAPI => {
  shared ??= new LidarrMetadataAPI();

  return shared;
};

export default LidarrMetadataAPI;
