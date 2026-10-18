import MusicResultsSlider from '@app/components/Discover/MusicResultsSlider';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.SimilarToLibrarySlider', {
  title: 'Similar to Your Library',
});

interface SimilarToLibrarySliderProps {
  title?: string;
}

// Similar to Your Library (F2-D-294): the artists ListenBrainz gives as similar
// to those the default Lidarr holds, read from the server's route.
const SimilarToLibrarySlider = ({ title }: SimilarToLibrarySliderProps) => {
  const intl = useIntl();

  return (
    <MusicResultsSlider
      sliderKey="similar-to-library"
      url="/api/v1/music/library/similar"
      title={title ?? intl.formatMessage(messages.title)}
    />
  );
};

export default SimilarToLibrarySlider;
