import { AppLogger } from '../../common/logger.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import type { MessageHistoryRecord } from '../../types/message.types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FacebookOAuthService,
  extractGraphPictureUrl,
  type GraphConversation,
  type GraphConversationMessage,
  type GraphPostComment,
} from './facebook-oauth.service';
import { FacebookGraphApiService } from './facebook-graph-api.service';
import { FacebookRepoService } from './facebook-repo.service';
import { RedisCacheService, GRAPH_CACHE_TTL_SECONDS } from '../../redis/redis-cache.service';
import {
  aggregateConversations,
  buildFeedCommentThreadId,
  buildThreadEventWhere,
  isGenericSenderName,
  normalizeCommentThreadId,
  parseThreadId,
  pickBetterSenderName,
  type ConversationThread,
} from '../utils/conversation-thread.util';
import { buildMessengerThreadId } from '../utils/messenger-thread.util';
import {
  serializeFeedCommentContent,
  serializeFeedCommentFromRawPayload,
  feedCommentContentHasMedia,
} from '../utils/feed-comment-content.util';
import { isValidFacebookCommentId, buildGraphCommentIdCandidates, facebookCommentIdsMatch } from '../utils/facebook-comment-id.util';
import { formatConversationThreadPreview } from '../utils/thread-preview.util';
import { EVENT_STATUS_ACTIVE, EVENT_STATUS_DELETED, EVENT_STATUS_HIDDEN } from '../utils/event-visibility.util';

export interface FacebookPostPreview {
  id: string;
  message?: string;
  story?: string;
  permalinkUrl?: string;
  fullPicture?: string;
  createdTime?: string;
  fromName?: string;
}

export type ConversationMessage = MessageHistoryRecord & {
  senderPictureUrl?: string | null;
  isPinned?: boolean;
  reactions?: MessageReactionView[];
};

export interface MessageReactionView {
  emoji: string;
  reactorId: string;
}

export interface ThreadMessagesMeta {
  pinnedMessageIds: string[];
}

export interface ThreadMessagesPage {
  messages: ConversationMessage[];
  paging: {
    hasMore: boolean;
    nextBefore: string | null;
  };
  meta?: ThreadMessagesMeta;
}

const ALLOWED_MESSENGER_REACTIONS = new Set([
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '😡',
]);

export interface ConversationListPage {
  threads: ConversationThread[];
  paging: {
    hasMore: boolean;
    nextBefore: string | null;
  };
}

const MESSAGE_PAGE_SIZE = 15;
const CONVERSATION_PAGE_SIZE = 30;
const FEED_POSTS_SCAN_LIMIT = 50;

