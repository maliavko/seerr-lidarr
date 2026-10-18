import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activeYears,
  formatAlbumLength,
  genreUrl,
  ratingText,
  sizeText,
} from './musicFacts';

describe('formatAlbumLength', () => {
  it('writes m:ss under an hour and h:mm:ss above', () => {
    assert.equal(formatAlbumLength(3207156), '53:27');
    assert.equal(formatAlbumLength(20705000), '5:45:05');
    assert.equal(formatAlbumLength(59000), '0:59');
  });
});

describe('activeYears', () => {
  it('writes an active artist to the present, an ended one to its end', () => {
    assert.equal(activeYears('1991', undefined, false), '1991 – present');
    assert.equal(activeYears('1981', '1990', true), '1981 – 1990');
    assert.equal(activeYears(undefined, '1990', true), '? – 1990');
    assert.equal(activeYears('1981', undefined, true), '1981');
    assert.equal(activeYears(undefined, undefined, true), undefined);
  });
});

describe('ratingText, sizeText and genreUrl', () => {
  it('writes the rating out of ten, a size in bytes, and a genre tag link', () => {
    assert.equal(ratingText({ value: 9, votes: 80 }), '9.0 / 10');
    assert.equal(sizeText(1536 * 1024 * 1024), '1.5 GB');
    assert.equal(sizeText(0), undefined);
    assert.equal(
      genreUrl('Alternative Rock'),
      'https://musicbrainz.org/tag/alternative%20rock'
    );
  });
});
