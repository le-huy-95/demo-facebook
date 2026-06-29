'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { uploadFile, sendThreadMessage } from '@/lib/api';
import { UserAvatar } from '@/components/user-avatar';

interface MessageComposerProps {
  pageId: string;
  threadId: string;
  shopPictureUrl?: string | null;
  commentId?: string | null;
  /** Messenger: mid của tin nhắn đang reply (không dùng cho thread comment). */
  replyToMessageId?: string | null;
  /** Nội dung rút gọn của bình luận đang trả lời. */
  replyPreview?: string | null;
  /** Tag @tên khi trả lời bình luận. */
  replyMentionName?: string | null;
  /** Click vào preview để cuộn tới bình luận gốc. */
  onReplyPreviewClick?: () => void;
  /** Bỏ chọn bình luận đang trả lời. */
  onClearReply?: () => void;
  /** Chỉ hiển thị icon cho các thao tác của composer, dùng cho màn hình comment. */
  iconOnlyActions?: boolean;
  disabled?: boolean;
  allowAttachments?: boolean;
  onSent?: (payload: {
    clientMessageId: string;
    text: string;
    pending: boolean;
  }) => void;
  onAck?: (payload: {
    clientMessageId: string;
    ok: boolean;
    fbMessageId?: string | null;
    savedEventId?: string;
    error?: string;
  }) => void;
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

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M17.28 2.72a1 1 0 0 0-1.04-.23L3.64 7.54a1 1 0 0 0 .05 1.88l5.03 1.68 1.68 5.03a1 1 0 0 0 1.88.05l5.05-12.6a1 1 0 0 0-.05-1.04ZM10.03 9.96 5.9 8.58l8.76-3.5-4.63 4.88Zm1.39 4.14-1.38-4.13 4.88-4.63-3.5 8.76Z" />
    </svg>
  );
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M7.25 17.5a4.75 4.75 0 0 1-3.36-8.11l5.8-5.8a3.25 3.25 0 1 1 4.6 4.6l-5.8 5.8a1.75 1.75 0 1 1-2.48-2.48l5.48-5.48a.75.75 0 1 1 1.06 1.06l-5.48 5.48a.25.25 0 0 0 .36.36l5.8-5.8a1.75 1.75 0 1 0-2.48-2.48l-5.8 5.8a3.25 3.25 0 1 0 4.6 4.6l5.8-5.8a.75.75 0 1 1 1.06 1.06l-5.8 5.8A4.73 4.73 0 0 1 7.25 17.5Z" />
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
      <path d="M10 4.5C5.5 4.5 2 10 2 10s3.5 5.5 8 5.5 8-5.5 8-5.5-3.5-5.5-8-5.5Zm0 9a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
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

function ComposerIconButton({
  label,
  icon,
  onClick,
  disabled = false,
  type = 'button',
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <IconTooltip label={label}>
      <button
        type={type}
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#3b82f6] text-white transition hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:bg-[#93c5fd]"
      >
        {icon}
      </button>
    </IconTooltip>
  );
}

