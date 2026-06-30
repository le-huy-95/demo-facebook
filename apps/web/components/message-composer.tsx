'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { uploadFile, sendThreadMessage } from '@/lib/api';
import { isValidFacebookCommentId } from '@/lib/conversation';
import { CommentReplyPreview } from '@/components/comment-reply-preview';
import { UserAvatar } from '@/components/user-avatar';

interface MessageComposerProps {
  pageId: string;
  threadId: string;
  shopPictureUrl?: string | null;
  commentId?: string | null;
  /** Messenger: mid của tin nhắn đang reply (không dùng cho thread comment). */
  replyToMessageId?: string | null;
  /** Nội dung rút gọn của bình luận / tin nhắn đang trả lời. */
  replyPreview?: string | null;
  /** Nhãn preview (Messenger vs comment). */
  replyPreviewLabel?: string;
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
    savedEventId?: string;
    fbMessageId?: string | null;
    msgType?: string;
    content?: string;
  }) => void;
  onAck?: (payload: {
    clientMessageId: string;
    ok: boolean;
    fbMessageId?: string | null;
    savedEventId?: string;
    error?: string;
  }) => void;
  /** Báo parent đang gửi/upload — chặn hiển thị tin OUT từ socket trước khi xong. */
  onBusyChange?: (busy: boolean) => void;
}

type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

