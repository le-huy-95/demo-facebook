import type { WebhookMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';

const TYPE_LABELS: Record<string, string> = {
  MESSENGER: 'Tin nhắn Messenger',
  MESSENGER_POSTBACK: 'Postback',
  FEED_COMMENT: 'Bình luận bài viết',
  FEED_POST: 'Bài viết / Feed',
  FEED_REACTION: 'Reaction',
  FEED: 'Feed',
};

const TYPE_COLORS: Record<string, string> = {
  MESSENGER: 'bg-blue-500/20 text-blue-200 border-blue-500/30',
  MESSENGER_POSTBACK: 'bg-indigo-500/20 text-indigo-200 border-indigo-500/30',
  FEED_COMMENT: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30',
  FEED_POST: 'bg-amber-500/20 text-amber-200 border-amber-500/30',
  FEED_REACTION: 'bg-pink-500/20 text-pink-200 border-pink-500/30',
  FEED: 'bg-slate-500/20 text-slate-200 border-slate-500/30',
};

export function MessageCard({ message }: { message: WebhookMessage }) {
  const label = TYPE_LABELS[message.eventType] ?? message.eventType;
  const color = TYPE_COLORS[message.eventType] ?? TYPE_COLORS.FEED;
  const time = formatDateTime(message.createdAt);

  return (
    <article className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-lg shadow-black/20">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${color}`}>{label}</span>
        {message.direction && (
          <span className="text-xs text-[var(--muted)]">{message.direction === 'IN' ? 'Đến' : 'Đi'}</span>
        )}
        <span className="ml-auto text-xs text-[var(--muted)]">{time}</span>
      </div>

      <p className="mb-3 text-sm leading-6 text-[var(--text)]">{message.content || '(Không có nội dung)'}</p>

      {message.status && message.status !== 'ACTIVE' && (
        <p className="mb-3 text-xs text-amber-600">
          {message.status === 'HIDDEN'
            ? 'Đã bị ẩn trên Facebook'
            : message.status === 'DELETED'
              ? 'Đã bị xóa trên Facebook'
              : `Trạng thái: ${message.status}`}
        </p>
      )}

      <dl className="grid gap-1 text-xs text-[var(--muted)] sm:grid-cols-2">
        {message.senderName && (
          <div>
            <dt className="inline font-medium">Người gửi: </dt>
            <dd className="inline">{message.senderName}</dd>
          </div>
        )}
        {message.pageId && (
          <div>
            <dt className="inline font-medium">Page ID: </dt>
            <dd className="inline font-mono">{message.pageId}</dd>
          </div>
        )}
        {message.postId && (
          <div>
            <dt className="inline font-medium">Post ID: </dt>
            <dd className="inline font-mono">{message.postId}</dd>
          </div>
        )}
        {message.commentId && (
          <div>
            <dt className="inline font-medium">Comment ID: </dt>
            <dd className="inline font-mono">{message.commentId}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}
