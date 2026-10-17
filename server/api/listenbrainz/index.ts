import ExternalAPI from '@server/api/externalapi';
import { getMusicBrainzUserAgent } from '@server/api/musicbrainz';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';

// Every outside call of the ListenBrainz client gives up after five seconds
// (F2-D-91).
const REQUEST_TIMEOUT = 5000;

// 6 hours, in seconds
const CACHE_TTL = 21600;

// The most a slider shows.
const RESULT_LIMIT = 20;

// The site-wide statistics repeat a release group under several releases and
// carry entries without a release-group id, so more than the limit are asked.
const STATS_COUNT = 100;

const SIMILAR_ARTISTS_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

const SIMILAR_ARTISTS_URL =
  'https://labs.api.listenbrainz.org/similar-artists/json';

export interface ListenBrainzPopularAlbum {
  // the release group's MusicBrainz id
  mbid: string;
  title: string;
  artistMbid?: string;
  artistName?: string;
  coverUrl: string;
}

export interface ListenBrainzSimilarArtist {
  // the artist's MusicBrainz id
  mbid: string;
  name: string;
}

// Only the fields the client reads are typed.
interface SitewideReleaseGroup {
  release_group_mbid?: string | null;
  release_group_name?: string | null;
  artist_name?: string | null;
  artist_mbids?: string[] | null;
  caa_id?: number | null;
  caa_release_mbid?: string | null;
}

interface SitewideReleaseGroupsResponse {
  payload: { release_groups: SitewideReleaseGroup[] };
}

interface SimilarArtistEntry {
  artist_mbid?: string | null;
  name?: string | null;
  score?: number | null;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const coverArtUrl = (entry: SitewideReleaseGroup, mbid: string): string =>
  entry.caa_id && isNonEmptyString(entry.caa_release_mbid)
    ? `https://coverartarchive.org/release/${entry.caa_release_mbid}/${entry.caa_id}-250.jpg`
    : `https://coverartarchive.org/release-group/${mbid}/front-250`;

// An answer ListenBrainz gave that is not of the shape the client reads.
class UnreadableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableAnswerError';
  }
}

export interface FailureCause {
  // never empty
  cause: string;
  status?: number;
  code?: string;
}

const TIMEOUT_CODES = ['ECONNABORTED', 'ETIMEDOUT'];

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null | undefined)?.code;

  return isNonEmptyString(code) ? code : undefined;
};

// The codes of the errors an AggregateError or a cause beneath an error holds.
const nestedCodes = (error: unknown, depth = 0): string[] => {
  if (depth > 3 || typeof error !== 'object' || error === null) {
    return [];
  }

  const { errors, cause } = error as { errors?: unknown; cause?: unknown };
  const found: string[] = [];

  for (const inner of Array.isArray(errors) ? errors : []) {
    const code = codeOf(inner);
    found.push(...(code ? [code] : nestedCodes(inner, depth + 1)));
  }

  if (cause !== undefined) {
    const code = codeOf(cause);
    found.push(...(code ? [code] : nestedCodes(cause, depth + 1)));
  }

  return [...new Set(found)];
};

// The cause of a failed read, read from the error (F2-D-141): an axios
// connection failure on Node 22 has an empty message, its cause in its code.
export const readFailureCause = (error: unknown): FailureCause => {
  if (error instanceof UnreadableAnswerError) {
    return { cause: `unreadable answer: ${error.message}` };
  }

  const status = (error as { response?: { status?: unknown } } | null)?.response
    ?.status;

  if (typeof status === 'number') {
    const statusText = (error as { response: { statusText?: unknown } })
      .response.statusText;

    return {
      cause: `HTTP ${status}${isNonEmptyString(statusText) ? ` ${statusText}` : ''}`,
      status,
    };
  }

  const code = codeOf(error);

  if (code && TIMEOUT_CODES.includes(code)) {
    return { cause: `timeout (${code})`, code };
  }

  if (code) {
    return { cause: `network error ${code}`, code };
  }

  const codes = nestedCodes(error);

  if (codes.length > 0) {
    const joined = codes.join(', ');

    return { cause: `network error ${joined}`, code: joined };
  }

  const name = isNonEmptyString((error as { name?: unknown } | null)?.name)
    ? (error as { name: string }).name
    : 'Error';
  const message = (error as { message?: unknown } | null)?.message;

  return {
    cause: isNonEmptyString(message) ? `${name}: ${message}` : name,
  };
};

