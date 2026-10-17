import AlbumCard from '@app/components/MusicCard/AlbumCard';
import ArtistCard from '@app/components/MusicCard/ArtistCard';
import Slider from '@app/components/Slider';
import { albumCardProps, artistCardProps } from '@app/utils/musicHelpers';
import type { MusicResults } from '@server/models/Search';
import useSWR from 'swr';

interface MusicResultsSliderProps {
  sliderKey: string;
  url: string;
  title?: string;
}

// A slider of music cards (F2-D-93) read from one of the music routes: each
// result is search's album or artist card; an answer with no item, or a read
// that failed, shows the Slider's empty state.
const MusicResultsSlider = ({
  sliderKey,
  url,
  title,
}: MusicResultsSliderProps) => {
  const { data, error } = useSWR<{ results: MusicResults[] }>(url, {
    revalidateOnMount: true,
  });
  const results = data?.results ?? [];

  return (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>{title}</span>
        </div>
      </div>
      <Slider
        sliderKey={sliderKey}
        isLoading={!data && !error}
        isEmpty={!!error || (!!data && results.length === 0)}
        items={results.map((item) =>
          item.mediaType === 'album' ? (
            <AlbumCard
              key={`${sliderKey}-album-${item.id}`}
              {...albumCardProps(item)}
            />
          ) : (
            <ArtistCard
              key={`${sliderKey}-artist-${item.id}`}
              {...artistCardProps(item)}
            />
          )
        )}
      />
    </>
  );
};

export default MusicResultsSlider;
