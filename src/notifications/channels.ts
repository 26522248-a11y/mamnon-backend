/**
 * Pluggable notification channels. NOTIFY_CHANNELS (default "inapp,webpush") lists the enabled ones;
 * sms / zalo are stubs (log a 'skipped' delivery) until a provider is wired: SMS_PROVIDER, ZALO_OA_ID/ZALO_ZNS_TEMPLATE_ID.
 * Every attempt is written to notification_deliveries; a failing channel never breaks the business flow.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import * as webpush from 'web-push';
import { Notification, NotificationDelivery, NotificationType, PushSubscription, User } from '../database/entities';

export interface PushAction { action: string; title: string }
export interface OutboundMessage {
  type: NotificationType; title: string; body?: string | null; data?: Record<string, unknown> | null;
  announcementId?: string | null; important?: boolean; refId?: string | null;
  /** web push extras; `perUser` builds per-recipient data (e.g. signed action tokens) */
  push?: { url?: string; tag?: string; image?: string | null; actions?: PushAction[]; requireInteraction?: boolean;
    perUser?: (userId: string) => Promise<Record<string, unknown>> | Record<string, unknown> };
}
export interface ChannelResult { channel: string; sent: number; failed: number; skipped: number }

export interface NotificationChannel {
  readonly name: string;
  enabled(): boolean;
  send(userIds: string[], msg: OutboundMessage, m?: EntityManager): Promise<ChannelResult>;
}

const enabledList = () => (process.env.NOTIFY_CHANNELS ?? 'inapp,webpush').split(',').map((s) => s.trim()).filter(Boolean);

async function logDeliveries(ds: DataSource | EntityManager, rows: Partial<NotificationDelivery>[]) {
  if (!rows.length) return;
  try { await ds.createQueryBuilder().insert().into(NotificationDelivery).values(rows as any).execute(); } catch (e) { new Logger('Notify').warn(`delivery log failed: ${e}`); }
}

/** In-app inbox (notifications table). */
export class InAppChannel implements NotificationChannel {
  readonly name = 'inapp';
  constructor(private ds: DataSource) {}
  enabled() { return enabledList().includes('inapp'); }
  async send(userIds: string[], msg: OutboundMessage, m?: EntityManager): Promise<ChannelResult> {
    if (!userIds.length) return { channel: this.name, sent: 0, failed: 0, skipped: 0 };
    await (m ?? this.ds.manager).createQueryBuilder().insert().into(Notification).values(userIds.map((userId) => ({
      userId, type: msg.type, title: msg.title.slice(0, 200), body: msg.body ?? null, data: msg.data ?? null, announcementId: msg.announcementId ?? null, important: !!msg.important,
    })) as any).execute();
    return { channel: this.name, sent: userIds.length, failed: 0, skipped: 0 };
  }
}

export type PushTransport = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<{ statusCode: number }>;
let transportOverride: PushTransport | null = null;
/** Tests replace the real push service call. */
export const setPushTransport = (t: PushTransport | null) => { transportOverride = t; };

export const vapidConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

/** Web Push (VAPID): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:… or https://…). */
export class WebPushChannel implements NotificationChannel {
  readonly name = 'webpush';
  private log = new Logger('WebPush');
  constructor(private ds: DataSource) {}
  enabled() { return enabledList().includes('webpush') && (vapidConfigured() || !!transportOverride); }
  private transport(): PushTransport {
    if (transportOverride) return transportOverride;
    return (sub, payload) => webpush.sendNotification(sub, payload, {
      TTL: 2 * 3600, urgency: 'high', timeout: 5000,
      vapidDetails: { subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! },
    });
  }
  async send(userIds: string[], msg: OutboundMessage): Promise<ChannelResult> {
    const res: ChannelResult = { channel: this.name, sent: 0, failed: 0, skipped: 0 };
    if (!userIds.length) return res;
    const subs = await this.ds.getRepository(PushSubscription).find({ where: { userId: In(userIds) } });
    const logs: Partial<NotificationDelivery>[] = [];
    const noSub = userIds.filter((u) => !subs.some((s) => s.userId === u));
    for (const u of noSub) logs.push({ channel: this.name, userId: u, type: msg.type, refId: msg.refId ?? null, status: 'skipped', error: 'no subscription' });
    res.skipped = noSub.length;
    const send = this.transport();
    await Promise.all(subs.map(async (s) => {
      const extra = msg.push?.perUser ? await msg.push.perUser(s.userId) : {};
      const payload = JSON.stringify({
        title: msg.title, body: msg.body ?? '', tag: msg.push?.tag, image: msg.push?.image ?? undefined, icon: '/icon-192.png', badge: '/icon-192.png',
        requireInteraction: msg.push?.requireInteraction ?? false, actions: msg.push?.actions ?? [],
        data: { type: msg.type, url: msg.push?.url ?? '/', ...(msg.data ?? {}), ...extra },
      });
      try {
        const r = await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        res.sent++;
        await this.ds.getRepository(PushSubscription).update(s.id, { lastSuccessAt: new Date(), failCount: 0, lastError: null });
        logs.push({ channel: this.name, userId: s.userId, type: msg.type, refId: msg.refId ?? null, status: 'sent', error: r?.statusCode && r.statusCode >= 300 ? `HTTP ${r.statusCode}` : null });
      } catch (e: any) {
        res.failed++;
        const code = e?.statusCode;
        const err = `${code ? 'HTTP ' + code + ' ' : ''}${e?.body || e?.message || e}`.slice(0, 500);
        this.log.warn(`push to user ${s.userId} failed: ${err}`);
        // 404/410: subscription expired or revoked by the browser -> remove it
        if (code === 404 || code === 410) await this.ds.getRepository(PushSubscription).delete(s.id);
        else await this.ds.getRepository(PushSubscription).update(s.id, { lastError: err, failCount: () => 'fail_count + 1' } as any);
        logs.push({ channel: this.name, userId: s.userId, type: msg.type, refId: msg.refId ?? null, status: 'failed', error: err });
      }
    }));
    await logDeliveries(this.ds, logs);
    return res;
  }
}