// ListenBrainz, keyless: the popular albums of its latest month and the artists
// similar to an artist. Any failure, timeout or answer Seerr cannot read is
// logged and answers an empty list, never an error (F2-D-5, F2-D-91).
class ListenBrainzAPI extends ExternalAPI {
  constructor() {
    super(
      'https://api.listenbrainz.org/1',
      {},
      {
        nodeCache: cacheManager.getCache('listenbrainz').data,
        timeout: REQUEST_TIMEOUT,
        headers: { 'User-Agent': getMusicBrainzUserAgent() },
      }
    );
  }

  // The albums most listened to site-wide over the latest month, most listened
  // first: at most 20, each release group once.
  public async getPopularAlbums(): Promise<ListenBrainzPopularAlbum[]> {
    try {
      const response = await this.get<SitewideReleaseGroupsResponse>(
        '/stats/sitewide/release-groups',
        { params: { range: 'month', count: STATS_COUNT } },
        CACHE_TTL,
        {
          // an answer not of the shape is never kept
          transform: (data) => {
            if (!Array.isArray(data?.payload?.release_groups)) {
              throw new UnreadableAnswerError(
                'the answer holds no list of release groups'
              );
            }

            return data;
          },
        }
      );
      const entries = response.payload.release_groups;

      const seen = new Set<string>();
      const albums: ListenBrainzPopularAlbum[] = [];

      for (const entry of entries) {
        const mbid = entry?.release_group_mbid;

        if (!isNonEmptyString(mbid) || seen.has(mbid)) {
          continue;
        }

        if (!isNonEmptyString(entry.release_group_name)) {
          continue;
        }

        seen.add(mbid);

        const [artistMbid] = Array.isArray(entry.artist_mbids)
          ? entry.artist_mbids
          : [];

        albums.push({
          mbid,
          title: entry.release_group_name,
          artistMbid: isNonEmptyString(artistMbid) ? artistMbid : undefined,
          artistName: isNonEmptyString(entry.artist_name)
            ? entry.artist_name
            : undefined,
          coverUrl: coverArtUrl(entry, mbid),
        });

        if (albums.length === RESULT_LIMIT) {
          break;
        }
      }

      return albums;
    } catch (e) {
      logger.error('Failed to read the popular albums from ListenBrainz', {
        label: 'ListenBrainz',
        errorMessage: e.message,
        ...readFailureCause(e),
      });

      return [];
    }
  }

  // The artists similar to an artist, most similar first: at most 20, never the
  // artist itself.
  public async getSimilarArtists(
    mbid: string
  ): Promise<ListenBrainzSimilarArtist[]> {
    try {
      const entries = await this.get<SimilarArtistEntry[]>(
        SIMILAR_ARTISTS_URL,
        {
          params: {
            artist_mbids: mbid,
            algorithm: SIMILAR_ARTISTS_ALGORITHM,
          },
        },
        CACHE_TTL,
        {
          transform: (data) => {
            if (!Array.isArray(data)) {
              throw new UnreadableAnswerError('the answer is not a list');
            }

            return data;
          },
        }
      );

      return entries
        .filter(
          (entry) =>
            isNonEmptyString(entry?.artist_mbid) &&
            entry.artist_mbid !== mbid &&
            isNonEmptyString(entry.name)
        )
        .map((entry, index) => ({ entry, index }))
        .sort(
          (a, b) =>
            (Number(b.entry.score) || 0) - (Number(a.entry.score) || 0) ||
            a.index - b.index
        )
        .slice(0, RESULT_LIMIT)
        .map(({ entry }) => ({
          mbid: entry.artist_mbid as string,
          name: entry.name as string,
        }));
    } catch (e) {
      logger.error('Failed to read the similar artists from ListenBrainz', {
        label: 'ListenBrainz',
        errorMessage: e.message,
        mbid,
        ...readFailureCause(e),
      });

      return [];
    }
  }
}

let shared: ListenBrainzAPI | undefined;

// One client for the whole server.
export const getListenBrainz = (): ListenBrainzAPI => {
  shared ??= new ListenBrainzAPI();

  return shared;
};

export default ListenBrainzAPI;
