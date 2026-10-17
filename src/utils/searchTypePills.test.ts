import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, isValidElement, type ReactElement } from 'react';
import { loadClient, renderClient } from './musicTestSupport';

type Kind = 'movie' | 'tv' | 'music' | 'person';
type Pills = (props: {
  kindsShown: Kind[];
  selected?: Kind;
  onSelect: (type?: Kind) => void;
}) => ReactElement;

const load = () =>
  loadClient<{ default: Pills }>('components/Search/SearchTypePills').default;

const render = (kindsShown: Kind[], selected?: Kind) =>
  renderClient(() =>
    createElement(load() as never, { kindsShown, selected, onSelect() {} })
  );

const labels = (html: string) =>
  [...html.matchAll(/data-testid="search-type-(?!pills)(\w+)"/g)].map(
    (m) => m[1]
  );

describe('the type pills of the search page', () => {
  it('offers All and every kind shown, in the order All, Movies, Series, Music, People', async () => {
    const html = await render(['movie', 'tv', 'music', 'person']);

    assert.deepEqual(labels(html), ['all', 'movie', 'tv', 'music', 'person']);
    assert.match(html, />All</);
    assert.match(html, />Movies</);
    assert.match(html, />Series</);
    assert.match(html, />Music</);
    assert.match(html, />People</);
  });

  it('offers only All and Music where only a Lidarr is configured', async () => {
    const html = await render(['music']);

    assert.deepEqual(labels(html), ['all', 'music']);
    assert.doesNotMatch(html, />Movies</);
    assert.doesNotMatch(html, />Series</);
    assert.doesNotMatch(html, />People</);
  });

  it('offers All alone where no kind is shown', async () => {
    assert.deepEqual(labels(await render([])), ['all']);
  });

  it('leaves out a kind not shown whatever the others', async () => {
    assert.deepEqual(labels(await render(['movie', 'person'])), [
      'all',
      'movie',
      'person',
    ]);
  });

  it('marks the chosen pill, and All where none is chosen', async () => {
    const pressed = (html: string) =>
      [
        ...html.matchAll(
          /aria-pressed="true"[^>]*data-testid="search-type-(\w+)"/g
        ),
      ].map((m) => m[1]);

    assert.deepEqual(pressed(await render(['movie', 'tv'], 'tv')), ['tv']);
    assert.deepEqual(pressed(await render(['movie', 'tv'])), ['all']);
  });

  it('hands the type of the pill pressed to onSelect, undefined for All', async () => {
    const pressed: (Kind | undefined)[] = [];
    let tree: ReactElement | undefined;

    // render the component inside a provider-bearing render, to read its
    // buttons' handlers
    await renderClient(() => {
      const Probe = () => {
        tree = load()({
          kindsShown: ['movie', 'tv', 'music', 'person'],
          onSelect: (type) => pressed.push(type),
        });
        return null;
      };
      return createElement(Probe);
    });

    const buttons: ReactElement<{
      'data-testid': string;
      onClick: () => void;
    }>[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (isValidElement(node)) {
        const props = node.props as { children?: unknown };
        if (node.type === 'button') {
          buttons.push(node as never);
        }
        walk(props.children);
      }
    };
    walk(tree);

    for (const button of buttons) {
      button.props.onClick();
    }

    assert.deepEqual(pressed, [undefined, 'movie', 'tv', 'music', 'person']);
  });
});
