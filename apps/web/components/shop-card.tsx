'use client';

import type { FacebookShop } from '@/lib/api';

interface ShopCardProps {
  shop: FacebookShop;
  selected?: boolean;
  onClick?: () => void;
  onPin?: (shop: FacebookShop) => void;
  onUnlink?: (shop: FacebookShop) => void;
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 fill-[#1877F2]" aria-hidden>
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function UnlinkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" />
      <path d="m8 16 8-8" strokeLinecap="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M16 3v2h2v2h-2v3.17l1.59 1.59L16 13.83V16h-2v5l-2-1-2 1v-5H8v-2.17l-1.59-1.59L8 10.17V7H6V5h2V3h8z" />
    </svg>
  );
}

export function ShopCard({ shop, selected, onClick, onPin, onUnlink }: ShopCardProps) {
  const initials = (shop.name ?? shop.pageId).slice(0, 1).toUpperCase();
  const showActions = Boolean(onPin || onUnlink);

  return (
    <div
      className={`group relative w-full rounded-xl border bg-white shadow-sm transition hover:shadow-md ${
        shop.isPinned
          ? 'border-[#fdba74] ring-1 ring-[#f97316]/25'
          : selected
            ? 'border-[#3b82f6] ring-2 ring-[#3b82f6]/30'
            : 'border-[#e5e7eb]'
      }`}
    >
      {shop.isPinned && (
        <div
          title="Đã ghim"
          className="pointer-events-none absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-[#f97316] text-white shadow-sm transition-opacity group-hover:opacity-0"
        >
          <PinIcon />
        </div>
      )}

      {showActions && (
        <div className="pointer-events-none absolute right-2 top-2 z-20 flex gap-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          {onUnlink && (
            <button
              type="button"
              title="Hủy liên kết"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onUnlink(shop);
              }}
              className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full bg-[#fef2f2] text-[#ef4444] shadow-sm transition hover:bg-[#fee2e2]"
            >
              <UnlinkIcon />
            </button>
          )}
          {onPin && (
            <button
              type="button"
              title={shop.isPinned ? 'Bỏ ghim trang' : 'Ghim trang'}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onPin(shop);
              }}
              className={`pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full shadow-sm transition ${
                shop.isPinned
                  ? 'bg-[#f97316] text-white hover:bg-[#ea580c]'
                  : 'bg-[#fff7ed] text-[#f97316] hover:bg-[#ffedd5]'
              }`}
            >
              <PinIcon />
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left ${shop.isPinned ? 'pr-10' : ''}`}
      >
        {shop.pictureUrl ? (
          <img
            src={shop.pictureUrl}
            alt={shop.name ?? shop.pageId}
            className="h-12 w-12 shrink-0 rounded-lg object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#1877F2]/10 text-lg font-semibold text-[#1877F2]">
            {initials}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#111827]">{shop.name ?? 'Facebook Page'}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[#6b7280]">
            <FacebookIcon />
            <span className="truncate font-mono">{shop.pageId}</span>
          </p>
        </div>
      </button>
    </div>
  );
}
