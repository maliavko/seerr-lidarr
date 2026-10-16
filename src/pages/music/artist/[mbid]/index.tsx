import type { MusicArtistDetails as MusicArtistDetailsType } from '@app/components/ArtistDetails';
import ArtistDetails from '@app/components/ArtistDetails';
import { getHostAndPort } from '@app/utils/urlHelper';
import axios from 'axios';
import type { GetServerSideProps, NextPage } from 'next';

interface MusicArtistPageProps {
  artist?: MusicArtistDetailsType;
  statusCode?: number;
}

const MusicArtistPage: NextPage<MusicArtistPageProps> = ({
  artist,
  statusCode,
}) => {
  return <ArtistDetails artist={artist} statusCode={statusCode} />;
};

export const getServerSideProps: GetServerSideProps<
  MusicArtistPageProps
> = async (ctx) => {
  try {
    const response = await axios.get<MusicArtistDetailsType>(
      `http://${getHostAndPort()}/api/v1/music/artist/${ctx.query.mbid}`,
      {
        headers: ctx.req?.headers?.cookie
          ? { cookie: ctx.req.headers.cookie }
          : undefined,
      }
    );

    return {
      props: {
        artist: response.data,
      },
    };
  } catch (e) {
    // an unknown id, or a source that fails: the page says so
    return {
      props: {
        statusCode: axios.isAxiosError(e) ? (e.response?.status ?? 500) : 500,
      },
    };
  }
};

export default MusicArtistPage;
