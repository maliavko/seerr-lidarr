import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import {
  isEndByPageCount,
  newLoadMark,
  searchLoadStep,
} from '@app/utils/searchLoading';
import { MediaStatus } from '@server/constants/media';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import useSWRInfinite from 'swr/infinite';
import useSettings from './useSettings';
import { Permission, useUser } from './useUser';

export interface BaseSearchResult<T> {
  page: number;
  totalResults: number;
  totalPages: number;
  results: T[];
}

interface BaseMedia {
  // a TMDB id, or a MusicBrainz id for music
  id: number | string;
  mediaType: string;
  mediaInfo?: {
    status: MediaStatus;
    hasActiveRequest?: boolean;
  };
}

interface DiscoverResult<T, S> {
  isLoadingInitialData: boolean;
  isLoadingMore: boolean;
  fetchMore: () => void;
  isEmpty: boolean;
  isReachingEnd: boolean;
  error: unknown;
  titles: T[];
  firstResultData?: BaseSearchResult<T> & S;
  mutate?: () => void;
}

const extraEncodes: [RegExp, string][] = [
  [/\(/g, '%28'],
  [/\)/g, '%29'],
  [/!/g, '%21'],
  [/\*/g, '%2A'],
];

export const encodeURIExtraParams = (string: string): string => {
  let finalString = encodeURIComponent(string);

  extraEncodes.forEach((encode) => {
    finalString = finalString.replace(encode[0], encode[1]);
  });

  return finalString;
};

const useDiscover = <
  T extends BaseMedia,
  S = Record<string, never>,
  O = Record<string, unknown>,
>(
  endpoint: string,
  options?: O,
  {
    hideAvailable = true,
    hideBlocklisted = true,
    hideRequested = true,
    // The search page only (F2-D-71): the end of results is the last page by
    // the page count, and a run that has added fewer than 20 titles is
    // followed by the next page at once.
    endByPageCount = false,
  } = {}
): DiscoverResult<T, S> => {
  const settings = useSettings();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const intl = useIntl();
  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<
    BaseSearchResult<T> & S
  >(
    (pageIndex: number, previousPageData) => {
      if (previousPageData && pageIndex + 1 > previousPageData.totalPages) {
        return null;
      }

      const params: Record<string, unknown> = {
        page: pageIndex + 1,
        ...options,
      };

      const finalQueryString = Object.keys(params)
        .map(
          (paramKey) =>
            `${paramKey}=${encodeURIExtraParams(params[paramKey] as string)}`
        )
        .join('&');

      return `${endpoint}?${finalQueryString}`;
    },
    {
      initialSize: 3,
      revalidateFirstPage: false,
      dedupingInterval: 30000,
      revalidateOnFocus: false,
    }
  );

  const resultIds: Set<number | string> = new Set<number | string>();

  const isLoadingInitialData = !data && !error;
  const isLoadingMore =
    isLoadingInitialData ||
    (size > 0 &&
      !!data &&
      typeof data[size - 1] === 'undefined' &&
      isValidating);

  const fetchMore = () => {
    setSize(size + 1);
  };

  let titles = (data ?? []).reduce((a, v) => {
    const results: T[] = [];

    for (const result of v.results) {
      if (!resultIds.has(result.id)) {
        resultIds.add(result.id);
        results.push(result);
      }
    }

    return [...a, ...results];
  }, [] as T[]);

  if (settings.currentSettings.hideAvailable && hideAvailable) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        (i.mediaInfo?.status !== MediaStatus.AVAILABLE &&
          i.mediaInfo?.status !== MediaStatus.PARTIALLY_AVAILABLE)
    );
  }

  if (
    settings.currentSettings.hideBlocklisted &&
    hideBlocklisted &&
    hasPermission(Permission.MANAGE_BLOCKLIST)
  ) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        i.mediaInfo?.status !== MediaStatus.BLOCKLISTED
    );
  }

  if (settings.currentSettings.hideRequested && hideRequested) {
    titles = titles.filter((i) => {
      if (i.mediaType !== 'movie' && i.mediaType !== 'tv') {
        return true;
      }

      return !i.mediaInfo?.hasActiveRequest;
    });
  }

  const reachedLastPage = endByPageCount && isEndByPageCount(data);
  const isEmpty = endByPageCount
    ? !isLoadingInitialData && reachedLastPage && titles.length === 0
    : !isLoadingInitialData && titles?.length === 0;
  const isReachingEnd = endByPageCount
    ? reachedLastPage
    : isEmpty ||
      (!!data && (data[data?.length - 1]?.results.length ?? 0) < 20) ||
      (!!data && (data[data?.length - 1]?.totalResults ?? 0) <= size * 20) ||
      (!!data && (data[data?.length - 1]?.totalResults ?? 0) < 41);

  // The load-on's bookkeeping is the pure step in src/utils (F2-D-71): the
  // effect keeps the mark it answers and sets the size it answers.
  const loadMark = useRef(newLoadMark());
  const listKey = JSON.stringify([endpoint, options]);

  useEffect(() => {
    if (!endByPageCount) {
      return;
    }

    const answer = searchLoadStep({
      key: listKey,
      size,
      pages: data,
      titles: titles.length,
      outstanding:
        !!error ||
        !data ||
        isValidating ||
        data.length < size ||
        !data.every((page) => !!page),
      mark: loadMark.current,
    });

    loadMark.current = answer.mark;

    if (answer.size !== undefined) {
      setSize(answer.size);
    }
  });

  useEffect(() => {
    if (error && titles.length) {
      addToast(intl.formatMessage(globalMessages.error), {
        appearance: 'error',
        autoDismiss: true,
      });
      console.error('Error while fetching discover titles:', error);
    }
  }, [data, error, addToast, intl, titles.length]);

  return {
    isLoadingInitialData,
    isLoadingMore,
    fetchMore,
    isEmpty,
    isReachingEnd,
    error: error && titles.length ? null : error,
    titles,
    firstResultData: data?.[0],
    mutate,
  };
};

export default useDiscover;
