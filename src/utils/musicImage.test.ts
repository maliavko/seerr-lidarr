import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { loadClient } from './musicTestSupport';

type ImageElement = {
  props: {
    src: string;
    onError?: (event: unknown) => void;
  };
};

type Internals = { H: unknown };
const internals = (React as unknown as Record<string, Internals>)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

// Calls the component the way React does on a render, with the state a
// previous render left: the runner has no DOM to mount it in.
const makeRenderer = (cacheImages = false) => {
  const CachedImage = loadClient<{
    default: (props: Record<string, unknown>) => ImageElement | null;
  }>('components/Common/CachedImage').default;
  let state: unknown;

  return (props: Record<string, unknown>) => {
    const previous = internals.H;
    internals.H = {
      useState: () => [state, (value: unknown) => (state = value)],
      useContext: () => ({ currentSettings: { cacheImages } }),
    };
    try {
      return CachedImage(props);
    } finally {
      internals.H = previous;
    }
  };
};

const PLACEHOLDER = '/images/seerr_poster_not_found.png';

describe("CachedImage's music type", () => {
  it('passes the URL unchanged, even where images are cached', () => {
    const render = makeRenderer(true);
    const element = render({
      type: 'music',
      src: 'https://images.lidarr.audio/a.jpg',
      alt: '',
    });

    assert.equal(element?.props.src, 'https://images.lidarr.audio/a.jpg');
  });

  it('shows the placeholder for an empty src', () => {
    const render = makeRenderer();

    assert.equal(
      render({ type: 'music', src: '', alt: '' })?.props.src,
      PLACEHOLDER
    );
  });

  it('shows the placeholder once the image fails to load, and calls the onError it was given', () => {
    const render = makeRenderer();
    let called = 0;
    const props = {
      type: 'music',
      src: 'https://images.lidarr.audio/gone.jpg',
      alt: '',
      onError: () => called++,
    };

    const first = render(props);
    assert.equal(first?.props.src, 'https://images.lidarr.audio/gone.jpg');
    first?.props.onError?.({});

    assert.equal(called, 1);
    assert.equal(render(props)?.props.src, PLACEHOLDER);
  });

  it('shows another image after one failed', () => {
    const render = makeRenderer();
    const failing = { type: 'music', src: 'https://x/gone.jpg', alt: '' };

    render(failing)?.props.onError?.({});

    assert.equal(
      render({ ...failing, src: 'https://x/other.jpg' })?.props.src,
      'https://x/other.jpg'
    );
  });
});

describe('CachedImage of the other types', () => {
  it('still passes onError through and leaves a tmdb URL to the cache setting', () => {
    const render = makeRenderer(true);
    const onError = () => {};
    const element = render({
      type: 'tmdb',
      src: 'https://image.tmdb.org/t/p/w500/a.jpg',
      alt: '',
      onError,
    });

    assert.equal(element?.props.src, '/imageproxy/tmdb/t/p/w500/a.jpg');
    assert.equal(element?.props.onError, onError);
  });
});
