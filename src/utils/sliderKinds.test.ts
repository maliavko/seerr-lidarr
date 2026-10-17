import { DiscoverSliderType } from '@server/constants/discover';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getItemKind,
  getSliderKinds,
  isLeftOutByKinds,
  isMediaSliderLeftOut,
  isMenuKindShown,
  isSliderShown,
  keepShownKinds,
} from './sliderKinds';

const T = DiscoverSliderType;

describe('the kinds each slider type declares (F2-D-211)', () => {
  const declared: [DiscoverSliderType, string[]][] = [
    [T.POPULAR_MOVIES, ['movie']],
    [T.MOVIE_GENRES, ['movie']],
    [T.UPCOMING_MOVIES, ['movie']],
    [T.STUDIOS, ['movie']],
    [T.TMDB_MOVIE_KEYWORD, ['movie']],
    [T.TMDB_MOVIE_GENRE, ['movie']],
    [T.TMDB_STUDIO, ['movie']],
    [T.TMDB_MOVIE_STREAMING_SERVICES, ['movie']],
    [T.POPULAR_TV, ['tv']],
    [T.TV_GENRES, ['tv']],
    [T.UPCOMING_TV, ['tv']],
    [T.NETWORKS, ['tv']],
    [T.TMDB_TV_KEYWORD, ['tv']],
    [T.TMDB_TV_GENRE, ['tv']],
    [T.TMDB_NETWORK, ['tv']],
    [T.TMDB_TV_STREAMING_SERVICES, ['tv']],
    [T.RECENTLY_ADDED, ['movie', 'tv']],
    [T.PLEX_WATCHLIST, ['movie', 'tv']],
    [T.RECENT_REQUESTS, ['movie', 'tv', 'music']],
    [T.TRENDING, ['movie', 'tv', 'person']],
    [T.TMDB_SEARCH, ['movie', 'tv', 'music', 'person']],
    [T.RECENTLY_ADDED_MUSIC, ['music']],
    [T.RECENT_MUSIC_REQUESTS, ['music']],
    [T.POPULAR_ALBUMS, ['music']],
  ];

  for (const [type, kinds] of declared) {
    it(`${T[type]} declares ${kinds.join(', ')}`, () => {
      assert.deepEqual([...getSliderKinds(type)].sort(), [...kinds].sort());
    });
  }

  it('covers every slider type there is', () => {
    const types = Object.values(T).filter(
      (v): v is DiscoverSliderType => typeof v === 'number'
    );

    assert.equal(types.length, declared.length);
    for (const type of types) {
      assert.ok(getSliderKinds(type).length > 0, `${T[type]} declares a kind`);
    }
  });

  it('declares nothing for a type it does not know', () => {
    assert.deepEqual(getSliderKinds(999 as DiscoverSliderType), []);
  });
});

describe('whether a slider is rendered on the home page', () => {
  it('is rendered while at least one of its declared kinds is shown', () => {
    assert.equal(isSliderShown(T.POPULAR_MOVIES, ['movie']), true);
    assert.equal(isSliderShown(T.POPULAR_MOVIES, ['tv', 'music']), false);
    assert.equal(isSliderShown(T.POPULAR_TV, ['movie', 'person']), false);
    assert.equal(isSliderShown(T.POPULAR_TV, ['tv']), true);
    assert.equal(isSliderShown(T.POPULAR_ALBUMS, ['movie', 'tv']), false);
    assert.equal(isSliderShown(T.POPULAR_ALBUMS, ['music']), true);
    assert.equal(isSliderShown(T.TRENDING, ['person']), true);
    assert.equal(isSliderShown(T.TRENDING, ['music']), false);
    assert.equal(isSliderShown(T.RECENT_REQUESTS, ['music']), true);
    assert.equal(isSliderShown(T.RECENTLY_ADDED, ['music', 'person']), false);
    assert.equal(isSliderShown(T.TMDB_SEARCH, ['music']), true);
  });

  it('is rendered by no type while no kind is shown, and for no slider of unknown type', () => {
    assert.equal(isSliderShown(T.TRENDING, []), false);
    assert.equal(isSliderShown(T.RECENT_REQUESTS, []), false);
    assert.equal(isSliderShown(undefined, ['movie']), false);
    assert.equal(isSliderShown(999 as DiscoverSliderType, ['movie']), false);
  });
});

describe('the menu items of a kind', () => {
  it('shows an item of a kind only while the kind is shown, and an item of no kind always', () => {
    assert.equal(isMenuKindShown('movie', ['movie', 'person']), true);
    assert.equal(isMenuKindShown('movie', ['tv']), false);
    assert.equal(isMenuKindShown('tv', ['movie']), false);
    assert.equal(isMenuKindShown('tv', ['tv']), true);
    assert.equal(isMenuKindShown('music', ['movie', 'tv', 'person']), false);
    assert.equal(isMenuKindShown('music', ['music']), true);
    assert.equal(isMenuKindShown(undefined, []), true);
  });
});

describe('the kind of an item', () => {
  it('reads movie, tv and person by the media type, an artist or an album as music, a request by its type', () => {
    assert.equal(getItemKind('movie'), 'movie');
    assert.equal(getItemKind('tv'), 'tv');
    assert.equal(getItemKind('person'), 'person');
    assert.equal(getItemKind('artist'), 'music');
    assert.equal(getItemKind('album'), 'music');
    assert.equal(getItemKind('music'), 'music');
    assert.equal(getItemKind('collection'), undefined);
    assert.equal(getItemKind(undefined), undefined);
  });
});

