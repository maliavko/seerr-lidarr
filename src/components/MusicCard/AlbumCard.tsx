import { MusicCard } from '@app/components/MusicCard';
import type { MediaStatus } from '@server/constants/media';

interface AlbumCardProps {
  // the album's MusicBrainz release-group id
  id: string;
  title: string;
  // the album's artist's name, where known
  artistName?: string;
  releaseDate?: string;
  image?: string;
  status?: MediaStatus;
  canExpand?: boolean;
}

const AlbumCard = ({
  id,
  title,
  artistName,
  releaseDate,
  image,
  status,
  canExpand,
}: AlbumCardProps) => (
  <MusicCard
    kind="album"
    id={id}
    title={title}
    artistName={artistName}
    releaseDate={releaseDate}
    image={image}
    status={status}
    canExpand={canExpand}
  />
);

export default AlbumCard;