/** Stub: SMS_PROVIDER (e.g. "esms", "speedsms") not wired yet – records 'skipped' with the phone it would use. */
export class SmsChannel implements NotificationChannel {
  readonly name = 'sms';
  constructor(private ds: DataSource) {}
  enabled() { return enabledList().includes('sms'); }
  async send(userIds: string[], msg: OutboundMessage): Promise<ChannelResult> {
    const users = userIds.length ? await this.ds.getRepository(User).find({ where: { id: In(userIds) }, select: { id: true, phone: true } }) : [];
    await logDeliveries(this.ds, users.map((u) => ({ channel: this.name, userId: u.id, type: msg.type, refId: msg.refId ?? null, status: 'skipped',
      error: `SMS adapter not configured (SMS_PROVIDER=${process.env.SMS_PROVIDER || 'none'}); would send to ${u.phone ?? 'no phone'}` })));
    return { channel: this.name, sent: 0, failed: 0, skipped: users.length };
  }
}

/** Stub: Zalo ZNS (ZALO_OA_ID, ZALO_ZNS_TEMPLATE_ID, ZALO_ACCESS_TOKEN) not wired yet. */
export class ZaloChannel implements NotificationChannel {
  readonly name = 'zalo';
  constructor(private ds: DataSource) {}
  enabled() { return enabledList().includes('zalo'); }
  async send(userIds: string[], msg: OutboundMessage): Promise<ChannelResult> {
    await logDeliveries(this.ds, userIds.map((u) => ({ channel: this.name, userId: u, type: msg.type, refId: msg.refId ?? null, status: 'skipped',
      error: `Zalo ZNS adapter not configured (ZALO_OA_ID=${process.env.ZALO_OA_ID ? 'set' : 'unset'})` })));
    return { channel: this.name, sent: 0, failed: 0, skipped: userIds.length };
  }
}

@Injectable()
export class NotificationDispatcher {
  private log = new Logger('Notify');
  readonly channels: NotificationChannel[];
  constructor(private ds: DataSource) {
    this.channels = [new InAppChannel(ds), new WebPushChannel(ds), new SmsChannel(ds), new ZaloChannel(ds)];
  }
  /**
   * Sends through the enabled channels. `only` limits the channels (e.g. pickup requests skip the general inbox:
   * the parent sees them in the dedicated pickup feed). Channel errors are logged, never thrown.
   */
  async dispatch(userIds: string[], msg: OutboundMessage, opts: { only?: string[]; m?: EntityManager } = {}): Promise<ChannelResult[]> {
    const ids = [...new Set(userIds)];
    const out: ChannelResult[] = [];
    for (const ch of this.channels) {
      if (!ch.enabled() || (opts.only && !opts.only.includes(ch.name))) continue;
      try { out.push(await ch.send(ids, msg, ch.name === 'inapp' ? opts.m : undefined)); }
      catch (e) { this.log.warn(`channel ${ch.name} failed: ${e}`); out.push({ channel: ch.name, sent: 0, failed: ids.length, skipped: 0 }); }
    }
    return out;
  }
  status() { return this.channels.map((c) => ({ channel: c.name, enabled: c.enabled() })); }
}
