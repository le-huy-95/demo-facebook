'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ConversationList } from '@/components/conversation-list';
import { ThreadMessages } from '@/components/conversation-thread';
import { UserAvatar } from '@/components/user-avatar';
import {
  getAuthStatus,
  getConversationMessages,
  getConversations,
  getPostPreview,
  type ConversationThread,
  type FacebookPostPreview,
  type WebhookMessage,
} from '@/lib/api';
import {
  buildThreadIdFromEvent,
  pickBetterSenderName,
  resolveCustomerNameFromMessages,
} from '@/lib/conversation';
import { isReceiptMessage } from '@/lib/message-content';
import { MessageComposer } from '@/components/message-composer';
import {
  joinPageRoom,
  leavePageRoom,
  joinThreadRoom,
  leaveThreadRoom,
  onWebhookEvent,
} from '@/lib/socket';

export default function ConversationsPage() {
  const params = useParams();
  const pageId = params.pageId as string;

  const extractPostIdFromJson = useCallback((rawPayload: string | null | undefined): string | null => {
    if (!rawPayload) return null;
    try {
      const raw = JSON.parse(rawPayload);

      const referral = raw?.referral ?? raw?.message?.referral ?? raw?.postback?.referral;
      if (referral) {
        const adsPostId = referral?.ads_context_data?.post_id;
        if (typeof adsPostId === 'string' && adsPostId) {
          if (/^\d+_\d+$/.test(adsPostId)) return adsPostId;
          if (/^\d+$/.test(adsPostId)) return adsPostId;
        }
      }

      if (raw?.post_id && typeof raw.post_id === 'string') return raw.post_id;
    } catch {
      // not JSON
    }
    return null;
  }, []);

  const extractPostIdFromText = useCallback((text: string | null | undefined): string | null => {
    if (!text) return null;

    const fromJson = extractPostIdFromJson(text);
    if (fromJson) return fromJson;

    const direct = text.match(/\b(\d+_\d+)\b/);
    if (direct?.[1]) return direct[1];

    const perm = text.match(/https?:\/\/[^\s)]+/g) ?? [];
    for (const rawUrl of perm) {
      try {
        const url = new URL(rawUrl.replace(/[)\].,]+$/, ''));
        const storyFbid = url.searchParams.get('story_fbid');
        const id = url.searchParams.get('id');
        if (storyFbid && id) return `${id}_${storyFbid}`;

        const m = url.pathname.match(/\/posts\/(\d+_\d+)/);
        if (m?.[1]) return m[1];
      } catch {
        // ignore invalid URL
      }
    }

    return null;
  }, [extractPostIdFromJson]);

  const [pageName, setPageName] = useState('');
  const [pagePictureUrl, setPagePictureUrl] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationThread[]>([]);
  const [selected, setSelected] = useState<ConversationThread | null>(null);
  const [messages, setMessages] = useState<WebhookMessage[]>([]);
  const [post, setPost] = useState<FacebookPostPreview | null>(null);
  const [highlightComment, setHighlightComment] = useState<string | undefined>(undefined);
  const [replyCommentId, setReplyCommentId] = useState<string | null>(null);
  const [replyPreview, setReplyPreview] = useState<string | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [replyToSenderName, setReplyToSenderName] = useState<string | null>(null);
  const [postExpanded, setPostExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [postLoading, setPostLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [messagesCursor, setMessagesCursor] = useState<string | null>(null);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [conversationsCursor, setConversationsCursor] = useState<string | null>(null);
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});

  const upsertConversationFromRealtimeEvent = useCallback(
    (event: WebhookMessage, threadId: string) => {
      setConversations((prev) => {
        const kind = event.eventType === 'FEED_COMMENT' ? 'FEED_COMMENT' : 'MESSENGER';
        const rootCommentId = event.parentCommentId ?? event.commentId;
        const derivedCustomerId =
          event.eventType === 'FEED_COMMENT'
            ? event.direction === 'OUT'
              ? (event.senderId && event.senderId !== event.pageId
                  ? event.senderId
                  : event.recipientId)
              : event.senderId
            : event.direction === 'OUT'
              ? event.recipientId
              : event.senderId;
        if (!derivedCustomerId) return prev;

        const idx = prev.findIndex((c) => c.id === threadId);
        if (idx >= 0) {
          const current = prev[idx];
          const nextSenderName = pickBetterSenderName(
            event.direction === 'IN' ? event.senderName : current.senderName,
            current.senderName,
          );
          const updated = {
            ...current,
            senderId: derivedCustomerId,
            senderName: nextSenderName,
            preview: event.content ?? current.preview,
            lastMessageAt: event.createdAt,
            messageCount: current.messageCount + 1,
            postId: event.postId ?? current.postId,
            commentId: rootCommentId ?? current.commentId,
          };
          const next = [...prev];
          next[idx] = updated;
          return next.sort(
            (a, b) =>
              new Date(b.lastMessageAt).getTime() -
              new Date(a.lastMessageAt).getTime(),
          );
        }

        const created = {
          id: threadId,
          kind,
          pageId: event.pageId ?? pageId,
          senderId: derivedCustomerId,
          senderName: pickBetterSenderName(event.senderName, 'Khách hàng'),
          preview: event.content ?? '',
          lastMessageAt: event.createdAt,
          postId: event.postId ?? null,
          commentId: rootCommentId ?? null,
          messageCount: 1,
        } as ConversationThread;

        return [created, ...prev].sort(
          (a, b) =>
            new Date(b.lastMessageAt).getTime() -
            new Date(a.lastMessageAt).getTime(),
        );
      });
    },
    [pageId],
  );

  const loadConversations = useCallback(async () => {
    const status = await getAuthStatus();
    const page = status.data.pages.find((p) => p.pageId === pageId);
    setPageName(page?.name ?? pageId);
    setPagePictureUrl(page?.pictureUrl ?? null);

    const { data, paging } = await getConversations(pageId, { limit: 30 });
    const filtered = data.filter((c) => c.pageId === pageId);
    setConversations(filtered);
    setConversationsCursor(paging.nextBefore);
    setHasMoreConversations(paging.hasMore);
    return filtered;
  }, [pageId]);

  const loadMoreConversations = useCallback(async () => {
    if (!hasMoreConversations || loadingMoreConversations || !conversationsCursor) return;

    setLoadingMoreConversations(true);
    try {
      const { data, paging } = await getConversations(pageId, {
        limit: 30,
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
  }, [hasMoreConversations, loadingMoreConversations, conversationsCursor, pageId]);

  const loadThread = useCallback(
    async (thread: ConversationThread) => {
      setSelected(thread);
      setMessages([]);
      setMessagesCursor(null);
      setHasMoreMessages(false);
      setMessagesLoading(true);
      setHighlightComment(undefined);
      setReplyCommentId(null);
      setReplyPreview(null);
      setReplyToMessageId(null);
      setReplyToSenderName(null);
      setPostExpanded(false);
      setUnreadMap((prev) => {
        if (!prev[thread.id]) return prev;
        const next = { ...prev };
        delete next[thread.id];
        return next;
      });

      try {
        const { data: msgs, paging } = await getConversationMessages(pageId, thread.id, { limit: 15 });
        const resolvedName = resolveCustomerNameFromMessages(msgs, thread.senderName);
        const enrichedThread = { ...thread, senderName: resolvedName };
        setSelected(enrichedThread);
        setConversations((prev) =>
          prev.map((c) => (c.id === thread.id ? { ...c, senderName: resolvedName } : c)),
        );
        setMessages(msgs);
        setMessagesCursor(paging.nextBefore);
        setHasMoreMessages(paging.hasMore);

        if (thread.kind === 'FEED_COMMENT') {
          const latestInbound = [...msgs].reverse().find(
            (m) => m.eventType === 'FEED_COMMENT' && m.direction === 'IN',
          );
          setReplyCommentId(latestInbound?.commentId ?? thread.commentId ?? null);
          setReplyPreview(latestInbound?.content ?? thread.preview ?? null);
          setHighlightComment(latestInbound?.content ?? thread.preview ?? undefined);
        }

        // Auto-detect postId for Messenger threads.
        // Prefer thread.postId from server summary, then fallback to recent messages.
        if (thread.kind !== 'FEED_COMMENT') {
          const recentPostIds = [...msgs]
            .reverse()
            .map((m) => m.postId ?? extractPostIdFromText(m.content) ?? extractPostIdFromText(m.rawPayload))
            .filter((v): v is string => typeof v === 'string' && v.length > 0);
          const candidatePostIds = [thread.postId, ...recentPostIds].filter(
            (v, idx, arr): v is string =>
              typeof v === 'string' && v.length > 0 && arr.indexOf(v) === idx,
          );
          const latestWithPost = candidatePostIds[0] ?? null;

          if (latestWithPost) {
            setPostLoading(true);
            try {
              const { data: postData } = await getPostPreview(pageId, latestWithPost);
              setPost(postData);
            } catch {
              // keep last post panel on error
            } finally {
              setPostLoading(false);
            }
          } else {
            setPost(null);
          }
        }
      } finally {
        setMessagesLoading(false);
      }

      if (thread.kind === 'FEED_COMMENT' && thread.postId) {
        setPostLoading(true);
        try {
          const { data: postData } = await getPostPreview(pageId, thread.postId);
          setPost(postData);
        } catch {
          setPost(null);
        } finally {
          setPostLoading(false);
        }
      } else {
        // Keep the last post panel by default for Messenger threads unless user clicks a message with postId
        setPostLoading(false);
      }
    },
    [pageId, extractPostIdFromText],
  );

  const handleSelectMessage = useCallback(
    async (msg: WebhookMessage) => {
      if (msg.eventType === 'FEED_COMMENT' && msg.content) {
        setHighlightComment(msg.content);
      } else {
        setHighlightComment(undefined);
      }

      if (selected?.kind === 'FEED_COMMENT') {
        setReplyCommentId(msg.commentId ?? null);
        setReplyPreview(msg.content ?? null);
      }

      const inferredPostId =
        msg.postId ?? extractPostIdFromText(msg.content) ?? extractPostIdFromText(msg.rawPayload);
      if (!inferredPostId) return; // fallback: keep last post panel

      setPostLoading(true);
      try {
        const { data } = await getPostPreview(pageId, inferredPostId);
        setPost(data);
        setPostExpanded(false);
      } catch {
        // keep last post panel on error
      } finally {
        setPostLoading(false);
      }
    },
    [pageId, extractPostIdFromText, selected?.kind],
  );

  const loadMoreMessages = useCallback(async () => {
    if (!selected || !hasMoreMessages || loadingMoreMessages || !messagesCursor) return;

    setLoadingMoreMessages(true);
    try {
      const { data: older, paging } = await getConversationMessages(pageId, selected.id, {
        limit: 15,
        before: messagesCursor,
      });
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
    setSelected(null);
    setMessages([]);
    setPost(null);
    setConversationsCursor(null);
    setHasMoreConversations(false);

    (async () => {
      setLoading(true);
      try {
        const status = await getAuthStatus();
        const page = status.data.pages.find((p) => p.pageId === pageId);
        setPageName(page?.name ?? pageId);
        setPagePictureUrl(page?.pictureUrl ?? null);

        const { data, paging } = await getConversations(pageId, { limit: 30 });
        const list = data.filter((c) => c.pageId === pageId);
        if (!cancelled) {
          setConversations(list);
          setConversationsCursor(paging.nextBefore);
          setHasMoreConversations(paging.hasMore);
        }
        if (!cancelled && list.length > 0) {
          await loadThread(list[0]);
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
      const event = raw as unknown as WebhookMessage;
      if (event.pageId !== pageId) return;

      const threadId = buildThreadIdFromEvent(event);
      if (!threadId) {
        if (event.eventType === 'FEED_COMMENT') {
          // Fallback for partial feed payloads: refresh threads and patch opened comment thread.
          void loadConversations();
          setSelected((current) => {
            if (
              current?.kind === 'FEED_COMMENT' &&
              current.postId &&
              event.postId === current.postId &&
              (event.senderId === current.senderId || event.recipientId === current.senderId)
            ) {
              setMessages((msgs) => {
                if (msgs.some((m) => m.id === event.id)) return msgs;
                if (
                  event.messageId &&
                  msgs.some((m) => m.messageId === event.messageId && m.msgType === event.msgType)
                ) {
                  return msgs;
                }
                return [...msgs, event];
              });
            }
            return current;
          });
        }
        return;
      }

      const isReceipt = isReceiptMessage(event);

      if (!isReceipt) {
        upsertConversationFromRealtimeEvent(event, threadId);

        if (event.direction === 'IN') {
          setSelected((current) => {
            if (current?.id !== threadId) {
              setUnreadMap((prev) => ({
                ...prev,
                [threadId]: (prev[threadId] ?? 0) + 1,
              }));
            }
            return current;
          });
        }
      }

      setSelected((current) => {
        if (current?.id === threadId) {
          setMessages((msgs) => {
            if (msgs.some((m) => m.id === event.id)) return msgs;
            if (
              event.messageId &&
              msgs.some(
                (m) => m.messageId === event.messageId && m.msgType === event.msgType,
              )
            ) {
              return msgs;
            }

            let next = msgs;
            if (event.direction === 'OUT' && event.content) {
              next = msgs.filter(
                (m) =>
                  !(
                    m.id.startsWith('client-') &&
                    m.direction === 'OUT' &&
                    m.content === event.content
                  ),
              );
            }

            return [...next, event];
          });
        }
        return current;
      });
    });
  }, [pageId, loadConversations, upsertConversationFromRealtimeEvent]);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#eef2f7]">
        <p className="text-[#6b7280]">Đang tải hội thoại...</p>
      </main>
    );
  }

  const firstComment = messages.find((m) => m.eventType === 'FEED_COMMENT');
  const resolvedHighlightComment = highlightComment ?? firstComment?.content ?? undefined;

  return (
    <main className="flex h-screen flex-col bg-[#eef2f7]">
      <header className="flex items-center justify-between border-b border-[#e5e7eb] bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <Link href="/shops" className="text-sm text-[#3b82f6] hover:underline">
            ← Danh sách shop
          </Link>
          <h1 className="text-lg font-semibold text-[#111827]">{pageName}</h1>
        </div>
        <span className="text-xs text-[#6b7280]">
          {conversations.length}
          {hasMoreConversations ? '+' : ''} hội thoại · Socket.io realtime
        </span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_1fr_280px]">
        <aside className="min-h-0 border-r border-[#e5e7eb]">
          <ConversationList
            items={conversations}
            selectedId={selected?.id ?? null}
            onSelect={loadThread}
            hasMore={hasMoreConversations}
            loadingMore={loadingMoreConversations}
            onLoadMore={loadMoreConversations}
            unreadMap={unreadMap}
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
                <div>
                  <p className="font-semibold text-[#111827]">{selected.senderName}</p>
                  <p className="text-xs text-[#6b7280]">
                    {selected.kind === 'FEED_COMMENT'
                      ? 'Bình luận bài viết · cuộc trò chuyện'
                      : 'Tin nhắn Messenger'}
                  </p>
                </div>
              </div>

              <ThreadMessages
                messages={messages}
                customerName={selected.senderName}
                customerPictureUrl={selected.senderPictureUrl}
                customerSenderId={selected.senderId}
                pageId={pageId}
                pageName={pageName}
                pagePictureUrl={pagePictureUrl}
                selectedCommentId={selected.kind === 'FEED_COMMENT' ? replyCommentId : null}
                loading={messagesLoading}
                hasMore={hasMoreMessages}
                loadingMore={loadingMoreMessages}
                onLoadMore={loadMoreMessages}
                onSelectMessage={handleSelectMessage}
                onReplyMessage={(msg) => {
                  if (selected.kind === 'FEED_COMMENT') {
                    setReplyCommentId(msg.commentId ?? null);
                    setReplyPreview(msg.content ?? null);
                    setReplyToMessageId(null);
                    setReplyToSenderName(null);
                    setHighlightComment(msg.content ?? undefined);
                    return;
                  }

                  if (!msg.messageId) return;
                  setReplyToMessageId(msg.messageId);
                  setReplyPreview(msg.content ?? null);
                  setReplyToSenderName(msg.senderName ?? selected.senderName);
                  setReplyCommentId(null);
                }}
                post={post}
                postLoading={postLoading}
                highlightComment={resolvedHighlightComment}
                highlightSenderName={selected.senderName}
                showFeedCommentBanner={selected.kind === 'FEED_COMMENT'}
                showPostHintWhenEmpty={selected.kind !== 'FEED_COMMENT'}
                postExpanded={postExpanded}
                onTogglePostExpanded={() => setPostExpanded((v) => !v)}
              />

              <div className="border-t border-[#e5e7eb] bg-white p-3">
                {selected.kind === 'MESSENGER' ? (
                  <MessageComposer
                    pageId={pageId}
                    threadId={selected.id}
                    shopPictureUrl={pagePictureUrl}
                    commentId={selected.commentId}
                    replyToMessageId={replyToMessageId}
                    replyPreview={replyPreview}
                    replySenderName={replyToSenderName}
                    onClearReplyTarget={() => {
                      setReplyToMessageId(null);
                      setReplyPreview(null);
                      setReplyToSenderName(null);
                    }}
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
                          replyToMessageId,
                          replyToText: replyPreview,
                          replyToSenderName,
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
                                }
                              : c,
                          )
                          .sort(
                            (a, b) =>
                              new Date(b.lastMessageAt).getTime() -
                              new Date(a.lastMessageAt).getTime(),
                          ),
                      );
                      setReplyToMessageId(null);
                      setReplyPreview(null);
                      setReplyToSenderName(null);
                    }}
                    onAck={({ clientMessageId, ok }) => {
                      if (!ok) {
                        setMessages((msgs) => msgs.filter((m) => m.id !== clientMessageId));
                      }
                    }}
                  />
                ) : (
                  <MessageComposer
                    pageId={pageId}
                    threadId={selected.id}
                    shopPictureUrl={pagePictureUrl}
                    commentId={replyCommentId ?? selected.commentId}
                    replyPreview={replyPreview}
                    replySenderName={replyToSenderName}
                    onClearReplyTarget={() => {
                      setReplyCommentId(null);
                      setReplyPreview(null);
                      setReplyToMessageId(null);
                      setReplyToSenderName(null);
                    }}
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
                        parentCommentId: replyCommentId ?? selected.commentId,
                        msgType: 'feed.comment.reply',
                        content: text,
                        rawPayload: JSON.stringify({
                          source: 'optimistic',
                          clientMessageId,
                        }),
                        createdAt: new Date().toISOString(),
                      };
                      setMessages((msgs) => [...msgs, optimistic]);
                    }}
                    onAck={({ clientMessageId, ok }) => {
                      if (!ok) {
                        setMessages((msgs) =>
                          msgs.filter((m) => m.id !== clientMessageId),
                        );
                      }
                    }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-[#6b7280]">
              Chọn một cuộc trò chuyện bên trái
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
                  <p className="text-sm font-semibold text-[#111827]">{selected.senderName}</p>
                </div>
                <div className="space-y-2">
                <p>
                  <span className="font-medium text-[#374151]">Khách hàng:</span> {selected.senderName}
                </p>
                <p>
                  <span className="font-medium text-[#374151]">Loại:</span>{' '}
                  {selected.kind === 'FEED_COMMENT' ? 'Bình luận' : 'Messenger'}
                </p>
                {selected.postId && (
                  <p className="break-all font-mono text-xs">{selected.postId}</p>
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
