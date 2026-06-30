/**
 * Migrate data from SQLite (prisma/dev.db) to PostgreSQL (DATABASE_URL).
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-postgres.mjs           # merge webhook + profile data
 *   node scripts/migrate-sqlite-to-postgres.mjs --dry-run
 *   node scripts/migrate-sqlite-to-postgres.mjs --include-auth
 */
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env') });

const SQLITE_PATH = resolve(process.cwd(), 'prisma/dev.db');
const dryRun = process.argv.includes('--dry-run');
const includeAuth = process.argv.includes('--include-auth');
const BATCH = 100;

const prisma = new PrismaClient();
const sqlite = new Database(SQLITE_PATH, { readonly: true });

function parseDate(value) {
  if (value == null || value === '') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function bool(value) {
  if (value == null) return false;
  return value === 1 || value === true || value === '1';
}

async function batchCreateMany(model, rows, label) {
  if (!rows.length) {
    console.log(`  ${label}: 0 rows (skip)`);
    return { inserted: 0, skipped: 0 };
  }
  if (dryRun) {
    console.log(`  ${label}: would insert up to ${rows.length} rows`);
    return { inserted: rows.length, skipped: 0 };
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const result = await model.createMany({ data: chunk, skipDuplicates: true });
    inserted += result.count;
  }
  const skipped = rows.length - inserted;
  console.log(`  ${label}: inserted ${inserted}, skipped ${skipped} (duplicate)`);
  return { inserted, skipped };
}

function readAll(table) {
  return sqlite.prepare(`SELECT * FROM "${table}"`).all();
}

async function migrateCredentials() {
  const rows = readAll('facebook_credentials').map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    friendlyName: r.friendly_name,
    fbUserId: r.fb_user_id,
    fbUserName: r.fb_user_name,
    userAccessToken: r.user_access_token,
    userTokenExpiresAt: parseDate(r.user_token_expires_at),
    userTokenStatus: r.user_token_status ?? 'VALID',
    status: r.status ?? 'PENDING',
    createdAt: parseDate(r.created_at) ?? new Date(),
    updatedAt: parseDate(r.updated_at) ?? new Date(),
  }));
  return batchCreateMany(prisma.facebookCredential, rows, 'facebook_credentials');
}

async function migratePages() {
  const rows = readAll('facebook_pages').map((r) => ({
    id: r.id,
    credentialId: r.credential_id,
    organizationId: r.organization_id,
    pageId: r.page_id,
    name: r.name,
    category: r.category,
    pictureUrl: r.picture_url,
    pageAccessToken: r.page_access_token,
    tasks: r.tasks ?? '[]',
    webhookSubscribed: bool(r.webhook_subscribed),
    webhookSubscribedAt: parseDate(r.webhook_subscribed_at),
    isPinned: bool(r.is_pinned),
    pinnedAt: parseDate(r.pinned_at),
    status: r.status ?? 'ACTIVE',
    createdAt: parseDate(r.created_at) ?? new Date(),
    updatedAt: parseDate(r.updated_at) ?? new Date(),
  }));
  return batchCreateMany(prisma.facebookPage, rows, 'facebook_pages');
}

async function migrateWebhookEvents() {
  const rows = readAll('webhook_events').map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    pageId: r.page_id,
    eventType: r.event_type ?? 'MESSENGER',
    direction: r.direction,
    senderId: r.sender_id,
    senderName: r.sender_name,
    recipientId: r.recipient_id,
    messageId: r.message_id,
    postId: r.post_id,
    commentId: r.comment_id,
    parentCommentId: r.parent_comment_id,
    msgType: r.msg_type,
    content: r.content,
    rawPayload: r.raw_payload,
    status: r.status ?? 'ACTIVE',
    deliveryStatus: r.delivery_status,
    createdAt: parseDate(r.created_at) ?? new Date(),
  }));
  return batchCreateMany(prisma.webhookEvent, rows, 'webhook_events');
}

