import {
  buildFacebookCommentIdCandidates,
  buildGraphCommentIdCandidates,
  facebookCommentIdSuffix,
  isValidFacebookCommentId,
} from './facebook-comment-id.util';

describe('facebook-comment-id.util', () => {
  it('buildFacebookCommentIdCandidates includes full id and suffix', () => {
    expect(buildFacebookCommentIdCandidates('123456_789012')).toEqual([
      '123456_789012',
      '789012',
    ]);
  });

  it('buildFacebookCommentIdCandidates adds postId_suffix when postId is known', () => {
    expect(
      buildFacebookCommentIdCandidates('789012', '111222_333444'),
    ).toEqual(
      expect.arrayContaining(['111222_333444_789012', '789012']),
    );
  });

  it('facebookCommentIdSuffix returns last segment', () => {
    expect(facebookCommentIdSuffix('111_222_333')).toBe('333');
  });

  it('isValidFacebookCommentId requires underscore segments', () => {
    expect(isValidFacebookCommentId('123_456')).toBe(true);
    expect(isValidFacebookCommentId('789012')).toBe(false);
  });

  it('buildGraphCommentIdCandidates excludes suffix-only ids', () => {
    expect(buildGraphCommentIdCandidates('123456_789012')).toEqual([
      '123456_789012',
    ]);
    expect(
      buildGraphCommentIdCandidates('789012', '111222_333444'),
    ).toEqual(expect.arrayContaining(['111222_333444_789012']));
    expect(
      buildGraphCommentIdCandidates('789012', '111222_333444'),
    ).not.toContain('789012');
  });
});
