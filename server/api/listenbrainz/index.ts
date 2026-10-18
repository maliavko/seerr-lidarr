import ExternalAPI from '@server/api/externalapi';
import { getMusicBrainzUserAgent } from '@server/api/musicbrainz';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';

// Every outside call of the ListenBrainz client gives up after five seconds
// (F2-D-291).
const REQUEST_TIMEOUT = 5000;

// 24 hours, in seconds: the call's ttl and the 'listenbrainz' cache's stdTtl
// alike (F2-D-291).
const CACHE_TTL = 86400;

const SIMILAR_ARTISTS_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

const SIMILAR_ARTISTS_URL =
  'https://labs.api.listenbrainz.org/similar-artists/json';

export interface ListenBrainzSimilarArtist {
  // the artist's MusicBrainz id
  mbid: string;
  name: string;
  // ListenBrainz's own score, 0 where the entry gives none
  score: number;
}

interface SimilarArtistEntry {
  artist_mbid?: string | null;
  name?: string | null;
  score?: number | null;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

// an entry's score as a number, 0 where it gives none
const scoreOf = (entry: SimilarArtistEntry): number => {
  const score = Number(entry.score);

  return Number.isFinite(score) ? score : 0;
};

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

// The cause of a failed read, read from the error (F2-D-292): an axios
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

// ListenBrainz, keyless: the artists similar to an artist. Any failure, timeout
// or answer Seerr cannot read is logged and answers an empty list, never an
// error (F2-D-282, F2-D-291, F2-D-292).
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

  // The artists similar to an artist, by score descending (ties in the answer's
  // order), every entry left (up to the 100 the algorithm gives), never the
  // artist itself and none without an id or a name.
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
          (a, b) => scoreOf(b.entry) - scoreOf(a.entry) || a.index - b.index
        )
        .map(({ entry }) => ({
          mbid: entry.artist_mbid as string,
          name: entry.name as string,
          score: scoreOf(entry),
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