function parseDateCursor(cursor: string | undefined): Date | null {
  if (!cursor) return null;

  const date = new Date(cursor);
  return Number.isNaN(date.getTime()) ? null : date;
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookRepo: FacebookRepoService,
    private readonly facebookOAuth: FacebookOAuthService,
    private readonly graphApi: FacebookGraphApiService,
    private readonly redisCache: RedisCacheService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(ConversationsService.name);
  }

  async invalidatePageCache(pageId: string, orgId: string): Promise<void> {
    await this.redisCache.bumpPageRevision(orgId, pageId);
  }

  async listByPage(
    pageId: string,
    orgId: string,
    options?: { limit?: number; before?: string; kind?: ConversationThread['kind'] },
  ): Promise<ConversationListPage> {
    const limit = options?.limit ?? CONVERSATION_PAGE_SIZE;
    const readAtByThread = await this.getReadAtByThread(pageId, orgId);
    const merged = await this.fetchMergedThreads(pageId, orgId, readAtByThread);
    const withPictures = await this.enrichThreadPictures(merged, pageId);
    const enriched = await this.enrichThreadNames(withPictures, pageId, orgId);

    const allSorted = [...enriched].sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime(),
    );

    const beforeDate = parseDateCursor(options?.before);
    const eligible = beforeDate
      ? allSorted.filter(
          (t) =>
            new Date(t.lastMessageAt).getTime() <
            beforeDate.getTime(),
        )
      : allSorted;

    const hasMore = eligible.length > limit;
    const page = eligible.slice(0, limit);
    const oldest = page[page.length - 1];

    return {
      threads: page,
      paging: {
        hasMore,
        nextBefore: hasMore && oldest ? oldest.lastMessageAt : null,
      },
    };
  }

  private async fetchMergedThreads(
    pageId: string,
    orgId: string,
    readAtByThread: ReadonlyMap<string, Date>,
  ): Promise<ConversationThread[]> {
    await this.assertPageBelongsToOrg(pageId, orgId);

    // Cập nhật status DELETED/HIDDEN nhưng vẫn trả tất cả qua API
    await this.pruneStaleCommentsForPage(pageId, orgId);

    const pageRev = await this.redisCache.getPageRevision(orgId, pageId);
    const cacheKey = this.redisCache.pageThreadsKey(orgId, pageId, pageRev);
    const cached = await this.redisCache.get<ConversationThread[]>(cacheKey);
    if (cached) {
      this.logger.debug(
        `[Conversations] cache HIT page threads pageId=${pageId} rev=${pageRev}`,
      );
      return cached.filter((thread) => thread.pageId === pageId);
    }

    const events = await this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        OR: [{ organizationId: orgId }, { organizationId: null }],
        eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK', 'FEED_COMMENT'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    const fromWebhook = aggregateConversations(events, readAtByThread);

    const [fromMessengerGraph, fromCommentGraph] = await Promise.all([
      this.getCachedMessengerThreads(pageId, orgId, pageRev),
      this.getCachedCommentThreads(pageId, orgId, pageRev),
    ]);

    const merged = this.mergeConversationThreads(fromWebhook, [
      ...fromMessengerGraph,
      ...fromCommentGraph,
    ]);

    this.logger.log(
      `[Conversations] Threads merged: webhook=${fromWebhook.length} messenger=${fromMessengerGraph.length} comments=${fromCommentGraph.length} total=${merged.length}`,
    );

    const filtered = merged.filter((thread) => thread.pageId === pageId);
    await this.redisCache.set(
      cacheKey,
      filtered,
      GRAPH_CACHE_TTL_SECONDS,
    );
    return filtered;
  }

  /** Graph API messenger threads — cache theo page revision, dùng khi DB chưa có webhook. */
  private async getCachedMessengerThreads(
    pageId: string,
    orgId: string,
    pageRev: number,
  ): Promise<ConversationThread[]> {
    const key = this.redisCache.graphMessengerThreadsKey(pageId, pageRev);
    const hit = await this.redisCache.get<ConversationThread[]>(key);
    if (hit) return hit;

    const data = await this.listMessengerThreadsFromGraph(pageId, orgId).catch(
      () => [] as ConversationThread[],
    );
    await this.redisCache.set(key, data, GRAPH_CACHE_TTL_SECONDS);
    return data;
  }

  /** Graph API comment threads — cache theo page revision, dùng khi DB chưa có webhook. */
  private async getCachedCommentThreads(
    pageId: string,
    orgId: string,
    pageRev: number,
  ): Promise<ConversationThread[]> {
    const key = this.redisCache.graphCommentThreadsKey(pageId, pageRev);
    const hit = await this.redisCache.get<ConversationThread[]>(key);
    if (hit) return hit;

    const data = await this.listCommentThreadsFromGraph(pageId, orgId).catch(
      (err) => {
        this.logger.error(`listCommentThreadsFromGraph failed: ${err.message}`);
        return [] as ConversationThread[];
      },
    );
    await this.redisCache.set(key, data, GRAPH_CACHE_TTL_SECONDS);
    return data;
  }

  async getThreadMessages(
    threadId: string,
    pageId: string,
    orgId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ThreadMessagesPage> {
    const limit = options?.limit ?? MESSAGE_PAGE_SIZE;
    let effectiveThreadId = normalizeCommentThreadId(threadId);
    let parsed = parseThreadId(effectiveThreadId);
    if (!parsed || parsed.pageId !== pageId) {
      throw new NotFoundException('Cuộc trò chuyện không hợp lệ');
    }

    if (parsed.kind === 'MESSENGER') {
      const resolved = await this.resolveMessengerPsid(pageId, orgId, {
        commentAuthorId: parsed.senderId,
      });
      if (
        resolved.psid &&
        resolved.threadId &&
        resolved.psid !== parsed.senderId
      ) {
        effectiveThreadId = resolved.threadId;
        parsed = parseThreadId(effectiveThreadId)!;
      }
    }

    await this.assertPageBelongsToOrg(pageId, orgId);

    const revision = await this.redisCache.getThreadRevision(
      pageId,
      effectiveThreadId,
    );
    const cacheKey =
      parsed.kind === 'FEED_COMMENT'
        ? `${this.redisCache.threadMessagesKey(
            pageId,
            effectiveThreadId,
            revision,
            limit,
            options?.before,
          )}:feed-graph-merge`
        : this.redisCache.threadMessagesKey(
            pageId,
            effectiveThreadId,
            revision,
            limit,
            options?.before,
          );
    const cached =
      parsed.kind === 'FEED_COMMENT'
        ? null
        : await this.redisCache.get<ThreadMessagesPage>(cacheKey);
    if (cached) {
      await this.markThreadRead(pageId, orgId, effectiveThreadId);
      if (parsed.kind === 'FEED_COMMENT') {
        const messages = this.enrichFeedCommentContent(cached.messages);
        return {
          ...cached,
          messages: await this.applyFeedCommentVisibilityFromGraph(
            messages,
            pageId,
            orgId,
            parsed.postId ?? '',
          ),
        };
      }
      return cached;
    }

    let result: ThreadMessagesPage;
    if (parsed.kind === 'MESSENGER') {
      result = await this.getMessengerThreadMessages(
        pageId,
        orgId,
        parsed.senderId,
        effectiveThreadId,
        limit,
        options?.before,
      );
    } else {
      result = await this.getCommentThreadMessages(
        pageId,
        orgId,
        parsed.postId!,
        parsed.senderId,
        effectiveThreadId,
        limit,
        options?.before,
        parsed.commentId,
      );
    }

    await this.redisCache.set(cacheKey, result, GRAPH_CACHE_TTL_SECONDS);
    await this.markThreadRead(pageId, orgId, effectiveThreadId);
    return result;
  }

  async getPostPreview(
    pageId: string,
    postId: string,
    orgId: string,
  ): Promise<FacebookPostPreview | null> {
    if (!postId) return null;

    const cacheKey = this.redisCache.postPreviewKey(pageId, postId);
    const cached = await this.redisCache.get<FacebookPostPreview>(cacheKey);
    if (cached) return cached;

    const page = await this.assertPageBelongsToOrg(pageId, orgId);
    if (!page.pageAccessToken) return null;

    const graphPost = await this.facebookOAuth.getPost(
      postId,
      page.pageAccessToken,
    );
    if (!graphPost) return null;

    const preview: FacebookPostPreview = {
      id: graphPost.id ?? postId,
      message: graphPost.message,
      story: graphPost.story,
      permalinkUrl: graphPost.permalink_url,
      fullPicture: graphPost.full_picture,
      createdTime: graphPost.created_time,
      fromName: graphPost.from?.name,
    };

    await this.redisCache.set(cacheKey, preview, GRAPH_CACHE_TTL_SECONDS);
    return preview;
  }

  private async assertPageBelongsToOrg(pageId: string, orgId: string) {
    if (!pageId?.trim()) {
      throw new BadRequestException('Thiếu pageId');
    }

    const pages = await this.facebookRepo.listPages(orgId);
    const page = pages.find((p) => p.pageId === pageId);
    if (!page) {
      throw new NotFoundException('Fanpage không tồn tại hoặc chưa liên kết');
    }

    return page;
  }

  private async getPageAccessToken(
    pageId: string,
    orgId: string,
  ): Promise<string | null> {
    const pages = await this.facebookRepo.listPages(orgId);
    return pages.find((p) => p.pageId === pageId)?.pageAccessToken ?? null;
  }

  private async listMessengerThreadsFromGraph(
    pageId: string,
    orgId: string,
  ): Promise<ConversationThread[]> {
    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) return [];

    const conversations = await this.facebookOAuth.listPageConversations(
      pageId,
      token,
    );
    return conversations
      .map((conv) => this.graphConversationToThread(conv, pageId))
      .filter(
        (t): t is ConversationThread => t !== null && t.pageId === pageId,
      );
  }

  private async listCommentThreadsFromGraph(
    pageId: string,
    orgId: string,
  ): Promise<ConversationThread[]> {
    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) return [];

    const posts = await this.facebookOAuth.listPageFeedWithComments(
      pageId,
      token,
      50,
    );
    this.logger.log(
      `[Conversations] listCommentThreadsFromGraph: found ${posts.length} posts from feed`,
    );

    // Fallback: nếu Graph API không trả post (thiếu quyền), dùng postId đã biết từ webhook
    const postIds =
      posts.length > 0
        ? posts.map((p) => p.id).filter(Boolean)
        : await this.listKnownCommentPostIds(pageId, orgId);

    if (posts.length === 0 && postIds.length > 0) {
      this.logger.warn(
        `[Conversations] Feed API trả rỗng, thử lấy comment từ ${postIds.length} bài đã biết qua webhook`,
      );
    }

    const map = new Map<string, ConversationThread & { _latest: number }>();

    const ingestPost = (postId: string, comments: GraphPostComment[]) => {
      this.logger.log(
        `[Conversations] Processing post ${postId} with ${comments.length} comments`,
      );
      for (const comment of comments) {
        const senderId = comment.from?.id;
        if (!senderId || senderId === pageId || !comment.created_time) continue;

        const ts = new Date(comment.created_time).getTime();
        if (!Number.isFinite(ts)) continue;

        const threadId = buildFeedCommentThreadId(pageId, postId, senderId);
        const existing = map.get(threadId);

        const serialized = this.serializeGraphCommentContent(comment);
        const preview = formatConversationThreadPreview({
          content: serialized.content,
          msgType: serialized.msgType,
          eventType: 'FEED_COMMENT',
          direction: 'IN',
          senderName: comment.from?.name ?? 'Khách hàng',
        });

        if (!existing) {
          map.set(threadId, {
            id: threadId,
            kind: 'FEED_COMMENT',
            pageId,
            senderId,
            senderName: comment.from?.name ?? 'Khách hàng',
            senderPictureUrl: extractGraphPictureUrl(comment.from),
            preview,
            lastMessageAt: comment.created_time,
            postId,
            commentId: comment.id,
            messageCount: 1,
            unreadCount: 0,
            _latest: ts,
          });
          continue;
        }

        existing.messageCount += 1;
        if (ts >= existing._latest) {
          existing._latest = ts;
          existing.lastMessageAt = comment.created_time;
          existing.preview = preview;
          if (senderId !== pageId) {
            existing.commentId = comment.id;
          }
          if (comment.from?.name && !isGenericSenderName(comment.from.name)) {
            existing.senderName = comment.from.name;
          }
        }
      }
    };

    for (const post of posts) {
      if (post.id) {
        ingestPost(post.id, post.comments?.data ?? []);
      }
    }

    if (posts.length === 0) {
      for (const postId of postIds) {
        const { comments } = await this.facebookOAuth.getPostComments(
          postId,
          token,
          { limit: 100 },
        );
        ingestPost(postId, comments);
      }
    }

    return [...map.values()]
      .sort((a, b) => b._latest - a._latest)
      .map(({ _latest, ...thread }) => thread);
  }

  /** Lấy danh sách postId đã có sự kiện bình luận trong webhook (fallback khi Graph feed lỗi). */
  private async listKnownCommentPostIds(
    pageId: string,
    orgId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        postId: { not: null },
        OR: [{ organizationId: orgId }, { organizationId: null }],
      },
      select: { postId: true },
      distinct: ['postId'],
      take: 100,
    });

    return rows.map((r) => r.postId!).filter(Boolean);
  }

  private graphConversationToThread(
    conv: GraphConversation,
    pageId: string,
  ): ConversationThread | null {
    const customer = conv.participants?.data?.find((p) => p.id !== pageId);
    if (!customer?.id) return null;

    let senderPictureUrl = extractGraphPictureUrl(customer);
    let senderName = customer.name ?? 'Khách hàng';
    if (conv.messages?.data) {
      for (const msg of conv.messages.data) {
        if (msg.from?.id !== customer.id) continue;
        if (
          isGenericSenderName(senderName) &&
          msg.from?.name &&
          !isGenericSenderName(msg.from.name)
        ) {
          senderName = msg.from.name;
        }
        if (!senderPictureUrl) {
          senderPictureUrl = extractGraphPictureUrl(msg.from);
        }
        if (!isGenericSenderName(senderName) && senderPictureUrl) break;
      }
    }

    return {
      id: `messenger:${pageId}:${customer.id}`,
      kind: 'MESSENGER',
      pageId,
      senderId: customer.id,
      senderName,
      senderPictureUrl,
      preview: conv.snippet ?? '',
      lastMessageAt: conv.updated_time ?? new Date().toISOString(),
      postId: null,
      commentId: null,
      messageCount: conv.message_count ?? 0,
      unreadCount: 0,
    };
  }

  private mergeConversationThreads(
    webhook: ConversationThread[],
    graph: ConversationThread[],
  ): ConversationThread[] {
    const map = new Map<string, ConversationThread>();

    for (const thread of graph) {
      map.set(thread.id, thread);
    }

    for (const thread of webhook) {
      const existing = map.get(thread.id);
      if (!existing) {
        map.set(thread.id, thread);
        continue;
      }

      const webhookTs = new Date(thread.lastMessageAt).getTime();
      const graphTs = new Date(existing.lastMessageAt).getTime();

      map.set(thread.id, {
        ...existing,
        senderName: pickBetterSenderName(existing.senderName, thread.senderName),
        senderPictureUrl:
          existing.senderPictureUrl ?? thread.senderPictureUrl ?? null,
        preview: webhookTs >= graphTs ? thread.preview : existing.preview,
        lastMessageAt:
          webhookTs >= graphTs ? thread.lastMessageAt : existing.lastMessageAt,
        messageCount: Math.max(thread.messageCount, existing.messageCount),
        unreadCount: Math.max(thread.unreadCount, existing.unreadCount),
        postId: thread.postId ?? existing.postId,
        commentId: thread.commentId ?? existing.commentId,
        kind: thread.kind,
      });
    }

    return [...map.values()].sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime(),
    );
  }

  private async getReadAtByThread(
    pageId: string,
    orgId: string,
  ): Promise<Map<string, Date>> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ thread_id: string; last_read_at: Date | string }>
      >`
        SELECT thread_id, last_read_at
        FROM conversation_read_states
        WHERE page_id = ${pageId} AND organization_id = ${orgId}
      `;

      return new Map(
        rows.map((row) => [row.thread_id, new Date(row.last_read_at)]),
      );
    } catch {
      return new Map();
    }
  }

  private async markThreadRead(
    pageId: string,
    orgId: string,
    threadId: string,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO conversation_read_states (
          id,
          organization_id,
          page_id,
          thread_id,
          last_read_at,
          updated_at
        )
        VALUES (
          lower(hex(randomblob(16))),
          ${orgId},
          ${pageId},
          ${threadId},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(organization_id, page_id, thread_id)
        DO UPDATE SET
          last_read_at = excluded.last_read_at,
          updated_at = excluded.updated_at
      `;
    } catch {
      // Bỏ qua khi database local chưa chạy migration read-state.
    }
  }

  private async getMessengerThreadMessages(
    pageId: string,
    orgId: string,
    customerPsid: string,
    threadId: string,
    limit: number,
    before?: string,
  ): Promise<ThreadMessagesPage> {
    const result = await this.getWebhookThreadMessages(
      threadId,
      pageId,
      orgId,
      customerPsid,
      limit,
      before,
    );

    const needsGraphFallback =
      result.messages.length === 0 ||
      (!before && result.messages.length < Math.min(limit, 3));

    if (needsGraphFallback) {
      const graphResult = await this.getMessengerThreadMessagesFromGraph(
        pageId,
        orgId,
        customerPsid,
        limit,
        before,
      );
      if (graphResult.messages.length > 0) {
        const mergedMessages = this.mergeThreadMessages(
          result.messages as WebhookEvent[],
          graphResult.messages,
        );
        const sliced = mergedMessages.slice(-limit);
        const oldest = sliced[0];
        const graphMeta = before
          ? undefined
          : await this.loadMessengerThreadMeta(pageId, threadId, orgId);
        const pinnedSet = new Set(graphMeta?.pinnedMessageIds ?? []);
        const reactionsByMessage = before
          ? new Map<string, MessageReactionView[]>()
          : await this.loadMessengerReactions(pageId, threadId);

        return {
          messages: sliced.map((msg) => {
            const messageId = msg.messageId?.trim();
            if (!messageId) return msg;
            return {
              ...msg,
              isPinned: pinnedSet.has(messageId),
              reactions: reactionsByMessage.get(messageId) ?? [],
            };
          }),
          paging: {
            hasMore: graphResult.paging.hasMore || result.paging.hasMore,
            nextBefore:
              result.paging.nextBefore ?? graphResult.paging.nextBefore,
          },
          meta: graphMeta,
        };
      }
    }

    if (before) {
      return result;
    }

    const meta = await this.loadMessengerThreadMeta(pageId, threadId, orgId);
    const pinnedSet = new Set(meta.pinnedMessageIds);
    const reactionsByMessage = await this.loadMessengerReactions(
      pageId,
      threadId,
    );

    return {
      ...result,
      messages: result.messages.map((msg) => {
        const messageId = msg.messageId?.trim();
        if (!messageId) return msg;
        return {
          ...msg,
          isPinned: pinnedSet.has(messageId),
          reactions: reactionsByMessage.get(messageId) ?? [],
        };
      }),
      meta,
    };
  }

  /** Kiểm tra comment thuộc thread khách trên bài viết (dùng khi đọc từ Graph API). */
  private commentBelongsToThread(
    comment: GraphPostComment,
    pageId: string,
    customerId: string,
    byId: Map<string, GraphPostComment>,
  ): boolean {
    const senderId = comment.from?.id;
    if (!senderId) return false;
    if (senderId === customerId) return true;
    if (senderId !== pageId || !comment.parent?.id) return false;

    const parent = byId.get(comment.parent.id);
    if (!parent) return false;
    return this.commentBelongsToThread(parent, pageId, customerId, byId);
  }

  private async getCommentThreadMessages(
    pageId: string,
    orgId: string,
    postId: string,
    customerId: string,
    threadId: string,
    limit: number,
    before?: string,
    _rootCommentId?: string,
  ): Promise<ThreadMessagesPage> {
    const result = await this.getWebhookThreadMessages(
      threadId,
      pageId,
      orgId,
      customerId,
      limit,
      before,
    );

    const graphResult = await this.getCommentThreadMessagesFromGraph(
      pageId,
      orgId,
      postId,
      customerId,
      limit,
      before,
    );

    if (graphResult.messages.length === 0 && result.messages.length === 0) {
      return graphResult;
    }

    if (graphResult.messages.length === 0) {
      return {
        ...result,
        messages: await this.applyFeedCommentVisibilityFromGraph(
          result.messages,
          pageId,
          orgId,
          postId,
        ),
      };
    }

    const mergedMessages = this.mergeThreadMessages(
      result.messages as WebhookEvent[],
      graphResult.messages,
    );
    const sliced = mergedMessages.slice(-limit);
    const oldest = sliced[0];
    const hasMore =
      mergedMessages.length > limit ||
      graphResult.paging.hasMore ||
      result.paging.hasMore;

    return {
      messages: await this.applyFeedCommentVisibilityFromGraph(
        sliced,
        pageId,
        orgId,
        postId,
      ),
      paging: {
        hasMore,
        nextBefore:
          hasMore && oldest
            ? oldest.createdAt.toISOString()
            : result.paging.nextBefore ?? graphResult.paging.nextBefore,
      },
    };
  }

  private async getMessengerThreadMessagesFromGraph(
    pageId: string,
    orgId: string,
    customerPsid: string,
    limit: number,
    before?: string,
  ): Promise<ThreadMessagesPage> {
    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) {
      return { messages: [], paging: { hasMore: false, nextBefore: null } };
    }

    const { messages, paging } =
      await this.facebookOAuth.getMessengerMessagesByPsid(
        pageId,
        customerPsid,
        token,
        { limit, before },
      );

    const events = messages
      .map((msg) => this.graphMessageToEvent(msg, pageId, customerPsid, orgId))
      .reverse();

    const enriched = await this.enrichMessagePictures(
      events,
      pageId,
      orgId,
      customerPsid,
    );
    const withNames = await this.enrichMessageSenderNames(
      enriched,
      pageId,
      orgId,
      customerPsid,
    );

    const oldest = withNames[0];
    const hasMore = Boolean(paging?.cursors?.before);

    return {
      messages: withNames,
      paging: {
        hasMore,
        nextBefore: hasMore && oldest ? oldest.createdAt.toISOString() : null,
      },
    };
  }

  private async getCommentThreadMessagesFromGraph(
    pageId: string,
    orgId: string,
    postId: string,
    customerId: string,
    limit: number,
    before?: string,
  ): Promise<ThreadMessagesPage> {
    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) {
      return { messages: [], paging: { hasMore: false, nextBefore: null } };
    }

    const comments = await this.getCachedPostComments(
      pageId,
      orgId,
      postId,
      token,
    );
    const byId = new Map(
      comments
        .filter((c): c is GraphPostComment & { id: string } => !!c.id)
        .map((c) => [c.id, c]),
    );

    let threadComments = comments.filter((c) =>
      this.commentBelongsToThread(c, pageId, customerId, byId),
    );

    const beforeDate = parseDateCursor(before);
    if (beforeDate) {
      threadComments = threadComments.filter(
        (c) => new Date(c.created_time).getTime() < beforeDate.getTime(),
      );
    }

    threadComments.sort(
      (a, b) =>
        new Date(a.created_time).getTime() - new Date(b.created_time).getTime(),
    );

    const hasMore = threadComments.length > limit;
    const page = hasMore
      ? threadComments.slice(threadComments.length - limit)
      : threadComments;

    const events = page.map((c) =>
      this.graphCommentToEvent(c, pageId, postId, customerId, orgId),
    );

    const withMedia = this.enrichFeedCommentContent(events);
    const enriched = await this.enrichMessagePictures(
      withMedia,
      pageId,
      orgId,
      customerId,
    );
    const withNames = await this.enrichMessageSenderNames(
      enriched,
      pageId,
      orgId,
      customerId,
    );

    const oldest = withNames[0];

    return {
      messages: withNames,
      paging: {
        hasMore,
        nextBefore: hasMore && oldest ? oldest.createdAt.toISOString() : null,
      },
    };
  }

  /** Webhook-driven only — không reconcile với Graph API */
  private async pruneStaleCommentsForPage(
    _pageId: string,
    _orgId: string,
  ): Promise<void> {
    return;
  }

  /** @deprecated */
  private async reconcileStaleCommentsForPost_UNUSED(
    pageId: string,
    orgId: string,
    postId: string,
    graphComments: GraphPostComment[],
    token: string,
  ): Promise<Set<string>> {
    const validIds = new Set(
      graphComments.map((c) => c.id).filter((id): id is string => !!id),
    );

    const staleCandidates = await this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        postId,
        eventType: 'FEED_COMMENT',
        status: { not: EVENT_STATUS_DELETED },
      },
      select: { id: true, commentId: true, messageId: true },
    });

    const staleRowIds: string[] = [];

    for (const row of staleCandidates) {
      const key = row.commentId ?? row.messageId;
      if (!key || !isValidFacebookCommentId(key)) {
        staleRowIds.push(row.id);
        continue;
      }
      if (validIds.has(key)) continue;

      const meta = await this.facebookOAuth.getCommentMeta(key, token);
      if (meta?.id) {
        validIds.add(meta.id);
        continue;
      }

      staleRowIds.push(row.id);
    }

    if (staleRowIds.length > 0) {
      await this.prisma.webhookEvent.updateMany({
        where: { id: { in: staleRowIds } },
        data: { status: EVENT_STATUS_DELETED },
      });
      await this.redisCache.bumpPageRevision(orgId, pageId);
      this.logger.log(
        `[Conversations] Đã ẩn ${staleRowIds.length} comment không còn trên Facebook (post ${postId})`,
      );
    }

    return validIds;
  }

  private async getCachedPostComments(
    pageId: string,
    orgId: string,
    postId: string,
    token: string,
  ): Promise<GraphPostComment[]> {
    const pageRev = await this.redisCache.getPageRevision(orgId, pageId);
    const key = this.redisCache.postCommentsKey(pageId, postId, pageRev);
    const hit = await this.redisCache.get<GraphPostComment[]>(key);
    if (hit) return hit;

    const comments = await this.facebookOAuth.listAllPostComments(
      postId,
      token,
      { pageSize: 100, maxComments: 500 },
    );
    await this.redisCache.set(key, comments, GRAPH_CACHE_TTL_SECONDS);
    return comments;
  }

  /** Đồng bộ is_hidden từ Graph khi load thread — tránh UI ACTIVE trong khi FB đã ẩn. */
  private async applyFeedCommentVisibilityFromGraph(
    messages: ConversationMessage[],
    pageId: string,
    orgId: string,
    postId: string,
  ): Promise<ConversationMessage[]> {
    const hasFeedComments = messages.some((m) => m.eventType === 'FEED_COMMENT');
    if (!hasFeedComments || !postId?.trim()) return messages;

    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) return messages;

    const graphComments = await this.getCachedPostComments(
      pageId,
      orgId,
      postId,
      token,
    );
    if (!graphComments.length) return messages;

    const graphById = new Map<string, GraphPostComment>();
    for (const comment of graphComments) {
      if (comment.id) graphById.set(comment.id, comment);
    }

    const resolveGraphComment = (
      commentKey: string,
    ): GraphPostComment | undefined => {
      const direct = graphById.get(commentKey);
      if (direct) return direct;
      for (const [id, candidate] of graphById) {
        if (facebookCommentIdsMatch(id, commentKey)) return candidate;
      }
      return undefined;
    };

    return messages.map((msg) => {
      if (msg.eventType !== 'FEED_COMMENT') return msg;
      const key = msg.commentId ?? msg.messageId;
      if (!key) return msg;

      const graph = resolveGraphComment(key);
      if (!graph || graph.is_hidden === undefined) return msg;

      const nextStatus =
        graph.is_hidden === true
          ? EVENT_STATUS_HIDDEN
          : msg.status === EVENT_STATUS_DELETED
            ? EVENT_STATUS_DELETED
            : EVENT_STATUS_ACTIVE;

      if ((msg.status ?? EVENT_STATUS_ACTIVE) === nextStatus) return msg;
      return { ...msg, status: nextStatus };
    });
  }

  private async getWebhookThreadMessages(
    threadId: string,
    pageId: string,
    orgId: string,
    customerPsid: string,
    limit: number,
    before?: string,
  ): Promise<ThreadMessagesPage> {
    const threadWhere = buildThreadEventWhere(threadId, pageId, orgId);
    if (!threadWhere) {
      throw new NotFoundException('Cuộc trò chuyện không hợp lệ');
    }

    const beforeDate = parseDateCursor(before);
    const where = {
      ...threadWhere,
      ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
    };

    const events = await this.prisma.webhookEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const pageEvents = hasMore ? events.slice(0, limit) : events;
    const chronological = [...pageEvents].reverse();

    const withMedia = this.enrichFeedCommentContent(chronological);
    const enriched = await this.enrichMessagePictures(
      withMedia,
      pageId,
      orgId,
      customerPsid,
    );
    const withNames = await this.enrichMessageSenderNames(
      enriched,
      pageId,
      orgId,
      customerPsid,
    );

    const oldest = withNames[0];

    return {
      messages: withNames,
      paging: {
        hasMore,
        nextBefore: hasMore && oldest ? oldest.createdAt.toISOString() : null,
      },
    };
  }

  private async enrichThreadNames(
    threads: ConversationThread[],
    pageId: string,
    orgId: string,
  ): Promise<ConversationThread[]> {
    const senderIds = [
      ...new Set(threads.filter((t) => t.senderId).map((t) => t.senderId)),
    ];
    if (!senderIds.length) return threads;

    const profiles = await this.prisma.customerProfile.findMany({
      where: { pageId, senderId: { in: senderIds } },
    });
    const nameBySender = new Map(
      profiles
        .filter((p) => p.senderName && !isGenericSenderName(p.senderName))
        .map((p) => [p.senderId, p.senderName as string]),
    );

    const token = await this.getPageAccessToken(pageId, orgId);
    const needsFetch = threads.filter(
      (t) =>
        t.senderId &&
        isGenericSenderName(t.senderName) &&
        !nameBySender.has(t.senderId),
    );

    if (token) {
      for (const thread of needsFetch.slice(0, 25)) {
        const profile = await this.facebookOAuth.getMessengerUserProfile(
          thread.senderId,
          token,
        );
        if (profile?.name && !isGenericSenderName(profile.name)) {
          nameBySender.set(thread.senderId, profile.name);
          void this.upsertCustomerProfile(
            pageId,
            thread.senderId,
            profile.name,
            profile.pictureUrl ?? null,
          ).catch(() => undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    return threads.map((thread) => {
      const resolved = nameBySender.get(thread.senderId);
      return {
        ...thread,
        senderName: pickBetterSenderName(resolved, thread.senderName),
      };
    });
  }

  private async resolveCustomerDisplayName(
    pageId: string,
    orgId: string,
    customerPsid: string,
  ): Promise<string | null> {
    if (!customerPsid || customerPsid === pageId) return null;

    const cached = await this.prisma.customerProfile.findUnique({
      where: { pageId_senderId: { pageId, senderId: customerPsid } },
    });
    if (cached?.senderName && !isGenericSenderName(cached.senderName)) {
      return cached.senderName;
    }

    const token = await this.getPageAccessToken(pageId, orgId);
    if (token) {
      const profile = await this.facebookOAuth.getMessengerUserProfile(
        customerPsid,
        token,
      );
      if (profile?.name && !isGenericSenderName(profile.name)) {
        void this.upsertCustomerProfile(
          pageId,
          customerPsid,
          profile.name,
          profile.pictureUrl ?? null,
        ).catch(() => undefined);
        return profile.name;
      }
    }

    return null;
  }

  private async enrichMessageSenderNames(
    messages: ConversationMessage[],
    pageId: string,
    orgId: string,
    customerPsid: string,
  ): Promise<ConversationMessage[]> {
    if (!messages.length) return messages;

    const pages = await this.facebookRepo.listPages(orgId);
    const pageName =
      pages.find((p) => p.pageId === pageId)?.name?.trim() || 'Page';
    const customerName =
      (await this.resolveCustomerDisplayName(pageId, orgId, customerPsid)) ??
      messages
        .map((m) =>
          m.direction === 'IN' && m.senderId === customerPsid
            ? m.senderName
            : null,
        )
        .find((name) => name && !isGenericSenderName(name)) ??
      'Khách hàng';

    return messages.map((msg) => {
      const isFromPage = msg.direction === 'OUT' || msg.senderId === pageId;
      if (isFromPage) {
        return {
          ...msg,
          senderName: pickBetterSenderName(pageName, msg.senderName),
        };
      }
      return {
        ...msg,
        senderName: pickBetterSenderName(customerName, msg.senderName),
      };
    });
  }

  private async enrichThreadPictures(
    threads: ConversationThread[],
    pageId: string,
  ): Promise<ConversationThread[]> {
    const senderIds = [
      ...new Set(threads.filter((t) => t.senderId).map((t) => t.senderId)),
    ];

    let cached = new Map<string, string>();
    try {
      cached = await this.getCachedCustomerPictures(pageId, senderIds);
    } catch {
      cached = new Map();
    }

    for (const thread of threads) {
      if (!thread.senderPictureUrl || cached.has(thread.senderId)) continue;
      void this.upsertCustomerProfile(
        pageId,
        thread.senderId,
        thread.senderName,
        thread.senderPictureUrl,
      ).catch(() => undefined);
      cached.set(thread.senderId, thread.senderPictureUrl);
    }

    return threads.map((thread) => {
      if (thread.senderPictureUrl) return thread;
      const picture = cached.get(thread.senderId) ?? null;
      return { ...thread, senderPictureUrl: picture };
    });
  }

  async enrichMessagesForDisplay(
    messages: ConversationMessage[],
    pageId: string,
    orgId: string,
    customerPsid: string,
  ): Promise<ConversationMessage[]> {
    const withMedia = this.enrichFeedCommentContent(messages);
    const withPictures = await this.enrichMessagePictures(
      withMedia,
      pageId,
      orgId,
      customerPsid,
    );
    return this.enrichMessageSenderNames(
      withPictures,
      pageId,
      orgId,
      customerPsid,
    );
  }

  async fetchAndCacheCustomerProfile(
    pageId: string,
    senderId: string,
    orgId: string,
    senderName?: string,
  ): Promise<string | null> {
    if (!pageId || !senderId) return null;

    const existing = await this.prisma.customerProfile.findUnique({
      where: { pageId_senderId: { pageId, senderId } },
    });
    if (existing?.pictureUrl && existing.senderName && !isGenericSenderName(existing.senderName)) {
      return existing.pictureUrl;
    }

    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) return existing?.pictureUrl ?? null;

    const graphProfile = await this.facebookOAuth.getMessengerUserProfile(
      senderId,
      token,
    );
    const resolvedName = pickBetterSenderName(
      graphProfile?.name,
      pickBetterSenderName(senderName, existing?.senderName),
    );
    const pictureUrl =
      graphProfile?.pictureUrl ??
      existing?.pictureUrl ??
      (await this.facebookOAuth.getProfilePictureUrl(senderId, token, pageId)) ??
      null;

    await this.upsertCustomerProfile(
      pageId,
      senderId,
      isGenericSenderName(resolvedName) ? undefined : resolvedName,
      pictureUrl,
    );
    return pictureUrl;
  }

  async resolveCustomerAvatarUrl(
    pageId: string,
    psid: string,
    orgId: string,
  ): Promise<string | null> {
    const cached = await this.prisma.customerProfile.findUnique({
      where: { pageId_senderId: { pageId, senderId: psid } },
    });
    if (cached?.pictureUrl) return cached.pictureUrl;

    return this.fetchAndCacheCustomerProfile(pageId, psid, orgId);
  }

  private async getCachedCustomerPictures(
    pageId: string,
    senderIds: string[],
  ): Promise<Map<string, string>> {
    if (!senderIds.length) return new Map();

    const rows = await this.prisma.customerProfile.findMany({
      where: { pageId, senderId: { in: senderIds }, pictureUrl: { not: null } },
    });

    return new Map(
      rows
        .filter((row) => row.pictureUrl)
        .map((row) => [row.senderId, row.pictureUrl as string]),
    );
  }

  private async upsertCustomerProfile(
    pageId: string,
    senderId: string,
    senderName?: string,
    pictureUrl?: string | null,
  ) {
    if (!pageId || !senderId) return;

    await this.prisma.customerProfile.upsert({
      where: { pageId_senderId: { pageId, senderId } },
      create: {
        pageId,
        senderId,
        senderName: senderName ?? null,
        pictureUrl: pictureUrl ?? null,
      },
      update: {
        ...(senderName && !isGenericSenderName(senderName) ? { senderName } : {}),
        ...(pictureUrl ? { pictureUrl } : {}),
      },
    });
  }

  private graphMessageToEvent(
    msg: GraphConversationMessage,
    pageId: string,
    customerPsid: string,
    orgId: string,
  ): ConversationMessage {
    const senderId = msg.from?.id ?? '';
    const isFromPage = senderId === pageId;

    return {
      id: `graph-${msg.id}`,
      organizationId: orgId,
      pageId,
      eventType: 'MESSENGER',
      direction: isFromPage ? 'OUT' : 'IN',
      senderId,
      senderName: msg.from?.name ?? (isFromPage ? 'Page' : 'Khách hàng'),
      senderPictureUrl: extractGraphPictureUrl(msg.from),
      recipientId: isFromPage ? customerPsid : pageId,
      messageId: msg.id,
      postId: null,
      commentId: null,
      parentCommentId: null,
      msgType: 'text',
      content: msg.message ?? '',
      rawPayload: JSON.stringify(msg),
      status: 'ACTIVE',
      deliveryStatus: null,
      createdAt: new Date(msg.created_time),
    };
  }

  private serializeGraphCommentContent(comment: GraphPostComment): {
    content: string;
    msgType: string;
  } {
    const isReply = !!comment.parent?.id;
    return serializeFeedCommentContent(
      {
        message: comment.message,
        attachment: comment.attachment,
      },
      { isReply },
    );
  }

  private enrichFeedCommentContent(
    messages: ConversationMessage[],
  ): ConversationMessage[] {
    return messages.map((msg) => {
      if (msg.eventType !== 'FEED_COMMENT') return msg;
      if (feedCommentContentHasMedia(msg.content)) return msg;
      if (msg.msgType?.includes('photo') && msg.content?.startsWith('{')) {
        return msg;
      }

      const serialized = serializeFeedCommentFromRawPayload(msg.rawPayload, {
        content: msg.content,
        msgType: msg.msgType,
        isReply: msg.msgType?.includes('reply'),
      });
      if (!serialized) return msg;

      return {
        ...msg,
        content: serialized.content,
        msgType: serialized.msgType,
      };
    });
  }

  private graphCommentToEvent(
    comment: GraphPostComment,
    pageId: string,
    postId: string,
    customerPsid: string,
    orgId: string,
  ): ConversationMessage {
    const senderId = comment.from?.id ?? '';
    const isFromPage = senderId === pageId;
    const { content, msgType } = this.serializeGraphCommentContent(comment);

    return {
      id: `graph-comment-${comment.id}`,
      organizationId: orgId,
      pageId,
      eventType: 'FEED_COMMENT',
      direction: isFromPage ? 'OUT' : 'IN',
      senderId: isFromPage ? pageId : senderId,
      senderName: comment.from?.name ?? (isFromPage ? 'Page' : 'Khách hàng'),
      senderPictureUrl: extractGraphPictureUrl(comment.from),
      recipientId: isFromPage ? customerPsid : null,
      messageId: comment.id,
      postId,
      commentId: comment.id,
      msgType,
      content,
      rawPayload: JSON.stringify(comment),
      status: comment.is_hidden === true ? 'HIDDEN' : 'ACTIVE',
      deliveryStatus: null,
      createdAt: new Date(comment.created_time),
      parentCommentId: comment.parent?.id ?? null,
    };
  }

  private pickMergedContentStatus(
    a?: string | null,
    b?: string | null,
  ): string {
    const rank: Record<string, number> = {
      ACTIVE: 0,
      HIDDEN: 1,
      DELETED: 2,
    };
    const sa = a ?? 'ACTIVE';
    const sb = b ?? 'ACTIVE';
    return (rank[sa] ?? 0) >= (rank[sb] ?? 0) ? sa : sb;
  }

  private mergeThreadMessages(
    webhook: WebhookEvent[],
    graph: ConversationMessage[],
  ): ConversationMessage[] {
    const byMessageId = new Map<string, ConversationMessage>();

    for (const event of graph) {
      if (event.messageId) byMessageId.set(event.messageId, event);
    }

    for (const event of webhook) {
      const key = event.messageId ?? event.id;
      const existing = byMessageId.get(key);
      const parentCommentId =
        existing?.parentCommentId ?? this.extractParentCommentId(event);
      const merged = {
        ...event,
        senderName: pickBetterSenderName(
          existing?.senderName,
          event.senderName,
        ),
        senderPictureUrl: existing?.senderPictureUrl ?? null,
        status: this.pickMergedContentStatus(existing?.status, event.status),
      } as ConversationMessage;
      byMessageId.set(key, merged);
    }

    return [...byMessageId.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  private extractParentCommentId(event: WebhookEvent): string | null {
    if (!event.rawPayload) return null;
    try {
      const raw = JSON.parse(event.rawPayload);
      if (raw.parent?.id) return raw.parent.id;
      if (raw.parent_id && raw.parent_id !== raw.post_id) return raw.parent_id;
    } catch {
      // ignore
    }
    return null;
  }

  private async enrichMessagePictures(
    messages: WebhookEvent[],
    pageId: string,
    orgId: string,
    customerPsid: string,
  ): Promise<ConversationMessage[]> {
    const pages = await this.facebookRepo.listPages(orgId);
    const pagePicture =
      pages.find((p) => p.pageId === pageId)?.pictureUrl ?? null;
    const token = await this.getPageAccessToken(pageId, orgId);

    const userIdsToFetch = new Set<string>();
    for (const msg of messages) {
      const existing = msg as ConversationMessage;
      if (existing.senderPictureUrl) continue;

      const isFromPage = msg.direction === 'OUT' || msg.senderId === pageId;
      if (isFromPage) continue;
      const userId = msg.senderId ?? customerPsid;
      if (userId) userIdsToFetch.add(userId);
    }

    const fetchedPictures =
      token && userIdsToFetch.size > 0
        ? await this.facebookOAuth.getProfilePicturesBatch(
            [...userIdsToFetch],
            token,
            pageId,
          )
        : new Map<string, string | null>();

    let resolvedPagePicture = pagePicture;
    if (!resolvedPagePicture && token) {
      resolvedPagePicture =
        (await this.facebookOAuth.getProfilePictureUrl(
          pageId,
          token,
          pageId,
        )) ?? null;
    }

    return messages.map((msg) => {
      const existing = msg as ConversationMessage;
      if (existing.senderPictureUrl) return existing;

      const isFromPage = msg.direction === 'OUT' || msg.senderId === pageId;
      if (isFromPage) {
        return { ...msg, senderPictureUrl: resolvedPagePicture };
      }

      const userId = msg.senderId ?? customerPsid;
      return {
        ...msg,
        senderPictureUrl: userId ? (fetchedPictures.get(userId) ?? null) : null,
      };
    });
  }

  private async loadMessengerThreadMeta(
    pageId: string,
    threadId: string,
    orgId: string,
  ): Promise<ThreadMessagesMeta> {
    const pinned = await this.prisma.pinnedThreadMessage.findMany({
      where: { pageId, threadId, organizationId: orgId },
      orderBy: { pinnedAt: 'desc' },
      select: { messageId: true },
    });

    return {
      pinnedMessageIds: pinned.map((row) => row.messageId),
    };
  }

  private async loadMessengerReactions(
    pageId: string,
    threadId: string,
  ): Promise<Map<string, MessageReactionView[]>> {
    const rows = await this.prisma.messengerMessageReaction.findMany({
      where: { pageId, threadId },
      orderBy: { createdAt: 'asc' },
    });

    const byMessage = new Map<string, MessageReactionView[]>();
    for (const row of rows) {
      const list = byMessage.get(row.messageId) ?? [];
      list.push({ emoji: row.emoji, reactorId: row.reactorId });
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  }

  async reactToMessengerMessage(input: {
    pageId: string;
    threadId: string;
    messageId: string;
    emoji: string;
    orgId: string;
  }): Promise<{ success: boolean; emoji: string }> {
    const pageId = input.pageId?.trim();
    const threadId = normalizeCommentThreadId(input.threadId?.trim() ?? '');
    const messageId = input.messageId?.trim();
    const emoji = input.emoji?.trim();

    if (!pageId || !threadId || !messageId || !emoji) {
      throw new BadRequestException('Thiếu pageId, threadId, messageId hoặc emoji');
    }
    if (!ALLOWED_MESSENGER_REACTIONS.has(emoji)) {
      throw new BadRequestException('Emoji reaction không được hỗ trợ');
    }

    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.pageId !== pageId || parsed.kind !== 'MESSENGER') {
      throw new BadRequestException('Chỉ hỗ trợ reaction trên tin nhắn Messenger');
    }

    await this.assertPageBelongsToOrg(pageId, input.orgId);

    const event = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        messageId,
        eventType: 'MESSENGER',
        direction: 'IN',
        OR: [
          { senderId: parsed.senderId },
          { recipientId: parsed.senderId },
        ],
      },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException('Không tìm thấy tin nhắn khách hàng');
    }

    const token = await this.getPageAccessToken(pageId, input.orgId);
    if (token) {
      try {
        await this.graphApi.reactToMessengerMessage(
          parsed.senderId,
          token,
          messageId,
          emoji,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[Conversations] Graph react failed for ${messageId}: ${message}`,
        );
      }
    }

    await this.prisma.messengerMessageReaction.upsert({
      where: {
        pageId_threadId_messageId_reactorId: {
          pageId,
          threadId,
          messageId,
          reactorId: pageId,
        },
      },
      create: {
        organizationId: input.orgId,
        pageId,
        threadId,
        messageId,
        emoji,
        reactorId: pageId,
      },
      update: { emoji },
    });

    await this.redisCache.bumpThreadRevision(pageId, threadId);
    return { success: true, emoji };
  }

  async unreactToMessengerMessage(input: {
    pageId: string;
    threadId: string;
    messageId: string;
    orgId: string;
  }): Promise<{ success: boolean }> {
    const pageId = input.pageId?.trim();
    const threadId = normalizeCommentThreadId(input.threadId?.trim() ?? '');
    const messageId = input.messageId?.trim();

    if (!pageId || !threadId || !messageId) {
      throw new BadRequestException('Thiếu pageId, threadId hoặc messageId');
    }

    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.pageId !== pageId || parsed.kind !== 'MESSENGER') {
      throw new BadRequestException('Chỉ hỗ trợ bỏ reaction trên tin nhắn Messenger');
    }

    await this.assertPageBelongsToOrg(pageId, input.orgId);

    const token = await this.getPageAccessToken(pageId, input.orgId);
    if (token) {
      try {
        await this.graphApi.unreactToMessengerMessage(
          parsed.senderId,
          token,
          messageId,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[Conversations] Graph unreact failed for ${messageId}: ${message}`,
        );
      }
    }

    await this.prisma.messengerMessageReaction.deleteMany({
      where: {
        pageId,
        threadId,
        messageId,
        reactorId: pageId,
      },
    });

    await this.redisCache.bumpThreadRevision(pageId, threadId);
    return { success: true };
  }

  async pinMessengerMessage(input: {
    pageId: string;
    threadId: string;
    messageId: string;
    orgId: string;
  }): Promise<{ success: boolean; pinned: boolean }> {
    const pageId = input.pageId?.trim();
    const threadId = normalizeCommentThreadId(input.threadId?.trim() ?? '');
    const messageId = input.messageId?.trim();

    if (!pageId || !threadId || !messageId) {
      throw new BadRequestException('Thiếu pageId, threadId hoặc messageId');
    }

    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.pageId !== pageId || parsed.kind !== 'MESSENGER') {
      throw new BadRequestException('Chỉ hỗ trợ ghim tin nhắn Messenger');
    }

    await this.assertPageBelongsToOrg(pageId, input.orgId);

    const event = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        messageId,
        eventType: 'MESSENGER',
      },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException('Không tìm thấy tin nhắn');
    }

    await this.prisma.pinnedThreadMessage.upsert({
      where: {
        pageId_threadId_messageId: {
          pageId,
          threadId,
          messageId,
        },
      },
      create: {
        organizationId: input.orgId,
        pageId,
        threadId,
        messageId,
      },
      update: { pinnedAt: new Date() },
    });

    await this.redisCache.bumpThreadRevision(pageId, threadId);
    return { success: true, pinned: true };
  }

  async unpinMessengerMessage(input: {
    pageId: string;
    threadId: string;
    messageId: string;
    orgId: string;
  }): Promise<{ success: boolean; pinned: boolean }> {
    const pageId = input.pageId?.trim();
    const threadId = normalizeCommentThreadId(input.threadId?.trim() ?? '');
    const messageId = input.messageId?.trim();

    if (!pageId || !threadId || !messageId) {
      throw new BadRequestException('Thiếu pageId, threadId hoặc messageId');
    }

    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.pageId !== pageId || parsed.kind !== 'MESSENGER') {
      throw new BadRequestException('Chỉ hỗ trợ bỏ ghim tin nhắn Messenger');
    }

    await this.assertPageBelongsToOrg(pageId, input.orgId);

    await this.prisma.pinnedThreadMessage.deleteMany({
      where: { pageId, threadId, messageId },
    });

    await this.redisCache.bumpThreadRevision(pageId, threadId);
    return { success: true, pinned: false };
  }

  /**
   * Tìm PSID Messenger từ ID người bình luận (Graph user id ≠ PSID).
   * Dùng khi chuyển từ tab bình luận sang nhắn tin Messenger.
   */
  async resolveMessengerPsid(
    pageId: string,
    orgId: string,
    input: { commentAuthorId?: string; senderName?: string },
  ): Promise<{
    psid: string | null;
    threadId: string | null;
    hasExistingConversation: boolean;
  }> {
    const commentAuthorId = input.commentAuthorId?.trim();
    const senderName = input.senderName?.trim();
    const empty = {
      psid: null,
      threadId: null,
      hasExistingConversation: false,
    };

    if (commentAuthorId) {
      const token = await this.getPageAccessToken(pageId, orgId);

      const fromPrivateReply = await this.resolvePsidFromPrivateReplyHistory(
        pageId,
        orgId,
        commentAuthorId,
        senderName,
        token,
      );
      if (fromPrivateReply) {
        return {
          psid: fromPrivateReply,
          threadId: buildMessengerThreadId(pageId, fromPrivateReply),
          hasExistingConversation: true,
        };
      }

      const messengerInEvent = await this.prisma.webhookEvent.findFirst({
        where: {
          pageId,
          eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK'] },
          direction: 'IN',
          senderId: commentAuthorId,
        },
        orderBy: { createdAt: 'desc' },
        select: { senderId: true },
      });
      if (messengerInEvent?.senderId && token) {
        const verified = await this.verifyMessengerPsid(
          pageId,
          messengerInEvent.senderId,
          token,
        );
        if (verified) {
          return {
            psid: verified,
            threadId: buildMessengerThreadId(pageId, verified),
            hasExistingConversation: true,
          };
        }
      }

      if (token) {
        const verifiedPsid = await this.verifyMessengerPsid(
          pageId,
          commentAuthorId,
          token,
        );
        if (verifiedPsid) {
          return {
            psid: verifiedPsid,
            threadId: buildMessengerThreadId(pageId, verifiedPsid),
            hasExistingConversation: true,
          };
        }
      }
    }

    if (senderName && !isGenericSenderName(senderName)) {
      const normalized = senderName.toLowerCase();
      const messengerEvents = await this.prisma.webhookEvent.findMany({
        where: {
          pageId,
          eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK'] },
          direction: 'IN',
          senderName: { not: null },
        },
        select: { senderId: true, senderName: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const byName = messengerEvents.find(
        (e) => e.senderName?.trim().toLowerCase() === normalized,
      );
      const token = await this.getPageAccessToken(pageId, orgId);
      if (byName?.senderId && token) {
        const verified = await this.verifyMessengerPsid(
          pageId,
          byName.senderId,
          token,
        );
        if (verified) {
          return {
            psid: verified,
            threadId: buildMessengerThreadId(pageId, verified),
            hasExistingConversation: true,
          };
        }
      }

      if (token) {
        const conversations = await this.facebookOAuth.listPageConversations(
          pageId,
          token,
        );
        for (const conv of conversations) {
          const customer = conv.participants?.data?.find((p) => p.id !== pageId);
          const name = customer?.name?.trim().toLowerCase();
          if (customer?.id && name === normalized) {
            const verified = await this.verifyMessengerPsid(
              pageId,
              customer.id,
              token,
            );
            if (verified) {
              return {
                psid: verified,
                threadId: buildMessengerThreadId(pageId, verified),
                hasExistingConversation: true,
              };
            }
          }
        }
      }
    }

    return empty;
  }

  /**
   * Sau private reply: PSID có thể nằm trong payload hoặc tin IN đầu tiên của khách (cùng tên).
   */
  private async resolvePsidFromPrivateReplyHistory(
    pageId: string,
    orgId: string,
    commentAuthorId: string,
    senderName: string | undefined,
    token: string | null,
  ): Promise<string | null> {
    if (!commentAuthorId?.trim() || !token) return null;

    const outRows = await this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        eventType: 'MESSENGER',
        direction: 'OUT',
        recipientId: commentAuthorId.trim(),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { rawPayload: true, createdAt: true },
    });

    let privateReplyAt: Date | null = null;
    for (const row of outRows) {
      try {
        const raw = JSON.parse(row.rawPayload ?? '{}') as {
          source?: string;
          resolvedPsid?: string;
        };
        if (raw.source !== 'app_send_private_reply') continue;
        privateReplyAt = row.createdAt;
        const candidate = raw.resolvedPsid?.trim();
        if (candidate) {
          const verified = await this.verifyMessengerPsid(
            pageId,
            candidate,
            token,
          );
          if (verified) return verified;
        }
      } catch {
        // ignore malformed payload
      }
    }

    const name =
      senderName?.trim() ||
      (await this.lookupFeedCommentAuthorName(pageId, commentAuthorId));
    if (!name || isGenericSenderName(name) || !privateReplyAt) return null;

    const normalized = name.toLowerCase();
    const inRows = await this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK'] },
        direction: 'IN',
        createdAt: { gte: privateReplyAt },
        senderName: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { senderId: true, senderName: true },
    });

    const match = inRows.find(
      (e) => e.senderName?.trim().toLowerCase() === normalized,
    );
    if (!match?.senderId) return null;

    return this.verifyMessengerPsid(pageId, match.senderId, token);
  }

  private async lookupFeedCommentAuthorName(
    pageId: string,
    commentAuthorId: string,
  ): Promise<string | null> {
    const row = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        direction: 'IN',
        senderId: commentAuthorId.trim(),
        senderName: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { senderName: true },
    });
    return row?.senderName?.trim() ?? null;
  }

  /** Chỉ coi là PSID hợp lệ khi Graph trả về hội thoại Messenger thật. */
  private async verifyMessengerPsid(
    pageId: string,
    candidateId: string,
    token: string,
  ): Promise<string | null> {
    if (!candidateId?.trim()) return null;
    const { messages } = await this.facebookOAuth.getMessengerMessagesByPsid(
      pageId,
      candidateId,
      token,
      { limit: 1 },
    );
    return messages.length > 0 ? candidateId : null;
  }

  /**
   * Chuẩn hóa comment id trước khi gọi Graph (webhook id đôi khi khác format).
   * Trả về id Graph xác nhận được, hoặc id gốc nếu không tra được.
   */
  async resolveCanonicalCommentId(
    pageId: string,
    orgId: string,
    commentId: string,
    postIdHint?: string | null,
  ): Promise<string> {
    const trimmed = commentId?.trim();
    if (!trimmed || !isValidFacebookCommentId(trimmed)) return trimmed;

    const token = await this.getPageAccessToken(pageId, orgId);
    if (!token) return trimmed;

    const sample = await this.prisma.webhookEvent.findFirst({
      where: {
        pageId,
        eventType: 'FEED_COMMENT',
        OR: [{ commentId: trimmed }, { messageId: trimmed }],
      },
      select: { postId: true, commentId: true, messageId: true },
    });

    const postId = postIdHint?.trim() || sample?.postId?.trim() || undefined;
    for (const candidate of buildGraphCommentIdCandidates(trimmed, postId)) {
      const direct = await this.facebookOAuth.getCommentMeta(candidate, token, {
        silent: true,
      });
      if (direct?.id) return direct.id;
    }

    if (postId) {
      for (const candidate of buildGraphCommentIdCandidates(trimmed, postId)) {
        const fromPost = await this.facebookOAuth.getCommentMeta(
          candidate,
          token,
          { postId, silent: true },
        );
        if (fromPost?.id) return fromPost.id;
      }
    }

    if (sample) {
      for (const candidate of [sample.commentId, sample.messageId]) {
        if (!candidate || candidate === trimmed) continue;
        for (const lookupId of buildGraphCommentIdCandidates(candidate, postId)) {
          const meta = await this.facebookOAuth.getCommentMeta(lookupId, token, {
            postId: postId ?? undefined,
            silent: true,
          });
          if (meta?.id && facebookCommentIdsMatch(meta.id, trimmed)) {
            return meta.id;
          }
        }
      }
    }

    return trimmed;
  }
}
