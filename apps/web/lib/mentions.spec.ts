import type { WebhookMessage } from './api';
import { collectMentionTargets, parseMentionSegments } from './mentions';

const PAGE_ID = '123456789';
const POST_URL = 'https://www.facebook.com/123/posts/456';

function makeMsg(
  overrides: Partial<WebhookMessage> & Pick<WebhookMessage, 'id' | 'direction'>,
): WebhookMessage {
  return {
    organizationId: 'org',
    pageId: PAGE_ID,
    eventType: 'FEED_COMMENT',
    senderId: '999888',
    senderName: 'Khách hàng',
    messageId: overrides.commentId ?? overrides.id,
    commentId: overrides.commentId ?? overrides.id,
    content: '',
    msgType: 'feed.comment',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as WebhookMessage;
}

function pageOutComment(
  facebookName: string,
  commentId = '111_222',
): WebhookMessage {
  return makeMsg({
    id: 'page-1',
    direction: 'OUT',
    senderId: '999888',
    senderName: 'Page',
    commentId,
    content: 'Xin chào!',
    rawPayload: JSON.stringify({
      from: { id: PAGE_ID, name: facebookName },
    }),
  });
}

function customerReply(
  text: string,
  overrides: Partial<WebhookMessage> = {},
): WebhookMessage {
  return makeMsg({
    id: 'cust-1',
    direction: 'IN',
    senderName: 'Nguyễn Văn A',
    content: text,
    parentCommentId: '111_222',
    msgType: 'feed.comment.reply',
    rawPayload: JSON.stringify({
      from: { id: '999888', name: 'Nguyễn Văn A' },
    }),
    ...overrides,
  });
}

function firstMention(text: string, messages: WebhookMessage[]) {
  const targets = collectMentionTargets({
    pageId: PAGE_ID,
    pageName: 'Tên DB khác',
    customerName: 'Nguyễn Văn A',
    customerSenderId: '999888',
    postPermalinkUrl: POST_URL,
    messages,
  });
  const segments = parseMentionSegments(text, targets);
  return segments.find((s) => s.type === 'mention');
}

describe('mentions – fanpage reply edge cases', () => {
  it('khớp tên fanpage từ rawPayload khi senderName là "Page"', () => {
    const mention = firstMention('@My Coffee Shop vâng ạ', [
      pageOutComment('My Coffee Shop'),
      customerReply('@My Coffee Shop vâng ạ'),
    ]);
    expect(mention).toBeDefined();
    expect(mention!.value).toBe('@My Coffee Shop');
    expect(mention!.facebookUrl).toContain('facebook.com');
  });

  it('khớp tên tiếng Việt có dấu', () => {
    const name = 'Cửa Hàng Thời Trang ABC';
    const mention = firstMention(`@${name} cho em hỏi`, [
      pageOutComment(name),
      customerReply(`@${name} cho em hỏi`),
    ]);
    expect(mention?.value).toBe(`@${name}`);
  });

  it('khớp tên fanpage dài nhiều từ + phần nội dung sau mention', () => {
    const name = 'Official Store Vietnam 2024';
    const mention = firstMention(`@${name} ship COD được không`, [
      pageOutComment(name),
      customerReply(`@${name} ship COD được không`),
    ]);
    expect(mention?.value).toBe(`@${name}`);
    const segments = parseMentionSegments(
      `@${name} ship COD được không`,
      collectMentionTargets({
        pageId: PAGE_ID,
        pageName: 'Tên DB',
        messages: [pageOutComment(name)],
        postPermalinkUrl: POST_URL,
      }),
    );
    expect(segments.some((s) => s.type === 'text' && s.value.includes('ship'))).toBe(
      true,
    );
  });

  it('ưu tiên link comment khi @ đúng tên fanpage có bình luận OUT', () => {
    const name = 'Shop XYZ';
    const mention = firstMention(`@${name} ok`, [pageOutComment(name, '555_666')]);
    expect(mention?.kind).toBe('comment');
    expect(mention?.facebookUrl).toContain('comment_id=666');
  });

  it('không nhầm @tên khách với tên fanpage', () => {
    const mention = firstMention('@Nguyễn Văn A bạn ơi', [
      pageOutComment('Shop ABC'),
      customerReply('@Nguyễn Văn A bạn ơi'),
    ]);
    expect(mention?.value).toBe('@Nguyễn Văn A');
    expect(mention?.kind).toBe('profile');
  });

  it('fallback pageName từ DB khi chưa có comment OUT trong thread', () => {
    const targets = collectMentionTargets({
      pageId: PAGE_ID,
      pageName: 'Fanpage DB',
      messages: [],
      postPermalinkUrl: POST_URL,
    });
    const segments = parseMentionSegments('@Fanpage DB xin chào', targets);
    const mention = segments.find((s) => s.type === 'mention');
    expect(mention?.value).toBe('@Fanpage DB');
    expect(mention?.facebookUrl).toContain('facebook.com/123456789');
  });
});
