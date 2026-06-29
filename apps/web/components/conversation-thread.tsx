'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  CommentAction,
  FacebookPostPreview,
  WebhookMessage,
} from '@/lib/api';
import {
  buildFacebookCommentUrl,
  extractParentCommentId,
  getMessageCommentKey,
  pickBetterSenderName,
} from '@/lib/conversation';
import { formatDateTime } from '@/lib/datetime';
import {
  formatContentStatusLabel,
  isActiveContentStatus,
} from '@/lib/event-status';
import {
  getCommentPreviewText,
  parseMessageContent,
  isFeedCommentReply,
} from '@/lib/message-content';
import { UserAvatar } from '@/components/user-avatar';

const URL_SPLIT_REGEX = /(https?:\/\/[^\s]+)/g;

type MessageDeliveryStatus = 'delivery' | 'read';

interface DisplayMessage {
  msg: WebhookMessage;
  status?: MessageDeliveryStatus;
  showDateSeparator: boolean;
}

function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

function normalizeUrl(raw: string): string {
  return raw.replace(/[)\].,;!?]+$/, '');
}

export function LinkifiedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
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

function ReplyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M6.5 4.5 3 8v1.5h3.25A4.75 4.75 0 0 1 11 14.25V16l3.5-3.5L11 9v1.75A3.25 3.25 0 0 0 6.5 4.5Z" />
    </svg>
  );
}

function LikeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M7.3 17H5a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2h2.1l2.25-4A2 2 0 0 1 13 4.85V7h2.4a2 2 0 0 1 1.94 2.49l-1.25 5A2 2 0 0 1 14.15 16H9.2c-.44 0-.87-.15-1.21-.42L7.3 17ZM5 9.1a.4.4 0 0 0-.4.4V15a.4.4 0 0 0 .4.4h1.6V9.1H5Zm3.2 5.1.8.64c.06.05.13.07.2.07h4.95a.4.4 0 0 0 .39-.3l1.25-5A.4.4 0 0 0 15.4 9H11.4V4.85a.4.4 0 0 0-.74-.2L8.2 9.03v5.17Z" />
    </svg>
  );
}

function MessageIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M4.5 4A2.5 2.5 0 0 0 2 6.5v5A2.5 2.5 0 0 0 4.5 14H6v2.25a.75.75 0 0 0 1.2.6L11 14h4.5A2.5 2.5 0 0 0 18 11.5v-5A2.5 2.5 0 0 0 15.5 4h-11Zm0 1.5h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5l-3 2.25V12.5h-3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M11 3.75A.75.75 0 0 1 11.75 3h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V5.56l-6.22 6.22a.75.75 0 1 1-1.06-1.06l6.22-6.22h-2.69A.75.75 0 0 1 11 3.75ZM5.5 6.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2.25a.75.75 0 0 1 1.5 0v2.25A2.5 2.5 0 0 1 12.5 17h-7A2.5 2.5 0 0 1 3 14.5v-7A2.5 2.5 0 0 1 5.5 5h2.25a.75.75 0 0 1 0 1.5H5.5Z" />
    </svg>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M10 4.5c4.15 0 6.48 3.08 7.25 4.35.42.7.42 1.6 0 2.3C16.48 12.42 14.15 15.5 10 15.5s-6.48-3.08-7.25-4.35a2.2 2.2 0 0 1 0-2.3C3.52 7.58 5.85 4.5 10 4.5Zm0 1.5C6.62 6 4.7 8.53 4.03 9.62a.72.72 0 0 0 0 .76C4.7 11.47 6.62 14 10 14s5.3-2.53 5.97-3.62a.72.72 0 0 0 0-.76C15.3 8.53 13.38 6 10 6Zm0 1.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm0 1.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M4.03 3.22a.75.75 0 0 0-1.06 1.06l2.08 2.08a9.4 9.4 0 0 0-2.3 2.49 2.2 2.2 0 0 0 0 2.3c.77 1.27 3.1 4.35 7.25 4.35 1.28 0 2.39-.3 3.34-.74l2.38 2.37a.75.75 0 1 0 1.06-1.06L4.03 3.22Zm5.06 6.12 1.57 1.57a1 1 0 0 1-1.57-1.57Zm.91 4.66c-3.38 0-5.3-2.53-5.97-3.62a.72.72 0 0 1 0-.76 8.1 8.1 0 0 1 2.1-2.18l1.87 1.88a2.5 2.5 0 0 0 3.18 3.18l1.02 1.02c-.66.3-1.39.48-2.2.48Zm0-8c3.38 0 5.3 2.53 5.97 3.62a.72.72 0 0 1 0 .76 8.22 8.22 0 0 1-1.75 1.91l1.07 1.07a9.77 9.77 0 0 0 1.96-2.21c.42-.7.42-1.6 0-2.3C16.48 7.58 14.15 4.5 10 4.5c-1 0-1.9.18-2.69.48l1.19 1.19c.47-.11.97-.17 1.5-.17Zm2.48 4.85a2.5 2.5 0 0 0-3.33-3.33l1.15 1.15c.49.1.88.48.98.98l1.2 1.2Z" />
    </svg>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M4 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Zm2 0v8.17l2.59-2.58a1 1 0 0 1 1.42 0L13.17 15H14a1 1 0 0 0 1-1V5H6Zm7.5 1.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z" />
    </svg>
  );
}

function IconTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-[#111827] px-2 py-1 text-[11px] font-medium text-white shadow-lg group-hover/tooltip:block group-focus-within/tooltip:block"
      >
        {label}
      </span>
    </span>
  );
}

function CommentActionIcon({
  label,
  icon,
  onClick,
  disabled = false,
  active = false,
  href,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  href?: string;
}) {
  const className = `inline-flex h-7 w-7 items-center justify-center rounded-full border text-xs transition ${
    disabled
      ? 'cursor-not-allowed border-[#e5e7eb] bg-[#f9fafb] text-[#d1d5db]'
      : active
        ? 'border-[#93c5fd] bg-[#dbeafe] text-[#2563eb]'
        : 'border-[#e5e7eb] bg-white text-[#6b7280] hover:border-[#93c5fd] hover:bg-[#eff6ff] hover:text-[#2563eb]'
  }`;

  if (href && !disabled) {
    return (
      <IconTooltip label={label}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={label}
          className={className}
          onClick={(e) => e.stopPropagation()}
        >
          {icon}
        </a>
      </IconTooltip>
    );
  }

  return (
    <IconTooltip label={label}>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
        className={className}
      >
        {icon}
      </button>
    </IconTooltip>
  );
}

interface CommentActionBarProps {
  msg: WebhookMessage;
  pageId?: string;
  postPermalinkUrl?: string | null;
  isOut: boolean;
  liked: boolean;
  actionLoading: boolean;
  onReply: () => void;
  onMessage: () => void;
  onLike: () => void;
  onHide: () => void;
  onUnhide: () => void;
}

