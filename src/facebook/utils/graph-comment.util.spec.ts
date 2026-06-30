import {
  flattenGraphComments,
  type GraphCommentNode,
} from './graph-comment.util';

describe('flattenGraphComments', () => {
  it('flattens nested reply comments beyond Graph default limit', () => {
    const root: GraphCommentNode = {
      id: '1_100',
      comments: {
        data: [
          { id: '1_101' },
          { id: '1_102' },
          {
            id: '1_103',
            comments: {
              data: [{ id: '1_104' }],
            },
          },
        ],
      },
    };

    const flat = flattenGraphComments([root]);
    expect(flat.map((c) => c.id)).toEqual([
      '1_100',
      '1_101',
      '1_102',
      '1_103',
      '1_104',
    ]);
  });
});
