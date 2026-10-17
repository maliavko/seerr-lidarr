import MusicResultsSlider from '@app/components/Discover/MusicResultsSlider';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Discover.RecentlyAddedMusicSlider',
  {
    title: 'Recently Added',
  }
);

interface RecentlyAddedMusicSliderProps {
  title?: string;
}

const RecentlyAddedMusicSlider = ({ title }: RecentlyAddedMusicSliderProps) => {
  const intl = useIntl();

  return (
    <MusicResultsSlider
      sliderKey="recently-added-music"
      url="/api/v1/music/recentlyadded"
      title={title ?? intl.formatMessage(messages.title)}
    />
  );
};

export default RecentlyAddedMusicSlider;
