import ArtistCard from '@app/components/MusicCard/ArtistCard';
import Slider from '@app/components/Slider';
import defineMessages from '@app/utils/defineMessages';
import { artistCardProps } from '@app/utils/musicHelpers';
import type { ArtistResult } from '@server/models/Search';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.SimilarArtistsSlider', {
  title: 'Similar Artists',
});

interface SimilarArtistsSliderProps {
  // the artist's MusicBrainz id
  mbid: string;
  title?: string;
}

// The artist page's Similar Artists slider (F2-R-14, F2-D-93): read in its own
// fetch, and left out while it loads, on an error and on an empty answer.
const SimilarArtistsSlider = ({ mbid, title }: SimilarArtistsSliderProps) => {
  const intl = useIntl();
  const { data, error } = useSWR<{ results: ArtistResult[] }>(
    `/api/v1/music/artist/${mbid}/similar`
  );

  if (error || !data || data.results.length === 0) {
    return null;
  }

  return (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>{title ?? intl.formatMessage(messages.title)}</span>
        </div>
      </div>
      <Slider
        sliderKey="similar-artists"
        isLoading={false}
        items={data.results.map((artist) => (
          <ArtistCard
            key={`similar-artist-${artist.id}`}
            {...artistCardProps(artist)}
          />
        ))}
      />
    </>
  );
};

export default SimilarArtistsSlider;
