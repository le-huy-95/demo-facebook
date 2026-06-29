'use client';

import { useCallback, useState } from 'react';
import { uploadFile } from '@/lib/api';
import { sendMessage } from '@/lib/socket';
import { UserAvatar } from '@/components/user-avatar';

interface MessageComposerProps {
  pageId: string;
  threadId: string;
  shopPictureUrl?: string | null;
  commentId?: string | null;
  replyToMessageId?: string | null;
  replyPreview?: string | null;
  replySenderName?: string | null;
  onClearReplyTarget?: () => void;
  disabled?: boolean;
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

export function MessageComposer({
  pageId,
  threadId,
  shopPictureUrl = null,
  commentId = null,
  replyToMessageId = null,
  replyPreview = null,
  replySenderName = null,
  onClearReplyTarget,
  disabled = false,
  onSent,
  onAck,
}: MessageComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);

  function inferAttachmentType(mime: string): 'image' | 'video' | 'audio' | 'file' {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'file';
  }

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;

    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSending(true);
    setError(null);
    onSent?.({ clientMessageId, text: trimmed, pending: true });

    sendMessage(
      {
        pageId,
        threadId,
        commentId: commentId ?? undefined,
        replyToMessageId: replyToMessageId ?? undefined,
        text: trimmed,
        clientMessageId,
      },
      (ack) => {
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
          setError(ack.error ?? 'Gửi tin nhắn thất bại');
        }
      },
    );
  }, [text, sending, disabled, pageId, threadId, commentId, replyToMessageId, onSent, onAck]);

  const handleAttach = useCallback(
    async (file: File) => {
      if (disabled || sending || uploading) return;
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
        sendMessage(
          {
            pageId,
            threadId,
            commentId: commentId ?? undefined,
            replyToMessageId: replyToMessageId ?? undefined,
            text: text.trim() || '',
            clientMessageId,
            attachment: { type, url: data.url },
          },
          (ack) => {
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
          },
        );
      } catch (e: any) {
        setError(e?.message ?? 'Upload file thất bại');
      } finally {
        setUploading(false);
      }
    },
    [disabled, sending, uploading, pageId, threadId, commentId, replyToMessageId, onSent, onAck, text],
  );

  const isReplyingComment = Boolean(commentId);
  const isReplyingMessage = Boolean(replyToMessageId);
  const isReplying = isReplyingComment || isReplyingMessage;

  return (
    <div className="space-y-2">
      {isReplying && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-xs text-[#92400e]">
          <div className="min-w-0">
            <p className="font-semibold">
              {isReplyingComment ? 'Đang trả lời bình luận' : 'Đang trả lời tin nhắn'}
            </p>
            {replySenderName ? <p className="mt-0.5 text-[#a16207]">cho {replySenderName}</p> : null}
            {replyPreview ? (
              <p className="mt-0.5 line-clamp-2 text-[#a16207]">{replyPreview}</p>
            ) : null}
          </div>
          {onClearReplyTarget ? (
            <button
              type="button"
              onClick={onClearReplyTarget}
              className="shrink-0 rounded-lg border border-[#f59e0b]/30 bg-white/60 px-2 py-1 text-[#92400e] hover:bg-white"
            >
              Hủy
            </button>
          ) : null}
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
            placeholder="Nhập tin nhắn... (Enter để gửi, Shift+Enter xuống dòng)"
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-[#e5e7eb] bg-white px-4 py-3 text-sm text-[#111827] outline-none ring-[#3b82f6] focus:ring-2 disabled:bg-[#f3f4f6]"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled || sending || uploading || !text.trim()}
            className="rounded-xl bg-[#3b82f6] px-4 py-3 text-sm font-medium text-white hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:bg-[#93c5fd]"
          >
            {sending ? 'Đang gửi...' : uploading ? 'Đang upload...' : 'Gửi'}
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
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
            <span>{uploading ? 'Đang upload...' : 'Đính kèm file / ảnh'}</span>
          </label>
          <p className="text-xs text-[#6b7280]">
            {isReplyingComment
              ? 'Trả lời bình luận'
              : isReplyingMessage
                ? 'Trả lời tin nhắn'
                : 'Tin nhắn'}
          </p>
        </div>
      </div>
      {error && <p className="text-xs text-[#dc2626]">{error}</p>}
    </div>
  );
}