export function MessageComposer({
  pageId,
  threadId,
  shopPictureUrl = null,
  commentId = null,
  replyToMessageId = null,
  replyPreview = null,
  replyMentionName = null,
  onReplyPreviewClick,
  onClearReply,
  iconOnlyActions = false,
  disabled = false,
  allowAttachments = true,
  onSent,
  onAck,
}: MessageComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastMentionKeyRef = useRef<string | null>(null);

  const [uploading, setUploading] = useState(false);

  // Prefill @tên khi chọn bình luận để trả lời
  useEffect(() => {
    if (!commentId || !replyMentionName?.trim()) return;

    const mentionKey = `${commentId}:${replyMentionName.trim()}`;
    if (lastMentionKeyRef.current === mentionKey) return;
    lastMentionKeyRef.current = mentionKey;

    const mention = `@${replyMentionName.trim()} `;
    setText(mention);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(mention.length, mention.length);
    });
  }, [commentId, replyMentionName]);

  useEffect(() => {
    if (!commentId) {
      lastMentionKeyRef.current = null;
      setText('');
    }
  }, [commentId]);

  function inferAttachmentType(
    mime: string,
  ): 'image' | 'video' | 'audio' | 'file' {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'file';
  }

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;

    const isCommentThread = threadId.startsWith('comment:');
    if (isCommentThread && !commentId) return;

    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSending(true);
    setError(null);
    onSent?.({ clientMessageId, text: trimmed, pending: true });

    void sendThreadMessage({
      pageId,
      threadId,
      commentId: commentId ?? undefined,
      ...(isCommentThread || commentId
        ? {}
        : { replyToMessageId: replyToMessageId ?? undefined }),
      text: trimmed,
      clientMessageId,
    })
      .then((ack) => {
        setSending(false);
        onAck?.({
          clientMessageId,
          ok: ack.ok,
          fbMessageId: ack.fbMessageId,
          savedEventId: ack.savedEventId,
          error: ack.error,
        });
        if (ack.ok) {
          setText('');
        } else {
          const msg = ack.error ?? 'Gửi tin nhắn thất bại';
          setError(
            msg.includes('commentId')
              ? 'Không tìm thấy comment để trả lời. Hãy chọn một bình luận trong thread trước.'
              : msg,
          );
        }
      })
      .catch((e: unknown) => {
        setSending(false);
        setError(e instanceof Error ? e.message : 'Gửi tin nhắn thất bại');
      });
  }, [
    text,
    sending,
    disabled,
    pageId,
    threadId,
    commentId,
    replyToMessageId,
    onSent,
    onAck,
  ]);

  const handleAttach = useCallback(
    async (file: File) => {
      if (!allowAttachments || disabled || sending || uploading) return;
      setUploading(true);
      setError(null);

      const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const type = inferAttachmentType(file.type || '');

      onSent?.({
        clientMessageId,
        text: text.trim() || file.name,
        pending: true,
      });

      try {
        const { data } = await uploadFile(file);
        const ack = await sendThreadMessage({
          pageId,
          threadId,
          commentId: commentId ?? undefined,
          ...(threadId.startsWith('comment:') || commentId
            ? {}
            : { replyToMessageId: replyToMessageId ?? undefined }),
          text: text.trim() || '',
          clientMessageId,
          attachment: { type, url: data.url },
        });
        onAck?.({
          clientMessageId,
          ok: ack.ok,
          fbMessageId: ack.fbMessageId,
          savedEventId: ack.savedEventId,
          error: ack.error,
        });
        if (!ack.ok) {
          setError(ack.error ?? 'Gửi file thất bại');
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Upload file thất bại');
      } finally {
        setUploading(false);
      }
    },
    [
      allowAttachments,
      disabled,
      sending,
      uploading,
      pageId,
      threadId,
      commentId,
      replyToMessageId,
      onSent,
      onAck,
      text,
    ],
  );

  const isReplyingComment = Boolean(commentId);
  const isReplyingMessage = Boolean(replyToMessageId);
  const isReplying = isReplyingComment || isReplyingMessage;
  const isCommentThread = threadId.startsWith('comment:');
  const needsCommentSelection = isCommentThread && !commentId;
  const canSend = Boolean(text.trim()) && !needsCommentSelection;

  return (
    <div className="space-y-2">
      {commentId && (
        <div className="flex w-full items-start gap-2 rounded-xl border border-[#fcd34d] bg-[#fffbeb] px-3 py-2">
          <button
            type="button"
            onClick={onReplyPreviewClick}
            className="flex min-w-0 flex-1 items-start gap-2 text-left transition hover:opacity-90"
          >
            <ReplyIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" />
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-[#b45309]">
                Đang trả lời bình luận
              </span>
              <span className="block truncate text-sm text-[#78350f]">
                {replyPreview?.trim() || 'Bình luận'}
              </span>
            </span>
          </button>
          {onReplyPreviewClick && (
            <IconTooltip label="Xem bình luận gốc">
              <button
                type="button"
                onClick={onReplyPreviewClick}
                className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#d97706] transition hover:bg-[#fde68a]"
              >
                <EyeIcon className="h-4 w-4" />
              </button>
            </IconTooltip>
          )}
          {onClearReply && (
            <IconTooltip label="Bỏ chọn">
              <button
                type="button"
                onClick={onClearReply}
                className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#b45309] transition hover:bg-[#fde68a]"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </IconTooltip>
          )}
        </div>
      )}
      <div className="rounded-2xl border border-[#e5e7eb] bg-white px-3 py-3">
        <div className="flex items-end gap-2">
          <UserAvatar
            name="Shop"
            pictureUrl={shopPictureUrl}
            size="sm"
            className="mt-1"
          />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            disabled={disabled || sending || uploading}
            rows={2}
            placeholder={
              commentId
                ? 'Trả lời bình luận... (Enter để gửi)'
                : isCommentThread
                  ? 'Chọn bình luận để trả lời...'
                  : 'Nhập tin nhắn... (Enter để gửi, Shift+Enter xuống dòng)'
            }
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-[#e5e7eb] bg-white px-4 py-3 text-sm text-[#111827] outline-none ring-[#3b82f6] focus:ring-2 disabled:bg-[#f3f4f6]"
          />
          {iconOnlyActions ? (
            <ComposerIconButton
              label={
                sending
                  ? 'Đang gửi'
                  : uploading
                    ? 'Đang upload'
                    : 'Gửi bình luận'
              }
              icon={<SendIcon className="h-5 w-5" />}
              onClick={handleSend}
              disabled={disabled || sending || uploading || !canSend}
            />
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled || sending || uploading || !canSend}
              className="rounded-xl bg-[#3b82f6] px-4 py-3 text-sm font-medium text-white hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:bg-[#93c5fd]"
            >
              {sending ? 'Đang gửi...' : uploading ? 'Đang upload...' : 'Gửi'}
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          {allowAttachments ? (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1 text-sm text-[#374151] hover:bg-[#f9fafb]">
              <input
                type="file"
                className="hidden"
                disabled={disabled || sending || uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleAttach(f);
                  e.currentTarget.value = '';
                }}
              />
              <span className="text-base">📎</span>
              <span>
                {uploading ? 'Đang upload...' : 'Đính kèm file / ảnh'}
              </span>
            </label>
          ) : iconOnlyActions ? (
            <ComposerIconButton
              label="Bình luận chỉ hỗ trợ văn bản. Dùng Messenger để gửi ảnh/file."
              icon={<PaperclipIcon className="h-4 w-4" />}
              disabled
            />
          ) : (
            <p className="text-xs text-[#9ca3af]">
              Bình luận chỉ hỗ trợ văn bản. Dùng Messenger để gửi ảnh/file.
            </p>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-[#dc2626]">{error}</p>}
    </div>
  );
}
