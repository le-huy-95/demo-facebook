'use client';

import { useMemo, useState } from 'react';
import { API_BASE } from '@/lib/api';

interface UserAvatarProps {
  name?: string | null;
  pictureUrl?: string | null;
  senderId?: string | null;
  pageId?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClass = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
} as const;

export function UserAvatar({
  name,
  pictureUrl,
  senderId,
  pageId,
  size = 'md',
  className = '',
}: UserAvatarProps) {
  const [failed, setFailed] = useState(false);
  const label = (name || '?').slice(0, 1).toUpperCase();

  const proxyUrl = useMemo(() => {
    if (!senderId || !pageId) return null;
    const qs = new URLSearchParams({ pageId, psid: senderId });
    return `${API_BASE}/conversations/avatar?${qs}`;
  }, [senderId, pageId]);

  const src = !failed ? (pictureUrl || proxyUrl) : null;

  if (src) {
    return (
      <img
        src={src}
        alt={name || 'Avatar'}
        className={`shrink-0 rounded-full object-cover bg-[#e5e7eb] ${sizeClass[size]} ${className}`}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-[#e5e7eb] font-semibold text-[#374151] ${sizeClass[size]} ${className}`}
      aria-hidden
    >
      {label}
    </div>
  );
}