describe('what a mixed slider drops', () => {
  const items = [
    { mediaType: 'movie', n: 1 },
    { mediaType: 'tv', n: 2 },
    { mediaType: 'person', n: 3 },
    { mediaType: 'artist', n: 4 },
    { mediaType: 'album', n: 5 },
    { mediaType: 'collection', n: 6 },
  ];
  const kept = (kindsShown: string[]) =>
    keepShownKinds(items, kindsShown, (i) => i.mediaType).map((i) => i.n);

  it('keeps every item when every kind is shown, in the order given', () => {
    assert.deepEqual(
      kept(['movie', 'tv', 'music', 'person']),
      [1, 2, 3, 4, 5, 6]
    );
  });

  it('drops only the items whose kind is not shown', () => {
    assert.deepEqual(kept(['tv', 'person']), [2, 3, 6]);
    assert.deepEqual(kept(['movie']), [1, 6]);
    assert.deepEqual(kept(['music']), [4, 5, 6]);
    assert.deepEqual(kept([]), [6]);
  });

  it('keeps an item of a shown kind that its slider type does not declare (an artist in Trending)', () => {
    const trending = [
      { mediaType: 'artist', n: 1 },
      { mediaType: 'movie', n: 2 },
    ];

    assert.deepEqual(
      keepShownKinds(trending, ['music'], (i) => i.mediaType).map((i) => i.n),
      [1]
    );
  });
});

describe('when a mixed slider is left out once loaded', () => {
  it('is left out only where its source gave items and every one was dropped', () => {
    assert.equal(isLeftOutByKinds(3, 0), true);
    assert.equal(isLeftOutByKinds(3, 1), false);
    assert.equal(isLeftOutByKinds(3, 3), false);
  });

  it('is not left out where its source gave no item', () => {
    assert.equal(isLeftOutByKinds(0, 0), false);
  });
});

describe('when MediaSlider is left out once loaded (F2-D-211)', () => {
  const all = ['movie', 'tv', 'music', 'person'];
  const onlyMusic = ['music'];
  const noMusic = ['movie', 'tv', 'person'];

  it('is left out with only music shown where artists and albums were answered', () => {
    assert.equal(isMediaSliderLeftOut(['artist', 'album'], onlyMusic), true);
    assert.equal(isMediaSliderLeftOut(['artist'], onlyMusic), true);
    assert.equal(isMediaSliderLeftOut(['album', 'artist'], ['music']), true);
  });

  it('is not left out with every kind shown where only artists and albums were answered', () => {
    assert.equal(isMediaSliderLeftOut(['artist', 'album'], all), false);
  });

  it('is not left out with movie, tv and person shown (no music) where an item of a kind it draws is kept', () => {
    assert.equal(isMediaSliderLeftOut(['artist', 'movie'], noMusic), false);
    assert.equal(
      isMediaSliderLeftOut(['artist', 'album', 'person'], noMusic),
      false
    );
  });

  it('with movie, tv and person shown, an item of no card is dropped as a music one and nothing else leaves it out', () => {
    // artists and albums are of a kind not shown: dropped, none kept
    assert.equal(isMediaSliderLeftOut(['artist', 'album'], noMusic), true);
    // an item of no known kind has none to hide: kept, but no card for it, and
    // nothing was dropped and every card kind is shown
    assert.equal(isMediaSliderLeftOut(['collection'], noMusic), false);
    assert.equal(isMediaSliderLeftOut([undefined, 'collection'], all), false);
    // ... unless a kind it draws is not shown
    assert.equal(isMediaSliderLeftOut(['collection'], ['movie', 'tv']), true);
    assert.equal(isMediaSliderLeftOut([undefined], ['movie', 'tv']), true);
    assert.equal(isMediaSliderLeftOut([undefined], noMusic), false);
  });

  it('is left out where a kind was dropped and only artists are kept', () => {
    assert.equal(isMediaSliderLeftOut(['movie', 'artist'], ['music']), true);
    assert.equal(
      isMediaSliderLeftOut(['person', 'artist', 'tv'], ['music']),
      true
    );
    assert.equal(
      isMediaSliderLeftOut(['movie', 'artist'], ['tv', 'music']),
      true
    );
  });

  it('is not left out where any movie, tv or person is kept', () => {
    assert.equal(
      isMediaSliderLeftOut(['artist', 'movie'], ['movie', 'music']),
      false
    );
    assert.equal(
      isMediaSliderLeftOut(['artist', 'tv', 'tv'], ['tv', 'music']),
      false
    );
    assert.equal(
      isMediaSliderLeftOut(['person', 'artist'], ['person', 'music']),
      false
    );
    assert.equal(isMediaSliderLeftOut(['album', 'movie'], noMusic), false);
  });

  it('is not left out where its source gave nothing', () => {
    assert.equal(isMediaSliderLeftOut([], onlyMusic), false);
    assert.equal(isMediaSliderLeftOut([], []), false);
    assert.equal(isMediaSliderLeftOut([], all), false);
  });

  it('is left out with no kind shown where its source gave items', () => {
    assert.equal(isMediaSliderLeftOut(['movie', 'artist'], []), true);
  });
});
