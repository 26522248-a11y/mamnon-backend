import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Notification, NotificationType } from '../database/entities';

export interface NotifyPayload {
  type: NotificationType; title: string; body?: string | null; data?: Record<string, unknown> | null; announcementId?: string | null;
}

/** In-app inbox. (Push / SMS / Zalo delivery is not wired yet — inbox only.) */
@Injectable()
export class NotificationsService {
  constructor(@InjectRepository(Notification) private repo: Repository<Notification>, private ds: DataSource) {}

  async toUsers(userIds: string[], p: NotifyPayload, m?: EntityManager) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return 0;
    const em = m ?? this.ds.manager;
    await em.createQueryBuilder().insert().into(Notification).values(ids.map((userId) => ({
      userId, type: p.type, title: p.title.slice(0, 200), body: p.body ?? null, data: p.data ?? null, announcementId: p.announcementId ?? null,
    })) as any).execute();
    return ids.length;
  }

  /** Active parent accounts linked (via guardians.user_id) to the child. */
  async parentIdsOfChildren(childIds: string[], m?: EntityManager): Promise<string[]> {
    if (!childIds.length) return [];
    const rows = await (m ?? this.ds.manager).query(
      `SELECT DISTINCT g.user_id FROM guardians g JOIN users u ON u.id = g.user_id
       WHERE g.child_id = ANY($1) AND u.is_active AND u.role = 'parent'`, [childIds]);
    return rows.map((r: any) => r.user_id);
  }

  async toParentsOfChild(childId: string, p: NotifyPayload, m?: EntityManager) {
    return this.toUsers(await this.parentIdsOfChildren([childId], m), p, m);
  }
}
