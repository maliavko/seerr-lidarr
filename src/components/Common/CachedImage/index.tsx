import useSettings from '@app/hooks/useSettings';
import type { ImageLoader, ImageProps } from 'next/image';
import Image from 'next/image';
import { useState } from 'react';

const imageLoader: ImageLoader = ({ src }) => src;

export type CachedImageProps = ImageProps & {
  src: string;
  type: 'tmdb' | 'avatar' | 'tvdb' | 'music';
};

export const MUSIC_PLACEHOLDER = '/images/seerr_poster_not_found.png';

/**
 * The CachedImage component should be used wherever
 * we want to offer the option to locally cache images.
 * Type 'music' passes the URL unchanged and shows a placeholder where the
 * src is empty or the image fails to load.
 **/
const CachedImage = ({ src, type, onError, ...props }: CachedImageProps) => {
  const { currentSettings } = useSettings();
  // the URLs of music images that failed to load
  const [failedSrc, setFailedSrc] = useState<string>();

  let imageUrl: string;

  if (type === 'music') {
    // music images are Lidarr's http(s) URLs, passed unchanged; a missing or
    // failing one shows the placeholder
    imageUrl = !src || src === failedSrc ? MUSIC_PLACEHOLDER : src;

    return (
      <Image
        unoptimized
        loader={imageLoader}
        src={imageUrl}
        onError={(e) => {
          if (src && imageUrl !== MUSIC_PLACEHOLDER) {
            setFailedSrc(src);
          }
          onError?.(e);
        }}
        {...props}
      />
    );
  }

  if (type === 'tmdb') {
    // tmdb stuff
    imageUrl =
      currentSettings.cacheImages && !src.startsWith('/')
        ? src.replace(/^https:\/\/image\.tmdb\.org\//, '/imageproxy/tmdb/')
        : src;
  } else if (type === 'tvdb') {
    imageUrl =
      currentSettings.cacheImages && !src.startsWith('/')
        ? src.replace(
            /^https:\/\/artworks\.thetvdb\.com\//,
            '/imageproxy/tvdb/'
          )
        : src;
  } else if (type === 'avatar') {
    // jellyfin avatar (if any)
    imageUrl = src;
  } else {
    return null;
  }

  return (
    <Image
      unoptimized
      loader={imageLoader}
      src={imageUrl}
      onError={onError}
      {...props}
    />
  );
};

export default CachedImage;
