import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import { getAppVersion } from '@server/utils/appVersion';

// MusicBrainz answers at most one request a second to one client, and every
// outside call of the music metadata service gives up after ten seconds.
const REQUEST_TIMEOUT = 10000;

// 24 hours, in seconds
const CACHE_TTL = 86400;

// A release-group browse answers at most 100 per page, and an artist's page
// shows what the first three pages hold.
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

export interface MusicBrainzReleaseGroup {
  id: string;
  title: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
}

interface MusicBrainzReleaseGroupPage {
  'release-group-count': number;
  'release-group-offset': number;
  'release-groups': MusicBrainzReleaseGroup[];
}

export interface MusicBrainzTrack {
  id: string;
  // the number as the release gives it ('A1', '7')
  number: string;
  // the position within its medium
  position: number;
  title: string;
  // milliseconds
  length?: number | null;
}

export interface MusicBrainzMedium {
  position: number;
  title?: string;
  format?: string | null;
  tracks?: MusicBrainzTrack[];
}

export interface MusicBrainzRelease {
  id: string;
  title: string;
  status?: string | null;
  media?: MusicBrainzMedium[];
}

export const getMusicBrainzUserAgent = (): string =>
  `Seerr/${getAppVersion()} ( https://github.com/seerr-team/seerr )`;

class MusicBrainzAPI extends ExternalAPI {
  constructor() {
    super(
      'https://musicbrainz.org/ws/2',
      { fmt: 'json' },
      {
        nodeCache: cacheManager.getCache('musicbrainz').data,
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': getMusicBrainzUserAgent() },
        // across concurrent requests: the limiter queues the second call
        rateLimit: { maxRequests: 1, maxRPS: 1 },
      }
    );
  }

  // The studio albums of an artist: release groups of primary type Album with
  // no secondary type, ordered by first release date, undated last.
  public async getArtistAlbums(
    artistMbid: string
  ): Promise<MusicBrainzReleaseGroup[]> {
    try {
      const groups: MusicBrainzReleaseGroup[] = [];

      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE_SIZE;
        const data = await this.get<MusicBrainzReleaseGroupPage>(
          '/release-group',
          {
            params: {
              artist: artistMbid,
              type: 'album',
              limit: PAGE_SIZE,
              offset,
            },
          },
          CACHE_TTL
        );
        const found = data['release-groups'] ?? [];

        groups.push(...found);

        if (
          found.length < PAGE_SIZE ||
          offset + found.length >= (data['release-group-count'] ?? 0)
        ) {
          break;
        }
      }

      return (
        groups
          .filter(
            (group) =>
              group['primary-type'] === 'Album' &&
              (group['secondary-types'] ?? []).length === 0
          )
          // a stable sort: release groups of one date keep MusicBrainz's order
          .sort((a, b) => {
            const dateA = a['first-release-date'] ?? '';
            const dateB = b['first-release-date'] ?? '';

            if (dateA === dateB) {
              return 0;
            }
            if (dateA === '') {
              return 1;
            }
            if (dateB === '') {
              return -1;
            }
            return dateA < dateB ? -1 : 1;
          })
      );
    } catch (e) {
      throw new Error(
        `[MusicBrainz] Failed to retrieve release groups: ${e.message}`,
        { cause: e }
      );
    }
  }

  // One release with the tracks of its media.
  public async getRelease(releaseMbid: string): Promise<MusicBrainzRelease> {
    try {
      return await this.get<MusicBrainzRelease>(
        `/release/${releaseMbid}`,
        { params: { inc: 'recordings' } },
        CACHE_TTL
      );
    } catch (e) {
      throw new Error(
        `[MusicBrainz] Failed to retrieve release: ${e.message}`,
        {
          cause: e,
        }
      );
    }
  }
}

let shared: MusicBrainzAPI | undefined;

// One client for the whole server, so that its rate limit holds across
// everything that reads MusicBrainz.
export const getMusicBrainz = (): MusicBrainzAPI => {
  shared ??= new MusicBrainzAPI();

  return shared;
};

export default MusicBrainzAPI;
