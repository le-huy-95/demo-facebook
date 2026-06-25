'use client';

import type { FacebookShop } from '@/lib/api';

interface UnlinkConfirmModalProps {
  shop: FacebookShop | null;
  loading?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function UnlinkConfirmModal({ shop, loading, onClose, onConfirm }: UnlinkConfirmModalProps) {
  if (!shop) return null;

  const name = shop.name ?? shop.pageId;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
      >
        <div className="flex gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#fff7ed] text-[#f97316]">
            <span className="text-lg font-bold">?</span>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-[#111827]">
              Bạn có chắc chắn muốn huỷ kích hoạt trang &quot;{name}&quot;?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[#6b7280]">
              Trang này sẽ bị bỏ khỏi gói cước và các nhân viên trên trang sẽ không thể truy cập được
              nữa. Bạn có thể kích hoạt lại trang trong mục Kết nối.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-[#e5e7eb] bg-white px-4 py-2 text-sm text-[#374151] hover:bg-[#f9fafb] disabled:opacity-60"
          >
            Đóng
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-lg bg-[#fef2f2] px-4 py-2 text-sm font-medium text-[#dc2626] hover:bg-[#fee2e2] disabled:opacity-60"
          >
            {loading ? 'Đang xử lý...' : 'Huỷ kích hoạt'}
          </button>
        </div>
      </div>
    </div>
  );
}
