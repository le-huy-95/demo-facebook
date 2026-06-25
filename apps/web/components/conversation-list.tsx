'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { ConversationThread } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import { UserAvatar } from '@/components/user-avatar';

function EnvelopeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 text-[#6b7280]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4 6h16v12H4z" strokeLinejoin="round" />
      <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 text-[#6b7280]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M7 9h10M7 13h6" strokeLinecap="round" />
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3V7a2 2 0 0 1 2-2z" strokeLinejoin="round" />
    </svg>
  );
}

interface ConversationListProps {
  items: ConversationThread[];
  selectedId: string | null;
  onSelect: (thread: ConversationThread) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function ConversationList({
  items,
  selectedId,
  onSelect,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: ConversationListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);

  const handleLoadMore = useCallback(() => {
    if (!onLoadMore || loadingMore || !hasMore) return;
    onLoadMore();
  }, [onLoadMore, loadingMore, hasMore]);

  useEffect(() => {
    const sentinel = bottomSentinelRef.current;
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

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="border-b border-[#e5e7eb] p-3">
        <input
          type="search"
          placeholder="Tìm kiếm"
          className="w-full rounded-lg border border-[#e5e7eb] bg-[#f9fafb] px-3 py-2 text-sm outline-none focus:border-[#3b82f6]"
        />
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="p-4 text-center text-sm text-[#6b7280]">Chưa có hội thoại nào</p>
        ) : (
          <>
            {items.map((item) => {
            const active = selectedId === item.id;
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
                    <p className="truncate text-sm font-semibold text-[#111827]">{item.senderName}</p>
                    <span className="shrink-0 text-[11px] text-[#9ca3af]">{formatDateTime(item.lastMessageAt)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[#6b7280]">{item.preview}</p>
                </div>
                <div className="flex shrink-0 items-end pb-1">
                  {item.kind === 'FEED_COMMENT' ? <EnvelopeIcon /> : <MessageIcon />}
                </div>
              </button>
            );
          })}
            {hasMore && (
              <div ref={bottomSentinelRef} className="flex justify-center py-3">
                {loadingMore ? (
                  <span className="text-xs text-[#9ca3af]">Đang tải thêm...</span>
                ) : (
                  <span className="text-xs text-[#d1d5db]">·</span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
