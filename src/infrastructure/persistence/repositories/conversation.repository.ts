import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Repository conversation_list — đọc trạng thái inbox từ DB.
 * Danh sách hội thoại được aggregate từ message_history (webhook_events).
 */
@Injectable()
export class ConversationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getReadAtByThread(
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

  async markThreadRead(
    pageId: string,
    orgId: string,
    threadId: string,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO conversation_read_states (
          id, organization_id, page_id, thread_id, last_read_at, updated_at
        )
        VALUES (
          lower(hex(randomblob(16))), ${orgId}, ${pageId}, ${threadId},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT(organization_id, page_id, thread_id)
        DO UPDATE SET last_read_at = excluded.last_read_at, updated_at = excluded.updated_at
      `;
    } catch {
      // Bỏ qua khi DB chưa migrate read-state
    }
  }
}