function CommentActionBar({
  msg,
  pageId,
  postPermalinkUrl,
  isOut,
  liked,
  actionLoading,
  onReply,
  onMessage,
  onLike,
  onHide,
  onUnhide,
}: CommentActionBarProps) {
  const commentKey = getMessageCommentKey(msg);
  const isHidden = msg.status === 'HIDDEN';
  const canReply =
    !isOut &&
    msg.direction === 'IN' &&
    msg.senderId !== pageId &&
    isActiveContentStatus(msg.status) &&
    !!commentKey;
  const fbUrl = commentKey
    ? buildFacebookCommentUrl(commentKey, postPermalinkUrl)
    : null;

  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-1 text-[11px] ${
        isOut ? 'justify-end pr-1' : 'justify-start pl-1'
      }`}
    >
      {!isOut && (
        <>
          <CommentActionIcon
            label={liked ? 'Đã thích' : 'Thích'}
            icon={<LikeIcon className="h-4 w-4" />}
            onClick={onLike}
            disabled={actionLoading || liked || !commentKey}
            active={liked}
          />
          <CommentActionIcon
            label="Nhắn tin Messenger"
            icon={<MessageIcon className="h-4 w-4" />}
            onClick={onMessage}
            disabled={actionLoading}
          />
        </>
      )}
      {canReply && (
        <CommentActionIcon
          label="Trả lời bình luận"
          icon={<ReplyIcon className="h-4 w-4" />}
          onClick={onReply}
          disabled={actionLoading}
        />
      )}
      {fbUrl && (
        <CommentActionIcon
          label="Xem trên Facebook"
          icon={<ExternalLinkIcon className="h-4 w-4" />}
          href={fbUrl}
        />
      )}
      {commentKey && isActiveContentStatus(msg.status) && (
        <CommentActionIcon
          label="Ẩn bình luận"
          icon={<EyeOffIcon className="h-4 w-4" />}
          onClick={onHide}
          disabled={actionLoading}
        />
      )}
      {commentKey && isHidden && (
        <CommentActionIcon
          label="Hiện bình luận"
          icon={<EyeIcon className="h-4 w-4" />}
          onClick={onUnhide}
          disabled={actionLoading}
        />
      )}
    </div>
  );
}

function MessageBody({ msg }: { msg: WebhookMessage }) {
  const parsed = parseMessageContent(msg);

  if (parsed.kind === 'receipt') {
    return null;
  }

  if (parsed.kind === 'feed') {
    return (
      <div className="space-y-2">
        {parsed.text ? (
          <p className="whitespace-pre-wrap break-words">
            <LinkifiedText text={parsed.text} />
          </p>
        ) : null}
        {parsed.attachment ? (
          <AttachmentBlock attachment={parsed.attachment} />
        ) : null}
      </div>
    );
  }

  if (parsed.kind === 'attachments') {
    return (
      <div className="space-y-2">
        {parsed.attachments.map((att, index) => (
          <AttachmentBlock
            key={`${att.href ?? index}-${index}`}
            attachment={att}
          />
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

function AttachmentBlock({
  attachment,
}: {
  attachment: { title?: string; href?: string; thumb?: string; type?: string };
}) {
  const url = attachment.href || attachment.thumb;
  const isImage =
    attachment.type === 'image' ||
    attachment.type === 'sticker' ||
    /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url ?? '');

  if (url && isImage) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={url}
          alt={attachment.title ?? 'Đính kèm'}
          className="max-h-64 max-w-full rounded-lg object-cover"
          referrerPolicy="no-referrer"
        />
        {attachment.type === 'sticker' && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-[#6b7280]">
            <ImageIcon className="h-3 w-3" />
            Sticker
          </p>
        )}
      </a>
    );
  }

  if (url && attachment.type === 'video') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-lg bg-[#f3f4f6] px-3 py-2 text-sm text-[#2563eb] underline"
        onClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden>▶</span>
        {attachment.title ?? 'Xem video'}
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

function ThreadMessagesSkeleton() {
  return (
    <div className="space-y-4" aria-label="Đang tải tin nhắn">
      <div className="flex justify-center">
        <div className="h-6 w-24 animate-pulse rounded-full bg-[#e5e7eb]" />
      </div>
      {[0, 1, 2, 3].map((index) => {
        const isOut = index % 2 === 1;

        return (
          <div
            key={index}
            className={`flex items-end gap-2 ${isOut ? 'flex-row-reverse' : 'flex-row'}`}
          >
            <div className="h-8 w-8 animate-pulse rounded-full bg-[#e5e7eb]" />
            <div
              className={`animate-pulse rounded-2xl px-4 py-3 shadow-sm ${
                isOut
                  ? 'w-[42%] rounded-br-md bg-[#d9f5c3]'
                  : 'w-[58%] rounded-bl-md bg-white'
              }`}
            >
              <div className="mb-2 h-3 w-1/3 rounded bg-[#e5e7eb]" />
              <div className="h-3 w-full rounded bg-[#e5e7eb]" />
              <div className="mt-2 h-2 w-16 rounded bg-[#e5e7eb]" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatDateOnly(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function messageTimestamp(msg: WebhookMessage): number {
  const parsed = parseMessageContent(msg);
  const fallback = new Date(msg.createdAt).getTime();
  if (parsed.kind !== 'receipt' || !msg.content) return fallback;

  try {
    const payload = JSON.parse(msg.content) as {
      watermark?: number | string | null;
      timestamp?: number | string | null;
    };
    const raw = payload.watermark ?? payload.timestamp;
    const numeric = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof numeric === 'number' && Number.isFinite(numeric)) {
      return numeric;
    }
  } catch {
    // Receipt payload cũ có thể không phải JSON hợp lệ.
  }

  return fallback;
}

function receiptPriority(status: MessageDeliveryStatus): number {
  return status === 'read' ? 2 : 1;
}

function buildDisplayMessages(messages: WebhookMessage[]): DisplayMessage[] {
  const statusByMessageId = new Map<string, MessageDeliveryStatus>();
  const normalMessages: WebhookMessage[] = [];

  for (const msg of messages) {
    const parsed = parseMessageContent(msg);
    if (parsed.kind !== 'receipt') {
      normalMessages.push(msg);
      continue;
    }

    const receiptAt = messageTimestamp(msg);
    const target =
      normalMessages
        .filter((m) => {
          if (m.direction !== 'OUT') return false;
          if (msg.messageId && m.messageId === msg.messageId) return true;
          return new Date(m.createdAt).getTime() <= receiptAt;
        })
        .at(-1) ?? null;

    if (!target) continue;

    const nextStatus = parsed.receiptType;
    const currentStatus = statusByMessageId.get(target.id);
    if (
      !currentStatus ||
      receiptPriority(nextStatus) > receiptPriority(currentStatus)
    ) {
      statusByMessageId.set(target.id, nextStatus);
    }
  }

  let previousDate = '';
  return normalMessages.map((msg) => {
    const date = formatDateOnly(msg.createdAt);
    const showDateSeparator = !!date && date !== previousDate;
    previousDate = date || previousDate;

    return {
      msg,
      status: statusByMessageId.get(msg.id),
      showDateSeparator,
    };
  });
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
        <div
          className={
            variant === 'bubble' ? 'max-w-[520px]' : 'mx-auto max-w-[520px]'
          }
        >
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
            {post.createdTime && (
              <span>· {formatDateTime(post.createdTime)}</span>
            )}
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
          <p className="mt-1 break-all font-mono text-[10px] text-[#9ca3af]">
            {post.id}
          </p>
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
  initialLoading?: boolean;
  highlightComment?: string;
  highlightSenderName?: string;
  showFeedCommentBanner?: boolean;
  showPostHintWhenEmpty?: boolean;
  postExpanded?: boolean;
  onTogglePostExpanded?: () => void;
  /** Hiển thị thanh hành động bình luận (thích, nhắn tin, trả lời, ẩn). */
  showCommentActions?: boolean;
  postPermalinkUrl?: string | null;
  onReplyComment?: (msg: WebhookMessage) => void;
  onMessageCustomer?: () => void;
  onCommentAction?: (commentId: string, action: CommentAction) => Promise<void>;
}

export interface ThreadMessagesHandle {
  scrollToComment: (commentId: string) => void;
}

export const ThreadMessages = forwardRef<
  ThreadMessagesHandle,
  ThreadMessagesProps
>(function ThreadMessages(
  {
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
    post,
    postLoading = false,
    initialLoading = false,
    highlightComment,
    highlightSenderName,
    showFeedCommentBanner = false,
    showPostHintWhenEmpty = false,
    postExpanded = false,
    onTogglePostExpanded,
    showCommentActions = false,
    postPermalinkUrl = null,
    onReplyComment,
    onMessageCustomer,
    onCommentAction,
  }: ThreadMessagesProps,
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isInitialScroll = useRef(true);
  const prevScrollHeight = useRef(0);
  const loadMoreLock = useRef(false);
  const canRequestOlder = useRef(false);
  const [flashCommentId, setFlashCommentId] = useState<string | null>(null);
  const [likedCommentIds, setLikedCommentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const runCommentAction = useCallback(
    async (commentId: string, action: CommentAction) => {
      if (!onCommentAction) return;
      setActionLoadingId(commentId);
      try {
        await onCommentAction(commentId, action);
        if (action === 'like') {
          setLikedCommentIds((prev) => new Set(prev).add(commentId));
        }
      } finally {
        setActionLoadingId(null);
      }
    },
    [onCommentAction],
  );

  const scrollToComment = useCallback((commentId: string) => {
    const root = scrollRef.current;
    if (!root) return false;

    const el = root.querySelector<HTMLElement>(
      `[data-comment-id="${CSS.escape(commentId)}"]`,
    );
    if (!el) return false;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashCommentId(commentId);
    window.setTimeout(() => {
      setFlashCommentId((current) => (current === commentId ? null : current));
    }, 2000);
    return true;
  }, []);

  useImperativeHandle(ref, () => ({ scrollToComment }), [scrollToComment]);

  useEffect(() => {
    isInitialScroll.current = true;
    loadMoreLock.current = false;
    canRequestOlder.current = false;
  }, [customerName]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (isInitialScroll.current && messages.length > 0) {
      el.scrollTop = el.scrollHeight;
      isInitialScroll.current = false;
      canRequestOlder.current = false;
      return;
    }

    if (
      prevScrollHeight.current > 0 &&
      el.scrollHeight > prevScrollHeight.current
    ) {
      const delta = el.scrollHeight - prevScrollHeight.current;
      el.scrollTop += delta;
    }
    prevScrollHeight.current = el.scrollHeight;
  }, [messages, post, postLoading]);

  useEffect(() => {
    if (!loadingMore) {
      loadMoreLock.current = false;
    }
  }, [loadingMore]);

  const handleLoadMore = useCallback(() => {
    if (!onLoadMore || loadingMore || !hasMore || loadMoreLock.current) return;
    if (isInitialScroll.current || initialLoading) return;

    const el = scrollRef.current;
    if (!el) return;

    const hasOverflow = el.scrollHeight > el.clientHeight + 24;
    if (!hasOverflow || !canRequestOlder.current || el.scrollTop > 64) return;

    loadMoreLock.current = true;
    prevScrollHeight.current = el.scrollHeight;
    onLoadMore();
  }, [onLoadMore, loadingMore, hasMore, initialLoading]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || isInitialScroll.current || initialLoading) return;

    const hasOverflow = el.scrollHeight > el.clientHeight + 24;
    if (!hasOverflow) return;

    if (el.scrollTop < 64) {
      canRequestOlder.current = true;
      handleLoadMore();
    }
  }, [handleLoadMore, initialLoading]);

  const showPost = postLoading || !!post || showPostHintWhenEmpty;
  const displayMessages = buildDisplayMessages(messages);
  const showInitialSkeleton = initialLoading && displayMessages.length === 0;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto bg-[#f3f4f6]"
    >
      {loadingMore && (
        <div className="flex justify-center py-2">
          <span className="text-xs text-[#6b7280]">
            Đang tải tin nhắn cũ hơn...
          </span>
        </div>
      )}

      {showFeedCommentBanner && (
        <div className="border-b border-[#a7f3d0] bg-[#ecfdf5] px-4 py-2 text-xs text-[#047857]">
          Bạn có thể viết bình luận mới trên bài viết hoặc chọn một bình luận
          để trả lời.
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

        {showInitialSkeleton ? (
          <ThreadMessagesSkeleton />
        ) : displayMessages.length === 0 ? (
          <p className="text-center text-sm text-[#6b7280]">
            Chưa có tin nhắn trong cuộc trò chuyện này
          </p>
        ) : (
          displayMessages.map(({ msg, status, showDateSeparator }) => {
            const isOut = msg.direction === 'OUT';
            const avatarUrl =
              msg.senderPictureUrl ??
              (isOut ? pagePictureUrl : customerPictureUrl);
            const displayName = isOut
              ? pickBetterSenderName(pageName, msg.senderName)
              : pickBetterSenderName(msg.senderName, customerName);
            const avatarSenderId = isOut
              ? undefined
              : (msg.senderId ?? customerSenderId);
            const avatarPageId = isOut ? undefined : (msg.pageId ?? pageId);
            const commentKey = getMessageCommentKey(msg);
            const isSelected =
              !!selectedCommentId && commentKey === selectedCommentId;
            const isFlashing = !!commentKey && flashCommentId === commentKey;
            const statusLabel = formatContentStatusLabel(
              msg.status,
              msg.eventType,
            );
            const isInactive = !!statusLabel;
            const isReply = isFeedCommentReply(msg);
            const parentCommentId =
              isOut && isReply ? extractParentCommentId(msg) : null;
            const parentMsg = parentCommentId
              ? messages.find(
                  (m) => getMessageCommentKey(m) === parentCommentId,
                )
              : undefined;
            const parentPreview = parentMsg
              ? getCommentPreviewText(parentMsg)
              : null;
            const hasMedia =
              msg.msgType?.includes('photo') ||
              msg.msgType?.includes('sticker') ||
              msg.msgType?.includes('video');

            const isFeedComment = msg.eventType === 'FEED_COMMENT';
            const showActions =
              showCommentActions && isFeedComment && !!commentKey;
            const canHoverReply =
              showActions &&
              !isOut &&
              msg.direction === 'IN' &&
              msg.senderId !== pageId &&
              isActiveContentStatus(msg.status);

            return (
              <div key={msg.id} className="space-y-2">
                {showDateSeparator && (
                  <div className="flex justify-center">
                    <span className="rounded-full bg-[#e5e7eb] px-3 py-1 text-[11px] text-[#6b7280]">
                      {formatDateOnly(msg.createdAt)}
                    </span>
                  </div>
                )}
                <div
                  className={`flex items-end gap-2 ${isOut ? 'flex-row-reverse' : 'flex-row'}`}
                >
                  <UserAvatar
                    name={displayName}
                    pictureUrl={avatarUrl}
                    senderId={avatarSenderId}
                    pageId={avatarPageId}
                    size="sm"
                  />
                  <div
                    className={`flex max-w-[75%] flex-col ${
                      isOut ? 'items-end' : 'items-start'
                    }`}
                  >
                    <div className="group relative">
                      {canHoverReply && onReplyComment && (
                        <div
                          className={`absolute -top-3 z-10 hidden group-hover:block ${
                            isOut ? 'left-2' : 'right-2'
                          }`}
                        >
                          <CommentActionIcon
                            label="Trả lời bình luận"
                            icon={<ReplyIcon className="h-4 w-4" />}
                            onClick={() => onReplyComment(msg)}
                          />
                        </div>
                      )}
                      <div
                        data-comment-id={commentKey ?? undefined}
                        role={onSelectMessage ? 'button' : undefined}
                        tabIndex={onSelectMessage ? 0 : undefined}
                        onClick={
                          onSelectMessage
                            ? () => {
                                void onSelectMessage(msg);
                              }
                            : undefined
                        }
                        onKeyDown={
                          onSelectMessage
                            ? (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  void onSelectMessage(msg);
                                }
                              }
                            : undefined
                        }
                        className={`rounded-2xl px-4 py-2 text-sm shadow-sm ${
                          isOut
                            ? 'rounded-br-md bg-[#dcf8c6] text-[#111827]'
                            : 'rounded-bl-md bg-white text-[#111827]'
                        } ${isSelected || isFlashing ? 'ring-2 ring-[#f59e0b]' : ''} ${
                          isInactive ? 'opacity-70' : ''
                        } ${isFlashing ? 'bg-[#fef3c7]' : ''}`}
                      >
                        {isOut &&
                          isReply &&
                          parentCommentId &&
                          parentPreview && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                scrollToComment(parentCommentId);
                              }}
                              className="mb-2 w-full rounded-lg border-l-2 border-[#86efac] bg-[#f0fdf4]/80 px-2 py-1.5 text-left transition hover:bg-[#dcfce7]"
                            >
                              <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#166534]">
                                <ReplyIcon className="h-3 w-3" />
                                Trả lời bình luận
                              </p>
                              <p className="line-clamp-2 text-xs text-[#14532d]">
                                {parentPreview}
                              </p>
                            </button>
                          )}
                        {isOut &&
                          isReply &&
                          (!parentCommentId || !parentPreview) && (
                            <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[#166534]">
                              <ReplyIcon className="h-3 w-3" />
                              Trả lời bình luận
                            </p>
                          )}
                        {!isOut && (
                          <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-[#3b82f6]">
                            {hasMedia && (
                              <ImageIcon className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <span>{displayName}</span>
                          </p>
                        )}
                        <MessageBody msg={msg} />
                        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[#9ca3af]">
                          <span>{formatDateTime(msg.createdAt)}</span>
                          {isOut && status && (
                            <span>
                              {status === 'read' ? '✓✓ Đã xem' : '✓ Đã gửi'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {showActions && commentKey && (
                      <CommentActionBar
                        msg={msg}
                        pageId={pageId}
                        postPermalinkUrl={postPermalinkUrl}
                        isOut={isOut}
                        liked={likedCommentIds.has(commentKey)}
                        actionLoading={actionLoadingId === commentKey}
                        onReply={() => onReplyComment?.(msg)}
                        onMessage={() => onMessageCustomer?.()}
                        onLike={() => void runCommentAction(commentKey, 'like')}
                        onHide={() => void runCommentAction(commentKey, 'hide')}
                        onUnhide={() =>
                          void runCommentAction(commentKey, 'unhide')
                        }
                      />
                    )}
                  </div>
                </div>
                {statusLabel && (
                  <p
                    className={`text-[11px] text-[#b45309] ${
                      isOut ? 'pr-10 text-right' : 'pl-10 text-left'
                    }`}
                  >
                    {statusLabel}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
      )}
    </div>
  );
});
