import { MusicCard } from '@app/components/MusicCard';
import type { MediaStatus } from '@server/constants/media';

interface ArtistCardProps {
  // the artist's MusicBrainz id
  id: string;
  name: string;
  image?: string;
  status?: MediaStatus;
  canExpand?: boolean;
}

const ArtistCard = ({
  id,
  name,
  image,
  status,
  canExpand,
}: ArtistCardProps) => (
  <MusicCard
    kind="artist"
    id={id}
    title={name}
    image={image}
    status={status}
    canExpand={canExpand}
  />
);

export default ArtistCard;
