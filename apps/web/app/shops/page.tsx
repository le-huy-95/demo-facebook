'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShopCard } from '@/components/shop-card';
import { UnlinkConfirmModal } from '@/components/unlink-confirm-modal';
import {
  getAuthStatus,
  getFacebookShops,
  initiateOAuth,
  logout,
  toggleShopPin,
  unlinkShop,
  type FacebookShop,
} from '@/lib/api';

type PlatformFilter = 'ALL' | 'FACEBOOK';

export default function ShopsPage() {
  const router = useRouter();
  const [shops, setShops] = useState<FacebookShop[]>([]);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [platform, setPlatform] = useState<PlatformFilter>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<FacebookShop | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = await getAuthStatus();
      if (!status.data.connected) {
        router.replace('/login');
        return;
      }

      const { data } = await getFacebookShops();
      setShops(data);
      if (data.length > 0) {
        setSelectedId((prev) => prev ?? data[0].id);
      }
    } catch {
      router.replace('/login');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (platform === 'FACEBOOK') {
      return shops.filter((s) => s.platform === 'facebook');
    }
    return shops;
  }, [shops, platform]);

  const reconnect = async () => {
    const { data } = await initiateOAuth('Fanpage Demo');
    const popup = window.open(data.url, 'facebook_oauth', 'width=600,height=720');
    if (!popup) return;

    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        load();
      }
    }, 800);
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

  const openInbox = () => {
    if (selectedId) {
      const shop = shops.find((s) => s.id === selectedId);
      if (shop) {
        router.push(`/conversations/${shop.pageId}`);
        return;
      }
    }
    router.push('/inbox');
  };

  const handlePin = async (shop: FacebookShop) => {
    const targetId = shop.id;
    try {
      const { data } = await toggleShopPin(targetId);
      setSelectedId(targetId);
      setShops((prev) => {
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
      setShops((prev) => prev.filter((s) => s.id !== unlinkTarget.id));
      setUnlinkTarget(null);
      if (selectedId === unlinkTarget.id) {
        setSelectedId(null);
      }
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
        <p className="text-[var(--muted)]">Đang tải danh sách shop...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-[var(--muted)]">Quản lý shop</p>
          <h1 className="text-2xl font-semibold">Danh sách Fanpage</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reconnect}
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm hover:bg-white/5"
          >
            Liên kết thêm Page
          </button>
          <button
            type="button"
            onClick={openInbox}
            className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            Mở hội thoại
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

      <section className="rounded-2xl border border-[var(--border)] bg-[#f8fafc] p-5 shadow-inner">
        <div className="mb-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setPlatform('ALL')}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
              platform === 'ALL'
                ? 'bg-white text-[#111827] shadow-sm'
                : 'text-[#6b7280] hover:bg-white/60'
            }`}
          >
            Tất cả
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                platform === 'ALL' ? 'bg-[#3b82f6] text-white' : 'bg-[#e5e7eb] text-[#6b7280]'
              }`}
            >
              {shops.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setPlatform('FACEBOOK')}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
              platform === 'FACEBOOK'
                ? 'bg-white text-[#111827] shadow-sm'
                : 'text-[#6b7280] hover:bg-white/60'
            }`}
          >
            Facebook
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                platform === 'FACEBOOK' ? 'bg-[#3b82f6] text-white' : 'bg-[#e5e7eb] text-[#6b7280]'
              }`}
            >
              {shops.filter((s) => s.platform === 'facebook').length}
            </span>
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#d1d5db] bg-white p-10 text-center text-sm text-[#6b7280]">
            Chưa có shop nào. Hãy đăng nhập Facebook và liên kết Fanpage.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {filtered.map((shop) => (
              <ShopCard
                key={shop.id}
                shop={shop}
                selected={selectedId === shop.id}
                onClick={() => router.push(`/conversations/${shop.pageId}`)}
                onPin={handlePin}
                onUnlink={setUnlinkTarget}
              />
            ))}
          </div>
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
