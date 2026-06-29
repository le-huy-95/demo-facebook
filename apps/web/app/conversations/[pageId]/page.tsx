'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ConversationList } from '@/components/conversation-list';
import {
  ThreadMessages,
  type ThreadMessagesHandle,
} from '@/components/conversation-thread';
import { UserAvatar } from '@/components/user-avatar';
import {
  getAuthStatus,
  getConversationMessages,
  getConversations,
  getPostPreview,
  initiateOAuth,
  performCommentAction,
  subscribeMessages,
  syncComments,
  type CommentAction,
  type ConversationKind,
  type ConversationThread,
  type FacebookPostPreview,
  type FeedSyncedPayload,
  type WebhookMessage,
} from '@/lib/api';
import {
  buildMessengerThreadId,
  buildThreadFromEvent,
  enrichEventForThread,
  findCommentMessageById,
  isValidFacebookCommentId,
  mergeThreadMessages,
  pickBetterSenderName,
  pickDefaultReplyComment,
  resolveCustomerNameFromMessages,
  resolveThreadIdFromEvent,
} from '@/lib/conversation';
import { isActiveContentStatus } from '@/lib/event-status';
import { getCommentPreviewText, isReceiptMessage } from '@/lib/message-content';
import { MessageComposer } from '@/components/message-composer';
import {
  joinPageRoom,
  leavePageRoom,
  joinThreadRoom,
  leaveThreadRoom,
  onWebhookEvent,
  onContentRemoved,
  onFeedSynced,
} from '@/lib/socket';

function MessageIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M4.5 4A2.5 2.5 0 0 0 2 6.5v5A2.5 2.5 0 0 0 4.5 14H6v2.25a.75.75 0 0 0 1.2.6L11 14h4.5A2.5 2.5 0 0 0 18 11.5v-5A2.5 2.5 0 0 0 15.5 4h-11Zm0 1.5h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5l-3 2.25V12.5h-3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M16.25 3a.75.75 0 0 1 .75.75V8a.75.75 0 0 1-.75.75H12a.75.75 0 0 1 0-1.5h2.3A5.5 5.5 0 0 0 4.9 6.1a.75.75 0 1 1-1.2-.9 7 7 0 0 1 11.8 1.18V3.75a.75.75 0 0 1 .75-.75ZM3.75 11.25H8a.75.75 0 0 1 0 1.5H5.7a5.5 5.5 0 0 0 9.4 1.15.75.75 0 1 1 1.2.9A7 7 0 0 1 4.5 13.62v2.63a.75.75 0 0 1-1.5 0V12a.75.75 0 0 1 .75-.75Z" />
    </svg>
  );
}

function IconTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-[#111827] px-2 py-1 text-[11px] font-medium text-white shadow-lg group-hover/tooltip:block group-focus-within/tooltip:block"
      >
        {label}
      </span>
    </span>
  );
}

function CommentHeaderIconButton({
  label,
  icon,
  onClick,
  className = '',
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <IconTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#3b82f6] bg-[#eff6ff] text-[#1d4ed8] transition hover:bg-[#dbeafe] ${className}`}
      >
        {icon}
      </button>
    </IconTooltip>
  );
}

