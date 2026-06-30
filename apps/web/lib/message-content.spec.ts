import { formatConversationThreadPreview, parseMessageContent } from './message-content';

describe('formatConversationThreadPreview', () => {
  it('formats outbound photo comment JSON as Bạn đã gửi 1 hình ảnh', () => {
    const preview = formatConversationThreadPreview({
      content: JSON.stringify({
        text: '@Lê Huy',
        href: 'https://example.com/photo.jpg',
        type: 'image',
        title: 'Ảnh',
      }),
      msgType: 'feed.comment.reply.photo',
      eventType: 'FEED_COMMENT',
      direction: 'OUT',
    });

    expect(preview).toBe('Bạn đã gửi 1 hình ảnh');
  });

  it('formats inbound photo comment JSON with customer name', () => {
    const preview = formatConversationThreadPreview({
      content: JSON.stringify({
        href: 'https://example.com/photo.jpg',
        type: 'image',
        title: 'Ảnh',
      }),
      msgType: 'feed.comment.photo',
      eventType: 'FEED_COMMENT',
      direction: 'IN',
      senderName: 'Lê Huy',
    });

    expect(preview).toBe('Lê Huy đã gửi 1 hình ảnh');
  });

  it('parses webhook photo comment from rawPayload without placeholder text', () => {
    const parsed = parseMessageContent({
      id: '1',
      eventType: 'FEED_COMMENT',
      msgType: 'feed.comment.photo',
      content: '[Bình luận mới trên bài viết]',
      rawPayload: JSON.stringify({
        item: 'comment',
        verb: 'add',
        photo: 'https://cdn.example/webhook-photo.jpg',
        message: '',
      }),
      direction: 'IN',
      createdAt: new Date().toISOString(),
    } as never);

    expect(parsed.kind).toBe('feed');
    if (parsed.kind === 'feed') {
      expect(parsed.attachment?.href).toBe('https://cdn.example/webhook-photo.jpg');
      expect(parsed.text).toBe('');
    }
  });
});