async function migrateCustomerProfiles() {
  const rows = readAll('customer_profiles').map((r) => ({
    id: r.id,
    pageId: r.page_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    pictureUrl: r.picture_url,
    updatedAt: parseDate(r.updated_at) ?? new Date(),
  }));
  return batchCreateMany(prisma.customerProfile, rows, 'customer_profiles');
}

async function migrateReadStates() {
  const rows = readAll('conversation_read_states').map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    pageId: r.page_id,
    threadId: r.thread_id,
    lastReadAt: parseDate(r.last_read_at) ?? new Date(),
    updatedAt: parseDate(r.updated_at) ?? new Date(),
  }));
  return batchCreateMany(prisma.conversationReadState, rows, 'conversation_read_states');
}

async function migrateMessengerReactions() {
  const fromNew = readAll('messenger_message_reactions').map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    pageId: r.page_id,
    threadId: r.thread_id,
    messageId: r.message_id,
    emoji: r.emoji,
    reactorId: r.reactor_id,
    createdAt: parseDate(r.created_at) ?? new Date(),
  }));

  const fromLegacy = readAll('message_reactions').map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    pageId: r.page_id,
    threadId: r.thread_id,
    messageId: r.message_id,
    emoji: r.reaction ?? '👍',
    reactorId: r.organization_id ?? r.page_id ?? 'legacy',
    createdAt: parseDate(r.created_at) ?? new Date(),
  }));

  const seen = new Set(fromNew.map((r) => r.id));
  const merged = [...fromNew];
  for (const r of fromLegacy) {
    if (!seen.has(r.id)) merged.push(r);
  }
  return batchCreateMany(
    prisma.messengerMessageReaction,
    merged,
    'messenger_message_reactions',
  );
}

async function migratePinnedMessages() {
  const fromNew = readAll('pinned_thread_messages').map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    pageId: r.page_id,
    threadId: r.thread_id,
    messageId: r.message_id,
    pinnedAt: parseDate(r.pinned_at) ?? new Date(),
  }));

  const fromLegacy = readAll('pinned_messages').map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    pageId: r.page_id,
    threadId: r.thread_id,
    messageId: r.message_id,
    pinnedAt: parseDate(r.pinned_at) ?? new Date(),
  }));

  const seen = new Set(fromNew.map((r) => r.id));
  const merged = [...fromNew];
  for (const r of fromLegacy) {
    if (!seen.has(r.id)) merged.push(r);
  }
  return batchCreateMany(prisma.pinnedThreadMessage, merged, 'pinned_thread_messages');
}

async function main() {
  console.log('SQLite → PostgreSQL migration');
  console.log(`  source: ${SQLITE_PATH}`);
  console.log(`  target: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`  dry-run: ${dryRun}`);
  console.log(`  include-auth: ${includeAuth}`);
  console.log('');

  const before = {
    webhook: await prisma.webhookEvent.count(),
    profiles: await prisma.customerProfile.count(),
  };
  console.log(`PostgreSQL before: webhook_events=${before.webhook}, customer_profiles=${before.profiles}`);
  console.log('');

  if (includeAuth) {
    await migrateCredentials();
    await migratePages();
  } else {
    console.log('  facebook_credentials: skip (use --include-auth to import)');
    console.log('  facebook_pages: skip (use --include-auth to import)');
  }

  await migrateWebhookEvents();
  await migrateCustomerProfiles();
  await migrateReadStates();
  await migrateMessengerReactions();
  await migratePinnedMessages();

  if (!dryRun) {
    const after = {
      webhook: await prisma.webhookEvent.count(),
      profiles: await prisma.customerProfile.count(),
    };
    console.log('');
    console.log(`PostgreSQL after: webhook_events=${after.webhook}, customer_profiles=${after.profiles}`);
  }

  console.log('');
  console.log(dryRun ? 'Dry run complete.' : 'Migration complete.');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    sqlite.close();
    await prisma.$disconnect();
  });