export default function ConversationsPage() {
  const params = useParams();
  const pageId = params.pageId as string;

  const extractPostIdFromText = useCallback(
    (text: string | null | undefined): string | null => {
      if (!text) return null;

      // Case 1: Already a Graph post id like "pageId_storyFbid"
      const direct = text.match(/\b(\d+_\d+)\b/);
      if (direct?.[1]) return direct[1];

      // Case 2: permalink.php?story_fbid=...&id=...
      const perm = text.match(/https?:\/\/[^\s)]+/g) ?? [];
      for (const rawUrl of perm) {
        try {
          const url = new URL(rawUrl.replace(/[)\].,]+$/, ''));
          const storyFbid = url.searchParams.get('story_fbid');
          const id = url.searchParams.get('id');
          if (storyFbid && id) return `${id}_${storyFbid}`;

          // Case 3: /posts/<pageId>_<fbid>
          const m = url.pathname.match(/\/posts\/(\d+_\d+)/);
          if (m?.[1]) return m[1];
        } catch {
          // ignore invalid URL
        }
      }

      return null;
    },
    [],
  );

  const [pageName, setPageName] = useState('');
  const [pagePictureUrl, setPagePictureUrl] = useState<string | null>(null);
  const [commentPermissionsOk, setCommentPermissionsOk] = useState(true);
  const [missingCommentScopes, setMissingCommentScopes] = useState<string[]>(
    [],
  );
  const [webhookFeedOk, setWebhookFeedOk] = useState(true);
  const [conversations, setConversations] = useState<ConversationThread[]>([]);
  const [activeTab, setActiveTab] = useState<ConversationKind>('MESSENGER');
  const [selected, setSelected] = useState<ConversationThread | null>(null);
  const [messages, setMessages] = useState<WebhookMessage[]>([]);
  const [post, setPost] = useState<FacebookPostPreview | null>(null);
  const [highlightComment, setHighlightComment] = useState<string | undefined>(
    undefined,
  );
  const [replyCommentId, setReplyCommentId] = useState<string | null>(null);
  const [replyPreview, setReplyPreview] = useState<string | null>(null);
  const [replyMentionName, setReplyMentionName] = useState<string | null>(null);
  const [postExpanded, setPostExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [postLoading, setPostLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [messagesCursor, setMessagesCursor] = useState<string | null>(null);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] =
    useState(false);
  const [conversationsCursor, setConversationsCursor] = useState<string | null>(
    null,
  );
  const seenConversationEventIdsRef = useRef<Set<string>>(new Set());
  const threadLoadSeqRef = useRef(0);
  const selectedThreadIdRef = useRef<string | null>(null);
  /** Thread user đã mở rõ ràng (sidebar hoặc click vào nội dung cuộc trò chuyện). */
  const explicitlyOpenedThreadIdRef = useRef<string | null>(null);
  const threadMessagesRef = useRef<ThreadMessagesHandle>(null);

  useEffect(() => {
    selectedThreadIdRef.current = selected?.id ?? null;
  }, [selected?.id]);

  const filteredConversations = useMemo(
    () => conversations.filter((c) => c.kind === activeTab),
    [conversations, activeTab],
  );

  const tabCounts = useMemo(
    () => ({
      messenger: conversations.filter((c) => c.kind === 'MESSENGER').length,
      comment: conversations.filter((c) => c.kind === 'FEED_COMMENT').length,
    }),
    [conversations],
  );

  const tabUnread = useMemo(
    () => ({
      messenger: conversations
        .filter((c) => c.kind === 'MESSENGER')
        .reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
      comment: conversations
        .filter((c) => c.kind === 'FEED_COMMENT')
        .reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
    }),
    [conversations],
  );

  const replyTargetPreview = useMemo(() => {
    if (!replyCommentId) return null;
    const target = findCommentMessageById(messages, replyCommentId);
    if (target) return getCommentPreviewText(target);
    return replyPreview;
  }, [replyCommentId, messages, replyPreview]);

  const scrollToReplyTarget = useCallback(() => {
    if (!replyCommentId) return;
    threadMessagesRef.current?.scrollToComment(replyCommentId);
  }, [replyCommentId]);

  const shouldApplyConversationEvent = useCallback(
    (eventId: string): boolean => {
      const seen = seenConversationEventIdsRef.current;
      if (seen.has(eventId)) return false;

      seen.add(eventId);
      if (seen.size > 500) {
        const oldest = seen.values().next().value;
        if (oldest) seen.delete(oldest);
      }
      return true;
    },
    [],
  );

  const appendRealtimeMessage = useCallback(
    (event: WebhookMessage, threadId: string) => {
      if (selectedThreadIdRef.current !== threadId) return;

      setMessages((msgs) => {
        if (msgs.some((m) => m.id === event.id)) return msgs;

        const commentKey = event.commentId ?? event.messageId;
        if (
          event.eventType === 'FEED_COMMENT' &&
          commentKey &&
          msgs.some(
            (m) =>
              m.eventType === 'FEED_COMMENT' &&
              (m.commentId === commentKey || m.messageId === commentKey),
          )
        ) {
          return msgs;
        }

        if (
          event.messageId &&
          msgs.some(
            (m) =>
              m.messageId === event.messageId && m.msgType === event.msgType,
          )
        ) {
          return msgs;
        }

        let next = msgs;
        if (event.direction === 'OUT') {
          const commentKey = event.commentId ?? event.messageId;
          if (commentKey) {
            const dup = msgs.some(
              (m) => m.commentId === commentKey || m.messageId === commentKey,
            );
            if (dup) return msgs;
          }
          if (event.content) {
            next = msgs.filter(
              (m) =>
                !(
                  m.id.startsWith('client-') &&
                  m.direction === 'OUT' &&
                  m.content === event.content
                ),
            );
          }
        }

        return [...next, event];
      });
    },
    [],
  );

  const applyInboundCommentRealtime = useCallback(
    (event: WebhookMessage, threadId: string) => {
      setActiveTab('FEED_COMMENT');

      const currentId = selectedThreadIdRef.current;

      if (currentId === threadId) {
        appendRealtimeMessage(event, threadId);
        return;
      }

      const onCommentThread = currentId?.startsWith('comment:') ?? false;

      // Đang xem tab Tin nhắn hoặc chưa chọn thread → mở luôn thread bình luận mới
      if (!onCommentThread) {
        const thread = buildThreadFromEvent(
          enrichEventForThread(event),
          threadId,
        );
        if (!thread) return;

        selectedThreadIdRef.current = threadId;
        setSelected(thread);
        setMessages([event]);
        setMessagesCursor(null);
        setHasMoreMessages(false);
        setHighlightComment(undefined);
        setPostExpanded(false);

        const commentId = event.commentId ?? event.messageId;
        if (event.direction === 'IN' && isValidFacebookCommentId(commentId)) {
          setReplyCommentId(commentId);
          setReplyPreview(event.content ?? null);
          setReplyMentionName(
            pickBetterSenderName(event.senderName, thread.senderName),
          );
        }
      }
    },
    [appendRealtimeMessage],
  );

  const refreshSelectedThreadMessages = useCallback(async () => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId) return;

    try {
      const { data: msgs, paging } = await getConversationMessages(
        pageId,
        threadId,
        {
          limit: 15,
        },
      );
      setMessages((prev) => mergeThreadMessages(prev, msgs));
      setMessagesCursor(paging.nextBefore);
      setHasMoreMessages(paging.hasMore);

      if (threadId.startsWith('comment:')) {
        const defaultReply = pickDefaultReplyComment(msgs, pageId);
        setReplyCommentId(defaultReply.commentId);
        setReplyPreview(defaultReply.preview);
        if (defaultReply.commentId) {
          const target = findCommentMessageById(msgs, defaultReply.commentId);
          setReplyMentionName(pickBetterSenderName(target?.senderName, null));
        } else {
          setReplyMentionName(null);
        }
      }
    } catch {
      // bỏ qua lỗi refresh nền
    }
  }, [pageId]);

  const loadConversations = useCallback(async () => {
    const status = await getAuthStatus();
    const page = status.data.pages.find((p) => p.pageId === pageId);
    setPageName(page?.name ?? pageId);
    setPagePictureUrl(page?.pictureUrl ?? null);
    setCommentPermissionsOk(page?.commentPermissionsOk !== false);
    setMissingCommentScopes(page?.missingCommentScopes ?? []);
    setWebhookFeedOk(page?.feedSubscribed !== false);

    const { data, paging } = await getConversations(pageId, { limit: 15 });
    const filtered = data.filter((c) => c.pageId === pageId);
    setConversations((prev) => {
      const prevUnread = new Map(prev.map((c) => [c.id, c.unreadCount ?? 0]));
      const openedId = explicitlyOpenedThreadIdRef.current;

      return filtered.map((c) => {
        if (c.id === openedId) {
          return { ...c, unreadCount: 0 };
        }
        const preserved = prevUnread.get(c.id) ?? 0;
        return {
          ...c,
          unreadCount: Math.max(c.unreadCount ?? 0, preserved),
        };
      });
    });
    setConversationsCursor(paging.nextBefore);
    setHasMoreConversations(paging.hasMore);
    return filtered;
  }, [pageId]);

  const handleFeedSynced = useCallback(
    (payload: FeedSyncedPayload) => {
      if (payload.pageId !== pageId) return;

      setActiveTab('FEED_COMMENT');
      void loadConversations().then((list) => {
        const threadId = selectedThreadIdRef.current;
        if (!threadId) return;

        void refreshSelectedThreadMessages();
        const selectedThread = list?.find((c) => c.id === threadId);
        if (selectedThread) {
          setSelected((prev) =>
            prev?.id === threadId ? { ...prev, ...selectedThread } : prev,
          );
        }
      });
    },
    [loadConversations, pageId, refreshSelectedThreadMessages],
  );

  const updateConversationFromEvent = useCallback(
    (event: WebhookMessage, threadId: string, reloadMissing: boolean) => {
      if (isReceiptMessage(event) || !shouldApplyConversationEvent(event.id))
        return;

      setConversations((prev) => {
        const existing = prev.find((c) => c.id === threadId);
        if (!existing) {
          const created = buildThreadFromEvent(event, threadId);
          if (created) {
            return [created, ...prev].sort(
              (a, b) =>
                new Date(b.lastMessageAt).getTime() -
                new Date(a.lastMessageAt).getTime(),
            );
          }
          if (reloadMissing) void loadConversations();
          return prev;
        }

        const updated = prev.map((c) =>
          c.id === threadId
            ? {
                ...c,
                preview: event.content ?? c.preview,
                lastMessageAt: event.createdAt,
                messageCount: c.messageCount + 1,
                unreadCount:
                  event.direction === 'IN' &&
                  explicitlyOpenedThreadIdRef.current !== threadId
                    ? (c.unreadCount ?? 0) + 1
                    : explicitlyOpenedThreadIdRef.current === threadId
                      ? 0
                      : (c.unreadCount ?? 0),
              }
            : c,
        );

        return [...updated].sort(
          (a, b) =>
            new Date(b.lastMessageAt).getTime() -
            new Date(a.lastMessageAt).getTime(),
        );
      });
    },
    [loadConversations, shouldApplyConversationEvent],
  );

  const handleRealtimeEvent = useCallback(
    (raw: WebhookMessage, reloadMissing: boolean) => {
      if (raw.pageId !== pageId) return;

      const event = enrichEventForThread(raw);
      const threadId = resolveThreadIdFromEvent(event);
      if (!threadId) return;

      updateConversationFromEvent(event, threadId, reloadMissing);

      if (event.eventType === 'FEED_COMMENT') {
        if (event.direction === 'IN') {
          applyInboundCommentRealtime(event, threadId);
        } else if (selectedThreadIdRef.current === threadId) {
          appendRealtimeMessage(event, threadId);
        }
        return;
      }

      appendRealtimeMessage(event, threadId);
    },
    [
      appendRealtimeMessage,
      applyInboundCommentRealtime,
      pageId,
      updateConversationFromEvent,
    ],
  );

  const loadMoreConversations = useCallback(async () => {
    if (
      !hasMoreConversations ||
      loadingMoreConversations ||
      !conversationsCursor
    )
      return;

    setLoadingMoreConversations(true);
    try {
      const { data, paging } = await getConversations(pageId, {
        limit: 15,
        before: conversationsCursor,
      });

      setConversations((prev) => {
        const ids = new Set(prev.map((c) => c.id));
        const unique = data.filter((c) => !ids.has(c.id));
        return [...prev, ...unique];
      });
      setConversationsCursor(paging.nextBefore);
      setHasMoreConversations(paging.hasMore);
    } finally {
      setLoadingMoreConversations(false);
    }
  }, [
    hasMoreConversations,
    loadingMoreConversations,
    conversationsCursor,
    pageId,
  ]);

  const markThreadAsRead = useCallback((threadId: string) => {
    explicitlyOpenedThreadIdRef.current = threadId;
    setConversations((prev) =>
      prev.map((c) => (c.id === threadId ? { ...c, unreadCount: 0 } : c)),
    );
    setSelected((prev) =>
      prev?.id === threadId ? { ...prev, unreadCount: 0 } : prev,
    );
  }, []);

  const loadThread = useCallback(
    async (thread: ConversationThread, options?: { markRead?: boolean }) => {
      const markRead = options?.markRead === true;
      const loadSeq = threadLoadSeqRef.current + 1;
      threadLoadSeqRef.current = loadSeq;
      selectedThreadIdRef.current = thread.id;
      if (markRead) {
        markThreadAsRead(thread.id);
      }
      setSelected(markRead ? { ...thread, unreadCount: 0 } : thread);
      setMessages([]);
      setMessagesCursor(null);
      setHasMoreMessages(false);
      setMessagesLoading(true);
      setHighlightComment(undefined);
      setReplyCommentId(null);
      setReplyPreview(null);
      setReplyMentionName(null);
      setPostExpanded(false);

      try {
        const { data: msgs, paging } = await getConversationMessages(
          pageId,
          thread.id,
          { limit: 15 },
        );
        if (threadLoadSeqRef.current !== loadSeq) return;

        const resolvedName = resolveCustomerNameFromMessages(
          msgs,
          thread.senderName,
        );
        const enrichedThread = {
          ...thread,
          senderName: resolvedName,
          unreadCount: markRead ? 0 : (thread.unreadCount ?? 0),
        };
        setSelected(enrichedThread);
        setConversations((prev) =>
          prev.map((c) =>
            c.id === thread.id
              ? {
                  ...c,
                  senderName: resolvedName,
                  unreadCount: markRead ? 0 : (c.unreadCount ?? 0),
                }
              : c,
          ),
        );
        setMessages(msgs);
        setMessagesCursor(paging.nextBefore);
        setHasMoreMessages(paging.hasMore);

        if (thread.kind === 'FEED_COMMENT') {
          const defaultReply = pickDefaultReplyComment(msgs, pageId);
          setReplyCommentId(defaultReply.commentId);
          setReplyPreview(defaultReply.preview);
          if (defaultReply.commentId) {
            const target = findCommentMessageById(msgs, defaultReply.commentId);
            setReplyMentionName(
              pickBetterSenderName(target?.senderName, resolvedName),
            );
          } else {
            setReplyMentionName(null);
          }
        }

        // Auto-detect postId from latest message (Messenger threads) so the post panel shows up without requiring a click.
        if (thread.kind !== 'FEED_COMMENT') {
          const latestWithPost =
            [...msgs]
              .reverse()
              .map(
                (m) =>
                  m.postId ??
                  extractPostIdFromText(m.content) ??
                  extractPostIdFromText(m.rawPayload),
              )
              .find(Boolean) ?? null;

          if (latestWithPost) {
            setPostLoading(true);
            try {
              const { data: postData } = await getPostPreview(
                pageId,
                latestWithPost,
              );
              if (threadLoadSeqRef.current !== loadSeq) return;
              setPost(postData);
            } catch {
              // keep last post panel on error
            } finally {
              if (threadLoadSeqRef.current === loadSeq) setPostLoading(false);
            }
          }
        }
      } finally {
        if (threadLoadSeqRef.current === loadSeq) setMessagesLoading(false);
      }

      if (thread.kind === 'FEED_COMMENT' && thread.postId) {
        setPostLoading(true);
        try {
          const { data: postData } = await getPostPreview(
            pageId,
            thread.postId,
          );
          if (threadLoadSeqRef.current !== loadSeq) return;
          setPost(postData);
        } catch {
          if (threadLoadSeqRef.current === loadSeq) setPost(null);
        } finally {
          if (threadLoadSeqRef.current === loadSeq) setPostLoading(false);
        }
      } else {
        // Keep the last post panel by default for Messenger threads unless user clicks a message with postId
        if (threadLoadSeqRef.current === loadSeq) setPostLoading(false);
      }
    },
    [pageId, markThreadAsRead],
  );

  const handleTabChange = useCallback(
    (tab: ConversationKind) => {
      setActiveTab(tab);
      const first = conversations.find((c) => c.kind === tab);
      if (first) {
        void loadThread(first);
        return;
      }
      setSelected(null);
      setMessages([]);
      setPost(null);
      setMessagesCursor(null);
      setHasMoreMessages(false);
    },
    [conversations, loadThread],
  );

  const handleSelectMessage = useCallback(
    async (msg: WebhookMessage) => {
      if (msg.eventType === 'FEED_COMMENT' && msg.content) {
        setHighlightComment(msg.content);
      } else {
        setHighlightComment(undefined);
      }

      if (selected?.kind === 'FEED_COMMENT') {
        const commentKey = msg.commentId ?? msg.messageId;
        // Chỉ reply vào bình luận IN của khách — tránh dùng comment OUT Page (ID có thể đã hết hạn)
        if (
          msg.direction === 'IN' &&
          msg.senderId !== pageId &&
          isActiveContentStatus(msg.status) &&
          isValidFacebookCommentId(commentKey)
        ) {
          setReplyCommentId(commentKey);
          setReplyPreview(msg.content ?? null);
          setReplyMentionName(
            pickBetterSenderName(msg.senderName, selected.senderName),
          );
        }
      }

      const inferredPostId =
        msg.postId ??
        extractPostIdFromText(msg.content) ??
        extractPostIdFromText(msg.rawPayload);
      if (!inferredPostId) return;

      setPostLoading(true);
      try {
        const { data } = await getPostPreview(pageId, inferredPostId);
        setPost(data);
        setPostExpanded(false);
      } catch {
        // Giữ panel bài viết hiện tại khi lỗi
      } finally {
        setPostLoading(false);
      }
    },
    [pageId, extractPostIdFromText, selected?.kind, selected?.senderName],
  );

  const handleReplyToComment = useCallback(
    (msg: WebhookMessage) => {
      const commentKey = msg.commentId ?? msg.messageId;
      if (
        msg.direction !== 'IN' ||
        msg.senderId === pageId ||
        !isActiveContentStatus(msg.status) ||
        !isValidFacebookCommentId(commentKey)
      ) {
        return;
      }

      setReplyCommentId(commentKey);
      setReplyPreview(getCommentPreviewText(msg));
      setReplyMentionName(
        pickBetterSenderName(msg.senderName, selected?.senderName),
      );
      void handleSelectMessage(msg);
    },
    [pageId, selected?.senderName, handleSelectMessage],
  );

  const handleCommentAction = useCallback(
    async (commentId: string, action: CommentAction) => {
      await performCommentAction(pageId, commentId, action);

      if (action === 'hide' || action === 'unhide') {
        setMessages((msgs) =>
          msgs.map((m) => {
            const key = m.commentId ?? m.messageId;
            if (key !== commentId) return m;
            return {
              ...m,
              status: action === 'hide' ? 'HIDDEN' : 'ACTIVE',
            };
          }),
        );
      }

      if (action === 'hide' && replyCommentId === commentId) {
        setReplyCommentId(null);
        setReplyPreview(null);
        setReplyMentionName(null);
      }
    },
    [pageId, replyCommentId],
  );

  const openMessengerThread = useCallback(() => {
    if (!selected || selected.kind !== 'FEED_COMMENT') return;

    const messengerId = buildMessengerThreadId(pageId, selected.senderId);
    const existing = conversations.find((c) => c.id === messengerId);
    const thread: ConversationThread = existing ?? {
      id: messengerId,
      kind: 'MESSENGER',
      pageId,
      senderId: selected.senderId,
      senderName: selected.senderName,
      senderPictureUrl: selected.senderPictureUrl ?? null,
      preview: '',
      lastMessageAt: new Date().toISOString(),
      postId: null,
      commentId: null,
      messageCount: 0,
      unreadCount: 0,
    };

    if (!existing) {
      setConversations((prev) =>
        [thread, ...prev].sort(
          (a, b) =>
            new Date(b.lastMessageAt).getTime() -
            new Date(a.lastMessageAt).getTime(),
        ),
      );
    }

    setActiveTab('MESSENGER');
    void loadThread(thread);
  }, [selected, pageId, conversations, loadThread]);

  const loadMoreMessages = useCallback(async () => {
    if (!selected || !hasMoreMessages || loadingMoreMessages || !messagesCursor)
      return;

    setLoadingMoreMessages(true);
    try {
      const { data: older, paging } = await getConversationMessages(
        pageId,
        selected.id,
        {
          limit: 15,
          before: messagesCursor,
        },
      );
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const unique = older.filter((m) => !ids.has(m.id));
        return [...unique, ...prev];
      });
      setMessagesCursor(paging.nextBefore);
      setHasMoreMessages(paging.hasMore);
    } finally {
      setLoadingMoreMessages(false);
    }
  }, [selected, hasMoreMessages, loadingMoreMessages, messagesCursor, pageId]);

  useEffect(() => {
    let cancelled = false;

    setConversations([]);
    setActiveTab('MESSENGER');
    setSelected(null);
    explicitlyOpenedThreadIdRef.current = null;
    selectedThreadIdRef.current = null;
    setMessages([]);
    setPost(null);
    setConversationsCursor(null);
    setHasMoreConversations(false);
    seenConversationEventIdsRef.current.clear();

    void (async () => {
      setLoading(true);
      try {
        const status = await getAuthStatus();
        const page = status.data.pages.find((p) => p.pageId === pageId);
        setPageName(page?.name ?? pageId);
        setPagePictureUrl(page?.pictureUrl ?? null);
        setCommentPermissionsOk(page?.commentPermissionsOk !== false);
        setMissingCommentScopes(page?.missingCommentScopes ?? []);
        setWebhookFeedOk(page?.feedSubscribed !== false);

        const { data, paging } = await getConversations(pageId, { limit: 15 });
        const list = data.filter((c) => c.pageId === pageId);
        if (!cancelled) {
          setConversations(list);
          setConversationsCursor(paging.nextBefore);
          setHasMoreConversations(paging.hasMore);
        }
        if (!cancelled && list.length > 0) {
          const firstMessenger = list.find((c) => c.kind === 'MESSENGER');
          const firstComment = list.find((c) => c.kind === 'FEED_COMMENT');
          if (firstMessenger) {
            await loadThread(firstMessenger);
          } else if (firstComment) {
            setActiveTab('FEED_COMMENT');
            await loadThread(firstComment);
          }
        } else if (!cancelled) {
          setSelected(null);
        }
      } catch {
        if (!cancelled) setConversations([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pageId, loadThread]);

  useEffect(() => {
    joinPageRoom(pageId);
    return () => leavePageRoom(pageId);
  }, [pageId]);

  useEffect(() => {
    if (!selected?.id) return;

    joinThreadRoom(selected.id);
    return () => leaveThreadRoom(selected.id);
  }, [selected?.id]);

  useEffect(() => {
    return onWebhookEvent((raw) => {
      handleRealtimeEvent(raw as unknown as WebhookMessage, true);
    });
  }, [handleRealtimeEvent]);

  useEffect(() => {
    return onFeedSynced((payload) => {
      handleFeedSynced(payload);
    });
  }, [handleFeedSynced]);

  // Meta thường không gửi webhook comment đầy đủ — đồng bộ Graph khi tab Bình luận đang mở
  useEffect(() => {
    if (activeTab !== 'FEED_COMMENT') return;

    const runSync = () => {
      if (document.visibilityState !== 'visible') return;
      void syncComments(pageId).catch(() => undefined);
    };

    runSync();
    const timer = window.setInterval(runSync, 5000);
    return () => window.clearInterval(timer);
  }, [activeTab, pageId]);

  useEffect(() => {
    return onContentRemoved((payload) => {
      if (payload.pageId !== pageId) return;

      const matchesMessage = (m: WebhookMessage) => {
        if (payload.messageId) {
          return (
            m.messageId === payload.messageId || m.id === payload.messageId
          );
        }
        if (payload.commentId) {
          return (
            m.commentId === payload.commentId ||
            m.messageId === payload.commentId
          );
        }
        return false;
      };

      setMessages((msgs) =>
        msgs.map((m) =>
          matchesMessage(m) ? { ...m, status: payload.status } : m,
        ),
      );

      if (payload.commentId && payload.status !== 'ACTIVE') {
        setReplyCommentId((current) =>
          current === payload.commentId ? null : current,
        );
        setReplyPreview(null);
        setReplyMentionName(null);
      }
    });
  }, [pageId]);

  // Fallback: SSE stream (khi Socket.IO không ổn định qua proxy)
  useEffect(() => {
    return subscribeMessages(
      (event) => handleRealtimeEvent(event, false),
      (payload) => handleFeedSynced(payload),
    );
  }, [handleFeedSynced, handleRealtimeEvent]);

  const reconnectFacebook = useCallback(async () => {
    const { data } = await initiateOAuth(pageName || 'Fanpage');
    const popup = window.open(
      data.url,
      'facebook_oauth',
      'width=600,height=720',
    );
    if (!popup) return;

    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        void loadConversations();
      }
    }, 800);
  }, [loadConversations, pageName]);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#eef2f7]">
        <p className="text-[#6b7280]">Đang tải hội thoại...</p>
      </main>
    );
  }

  const firstComment = messages.find((m) => m.eventType === 'FEED_COMMENT');
  const resolvedHighlightComment =
    highlightComment ?? firstComment?.content ?? undefined;

  return (
    <main className="flex h-screen flex-col bg-[#eef2f7]">
      <header className="flex items-center justify-between border-b border-[#e5e7eb] bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            href="/shops"
            className="text-sm text-[#3b82f6] hover:underline"
          >
            ← Danh sách shop
          </Link>
          <h1 className="text-lg font-semibold text-[#111827]">{pageName}</h1>
        </div>
        <span className="text-xs text-[#6b7280]">
          {tabCounts.messenger} tin nhắn · {tabCounts.comment} bình luận ·
          Socket.io realtime
        </span>
      </header>

      {!webhookFeedOk && (
        <div className="border-b border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-sm text-[#991b1b]">
          <p className="font-semibold">Chưa bật webhook comment (field feed)</p>
          <p className="mt-1 text-xs text-[#b91c1c]">
            Comment từ Facebook chỉ realtime qua webhook. Vào Shops → liên kết
            lại Facebook hoặc gọi API resubscribe-webhook để Page subscribe
            field <code className="rounded bg-white/60 px-1">feed</code>.
          </p>
        </div>
      )}

      {!commentPermissionsOk && (
        <div className="flex items-center gap-3 border-b border-[#fde68a] bg-[#fffbeb] px-4 py-3 text-sm text-[#92400e]">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Chưa đủ quyền quản lý bình luận</p>
            <p className="mt-1 text-xs text-[#b45309]">
              {missingCommentScopes.length > 0
                ? `Thiếu quyền: ${missingCommentScopes.join(', ')}`
                : 'Kết nối lại Facebook để cấp quyền đọc, phản hồi và quản lý bình luận.'}
            </p>
          </div>
          <CommentHeaderIconButton
            label="Kết nối lại Facebook để cấp quyền comment"
            icon={<RefreshIcon className="h-5 w-5" />}
            onClick={() => {
              void reconnectFacebook();
            }}
          />
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_1fr_280px]">
        <aside className="min-h-0 border-r border-[#e5e7eb]">
          <ConversationList
            items={filteredConversations}
            activeTab={activeTab}
            onTabChange={handleTabChange}
            tabCounts={tabCounts}
            tabUnread={tabUnread}
            selectedId={selected?.id ?? null}
            onSelect={(thread) => {
              void loadThread(thread, { markRead: true });
            }}
            hasMore={hasMoreConversations}
            loadingMore={loadingMoreConversations}
            onLoadMore={() => {
              void loadMoreConversations();
            }}
          />
        </aside>

        <section className="flex min-h-0 flex-col bg-[#f3f4f6]">
          {selected ? (
            <>
              <div className="flex items-center gap-3 border-b border-[#e5e7eb] bg-white px-4 py-3">
                <UserAvatar
                  name={selected.senderName}
                  pictureUrl={selected.senderPictureUrl}
                  senderId={selected.senderId}
                  pageId={pageId}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-[#111827]">
                    {selected.senderName}
                  </p>
                  <p className="text-xs text-[#6b7280]">
                    {selected.kind === 'FEED_COMMENT'
                      ? 'Bình luận bài viết · cuộc trò chuyện'
                      : 'Tin nhắn Messenger'}
                  </p>
                </div>
                {selected.kind === 'FEED_COMMENT' && (
                  <CommentHeaderIconButton
                    label="Gửi tin nhắn Messenger"
                    icon={<MessageIcon className="h-5 w-5" />}
                    onClick={openMessengerThread}
                  />
                )}
              </div>

              <div
                className="flex min-h-0 flex-1 flex-col"
                onClick={() => {
                  if (selected?.id) {
                    markThreadAsRead(selected.id);
                  }
                }}
              >
                <ThreadMessages
                  ref={threadMessagesRef}
                  messages={messages}
                  customerName={selected.senderName}
                  customerPictureUrl={selected.senderPictureUrl}
                  customerSenderId={selected.senderId}
                  pageId={pageId}
                  pageName={pageName}
                  pagePictureUrl={pagePictureUrl}
                  selectedCommentId={
                    selected.kind === 'FEED_COMMENT' ? replyCommentId : null
                  }
                  hasMore={hasMoreMessages}
                  loadingMore={loadingMoreMessages}
                  onLoadMore={() => {
                    void loadMoreMessages();
                  }}
                  onSelectMessage={(msg) => {
                    void handleSelectMessage(msg);
                  }}
                  post={post}
                  postLoading={postLoading}
                  initialLoading={messagesLoading}
                  highlightComment={resolvedHighlightComment}
                  highlightSenderName={selected.senderName}
                  showFeedCommentBanner={selected.kind === 'FEED_COMMENT'}
                  showPostHintWhenEmpty={selected.kind !== 'FEED_COMMENT'}
                  postExpanded={postExpanded}
                  onTogglePostExpanded={() => setPostExpanded((v) => !v)}
                  showCommentActions={selected.kind === 'FEED_COMMENT'}
                  postPermalinkUrl={post?.permalinkUrl}
                  onReplyComment={handleReplyToComment}
                  onMessageCustomer={openMessengerThread}
                  onCommentAction={handleCommentAction}
                />

                <div className="border-t border-[#e5e7eb] bg-white p-3">
                  {selected.kind === 'MESSENGER' ? (
                    <MessageComposer
                      pageId={pageId}
                      threadId={selected.id}
                      shopPictureUrl={pagePictureUrl}
                      commentId={selected.commentId}
                      onSent={({ clientMessageId, text }) => {
                        const optimistic: WebhookMessage = {
                          id: clientMessageId,
                          organizationId: null,
                          pageId,
                          eventType: 'MESSENGER',
                          direction: 'OUT',
                          senderId: pageId,
                          senderName: pageName || 'Page',
                          recipientId: selected.senderId,
                          messageId: null,
                          postId: null,
                          commentId: null,
                          msgType: 'webchat',
                          content: text,
                          rawPayload: JSON.stringify({
                            source: 'optimistic',
                            clientMessageId,
                          }),
                          createdAt: new Date().toISOString(),
                        };
                        setMessages((msgs) => [...msgs, optimistic]);
                        setConversations((prev) =>
                          [...prev]
                            .map((c) =>
                              c.id === selected.id
                                ? {
                                    ...c,
                                    preview: text,
                                    lastMessageAt: optimistic.createdAt,
                                    unreadCount: 0,
                                  }
                                : c,
                            )
                            .sort(
                              (a, b) =>
                                new Date(b.lastMessageAt).getTime() -
                                new Date(a.lastMessageAt).getTime(),
                            ),
                        );
                      }}
                      onAck={({ clientMessageId, ok }) => {
                        if (!ok) {
                          setMessages((msgs) =>
                            msgs.filter((m) => m.id !== clientMessageId),
                          );
                        }
                      }}
                    />
                  ) : (
                    <MessageComposer
                      pageId={pageId}
                      threadId={selected.id}
                      shopPictureUrl={pagePictureUrl}
                      commentId={replyCommentId ?? selected.commentId}
                      replyPreview={replyTargetPreview}
                      replyMentionName={replyMentionName}
                      onReplyPreviewClick={scrollToReplyTarget}
                      iconOnlyActions
                      allowAttachments={false}
                      onSent={({ clientMessageId, text }) => {
                        const optimistic: WebhookMessage = {
                          id: clientMessageId,
                          organizationId: null,
                          pageId,
                          eventType: 'FEED_COMMENT',
                          direction: 'OUT',
                          senderId: selected.senderId,
                          senderName: pageName || 'Page',
                          recipientId: pageId,
                          messageId: null,
                          postId: selected.postId,
                          commentId: null,
                          msgType: 'feed.comment.reply',
                          content: text,
                          rawPayload: JSON.stringify({
                            source: 'optimistic',
                            clientMessageId,
                          }),
                          createdAt: new Date().toISOString(),
                        };
                        setMessages((msgs) => [...msgs, optimistic]);
                        setConversations((prev) =>
                          [...prev]
                            .map((c) =>
                              c.id === selected.id
                                ? {
                                    ...c,
                                    preview: text,
                                    lastMessageAt: optimistic.createdAt,
                                    unreadCount: 0,
                                  }
                                : c,
                            )
                            .sort(
                              (a, b) =>
                                new Date(b.lastMessageAt).getTime() -
                                new Date(a.lastMessageAt).getTime(),
                            ),
                        );
                      }}
                      onAck={({
                        clientMessageId,
                        ok,
                        fbMessageId,
                        savedEventId,
                      }) => {
                        if (!ok) {
                          setMessages((msgs) =>
                            msgs.filter((m) => m.id !== clientMessageId),
                          );
                          return;
                        }

                        setMessages((msgs) =>
                          msgs.map((m) =>
                            m.id === clientMessageId
                              ? {
                                  ...m,
                                  id: savedEventId ?? m.id,
                                  messageId: fbMessageId ?? m.messageId,
                                  commentId: fbMessageId ?? m.commentId,
                                }
                              : m,
                          ),
                        );

                        // Đồng bộ lại từ server sau khi gửi (phòng socket/event bị miss)
                        void getConversationMessages(pageId, selected.id, {
                          limit: 15,
                        })
                          .then(({ data }) => {
                            if (selectedThreadIdRef.current !== selected.id)
                              return;
                            setMessages((prev) =>
                              mergeThreadMessages(prev, data),
                            );
                          })
                          .catch(() => undefined);
                      }}
                    />
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-[#6b7280]">
              {activeTab === 'MESSENGER'
                ? 'Chọn một tin nhắn bên trái'
                : 'Chọn một bình luận bên trái'}
            </div>
          )}
        </section>

        <aside className="hidden min-h-0 border-l border-[#e5e7eb] bg-white lg:block">
          <div className="border-b border-[#e5e7eb] p-4">
            <p className="text-sm font-semibold text-[#111827]">Thông tin</p>
          </div>
          <div className="p-4 text-sm text-[#6b7280]">
            {selected ? (
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-2 text-center">
                  <UserAvatar
                    name={selected.senderName}
                    pictureUrl={selected.senderPictureUrl}
                    senderId={selected.senderId}
                    pageId={pageId}
                    size="lg"
                  />
                  <p className="text-sm font-semibold text-[#111827]">
                    {selected.senderName}
                  </p>
                </div>
                <div className="space-y-2">
                  <p>
                    <span className="font-medium text-[#374151]">
                      Khách hàng:
                    </span>{' '}
                    {selected.senderName}
                  </p>
                  <p>
                    <span className="font-medium text-[#374151]">Loại:</span>{' '}
                    {selected.kind === 'FEED_COMMENT'
                      ? 'Bình luận'
                      : 'Messenger'}
                  </p>
                  {selected.postId && (
                    <p className="break-all font-mono text-xs">
                      {selected.postId}
                    </p>
                  )}
                  {selected.kind === 'FEED_COMMENT' && (
                    <CommentHeaderIconButton
                      label="Gửi tin nhắn Messenger"
                      icon={<MessageIcon className="h-5 w-5" />}
                      onClick={openMessengerThread}
                      className="mx-auto"
                    />
                  )}
                </div>
              </div>
            ) : (
              <p>Bạn chưa chọn hội thoại</p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
