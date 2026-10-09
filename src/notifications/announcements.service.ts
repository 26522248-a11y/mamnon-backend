import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import * as crypto from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { BadRequest } from '../common/errors';
import { storage } from '../common/storage';
import { detectImage, heifToJpeg } from '../common/upload';
import { Announcement, AnnouncementAttachment, Child, ClassTeacher, User } from '../database/entities';
import { NotificationsService } from './notifications.service';

export const MAX_ATTACHMENTS = 6;
/** ISO-8601 in Vietnam time, e.g. 2026-10-10T07:30:00+07:00 */
export const vnIso = (d: Date | null | undefined) => {
  if (!d) return null;
  const x = new Date(d.getTime() + 7 * 3600_000).toISOString();
  return `${x.slice(0, 19)}+07:00`;
};
export const attView = (x: AnnouncementAttachment) => ({
  id: x.id, url: `/api/v1/announcements/attachments/${x.id}`, thumbUrl: `/api/v1/announcements/attachments/${x.id}/thumb`,
  width: x.width, height: x.height, size: x.size,
});

/**
 * B9: delivery of announcements (now or at scheduledAt) + image attachments.
 * Scheduler: in-process tick (ANNOUNCEMENT_TICK_MS, default 30s, 0 = off) + catch-up on boot + POST /internal/cron/announcements.
 * Idempotent: due rows are claimed with SELECT … FOR UPDATE SKIP LOCKED and flipped scheduled → sent in the same transaction
 * that writes the inbox notifications, so two instances / a cron call racing the tick never double-send.
 */
@Injectable()
export class AnnouncementsService implements OnApplicationBootstrap, OnModuleDestroy {
  private log = new Logger('Announcements');
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private ds: DataSource, private notify: NotificationsService) {}

  onApplicationBootstrap() {
    const ms = Number(process.env.ANNOUNCEMENT_TICK_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 30_000));
    if (ms > 0) {
      setTimeout(() => this.tick(), 3_000).unref(); // catch-up after a restart / sleep
      this.timer = setInterval(() => this.tick(), ms);
      this.timer.unref();
    }
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private tick() {
    if (this.running) return;
    this.running = true;
    this.runDue().catch((e) => this.log.error(e?.message ?? e)).finally(() => { this.running = false; });
  }

  /** Recipients by scope & audience (author excluded). */
  async recipients(a: Announcement, m: EntityManager = this.ds.manager): Promise<string[]> {
    if (a.audience === 'specific') return [...new Set(a.recipientUserIds ?? [])].filter((id) => id !== a.createdBy);
    const ids: string[] = [];
    const wantParents = a.audience !== 'staff', wantStaff = a.audience !== 'parents';
    if (a.scope === 'school') {
      const roles = [...(wantParents ? ['parent'] : []), ...(wantStaff ? ['admin', 'teacher', 'accountant'] : [])];
      ids.push(...(await m.find(User, { where: { isActive: true, role: In(roles as any) }, select: { id: true } })).map((x) => x.id));
    } else {
      if (wantParents) {
        const kids = await m.find(Child, { where: { classId: a.classId!, status: 'active' }, select: { id: true } });
        ids.push(...(await this.notify.parentIdsOfChildren(kids.map((k) => k.id))));
      }
      if (wantStaff) {
        ids.push(...(await m.find(ClassTeacher, { where: { classId: a.classId! } })).map((t) => t.userId));
        ids.push(...(await m.find(User, { where: { isActive: true, role: 'admin' }, select: { id: true } })).map((x) => x.id));
      }
    }
    return [...new Set(ids)].filter((id) => id !== a.createdBy);
  }

  /** Writes inbox notifications + marks sent (inside m). Returns recipient ids for web push after commit. */
  async deliver(m: EntityManager, a: Announcement): Promise<string[]> {
    const ids = await this.recipients(a, m);
    const nAtt = await m.count(AnnouncementAttachment, { where: { announcementId: a.id } });
    await this.notify.toUsers(ids, {
      type: 'announcement', title: a.title, body: a.body.length > 300 ? a.body.slice(0, 297) + '...' : a.body, important: a.important,
      data: { announcementId: a.id, scope: a.scope, classId: a.classId, important: a.important, audience: a.audience, attachments: nAtt }, announcementId: a.id,
    }, m);
    await m.update(Announcement, a.id, { status: 'sent', sentAt: () => 'now()', recipientCount: ids.length } as any);
    return ids;
  }

  /** Web push (best effort, after commit). In-app rows were already written by deliver(). */
  push(a: Announcement, ids: string[]) {
    if (!ids.length) return;
    this.notify.send(ids, { type: 'announcement', title: a.title, body: a.body.slice(0, 200), announcementId: a.id, important: a.important, refId: a.id,
      data: { announcementId: a.id }, push: { url: '/notifications', tag: `ann-${a.id}` } }, { only: ['webpush'] })
      .catch((e: any) => this.log.warn(`push failed: ${e?.message ?? e}`));
  }

  /** Send every due scheduled announcement once. Safe to call concurrently (row locks + status transition). */
  async runDue(limit = 50): Promise<{ sent: string[] }> {
    const sent: { a: Announcement; ids: string[] }[] = [];
    await this.ds.transaction(async (m) => {
      const due: { id: string }[] = await m.query(`SELECT id FROM announcements WHERE status = 'scheduled' AND scheduled_at <= now() AND recalled_at IS NULL
        ORDER BY scheduled_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
      for (const { id } of due) {
        const a = await m.findOneByOrFail(Announcement, { id });
        if (a.status !== 'scheduled') continue;
        sent.push({ a, ids: await this.deliver(m, a) });
      }
    });
    for (const s of sent) this.push(s.a, s.ids);
    if (sent.length) this.log.log(`sent ${sent.length} scheduled announcement(s)`);
    return { sent: sent.map((s) => s.a.id) };
  }

  /** Validate (magic bytes), HEIC→JPEG, auto-rotate, strip EXIF/GPS, cap 2560px, square 360px thumbnail; store via storage(). */
  async saveAttachment(file: Express.Multer.File | undefined, userId: string): Promise<AnnouncementAttachment> {
    if (!file?.buffer?.length) throw BadRequest('Thiếu file ảnh', 'INVALID_FILE');
    const kind = detectImage(file.buffer);
    if (!kind) throw BadRequest('File không phải ảnh JPG/PNG/HEIC hợp lệ', 'INVALID_FILE');
    const sharp = require('sharp');
    const src = kind === 'heif' ? await heifToJpeg(file.buffer) : file.buffer;
    let full: Buffer, info: { width: number; height: number; size: number }, thumb: Buffer;
    try {
      const out = await sharp(src).rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      full = out.data; info = out.info;
      thumb = await sharp(full).resize(360, 360, { fit: 'cover' }).jpeg({ quality: 75 }).toBuffer();
    } catch { throw BadRequest('Ảnh bị hỏng hoặc không đọc được', 'INVALID_FILE'); }
    const base = `announcements/${crypto.randomUUID()}`;
    await storage().put(`${base}.jpg`, full, 'image/jpeg');
    await storage().put(`${base}_thumb.jpg`, thumb, 'image/jpeg');
    return this.ds.getRepository(AnnouncementAttachment).save({ fileKey: `${base}.jpg`, thumbKey: `${base}_thumb.jpg`, width: info.width, height: info.height,
      size: full.length, uploadedBy: userId, announcementId: null });
  }

  async removeAttachmentFiles(x: AnnouncementAttachment) {
    await Promise.all([storage().remove(x.fileKey), storage().remove(x.thumbKey)]).catch(() => undefined);
  }
}
