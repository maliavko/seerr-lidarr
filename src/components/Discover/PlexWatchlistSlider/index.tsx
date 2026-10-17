import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { isLeftOutByKinds, keepShownKinds } from '@app/utils/sliderKinds';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.PlexWatchlistSlider', {
  plexwatchlist: 'Your Watchlist',
  emptywatchlist:
    'Media added to your <PlexWatchlistSupportLink>Plex Watchlist</PlexWatchlistSupportLink> will appear here.',
});

const PlexWatchlistSlider = () => {
  const intl = useIntl();
  const { user } = useUser();
  const { currentSettings } = useSettings();

  const { data: watchlistItems, error: watchlistError } = useSWR<{
    page: number;
    totalPages: number;
    totalResults: number;
    results: WatchlistItem[];
  }>('/api/v1/discover/watchlist', {
    revalidateOnMount: true,
  });

  // drop the items of kinds not shown (F2-D-211)
  const items = keepShownKinds(
    watchlistItems?.results ?? [],
    currentSettings.kindsShown,
    (item) => item.mediaType
  );

  if (
    (watchlistItems &&
      isLeftOutByKinds(watchlistItems.results.length, items.length)) ||
    (watchlistItems &&
      watchlistItems.results.length === 0 &&
      !user?.settings?.watchlistSyncMovies &&
      !user?.settings?.watchlistSyncTv) ||
    watchlistError
  ) {
    return null;
  }

  return (
    <>
      <div className="slider-header">
        <Link href="/discover/watchlist" className="slider-title">
          <span>{intl.formatMessage(messages.plexwatchlist)}</span>
          <ArrowRightCircleIcon />
        </Link>
      </div>
      <Slider
        sliderKey="watchlist"
        isLoading={!watchlistItems}
        isEmpty={!!watchlistItems && watchlistItems.results.length === 0}
        emptyMessage={intl.formatMessage(messages.emptywatchlist, {
          PlexWatchlistSupportLink: (msg: React.ReactNode) => (
            <a
              href="https://support.plex.tv/articles/universal-watchlist/"
              className="text-white transition duration-300 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              {msg}
            </a>
          ),
        })}
        items={items.map((item) => (
          <TmdbTitleCard
            id={item.tmdbId}
            key={`watchlist-slider-item-${item.ratingKey}`}
            tmdbId={item.tmdbId}
            type={item.mediaType as 'movie' | 'tv'}
            isAddedToWatchlist={true}
          />
        ))}
      />
    </>
  );
};

export default PlexWatchlistSlider;
