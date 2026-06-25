import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WebhookEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  FacebookOAuthService,
  extractGraphPictureUrl,
  type GraphConversation,
  type GraphConversationMessage,
  type GraphPostComment,
} from './facebook-oauth.service';
import { FacebookRepoService } from './facebook-repo.service';
import { RedisCacheService } from '../../redis/redis-cache.service';
import {
  aggregateConversations,
  buildThreadEventWhere,
  isGenericSenderName,
  parseThreadId,
  pickBetterSenderName,
  type ConversationThread,
} from '../utils/conversation-thread.util';

export interface FacebookPostPreview {
  id: string;
  message?: string;
  story?: string;
  permalinkUrl?: string;
  fullPicture?: string;
  createdTime?: string;
  fromName?: string;
}

export type ConversationMessage = WebhookEvent & {
  senderPictureUrl?: string | null;
};

export interface ThreadMessagesPage {
  messages: ConversationMessage[];
  paging: {
    hasMore: boolean;
    nextBefore: string | null;
  };
}

export interface ConversationListPage {
  threads: ConversationThread[];
  paging: {
    hasMore: boolean;
    nextBefore: string | null;
  };
}

const MESSAGE_PAGE_SIZE = 15;
const CONVERSATION_PAGE_SIZE = 15;

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookRepo: FacebookRepoService,
    private readonly facebookOAuth: FacebookOAuthService,
    private readonly redisCache: RedisCacheService,
  ) {}

  async listByPage(
    pageId: string,
    orgId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ConversationListPage> {
    const limit = options?.limit ?? CONVERSATION_PAGE_SIZE;
    const merged = await this.fetchMergedThreads(pageId, orgId);
    const withPictures = await this.enrichThreadPictures(merged, pageId);
    const enriched = await this.enrichThreadNames(withPictures, pageId, orgId);

    const sorted = [...enriched].sort(
      (a, b) =>
        new Date(b.lastMessageAt).getTime() -
        new Date(a.lastMessageAt).getTime(),
    );

    const eligible = options?.before
      ? sorted.filter(
          (t) =>
            new Date(t.lastMessageAt).getTime() <
            new Date(options.before!).getTime(),
        )
      : sorted;

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
  ): Promise<ConversationThread[]> {
    await this.assertPageBelongsToOrg(pageId, orgId);

    const events = await this.prisma.webhookEvent.findMany({
      where: {
        pageId,
        OR: [{ organizationId: orgId }, { organizationId: null }],
        eventType: { in: ['MESSENGER', 'MESSENGER_POSTBACK', 'FEED_COMMENT'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    const fromWebhook = aggregateConversations(events);

    const [fromMessengerGraph, fromCommentGraph] = await Promise.all([
      this.listMessengerThreadsFromGraph(pageId, orgId).catch(
        () => [] as ConversationThread[],
      ),
      this.listCommentThreadsFromGraph(pageId, orgId).catch(
        () => [] as ConversationThread[],
      ),
    ]);

    const merged = this.mergeConversationThreads(
      this.mergeConversationThreads(fromWebhook, fromMessengerGraph),
      fromCommentGraph,
    );

    return merged.filter((thread) => thread.pageId === pageId);
  }

  async getThreadMessages(
    threadId: string,
    pageId: string,
    orgId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ThreadMessagesPage> {
    const limit = options?.limit ?? MESSAGE_PAGE_SIZE;
    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.pageId !== pageId) {
      throw new NotFoundException('Cuộc trò chuyện không hợp lệ');
    }

    await this.assertPageBelongsToOrg(pageId, orgId);

    const revision = await this.redisCache.getThreadRevision(pageId, threadId);
    const cacheKey = this.redisCache.threadMessagesKey(
      pageId,
      threadId,
      revision,
      limit,
      options?.before,
    );
    const cached = await this.redisCache.get<ThreadMessagesPage>(cacheKey);
    if (cached) return cached;

    let result: ThreadMessagesPage;
    if (parsed.kind === 'MESSENGER') {
      result = await this.getMessengerThreadMessages(
        pageId,
        orgId,
        parsed.senderId,
        threadId,
        limit,
        options?.before,
      );
    } else {
      result = await this.getCommentThreadMessages(
        pageId,
        orgId,
        parsed.postId!,
        parsed.senderId,
        threadId,
        limit,
        options?.before,
      );
    }

    await this.redisCache.set(cacheKey, result);
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

    await this.redisCache.set(cacheKey, preview);
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
    );
    const map = new Map<string, ConversationThread & { _latest: number }>();

    for (const post of posts) {
      const postId = post.id;
      if (!postId) continue;

      for (const comment of post.comments?.data ?? []) {
        const senderId = comment.from?.id;
        if (!senderId || senderId === pageId || !comment.created_time) continue;

        const ts = new Date(comment.created_time).getTime();
        if (!Number.isFinite(ts)) continue;

        const threadId = `comment:${pageId}:${postId}:${senderId}`;
        const existing = map.get(threadId);

        if (!existing) {
          map.set(threadId, {
            id: threadId,
            kind: 'FEED_COMMENT',
            pageId,
            senderId,
            senderName: comment.from?.name ?? 'Khách hàng',
            senderPictureUrl: extractGraphPictureUrl(comment.from),
            preview: comment.message ?? '',
            lastMessageAt: comment.created_time,
            postId,
            commentId: comment.id,
            messageCount: 1,
            _latest: ts,
          });
          continue;
        }

        existing.messageCount += 1;
        if (ts >= existing._latest) {
          existing._latest = ts;
          existing.lastMessageAt = comment.created_time;
          existing.preview = comment.message ?? existing.preview;
          existing.commentId = comment.id;
          if (comment.from?.name) existing.senderName = comment.from.name;
          const picture = extractGraphPictureUrl(comment.from);
          if (picture) existing.senderPictureUrl = picture;
        }
      }
    }

    return [...map.values()]
      .sort((a, b) => b._latest - a._latest)
      .map(({ _latest, ...thread }) => thread);
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

  private async getMessengerThreadMessages(
    pageId: string,
    orgId: string,
    customerPsid: string,
    threadId: string,
    limit: number,
    before?: string,
  ): Promise<ThreadMessagesPage> {
    const token = await this.getPageAccessToken(pageId, orgId);

    let graphEvents: ConversationMessage[] = [];
    let graphPaging: { hasMore: boolean; nextBefore: string | null } = {
      hasMore: false,
      nextBefore: null,
    };

    if (token) {
      const { messages, paging } =
        await this.facebookOAuth.getMessengerMessagesByPsid(
          pageId,
          customerPsid,
          token,
          { limit, before },
        );

      graphEvents = messages.map((msg) =>
        this.graphMessageToEvent(msg, pageId, customerPsid, orgId),
      );

      const hasMore = messages.length >= limit && !!paging?.cursors?.before;
      graphPaging = {
        hasMore,
        nextBefore: hasMore ? (paging?.cursors?.before ?? null) : null,
      };
    }

    const webhookResult = await this.getWebhookThreadMessages(
      threadId,
      pageId,
      orgId,
      customerPsid,
      limit,
      before,
    );

    const merged = this.mergeThreadMessages(
      webhookResult.messages,
      graphEvents,
    );
    const sorted = merged.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    const eligible = before
      ? sorted.filter((m) => m.createdAt.getTime() < new Date(before).getTime())
      : sorted;
    const hasMore = eligible.length > limit || graphPaging.hasMore;
    const pageMessages = eligible.slice(-limit);
    const oldest = pageMessages[0];

    const enriched = await this.enrichMessagePictures(
      pageMessages,
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

    return {
      messages: withNames,
      paging: {
        hasMore,
        nextBefore:
          hasMore && oldest
            ? oldest.createdAt.toISOString()
            : graphPaging.nextBefore,
      },
    };
  }

  private async getCommentThreadMessages(
    pageId: string,
    orgId: string,
    postId: string,
    customerId: string,
    threadId: string,
    limit: number,
    before?: string,
  ): Promise<ThreadMessagesPage> {
    const token = await this.getPageAccessToken(pageId, orgId);
    const customerCommentIds = new Set<string>();

    let graphEvents: ConversationMessage[] = [];
    if (token) {
      const { comments } = await this.facebookOAuth.getPostComments(
        postId,
        token,
        { limit: 100 },
      );
      for (const comment of comments) {
        if (comment.from?.id === customerId) {
          customerCommentIds.add(comment.id);
        }
      }

      graphEvents = comments
        .filter(
          (comment) =>
            comment.from?.id === customerId ||
            (comment.from?.id === pageId &&
              comment.parent?.id &&
              customerCommentIds.has(comment.parent.id)),
        )
        .map((comment) =>
          this.graphCommentToEvent(comment, pageId, postId, customerId, orgId),
        );
    }

    const webhookResult = await this.getWebhookThreadMessages(
      threadId,
      pageId,
      orgId,
      customerId,
      limit,
      before,
    );

    const merged = this.mergeThreadMessages(
      webhookResult.messages,
      graphEvents,
    );
    const sorted = merged.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    const eligible = before
      ? sorted.filter((m) => m.createdAt.getTime() < new Date(before).getTime())
      : sorted;
    const hasMore = eligible.length > limit;
    const pageMessages = eligible.slice(-limit);
    const oldest = pageMessages[0];

    const enriched = await this.enrichMessagePictures(
      pageMessages,
      pageId,
      orgId,
      customerId,
    );

    return {
      messages: enriched,
      paging: {
        hasMore,
        nextBefore: hasMore && oldest ? oldest.createdAt.toISOString() : null,
      },
    };
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

    const where = {
      ...threadWhere,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    };

    const events = await this.prisma.webhookEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = events.length > limit;
    const pageEvents = hasMore ? events.slice(0, limit) : events;
    const chronological = [...pageEvents].reverse();

    const enriched = await this.enrichMessagePictures(
      chronological,
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
      msgType: 'text',
      content: msg.message ?? '',
      rawPayload: JSON.stringify(msg),
      createdAt: new Date(msg.created_time),
    };
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

    return {
      id: `graph-comment-${comment.id}`,
      organizationId: orgId,
      pageId,
      eventType: 'FEED_COMMENT',
      direction: isFromPage ? 'OUT' : 'IN',
      senderId,
      senderName: comment.from?.name ?? (isFromPage ? 'Page' : 'Khách hàng'),
      senderPictureUrl: extractGraphPictureUrl(comment.from),
      recipientId: isFromPage ? customerPsid : pageId,
      messageId: comment.id,
      postId,
      commentId: comment.id,
      msgType: 'feed.comment',
      content: comment.message ?? '',
      rawPayload: JSON.stringify(comment),
      createdAt: new Date(comment.created_time),
    };
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
      const merged = {
        ...event,
        senderName: pickBetterSenderName(
          existing?.senderName,
          event.senderName,
        ),
        senderPictureUrl: existing?.senderPictureUrl ?? null,
      } as ConversationMessage;
      byMessageId.set(key, merged);
    }

    return [...byMessageId.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
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
}
