import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { isLeftOutByKinds, keepShownKinds } from '@app/utils/sliderKinds';
import type { MediaResultsResponse } from '@server/interfaces/api/mediaInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.RecentlyAddedSlider', {
  recentlyAdded: 'Recently Added',
});

const RecentlyAddedSlider = () => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { currentSettings } = useSettings();
  const { data: media, error: mediaError } = useSWR<MediaResultsResponse>(
    '/api/v1/media?filter=allavailable&take=20&sort=mediaAdded',
    { revalidateOnMount: true }
  );

  // drop the items of kinds not shown (F2-D-211)
  const results = keepShownKinds(
    media?.results ?? [],
    currentSettings.kindsShown,
    (item) => item.mediaType
  );

  if (
    (media && !media.results.length && !mediaError) ||
    (media && isLeftOutByKinds(media.results.length, results.length)) ||
    !hasPermission([Permission.MANAGE_REQUESTS, Permission.RECENT_VIEW], {
      type: 'or',
    })
  ) {
    return null;
  }

  return (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>{intl.formatMessage(messages.recentlyAdded)}</span>
        </div>
      </div>
      <Slider
        sliderKey="media"
        isLoading={!media}
        items={results.map((item) => (
          <TmdbTitleCard
            key={`media-slider-item-${item.id}`}
            id={item.id}
            tmdbId={item.tmdbId}
            tvdbId={item.tvdbId}
            type={item.mediaType as 'movie' | 'tv'}
          />
        ))}
      />
    </>
  );
};

export default RecentlyAddedSlider;
