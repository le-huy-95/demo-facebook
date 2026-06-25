'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthStatus, initiateOAuth } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    getAuthStatus()
      .then(({ data }) => {
        if (data.connected) router.replace('/shops');
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [router]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'FACEBOOK_OAUTH_SUCCESS') {
        router.push('/shops');
      }
      if (event.data?.type === 'FACEBOOK_OAUTH_ERROR') {
        setError(event.data.message ?? 'Đăng nhập thất bại');
        setLoading(false);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [router]);

  const handleLogin = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const { data } = await initiateOAuth('Fanpage Demo');
      const popup = window.open(data.url, 'facebook_oauth', 'width=600,height=720');

      if (!popup) {
        setError('Trình duyệt chặn popup. Hãy cho phép popup và thử lại.');
        setLoading(false);
        return;
      }

      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          setLoading(false);
          getAuthStatus()
            .then(({ data: status }) => {
              if (status.connected) router.push('/shops');
            })
            .catch(() => {});
        }
      }, 800);
    } catch (err: any) {
      setError(err.message ?? 'Không thể bắt đầu đăng nhập');
      setLoading(false);
    }
  }, [router]);

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <p className="text-[var(--muted)]">Đang kiểm tra phiên đăng nhập...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-[var(--border)] bg-[var(--card)] p-8 shadow-2xl shadow-black/30">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/20 text-2xl font-bold text-blue-300">
            f
          </div>
          <h1 className="text-2xl font-semibold">Facebook Pancake Demo</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Đăng nhập Facebook Page để nhận tin nhắn Messenger và bình luận bài viết qua webhook.
          </p>
        </div>

        <button
          type="button"
          onClick={handleLogin}
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
        >
          {loading ? 'Đang mở Facebook...' : 'Đăng nhập bằng Facebook Page'}
        </button>

        {error && <p className="mt-4 text-center text-sm text-red-300">{error}</p>}

        <ul className="mt-8 space-y-2 text-xs text-[var(--muted)]">
          <li>• OAuth liên kết Fanpage bạn quản lý</li>
          <li>• Webhook nhận Messenger + bình luận feed</li>
          <li>• Hiển thị realtime trên trang Inbox</li>
        </ul>
      </div>
    </main>
  );
}
