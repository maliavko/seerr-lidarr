import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import PopularAlbumsSlider from '@app/components/Discover/PopularAlbumsSlider';
import RecentlyAddedMusicSlider from '@app/components/Discover/RecentlyAddedMusicSlider';
import RecentMusicRequestsSlider from '@app/components/Discover/RecentMusicRequestsSlider';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import type { NextPage } from 'next';
import { useIntl } from 'react-intl';

const messages = defineMessages('pages.discover.music', {
  discovermusic: 'Discover Music',
  notsetup:
    'Music is not set up. Add a Lidarr server and mark it as default in Settings > Services to discover music.',
});

// The Discover Music page (F2-R-2, F2-D-93): the three sliders in this order
// while music is shown; otherwise a notice, no slider and so no fetch.
const DiscoverMusicPage: NextPage = () => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const musicShown = currentSettings.kindsShown.includes('music');

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.discovermusic)} />
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages.discovermusic)}</Header>
      </div>
      {musicShown ? (
        <>
          <RecentlyAddedMusicSlider />
          <RecentMusicRequestsSlider />
          <PopularAlbumsSlider />
        </>
      ) : (
        <div
          className="mt-16 text-center font-medium text-gray-400"
          data-testid="discover-music-notice"
        >
          {intl.formatMessage(messages.notsetup)}
        </div>
      )}
    </>
  );
};

export default DiscoverMusicPage;
