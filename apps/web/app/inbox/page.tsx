'use client';

import { Suspense } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { MessageCard } from '@/components/message-card';
import { ShopCard } from '@/components/shop-card';
import { UnlinkConfirmModal } from '@/components/unlink-confirm-modal';
import {
  getAuthStatus,
  getMessages,
  initiateOAuth,
  logout,
  subscribeMessages,
  toggleShopPin,
  unlinkShop,
  type FacebookPage,
  type WebhookMessage,
} from '@/lib/api';

const FILTERS = [
  { key: 'ALL', label: 'Tất cả' },
  { key: 'MESSENGER', label: 'Messenger' },
  { key: 'FEED_COMMENT', label: 'Bình luận' },
  { key: 'FEED_POST', label: 'Bài viết' },
];

function InboxPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activePageId = searchParams.get('pageId');
  const [messages, setMessages] = useState<WebhookMessage[]>([]);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [filter, setFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<FacebookPage | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [status, msgs] = await Promise.all([
        getAuthStatus(),
        getMessages(filter === 'ALL' ? undefined : filter),
      ]);

      if (!status.data.connected) {
        router.replace('/login');
        return;
      }

      setConnected(true);
      setPages(status.data.pages);
      setMessages(msgs.data);
    } catch {
      router.replace('/login');
    } finally {
      setLoading(false);
    }
  }, [filter, router]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!connected) return;
    return subscribeMessages((msg) => {
      setMessages((prev) => {
        if (prev.some((p) => p.id === msg.id)) return prev;
        if (filter !== 'ALL' && msg.eventType !== filter) return prev;
        return [msg, ...prev];
      });
    });
  }, [connected, filter]);

  const filtered = useMemo(() => {
    let list = messages;
    if (filter !== 'ALL') {
      list = list.filter((m) => m.eventType === filter);
    }
    if (activePageId) {
      list = list.filter((m) => m.pageId === activePageId);
    }
    return list;
  }, [messages, filter, activePageId]);

  const reconnect = async () => {
    const { data } = await initiateOAuth('Fanpage Demo');
    window.open(data.url, 'facebook_oauth', 'width=600,height=720');
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      router.replace('/login');
    } catch {
      setLoggingOut(false);
    }
  };

  const handlePin = async (shop: FacebookPage) => {
    const targetId = shop.id;
    try {
      const { data } = await toggleShopPin(targetId);
      setPages((prev) => {
        const updated = prev.map((s) =>
          s.id === targetId ? { ...s, isPinned: data.isPinned } : s,
        );
        return [...updated].sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return 0;
        });
      });
    } catch {
      // ignore
    }
  };

  const handleUnlinkConfirm = async () => {
    if (!unlinkTarget) return;
    setUnlinking(true);
    try {
      const { data } = await unlinkShop(unlinkTarget.id);
      setPages((prev) => prev.filter((s) => s.id !== unlinkTarget.id));
      setUnlinkTarget(null);
      if (data.remainingPages === 0) {
        router.replace('/login');
      }
    } catch {
      setUnlinking(false);
    } finally {
      setUnlinking(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-[var(--muted)]">Đang tải hộp thư...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-8">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-[var(--muted)]">Facebook Webhook Inbox</p>
          <h1 className="text-3xl font-semibold">Tin nhắn & Bình luận</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {pages.length} page đã liên kết · realtime qua SSE
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/shops"
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm hover:bg-white/5"
          >
            Danh sách shop
          </Link>
          <button
            type="button"
            onClick={reconnect}
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm hover:bg-white/5"
          >
            Liên kết thêm Page
          </button>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="rounded-xl border border-red-500/40 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-60"
          >
            {loggingOut ? 'Đang đăng xuất...' : 'Đăng xuất'}
          </button>
        </div>
      </header>

      {pages.length > 0 && (
        <section className="mb-6 rounded-2xl border border-[var(--border)] bg-[#f8fafc] p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium text-[#374151]">Shop đã liên kết</p>
            <Link href="/shops" className="text-xs text-[#3b82f6] hover:underline">
              Xem tất cả
            </Link>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {pages.map((p) => (
              <ShopCard
                key={p.id}
                shop={p}
                selected={activePageId ? p.pageId === activePageId : false}
                onClick={() => router.push(`/inbox?pageId=${p.pageId}`)}
                onPin={handlePin}
                onUnlink={setUnlinkTarget}
              />
            ))}
          </div>
        </section>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-4 py-2 text-sm transition ${
              filter === f.key
                ? 'bg-[var(--accent)] text-white'
                : 'border border-[var(--border)] text-[var(--muted)] hover:bg-white/5'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <section className="grid gap-4">
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--border)] p-10 text-center text-[var(--muted)]">
            Chưa có tin nhắn. Hãy gửi tin nhắn tới Page hoặc bình luận trên bài viết để webhook đẩy dữ liệu vào đây.
          </div>
        ) : (
          filtered.map((message) => <MessageCard key={message.id} message={message} />)
        )}
      </section>

      <UnlinkConfirmModal
        shop={unlinkTarget}
        loading={unlinking}
        onClose={() => setUnlinkTarget(null)}
        onConfirm={handleUnlinkConfirm}
      />
    </main>
  );
}

export default function InboxPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center">
          <p className="text-[var(--muted)]">Đang tải hộp thư...</p>
        </main>
      }
    >
      <InboxPageClient />
    </Suspense>
  );
}
