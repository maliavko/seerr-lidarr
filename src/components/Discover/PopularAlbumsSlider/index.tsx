import MusicResultsSlider from '@app/components/Discover/MusicResultsSlider';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.PopularAlbumsSlider', {
  title: 'Popular Albums',
});

interface PopularAlbumsSliderProps {
  title?: string;
}

const PopularAlbumsSlider = ({ title }: PopularAlbumsSliderProps) => {
  const intl = useIntl();

  return (
    <MusicResultsSlider
      sliderKey="popular-albums"
      url="/api/v1/music/popular"
      title={title ?? intl.formatMessage(messages.title)}
    />
  );
};

export default PopularAlbumsSlider;
