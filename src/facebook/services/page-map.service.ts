import { Injectable } from '@nestjs/common';

export interface SocialMapEntry {
  socialId: string;
  orgId: string;
  status: string;
  isAiEnabled: boolean;
}

@Injectable()
export class PageMapService {
  private readonly map = new Map<string, SocialMapEntry>();

  syncSocialAccount(input: {
    platformId: string;
    socialId: string;
    organizationId: string;
    status?: string;
    isAiEnabled?: boolean;
  }): void {
    this.map.set(input.platformId, {
      socialId: input.socialId,
      orgId: input.organizationId,
      status: input.status ?? 'ACTIVE',
      isAiEnabled: input.isAiEnabled ?? true,
    });
  }

  getSocialMap(pageId: string): SocialMapEntry | null {
    return this.map.get(pageId) ?? null;
  }

  remove(pageId: string): void {
    this.map.delete(pageId);
  }

  listAll(): Array<{ pageId: string } & SocialMapEntry> {
    return [...this.map.entries()].map(([pageId, entry]) => ({
      pageId,
      ...entry,
    }));
  }
}
