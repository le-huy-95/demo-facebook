'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { FacebookPostPreview, WebhookMessage } from '@/lib/api';
import { pickBetterSenderName } from '@/lib/conversation';
import { formatDateTime } from '@/lib/datetime';
import { parseMessageContent } from '@/lib/message-content';
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

interface ThreadMessagesProps {
  messages: WebhookMessage[];
  customerName: string;
  customerPictureUrl?: string | null;
  customerSenderId?: string;
  pageId?: string;
  pageName?: string;
  pagePictureUrl?: string | null;
  selectedCommentId?: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onSelectMessage?: (msg: WebhookMessage) => void;
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
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onSelectMessage,
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
          messages.map((msg) => {
            const parsed = parseMessageContent(msg);

            if (parsed.kind === 'receipt') {
              return (
                <div key={msg.id} className="py-1">
                  <MessageBody msg={msg} />
                  <p className="mt-0.5 text-center text-[10px] text-[#9ca3af]">
                    {formatDateTime(msg.createdAt)}
                  </p>
                </div>
              );
            }

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

            return (
              <div key={msg.id} className={`flex items-end gap-2 ${isOut ? 'flex-row-reverse' : 'flex-row'}`}>
                <UserAvatar
                  name={displayName}
                  pictureUrl={avatarUrl}
                  senderId={avatarSenderId}
                  pageId={avatarPageId}
                  size="sm"
                />
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
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm shadow-sm ${
                    isOut
                      ? 'rounded-br-md bg-[#dcf8c6] text-[#111827]'
                      : 'rounded-bl-md bg-white text-[#111827]'
                  } ${isSelected ? 'ring-2 ring-[#f59e0b]' : ''}`}
                >
                  {!isOut && (
                    <p className="mb-1 text-xs font-semibold text-[#3b82f6]">{displayName}</p>
                  )}
                  <MessageBody msg={msg} />
                  <p className="mt-1 text-right text-[10px] text-[#9ca3af]">{formatDateTime(msg.createdAt)}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
