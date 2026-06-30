import { transformInboundMessage } from './facebook-payload.util';

describe('transformInboundMessage', () => {
  it('preserves full webhook event in contentRaw for text replies', () => {
    const event = {
      sender: { id: 'user-1' },
      recipient: { id: 'page-1' },
      message: {
        mid: 'mid.reply',
        text: 'Cảm ơn shop',
        reply_to: { mid: 'mid.page-message' },
      },
    };

    const result = transformInboundMessage(event);

    expect(result.content).toBe('Cảm ơn shop');
    expect(result.quote).toBe(JSON.stringify({ mid: 'mid.page-message' }));

    const parsed = JSON.parse(result.contentRaw);
    expect(parsed.message.reply_to.mid).toBe('mid.page-message');
  });
});