interface PendingAttachment {
  file: File;
  type: AttachmentKind;
  previewUrl: string | null;
  loading: boolean;
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

function LoadingSpinner({ className }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className ?? ''}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 14.93-4.06"
      />
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
  replyPreviewLabel = 'Trả lời bình luận',
  replyMentionName = null,
  onReplyPreviewClick,
  onClearReply,
  iconOnlyActions = false,
  disabled = false,
  allowAttachments = true,
  onSent,
  onAck,
  onBusyChange,
}: MessageComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastMentionKeyRef = useRef<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [pendingAttachment, setPendingAttachment] =
    useState<PendingAttachment | null>(null);
  const pendingPreviewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    onBusyChange?.(sending || uploading);
  }, [sending, uploading, onBusyChange]);

  useEffect(() => {
    return () => {
      if (pendingPreviewUrlRef.current) {
        URL.revokeObjectURL(pendingPreviewUrlRef.current);
        pendingPreviewUrlRef.current = null;
      }
    };
  }, []);

  function clearPendingAttachment() {
    if (pendingPreviewUrlRef.current) {
      URL.revokeObjectURL(pendingPreviewUrlRef.current);
      pendingPreviewUrlRef.current = null;
    }
    setPendingAttachment(null);
  }

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
      clearPendingAttachment();
    }
  }, [commentId]);

  function inferAttachmentType(mime: string): AttachmentKind {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'file';
  }

  function buildOptimisticAttachmentPayload(
    type: AttachmentKind,
    url: string,
    caption: string,
    isCommentThread: boolean,
    isReply: boolean,
  ): { msgType: string; content: string } {
    const trimmed = caption.trim();
    if (type === 'image') {
      const payload = trimmed
        ? { text: trimmed, href: url, type: 'image', title: 'Ảnh' }
        : { href: url, type: 'image', title: 'Ảnh' };
      return {
        msgType: isCommentThread
          ? isReply
            ? 'feed.comment.reply.photo'
            : 'feed.comment.photo'
          : 'chat.photo',
        content: JSON.stringify(payload),
      };
    }
    if (type === 'video') {
      const payload = trimmed
        ? { text: trimmed, href: url, type: 'video', title: 'Video' }
        : { href: url, type: 'video', title: 'Video' };
      return {
        msgType: isCommentThread
          ? isReply
            ? 'feed.comment.reply.video'
            : 'feed.comment.video'
          : 'chat.video.msg',
        content: JSON.stringify(payload),
      };
    }
    const label = type === 'audio' ? 'Audio' : 'Tệp đính kèm';
    const payload = trimmed
      ? { text: trimmed, href: url, type, title: label }
      : { href: url, type, title: label };
    return {
      msgType: isCommentThread
        ? isReply
          ? 'feed.comment.reply'
          : 'feed.comment'
        : type === 'file'
          ? 'share.file'
          : 'chat.video.msg',
      content: JSON.stringify(payload),
    };
  }

  const sendAttachment = useCallback(
    async (attachment: PendingAttachment, caption: string) => {
      const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { file, type } = attachment;
      const sentText = caption.trim() || file.name;
      const isCommentThread = threadId.startsWith('comment:');
      const replyCommentId =
        commentId && isValidFacebookCommentId(commentId) ? commentId : undefined;

      setUploading(true);
      setError(null);

      try {
        const { data } = await uploadFile(file);
        setUploading(false);
        setSending(true);

        const ack = await sendThreadMessage({
          pageId,
          threadId,
          commentId: replyCommentId,
          ...(isCommentThread || replyCommentId
            ? {}
            : { replyToMessageId: replyToMessageId ?? undefined }),
          text: caption.trim() || '',
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
        } else {
          const isReply = Boolean(replyCommentId);
          const optimistic = buildOptimisticAttachmentPayload(
            type,
            data.url,
            caption.trim(),
            isCommentThread,
            isReply,
          );
          onSent?.({
            clientMessageId,
            text: sentText,
            pending: false,
            savedEventId: ack.savedEventId,
            fbMessageId: ack.fbMessageId,
            msgType: optimistic.msgType,
            content: optimistic.content,
          });
          setText('');
          clearPendingAttachment();
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Upload file thất bại');
      } finally {
        setSending(false);
        setUploading(false);
      }
    },
    [
      pageId,
      threadId,
      commentId,
      replyToMessageId,
      onSent,
      onAck,
    ],
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && !pendingAttachment) || sending || uploading || disabled) {
      return;
    }

    if (pendingAttachment) {
      void sendAttachment(pendingAttachment, trimmed);
      return;
    }

    const isCommentThread = threadId.startsWith('comment:');
    const replyCommentId =
      commentId && isValidFacebookCommentId(commentId) ? commentId : undefined;

    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSending(true);
    setError(null);

    void sendThreadMessage({
      pageId,
      threadId,
      commentId: replyCommentId,
      ...(isCommentThread || replyCommentId
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
          onSent?.({
            clientMessageId,
            text: trimmed,
            pending: false,
            savedEventId: ack.savedEventId,
            fbMessageId: ack.fbMessageId,
          });
          setText('');
        } else {
          setError(ack.error ?? 'Gửi tin nhắn thất bại');
        }
      })
      .catch((e: unknown) => {
        setSending(false);
        setError(e instanceof Error ? e.message : 'Gửi tin nhắn thất bại');
      });
  }, [
    text,
    pendingAttachment,
    sending,
    uploading,
    disabled,
    pageId,
    threadId,
    commentId,
    replyToMessageId,
    onSent,
    onAck,
    sendAttachment,
  ]);

  const handleSelectFile = useCallback(
    (file: File) => {
      if (!allowAttachments || disabled || sending || uploading) return;
      setError(null);

      const type = inferAttachmentType(file.type || '');
      const canPreview = type === 'image' || type === 'video';

      if (pendingPreviewUrlRef.current) {
        URL.revokeObjectURL(pendingPreviewUrlRef.current);
        pendingPreviewUrlRef.current = null;
      }

      setPendingAttachment({
        file,
        type,
        previewUrl: null,
        loading: canPreview,
      });

      if (!canPreview) return;

      requestAnimationFrame(() => {
        const previewUrl = URL.createObjectURL(file);
        pendingPreviewUrlRef.current = previewUrl;
        setPendingAttachment({
          file,
          type,
          previewUrl,
          loading: false,
        });
      });
    },
    [allowAttachments, disabled, sending, uploading],
  );

  const isReplyingComment = Boolean(commentId);
  const isReplyingMessenger = Boolean(replyToMessageId && !commentId);
  const isCommentThread = threadId.startsWith('comment:');
  const showReplyPreview = isReplyingComment || isReplyingMessenger;
  const canSend = Boolean(text.trim() || pendingAttachment);
  const isBusy = sending || uploading;
  const attachmentPreviewLoading = Boolean(
    pendingAttachment?.loading && !pendingAttachment.previewUrl,
  );

  return (
    <div className="space-y-2">
      {showReplyPreview && (
        <CommentReplyPreview
          preview={replyPreview?.trim() || (isReplyingMessenger ? 'Tin nhắn' : 'Bình luận')}
          label={replyPreviewLabel}
          variant="composer"
          onClick={onReplyPreviewClick}
          actions={
            <>
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
            </>
          }
        />
      )}
      <div className="rounded-2xl border border-[#e5e7eb] bg-white px-3 py-3">
        <div className="flex items-end gap-2">
          <UserAvatar
            name="Shop"
            pictureUrl={shopPictureUrl}
            size="sm"
            className="mt-1"
          />
          <div className="relative min-w-0 flex-1 space-y-2">
            {pendingAttachment && (
              <div className="relative overflow-hidden rounded-xl border border-[#e5e7eb] bg-[#f9fafb]">
                {pendingAttachment.type === 'image' && pendingAttachment.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={pendingAttachment.previewUrl}
                    alt={pendingAttachment.file.name}
                    className="max-h-40 w-full object-contain"
                  />
                ) : pendingAttachment.type === 'video' && pendingAttachment.previewUrl ? (
                  <video
                    src={pendingAttachment.previewUrl}
                    className="max-h-40 w-full object-contain"
                    muted
                    playsInline
                  />
                ) : (
                  <div className="flex min-h-[72px] items-center gap-3 px-4 py-3">
                    <span className="text-2xl" aria-hidden>
                      {pendingAttachment.type === 'audio' ? '🎵' : '📎'}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[#111827]">
                        {pendingAttachment.file.name}
                      </p>
                      <p className="text-xs text-[#6b7280]">
                        {pendingAttachment.type === 'audio' ? 'Audio' : 'Tệp đính kèm'}
                      </p>
                    </div>
                  </div>
                )}
                {attachmentPreviewLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                    <LoadingSpinner className="h-6 w-6 text-[#3b82f6]" />
                  </div>
                )}
                {!isBusy && (
                  <button
                    type="button"
                    aria-label="Bỏ đính kèm"
                    onClick={clearPendingAttachment}
                    className="absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#111827]/70 text-white transition hover:bg-[#111827]"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
            <div className="relative">
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
              disabled={disabled || isBusy}
              rows={2}
              aria-busy={isBusy}
              placeholder={
                sending
                  ? 'Đang gửi...'
                  : uploading
                    ? 'Đang upload...'
                    : pendingAttachment
                      ? 'Thêm chú thích (tuỳ chọn)...'
                    : commentId
                      ? 'Trả lời bình luận... (Enter để gửi)'
                      : isReplyingMessenger
                        ? 'Trả lời tin nhắn... (Enter để gửi)'
                        : isCommentThread
                        ? 'Viết bình luận mới trên bài viết... (Enter để gửi)'
                        : 'Nhập tin nhắn... (Enter để gửi, Shift+Enter xuống dòng)'
              }
              className={`min-h-[44px] w-full resize-none rounded-xl border border-[#e5e7eb] bg-white py-3 text-sm text-[#111827] outline-none ring-[#3b82f6] focus:ring-2 disabled:bg-[#f3f4f6] ${
                isBusy ? 'pr-11 pl-4' : 'px-4'
              }`}
            />
            {isBusy && (
              <span
                className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[#3b82f6]"
                aria-hidden
              >
                <LoadingSpinner className="h-5 w-5" />
              </span>
            )}
            </div>
          </div>
          <div className="flex shrink-0 items-end gap-2">
            {allowAttachments ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  disabled={disabled || sending || uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleSelectFile(f);
                    e.currentTarget.value = '';
                  }}
                />
                <ComposerIconButton
                  label={
                    pendingAttachment ? 'Đổi file / ảnh' : 'Đính kèm file / ảnh'
                  }
                  icon={<PaperclipIcon className="h-5 w-5" />}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled || isBusy}
                />
              </>
            ) : iconOnlyActions ? (
              <ComposerIconButton
                label="Bình luận chỉ hỗ trợ văn bản. Dùng Messenger để gửi ảnh/file."
                icon={<PaperclipIcon className="h-5 w-5" />}
                disabled
              />
            ) : null}
          {iconOnlyActions ? (
            <ComposerIconButton
              label={
                sending
                  ? 'Đang gửi'
                  : uploading
                    ? 'Đang upload'
                    : commentId
                      ? 'Gửi phản hồi'
                      : isReplyingMessenger
                        ? 'Gửi trả lời'
                        : isCommentThread
                        ? 'Gửi bình luận mới'
                        : 'Gửi'
              }
              icon={
                isBusy ? (
                  <LoadingSpinner className="h-5 w-5" />
                ) : (
                  <SendIcon className="h-5 w-5" />
                )
              }
              onClick={handleSend}
              disabled={disabled || isBusy || !canSend}
            />
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled || isBusy || !canSend}
              className="inline-flex min-w-[88px] items-center justify-center gap-2 rounded-xl bg-[#3b82f6] px-4 py-3 text-sm font-medium text-white hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:bg-[#93c5fd]"
            >
              {isBusy && <LoadingSpinner className="h-4 w-4" />}
              {sending ? 'Đang gửi...' : uploading ? 'Đang upload...' : 'Gửi'}
            </button>
          )}
          </div>
        </div>
        {!allowAttachments && !iconOnlyActions && (
        <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-[#9ca3af]">
              Bình luận chỉ hỗ trợ văn bản. Dùng Messenger để gửi ảnh/file.
            </p>
        </div>
        )}
      </div>
      {error && <p className="text-xs text-[#dc2626]">{error}</p>}
    </div>
  );
}
