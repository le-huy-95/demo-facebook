import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppLogger } from '../common/logger.service';

export const CACHE_INVALIDATE_CHANNEL = 'cache:invalidate';

const DEFAULT_TTL_SECONDS = 86400;
/** TTL mặc định cho dữ liệu Graph API (hội thoại, comment) */
export const GRAPH_CACHE_TTL_SECONDS = 3600;

interface MemoryEntry {
  raw: string;
  expiresAt: number;
}

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;
  private subscriber: Redis | null = null;
  private enabled = false;
  /** Fallback khi không có Redis — vẫn cache để tránh gọi Graph API lặp lại */
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly memoryCounters = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RedisCacheService.name);
  }

  async onModuleInit(): Promise<void> {
    const url = this.configService.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn(
        'REDIS_URL not set — dùng in-memory cache (TTL) thay vì gọi Graph API mỗi request',
      );
      return;
    }

    try {
      this.client = new Redis(url, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
      });
      this.subscriber = new Redis(url, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
      });
      await this.client.connect();
      await this.subscriber.connect();
      await this.subscriber.subscribe(CACHE_INVALIDATE_CHANNEL);
      this.subscriber.on('message', (channel, message) => {
        if (channel !== CACHE_INVALIDATE_CHANNEL) return;
        try {
          const { keys } = JSON.parse(message) as { keys: string[] };
          void this.deleteKeys(keys);
        } catch {
          // ignore malformed pub/sub payload
        }
      });
      this.enabled = true;
      this.logger.log('Redis cache connected');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Redis unavailable: ${msg}. Dùng in-memory cache thay thế.`,
      );
      await this.disconnect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  isEnabled(): boolean {
    return this.enabled && !!this.client;
  }

  /** Có cache hoạt động (Redis hoặc in-memory). */
  hasCache(): boolean {
    return this.isEnabled() || this.memory.size > 0 || this.memoryCounters.size > 0;
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.client) {
      try {
        const raw = await this.client.get(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }

    const entry = this.memory.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.memory.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.raw) as T;
    } catch {
      return null;
    }
  }

  async set(
    key: string,
    value: unknown,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    const serialized = JSON.stringify(value);

    if (this.client) {
      try {
        await this.client.set(key, serialized, 'EX', ttlSeconds);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Redis SET failed for ${key}: ${msg}`);
      }
    }

    this.memory.set(key, {
      raw: serialized,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  postPreviewKey(pageId: string, postId: string): string {
    return `post:${pageId}:${postId}`;
  }

  pageThreadsKey(orgId: string, pageId: string, revision: number): string {
    return `page:threads:${orgId}:${pageId}:${revision}`;
  }

  graphMessengerThreadsKey(pageId: string, revision: number): string {
    return `graph:messenger:${pageId}:${revision}`;
  }

  graphCommentThreadsKey(pageId: string, revision: number): string {
    return `graph:comments:${pageId}:${revision}`;
  }

  postCommentsKey(pageId: string, postId: string, revision: number): string {
    return `post:comments:${pageId}:${postId}:${revision}`;
  }

  private pageRevisionKey(orgId: string, pageId: string): string {
    return `page:${orgId}:${pageId}:rev`;
  }

  async getPageRevision(orgId: string, pageId: string): Promise<number> {
    const key = this.pageRevisionKey(orgId, pageId);
    if (this.client) {
      try {
        const raw = await this.client.get(key);
        return raw ? Number(raw) : 0;
      } catch {
        return 0;
      }
    }
    return this.memoryCounters.get(key) ?? 0;
  }

  async bumpPageRevision(orgId: string, pageId: string): Promise<void> {
    const key = this.pageRevisionKey(orgId, pageId);
    if (this.client) {
      try {
        await this.client.incr(key);
        return;
      } catch {
        // fallback memory
      }
    }
    this.memoryCounters.set(key, (this.memoryCounters.get(key) ?? 0) + 1);
  }

  async getThreadRevision(pageId: string, threadId: string): Promise<number> {
    const key = this.threadRevisionKey(pageId, threadId);
    if (this.client) {
      try {
        const raw = await this.client.get(key);
        return raw ? Number(raw) : 0;
      } catch {
        return 0;
      }
    }
    return this.memoryCounters.get(key) ?? 0;
  }

  threadMessagesKey(
    pageId: string,
    threadId: string,
    revision: number,
    limit: number,
    before?: string,
  ): string {
    return `thread:${pageId}:${threadId}:msgs:${revision}:${limit}:${before ?? 'latest'}`;
  }

  private threadRevisionKey(pageId: string, threadId: string): string {
    return `thread:${pageId}:${threadId}:rev`;
  }

  async bumpThreadRevision(pageId: string, threadId: string): Promise<void> {
    const revKey = this.threadRevisionKey(pageId, threadId);
    if (this.client) {
      try {
        await this.client.incr(revKey);
        await this.client.publish(
          CACHE_INVALIDATE_CHANNEL,
          JSON.stringify({ keys: [revKey] }),
        );
        return;
      } catch {
        // fallback memory
      }
    }
    this.memoryCounters.set(revKey, (this.memoryCounters.get(revKey) ?? 0) + 1);
  }

  async invalidateAndPublish(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.deleteKeys(keys);
    if (!this.client) return;
    try {
      await this.client.publish(
        CACHE_INVALIDATE_CHANNEL,
        JSON.stringify({ keys }),
      );
    } catch {
      // ignore
    }
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.memory.delete(key);
    }
    if (!this.client || !keys.length) return;
    try {
      await this.client.del(...keys);
    } catch {
      // ignore
    }
  }

  private async disconnect(): Promise<void> {
    this.enabled = false;
    const toClose = [this.subscriber, this.client].filter(Boolean) as Redis[];
    this.subscriber = null;
    this.client = null;
    await Promise.all(toClose.map((c) => c.quit().catch(() => undefined)));
  }
}
