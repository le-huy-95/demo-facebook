'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { FacebookPostPreview, WebhookMessage } from '@/lib/api';
import { pickBetterSenderName } from '@/lib/conversation';
import { formatDateTime } from '@/lib/datetime';
import { isReceiptMessage, parseMessageContent } from '@/lib/message-content';
import { UserAvatar } from '@/components/user-avatar';

const URL_SPLIT_REGEX = /(https?:\/\/[^\s]+)/g;

function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

function normalizeUrl(raw: string): string {
  return raw.replace(/[)\].,;!?]+$/, '');
}

export function LinkifiedText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(URL_SPLIT_REGEX);

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (!part) return null;
        if (isHttpUrl(part)) {
          const href = normalizeUrl(part);
          return (
            <a
              key={`${href}-${index}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-[#2563eb] underline hover:text-[#1d4ed8]"
              onClick={(e) => e.stopPropagation()}
            >
              {part}
            </a>
          );
        }
        return <span key={`text-${index}`}>{part}</span>;
      })}
    </span>
  );
}

function MessageBody({ msg }: { msg: WebhookMessage }) {
  const parsed = parseMessageContent(msg);

  if (parsed.kind === 'receipt') {
    return (
      <p className="text-center text-xs text-[#6b7280]">
        {parsed.receiptType === 'read' ? '✓✓ ' : '✓ '}
        {parsed.label}
      </p>
    );
  }

  if (parsed.kind === 'attachments') {
    return (
      <div className="space-y-2">
        {parsed.attachments.map((att, index) => (
          <AttachmentBlock key={`${att.href ?? index}-${index}`} attachment={att} />
        ))}
      </div>
    );
  }

  if (parsed.kind === 'attachment') {
    return <AttachmentBlock attachment={parsed.attachment} />;
  }

  if (!parsed.text) return null;

  return (
    <p className="whitespace-pre-wrap break-words">
      <LinkifiedText text={parsed.text} />
    </p>
  );
}

function AttachmentBlock({ attachment }: { attachment: { title?: string; href?: string; thumb?: string; type?: string } }) {
  const url = attachment.href || attachment.thumb;
  const isImage =
    attachment.type === 'image' ||
    attachment.type === 'sticker' ||
    /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url ?? '');

  if (url && isImage) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        <img
          src={url}
          alt={attachment.title ?? 'Đính kèm'}
          className="max-h-64 max-w-full rounded-lg object-cover"
          referrerPolicy="no-referrer"
        />
      </a>
    );
  }

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-[#2563eb] underline"
        onClick={(e) => e.stopPropagation()}
      >
        {attachment.title ?? url}
      </a>
    );
  }

  return <p className="text-sm">{attachment.title ?? '[Tệp đính kèm]'}</p>;
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractReplyMeta(msg: WebhookMessage): { messageId: string | null; text: string | null; senderName: string | null } | null {
  try {
    const raw = JSON.parse(msg.rawPayload ?? '{}') as Record<string, any>;

    const nestedReply = raw?.message?.reply_to ?? raw?.reply_to ?? raw?.replyTo;
    if (nestedReply && typeof nestedReply === 'object') {
      return {
        messageId: safeString(nestedReply.mid ?? nestedReply.message_id ?? nestedReply.id),
        text: safeString(nestedReply.message ?? nestedReply.text ?? nestedReply.title),
        senderName: safeString(nestedReply.sender_name ?? nestedReply.name),
      };
    }

    const fallbackMessageId = safeString(raw?.replyToMessageId);
    const fallbackText = safeString(raw?.replyToText);
    const fallbackSenderName = safeString(raw?.replyToSenderName);

    if (fallbackMessageId || fallbackText || fallbackSenderName) {
      return {
        messageId: fallbackMessageId,
        text: fallbackText,
        senderName: fallbackSenderName,
      };
    }
  } catch {
    // ignore invalid payload
  }

  return null;
}

function messagePreviewText(msg: WebhookMessage): string {
  const parsed = parseMessageContent(msg);
  if (parsed.kind === 'text') return parsed.text;
  if (parsed.kind === 'attachment') {
    return parsed.attachment.title ?? parsed.attachment.preview ?? parsed.attachment.href ?? '[Tệp đính kèm]';
  }
  if (parsed.kind === 'attachments') {
    return `[${parsed.attachments.length} tệp đính kèm]`;
  }
  return '';
}

interface PostPreviewPanelProps {
  post: FacebookPostPreview | null;
  loading: boolean;
  highlightComment?: string;
  senderName?: string;
  emptyState?: 'hidden' | 'hint' | 'error';
  expanded?: boolean;
  onToggleExpanded?: () => void;
  variant?: 'inline' | 'side' | 'bubble';
}

export function PostPreviewPanel({
  post,
  loading,
  highlightComment,
  senderName,
  emptyState = 'error',
  expanded = false,
  onToggleExpanded,
  variant = 'inline',
}: PostPreviewPanelProps) {
  const containerClass =
    variant === 'bubble'
      ? 'bg-[#dbeafe] text-[#111827]'
      : variant === 'side'
        ? 'bg-[#ecfdf5]'
        : 'bg-white';

  if (loading) {
    return (
      <div
        className={`${
          variant === 'bubble' ? '' : 'border-b border-[#e5e7eb]'
        } px-4 py-3 text-sm text-[#6b7280] ${containerClass}`}
      >
        Đang tải nội dung bài viết...
      </div>
    );
  }

  if (!post) {
    if (emptyState === 'hidden') return null;
    if (emptyState === 'hint') {
      return (
        <div
          className={`${
            variant === 'bubble' ? '' : 'border-b border-[#e5e7eb]'
          } px-4 py-3 text-sm text-[#6b7280] ${containerClass}`}
        >
          Bấm vào tin nhắn có link bài viết để xem nội dung bài quảng cáo.
        </div>
      );
    }
    return (
      <div
        className={`${
          variant === 'bubble' ? '' : 'border-b border-[#e5e7eb]'
        } px-4 py-3 text-sm text-[#6b7280] ${containerClass}`}
      >
        Không tải được nội dung quảng cáo từ Facebook Graph API.
      </div>
    );
  }

  const text = post.message || post.story || '';

  return (
    <div
      className={`${variant === 'bubble' ? '' : 'border-b border-[#e5e7eb]'} ${containerClass}`}
    >
      <div className="px-4 py-3">
        <div className={variant === 'bubble' ? 'max-w-[520px]' : 'mx-auto max-w-[520px]'}>
          <p
            className={`whitespace-pre-wrap text-sm leading-relaxed text-[#111827] ${
              expanded ? '' : 'line-clamp-4'
            }`}
          >
            {text}
          </p>
          {onToggleExpanded && (
            <button
              type="button"
              onClick={onToggleExpanded}
              className="mt-2 text-xs font-medium text-[#2563eb] hover:underline"
            >
              {expanded ? 'Thu gọn' : 'Xem thêm'}
            </button>
          )}
        {post.fullPicture && (
          <img
            src={post.fullPicture}
            alt="Bài viết"
            className={`mt-3 w-full rounded-lg object-cover ${expanded ? 'max-h-[420px]' : 'max-h-56'}`}
            referrerPolicy="no-referrer"
          />
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#6b7280]">
          {post.fromName && <span>Đăng bởi: {post.fromName}</span>}
          {post.createdTime && <span>· {formatDateTime(post.createdTime)}</span>}
          {post.permalinkUrl && (
            <a
              href={post.permalinkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#2563eb] hover:underline"
            >
              Xem trên Facebook
            </a>
          )}
        </div>
        <p className="mt-1 break-all font-mono text-[10px] text-[#9ca3af]">{post.id}</p>
        </div>
      </div>
      {highlightComment && (
        <div className="border-t border-[#fde68a] bg-[#fffbeb] px-4 py-3">
          <p className="text-sm text-[#92400e]">
            <span className="font-semibold">{senderName}:</span>{' '}
            <LinkifiedText text={highlightComment} />
          </p>
        </div>
      )}
    </div>
  );
}

function MessageSkeleton({ align, width }: { align: 'left' | 'right'; width: string }) {
  const isLeft = align === 'left';
  return (
    <div className={`flex items-end gap-2 ${isLeft ? '' : 'justify-end'}`}>
      {isLeft && <div className="h-8 w-8 animate-pulse rounded-full bg-[#d1d5db]" />}
      <div className={`space-y-1.5 ${isLeft ? '' : 'flex flex-col items-end'}`}>
        <div
          className={`h-9 animate-pulse rounded-2xl ${isLeft ? 'rounded-bl-md bg-[#e5e7eb]' : 'rounded-br-md bg-[#bfdbfe]'}`}
          style={{ width }}
        />
      </div>
    </div>
  );
}

function MessagesSkeletonGroup() {
  return (
    <div className="space-y-3 p-4">
      <MessageSkeleton align="left" width="180px" />
      <MessageSkeleton align="left" width="140px" />
      <MessageSkeleton align="right" width="200px" />
      <MessageSkeleton align="left" width="160px" />
      <MessageSkeleton align="right" width="120px" />
      <MessageSkeleton align="right" width="180px" />
      <MessageSkeleton align="left" width="150px" />
    </div>
  );
}

interface ThreadMessagesProps {
  messages: WebhookMessage[];
  customerName: string;
  customerPictureUrl?: string | null;
  customerSenderId?: string;
  pageId?: string;
  pageName?: string;
  pagePictureUrl?: string | null;
  selectedCommentId?: string | null;
  loading?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onSelectMessage?: (msg: WebhookMessage) => void;
  onReplyMessage?: (msg: WebhookMessage) => void;
  post?: FacebookPostPreview | null;
  postLoading?: boolean;
  highlightComment?: string;
  highlightSenderName?: string;
  showFeedCommentBanner?: boolean;
  showPostHintWhenEmpty?: boolean;
  postExpanded?: boolean;
  onTogglePostExpanded?: () => void;
}

export function ThreadMessages({
  messages,
  customerName,
  customerPictureUrl,
  customerSenderId,
  pageId,
  pageName,
  pagePictureUrl = null,
  selectedCommentId = null,
  loading = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onSelectMessage,
  onReplyMessage,
  post,
  postLoading = false,
  highlightComment,
  highlightSenderName,
  showFeedCommentBanner = false,
  showPostHintWhenEmpty = false,
  postExpanded = false,
  onTogglePostExpanded,
}: ThreadMessagesProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const isInitialScroll = useRef(true);
  const prevScrollHeight = useRef(0);

  useEffect(() => {
    isInitialScroll.current = true;
  }, [customerName]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (isInitialScroll.current && messages.length > 0) {
      el.scrollTop = el.scrollHeight;
      isInitialScroll.current = false;
      return;
    }

    if (prevScrollHeight.current > 0 && el.scrollHeight > prevScrollHeight.current) {
      const delta = el.scrollHeight - prevScrollHeight.current;
      el.scrollTop += delta;
    }
    prevScrollHeight.current = el.scrollHeight;
  }, [messages, post, postLoading]);

  const handleLoadMore = useCallback(() => {
    if (!onLoadMore || loadingMore || !hasMore) return;
    const el = scrollRef.current;
    if (el) prevScrollHeight.current = el.scrollHeight;
    onLoadMore();
  }, [onLoadMore, loadingMore, hasMore]);

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !onLoadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          handleLoadMore();
        }
      },
      { root, rootMargin: '80px', threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleLoadMore, onLoadMore, hasMore]);

  const showPost = postLoading || !!post || showPostHintWhenEmpty;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-[#f3f4f6]">
      {hasMore && (
        <div ref={topSentinelRef} className="flex justify-center py-2">
          {loadingMore ? (
            <span className="text-xs text-[#6b7280]">Đang tải tin nhắn cũ hơn...</span>
          ) : (
            <span className="text-xs text-[#9ca3af]">Cuộn lên để xem thêm</span>
          )}
        </div>
      )}

      {showFeedCommentBanner && (
        <div className="border-b border-[#a7f3d0] bg-[#ecfdf5] px-4 py-2 text-xs text-[#047857]">
          Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình.
        </div>
      )}

      {loading && messages.length === 0 ? (
        <MessagesSkeletonGroup />
      ) : (
      <div className="space-y-3 p-4">
        {showPost && (
          <div className="flex items-end justify-end">
            <div className="max-w-[75%] rounded-2xl rounded-br-md shadow-sm">
              <PostPreviewPanel
                post={post ?? null}
                loading={postLoading}
                highlightComment={highlightComment}
                senderName={highlightSenderName ?? customerName}
                emptyState={showPostHintWhenEmpty ? 'hint' : 'error'}
                expanded={postExpanded}
                onToggleExpanded={onTogglePostExpanded}
                variant="bubble"
              />
            </div>
          </div>
        )}

        {messages.length === 0 ? (
          <p className="text-center text-sm text-[#6b7280]">Chưa có tin nhắn trong cuộc trò chuyện này</p>
        ) : (
          (() => {
            const nonReceipts = messages.filter((m) => !isReceiptMessage(m));
            const receipts = messages.filter((m) => isReceiptMessage(m));

            const lastReadReceipt = [...receipts]
              .reverse()
              .find((r) => r.msgType === 'read' && r.direction === 'IN');
            const lastDeliveryReceipt = [...receipts]
              .reverse()
              .find((r) => r.msgType === 'delivery');

            let lastDateStr = '';

            const commentIdSet = new Set(
              nonReceipts
                .filter((m) => m.commentId && m.eventType === 'FEED_COMMENT')
                .map((m) => m.commentId!),
            );

            const messageIdMap = new Map<string, WebhookMessage>();
            nonReceipts.forEach((m) => {
              if (m.messageId) messageIdMap.set(m.messageId, m);
            });

            return nonReceipts.map((msg, idx) => {
              const isOut = msg.direction === 'OUT';
              const avatarUrl =
                msg.senderPictureUrl ??
                (isOut ? pagePictureUrl : customerPictureUrl);
              const displayName = isOut
                ? pickBetterSenderName(pageName, msg.senderName)
                : pickBetterSenderName(msg.senderName, customerName);
              const avatarSenderId = isOut ? undefined : (msg.senderId ?? customerSenderId);
              const avatarPageId = isOut ? undefined : (msg.pageId ?? pageId);
              const isSelected = !!selectedCommentId && msg.commentId === selectedCommentId;

              const isReply =
                msg.eventType === 'FEED_COMMENT' &&
                !!msg.parentCommentId &&
                commentIdSet.has(msg.parentCommentId);

              const replyMeta = extractReplyMeta(msg);
              const repliedMsg = replyMeta?.messageId ? messageIdMap.get(replyMeta.messageId) : null;
              const replySnippet = replyMeta?.text ?? (repliedMsg ? messagePreviewText(repliedMsg) : null);
              const replySenderName =
                replyMeta?.senderName ??
                repliedMsg?.senderName ??
                (repliedMsg?.direction === 'OUT' ? pageName : customerName);
              const canReply =
                !isOut &&
                !isReceiptMessage(msg) &&
                !!onReplyMessage &&
                (msg.eventType !== 'MESSENGER' || !!msg.messageId);

              const msgDate = new Date(msg.createdAt);
              const dateStr = msgDate.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
              const showDateSeparator = dateStr !== lastDateStr;
              if (showDateSeparator) lastDateStr = dateStr;

              const isLastOutMsg =
                isOut &&
                (idx === nonReceipts.length - 1 ||
                  nonReceipts.slice(idx + 1).every((m) => m.direction === 'IN'));

              let readStatus: string | null = null;
              if (isLastOutMsg && lastReadReceipt) {
                readStatus = 'Đã xem';
              } else if (isLastOutMsg && lastDeliveryReceipt) {
                readStatus = 'Đã gửi';
              }

              return (
                <div key={msg.id} className={isReply ? 'ml-8 border-l-2 border-[#e5e7eb] pl-3' : ''}>
                  {showDateSeparator && (
                    <div className="flex items-center gap-3 py-2">
                      <div className="h-px flex-1 bg-[#e5e7eb]" />
                      <span className="text-[11px] font-medium text-[#9ca3af]">{dateStr}</span>
                      <div className="h-px flex-1 bg-[#e5e7eb]" />
                    </div>
                  )}
                  {isReply && (
                    <p className="mb-1 flex items-center gap-1 text-[11px] text-[#9ca3af]">
                      <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden>
                        <path fillRule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clipRule="evenodd" />
                      </svg>
                      Trả lời bình luận
                    </p>
                  )}
                  <div className={`group flex items-end gap-2 ${isOut ? 'flex-row-reverse' : 'flex-row'}`}>
                    <UserAvatar
                      name={displayName}
                      pictureUrl={avatarUrl}
                      senderId={avatarSenderId}
                      pageId={avatarPageId}
                      size="sm"
                    />
                    <div className={`max-w-[75%] ${isOut ? 'text-right' : 'text-left'}`}>
                      <div
                        role={onSelectMessage ? 'button' : undefined}
                        tabIndex={onSelectMessage ? 0 : undefined}
                        onClick={onSelectMessage ? () => onSelectMessage(msg) : undefined}
                        onKeyDown={
                          onSelectMessage
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') onSelectMessage(msg);
                              }
                            : undefined
                        }
                        className={`inline-block rounded-2xl px-4 py-2 text-sm shadow-sm text-left ${
                          isOut
                            ? 'rounded-br-md bg-[#dcf8c6] text-[#111827]'
                            : 'rounded-bl-md bg-white text-[#111827]'
                        } ${isSelected ? 'ring-2 ring-[#f59e0b]' : ''}`}
                      >
                        {!isOut && (
                          <p className="mb-1 text-xs font-semibold text-[#3b82f6]">{displayName}</p>
                        )}
                        {replySnippet && (
                          <div className="mb-2 rounded-lg border-l-2 border-[#d1d5db] bg-black/5 px-2 py-1 text-[11px] text-[#4b5563]">
                            {replySenderName ? (
                              <p className="font-semibold text-[#374151]">{replySenderName}</p>
                            ) : null}
                            <p className="line-clamp-2 whitespace-pre-wrap break-words">{replySnippet}</p>
                          </div>
                        )}
                        <MessageBody msg={msg} />
                        <p className="mt-1 text-right text-[10px] text-[#9ca3af]">{formatDateTime(msg.createdAt)}</p>
                      </div>
                      {readStatus && (
                        <p className={`mt-0.5 text-[10px] text-[#9ca3af] ${isOut ? 'text-right pr-1' : 'text-left pl-1'}`}>
                          {readStatus === 'Đã xem' ? '✓✓ ' : '✓ '}{readStatus}
                        </p>
                      )}
                      {canReply && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onReplyMessage?.(msg);
                          }}
                          className="mt-1 ml-1 inline-flex items-center gap-1 rounded-full border border-[#e5e7eb] bg-white px-2 py-0.5 text-[11px] text-[#6b7280] opacity-0 shadow-sm transition hover:border-[#93c5fd] hover:text-[#2563eb] group-hover:opacity-100 focus:opacity-100"
                        >
                          <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor" aria-hidden>
                            <path fillRule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clipRule="evenodd" />
                          </svg>
                          Trả lời
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            });
          })()
        )}
      </div>
      )}
    </div>
  );
}
