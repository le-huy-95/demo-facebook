import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppLogger } from '../common/logger.service';

export const CACHE_INVALIDATE_CHANNEL = 'cache:invalidate';

const DEFAULT_TTL_SECONDS = 86400;

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;
  private subscriber: Redis | null = null;
  private enabled = false;

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
        'REDIS_URL not set — cache disabled, falling back to direct API calls',
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
      this.logger.warn(`Redis unavailable: ${msg}. Cache disabled.`);
      await this.disconnect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  isEnabled(): boolean {
    return this.enabled && !!this.client;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const raw = await this.client.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(
    key: string,
    value: unknown,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Redis SET failed for ${key}: ${msg}`);
    }
  }

  postPreviewKey(pageId: string, postId: string): string {
    return `post:${pageId}:${postId}`;
  }

  async getThreadRevision(pageId: string, threadId: string): Promise<number> {
    if (!this.client) return 0;
    try {
      const raw = await this.client.get(
        this.threadRevisionKey(pageId, threadId),
      );
      return raw ? Number(raw) : 0;
    } catch {
      return 0;
    }
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
    if (!this.client) return;
    const revKey = this.threadRevisionKey(pageId, threadId);
    try {
      await this.client.incr(revKey);
      await this.client.publish(
        CACHE_INVALIDATE_CHANNEL,
        JSON.stringify({ keys: [revKey] }),
      );
    } catch {
      // ignore
    }
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
