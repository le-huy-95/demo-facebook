'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ConversationKind, ConversationThread } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import { UserAvatar } from '@/components/user-avatar';

interface ConversationListProps {
  items: ConversationThread[];
  selectedId: string | null;
  activeTab: ConversationKind;
  onTabChange: (tab: ConversationKind) => void;
  tabCounts: { messenger: number; comment: number };
  tabUnread: { messenger: number; comment: number };
  onSelect: (thread: ConversationThread) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  unreadMap?: Record<string, number>;
}

function TabButton({
  active,
  label,
  count,
  unread,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  unread: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'relative flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2.5 text-sm font-medium transition',
        active
          ? 'border-[#2563eb] text-[#2563eb]'
          : 'border-transparent text-[#6b7280] hover:text-[#374151]',
      ].join(' ')}
    >
      <span>{label}</span>
      {count > 0 && (
        <span
          className={[
            'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
            active ? 'bg-[#dbeafe] text-[#1d4ed8]' : 'bg-[#f3f4f6] text-[#6b7280]',
          ].join(' ')}
        >
          {count}
        </span>
      )}
      {unread > 0 && (
        <span
          aria-label={`${unread} chưa đọc`}
          className="absolute right-1 top-1 min-w-[18px] rounded-full bg-[#dc2626] px-1 text-center text-[10px] font-semibold text-white"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

export function ConversationList({
  items,
  selectedId,
  activeTab,
  onTabChange,
  tabCounts,
  tabUnread,
  onSelect,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  unreadMap = {},
}: ConversationListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreLock = useRef(false);
  const canRequestMore = useRef(false);

  const handleLoadMore = useCallback(() => {
    if (!onLoadMore || loadingMore || !hasMore || loadMoreLock.current) return;

    const el = scrollRef.current;
    if (!el) return;

    const hasOverflow = el.scrollHeight > el.clientHeight + 24;
    const nearBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 80;

    if (!hasOverflow || !canRequestMore.current || !nearBottom) return;

    loadMoreLock.current = true;
    onLoadMore();
  }, [onLoadMore, loadingMore, hasMore]);

  useEffect(() => {
    if (!loadingMore) {
      loadMoreLock.current = false;
    }
  }, [loadingMore]);

  useEffect(() => {
    canRequestMore.current = false;
    loadMoreLock.current = false;
  }, [activeTab, items.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const hasOverflow = el.scrollHeight > el.clientHeight + 24;
    if (!hasOverflow) return;

    const nearBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 80;

    if (nearBottom) {
      canRequestMore.current = true;
      handleLoadMore();
    }
  }, [handleLoadMore]);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-[#e5e7eb]">
        <div className="flex">
          <TabButton
            active={activeTab === 'MESSENGER'}
            label="Tin nhắn"
            count={tabCounts.messenger}
            unread={tabUnread.messenger}
            onClick={() => onTabChange('MESSENGER')}
          />
          <TabButton
            active={activeTab === 'FEED_COMMENT'}
            label="Bình luận"
            count={tabCounts.comment}
            unread={tabUnread.comment}
            onClick={() => onTabChange('FEED_COMMENT')}
          />
        </div>
        <div className="p-3 pt-2">
          <input
            type="search"
            placeholder={activeTab === 'MESSENGER' ? 'Tìm tin nhắn' : 'Tìm bình luận'}
            className="w-full rounded-lg border border-[#e5e7eb] bg-[#f9fafb] px-3 py-2 text-sm outline-none focus:border-[#3b82f6]"
          />
        </div>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="p-4 text-center text-sm text-[#6b7280]">
            {activeTab === 'MESSENGER'
              ? 'Chưa có tin nhắn Messenger'
              : 'Chưa có bình luận bài viết'}
          </p>
        ) : (
          <>
            {items.map((item) => {
              const active = selectedId === item.id;
              const unreadCount = item.unreadCount ?? 0;
              const hasUnread = unreadCount > 0;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item)}
                  className={`flex w-full gap-3 border-b border-[#f3f4f6] px-3 py-3 text-left transition hover:bg-[#f8fafc] ${
                    active ? 'bg-[#eff6ff]' : ''
                  }`}
                >
                  <UserAvatar
                    name={item.senderName}
                    pictureUrl={item.senderPictureUrl}
                    senderId={item.senderId}
                    pageId={item.pageId}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className={`truncate text-sm ${
                          hasUnread
                            ? 'font-bold text-[#111827]'
                            : 'font-semibold text-[#111827]'
                        }`}
                      >
                        {item.senderName}
                      </p>
                      <span
                        className={`shrink-0 text-[11px] ${
                          hasUnread
                            ? 'font-semibold text-[#2563eb]'
                            : 'text-[#9ca3af]'
                        }`}
                      >
                        {formatDateTime(item.lastMessageAt)}
                      </span>
                    </div>
                    <p
                      className={`mt-0.5 truncate text-xs ${
                        hasUnread
                          ? 'font-semibold text-[#374151]'
                          : 'text-[#6b7280]'
                      }`}
                    >
                      {item.preview}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end justify-between gap-2 pb-1">
                    {hasUnread && (
                      <span
                        aria-label={`${unreadCount} tin nhắn chưa đọc`}
                        className={[
                          'min-w-5 rounded-full bg-[#dc2626] px-1.5 py-0.5',
                          'text-center text-[11px] font-semibold text-white',
                        ].join(' ')}
                      >
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
            {loadingMore && (
              <div className="flex justify-center py-3">
                <span className="text-xs text-[#9ca3af]">Đang tải thêm...</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
