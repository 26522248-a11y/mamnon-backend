import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth';
import { addDays, todayStr } from '../common/dates';
import { AppError, Forbidden, NotFound } from '../common/errors';
import { isExpired, overallStatus } from './request-rules';
import { PickupCallAttempt, PickupRequest, SensitiveAccessLog } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';

export const ESCALATE_MINUTES = () => Number(process.env.PICKUP_ESCALATE_MINUTES || 15);
export const ID_NUMBER_RE = /^\d{12}$/;
/** CCCD masked for lists: only the last 4 digits. */
export const maskId = (v?: string | null) => (v ? `${'*'.repeat(Math.max(v.length - 4, 0))}${v.slice(-4)}` : null);
/** HH:MM in Vietnam time */
export const vnTime = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(11, 16);
const actionSecret = () => process.env.PUSH_ACTION_SECRET || `${process.env.JWT_ACCESS_SECRET}:push-action`;

export interface SameDayPick { childId: string; childName: string; relation: string | null; how: 'picked_up' | 'request'; status: string; at: string }

@Injectable()
export class PickupSafetyService {
  constructor(private ds: DataSource, private jwt: JwtService, private notify: NotificationsService) {}

  /** Is the user the 'trực đón' account for the given date? */
  async isOnDuty(userId: string, date = todayStr()) {
    const [{ n }] = await this.ds.query('SELECT COUNT(*)::int AS n FROM pickup_duties WHERE user_id = $1 AND date = $2', [userId, date]);
    return n > 0;
  }

  /**
   * Who may give the SCHOOL approval: admin (any day) or the duty account on the request's day, and only on that day.
   * Teachers (incl. homeroom) without duty -> 403.
   */
  async schoolRole(u: AuthUser, requestDate: string): Promise<'admin' | 'duty'> {
    if (u.role === 'admin') return 'admin';
    if (u.role === 'parent') throw Forbidden('Phụ huynh không duyệt phần của nhà trường');
    const today = todayStr();
    if (requestDate === today && (await this.isOnDuty(u.id, today))) return 'duty';
    throw new AppError(403, 'NOT_ON_DUTY', requestDate === today
      ? 'Chỉ Ban giám hiệu hoặc tài khoản trực đón hôm nay được duyệt phần nhà trường (giáo viên chủ nhiệm cũng không được)'
      : 'Tài khoản trực đón chỉ duyệt được yêu cầu của chính ngày trực');
  }

  /** Request's attendance date (YYYY-MM-DD). */
  async requestDate(r: PickupRequest) {
    const [row] = await this.ds.query(`SELECT to_char(date,'YYYY-MM-DD') AS d FROM attendance WHERE id = $1`, [r.attendanceId]);
    return row?.d as string;
  }

  /**
   * Parent phones to call, in order (max 2): the contact phones the parent set for the child (PATCH /children/:id/contact-phones)
   * first; remaining slots from guardians with a parent account first, then other guardians, first 2 distinct numbers.
   */
  async parentPhones(childId: string) {
    const rows: any[] = await this.ds.query(`
      SELECT g.id, g.full_name, g.relation, g.phone, u.phone AS user_phone, (g.user_id IS NOT NULL) AS has_account
      FROM guardians g LEFT JOIN users u ON u.id = g.user_id AND u.role = 'parent'
      WHERE g.child_id = $1 ORDER BY (g.user_id IS NOT NULL) DESC, g.created_at, g.id`, [childId]);
    const [c] = await this.ds.query('SELECT contact_phone1, contact_phone2 FROM children WHERE id = $1', [childId]);
    const norm = (v: string | null) => (v || '').replace(/\s/g, '');
    const out: { order: number; guardianId: string | null; name: string | null; relation: string | null; phone: string; tel: string; source: 'contact' | 'guardian' }[] = [];
    const push = (phone: string, source: 'contact' | 'guardian', g?: any) => {
      if (!phone || out.some((x) => x.phone === phone) || out.length >= 2) return;
      g = g ?? rows.find((r) => norm(r.phone) === phone || norm(r.user_phone) === phone);
      out.push({ order: out.length + 1, guardianId: g?.id ?? null, name: g?.full_name ?? null, relation: g?.relation ?? null, phone, tel: `tel:${phone}`, source });
    };
    if (c?.contact_phone1) { push(norm(c.contact_phone1), 'contact'); push(norm(c.contact_phone2), 'contact'); }
    for (const r of rows) push(norm(r.phone || r.user_phone), 'guardian', r); // fills up to 2

    return out;
  }

  /** 15-minute rule: after N minutes without the parent's answer the teacher UI must prompt calling phone 1, then 2. Never auto-handover. */
  async escalation(r: PickupRequest, now = new Date()) {
    const dueAt = new Date(r.createdAt.getTime() + ESCALATE_MINUTES() * 60_000);
    const open = r.status === 'pending' && r.parentStatus === 'pending' && (!r.expiresAt || r.expiresAt > now);
    const due = open && now >= dueAt;
    const attempts = await this.ds.getRepository(PickupCallAttempt).find({ where: { pickupRequestId: r.id }, relations: { caller: true }, order: { createdAt: 'ASC' } });
    const phones = due || attempts.length ? await this.parentPhones(r.childId) : [];
    const triedNo = new Set(attempts.map((a) => a.phone));
    const next = phones.find((p) => !triedNo.has(p.phone)) ?? phones[0] ?? null;
    return {
      afterMinutes: ESCALATE_MINUTES(), dueAt, due, promptCall: due,
      phones: due ? phones : [], nextPhone: due ? next : null,
      callAttempts: attempts.map((a) => ({ id: a.id, phone: a.phone, guardianId: a.guardianId, outcome: a.outcome, note: a.note, calledBy: a.calledBy, calledByName: a.caller?.name ?? null, at: a.createdAt })),
    };
  }

  /**
   * PM warning: the same person (same CCCD or phone) picks up / asks to pick up other children today. Never blocks.
   * Includes the relation to each child so siblings are easy to recognise.
   */
  async samePickerToday(childId: string, phone: string | null, idNumber: string | null, date = todayStr()): Promise<SameDayPick[]> {
    if (!phone && !idNumber) return [];
    const rows: any[] = await this.ds.query(`
      SELECT c.id AS child_id, c.full_name, p.relation, 'picked_up' AS how, 'picked_up' AS status, p.picked_up_at AS at
      FROM pickups p JOIN attendance a ON a.id = p.attendance_id JOIN children c ON c.id = a.child_id
      WHERE a.date = $1 AND a.child_id <> $2 AND ((p.picker_phone IS NOT NULL AND p.picker_phone = $3) OR (p.picker_id_number IS NOT NULL AND p.picker_id_number = $4))
      UNION ALL
      SELECT c.id, c.full_name, r.relation, 'request', r.status, r.created_at
      FROM pickup_requests r JOIN attendance a ON a.id = r.attendance_id JOIN children c ON c.id = r.child_id
      WHERE a.date = $1 AND r.child_id <> $2 AND r.status IN ('pending','approved') AND (r.picker_phone = $3 OR (r.picker_id_number IS NOT NULL AND r.picker_id_number = $4))
      ORDER BY at`, [date, childId, phone ?? '', idNumber ?? '']);
    const seen = new Set<string>();
    return rows.filter((r) => (seen.has(r.child_id + r.how) ? false : (seen.add(r.child_id + r.how), true)))
      .map((r) => ({ childId: r.child_id, childName: r.full_name, relation: r.relation, how: r.how, status: r.status, at: new Date(r.at).toISOString() }));
  }
  multiWarning(list: SameDayPick[], pickerName: string) {
    if (!list.length) return [];
    const kids = [...new Map(list.map((x) => [x.childId, x])).values()];
    return [{ code: 'SAME_PICKER_MULTIPLE_CHILDREN',
      message: `${pickerName} cũng đón/xin đón ${kids.length} bé khác hôm nay: ${kids.map((k) => `${k.childName}${k.relation ? ' (' + k.relation + ')' : ''}`).join(', ')}. Kiểm tra kỹ trước khi giao.`,
      children: kids }];
  }

  async logSensitive(u: AuthUser, entityType: string, entityId: string, childId: string | null, purpose: string, attendanceId: string | null, ip: string | null) {
    await this.ds.getRepository(SensitiveAccessLog).insert({ userId: u.id, userRole: u.role, entityType, entityId, childId, field: 'id_number', purpose, attendanceId, ip: ip?.slice(0, 64) ?? null });
  }

  // ───── push action tokens (signed, short-lived, bound to one request + one parent) ─────
  signAction(requestId: string, userId: string, expiresAt: Date | null) {
    const exp = Math.floor(Math.min(expiresAt?.getTime() ?? Date.now() + 2 * 3600_000, Date.now() + 2 * 3600_000) / 1000);
    return this.jwt.sign({ typ: 'pickup_action', rid: requestId, uid: userId, exp }, { secret: actionSecret() });
  }
  /** -> payload, or 403 (forged / wrong request), or 409 (token expired: request already expired). */
  verifyAction(token: string, requestId?: string): { rid: string; uid: string } {
    let p: any;
    try { p = this.jwt.verify(token, { secret: actionSecret(), ignoreExpiration: true }); } catch { throw new AppError(403, 'INVALID_ACTION_TOKEN', 'Liên kết xác nhận không hợp lệ'); }
    if (p?.typ !== 'pickup_action' || !p.rid || !p.uid) throw new AppError(403, 'INVALID_ACTION_TOKEN', 'Liên kết xác nhận không hợp lệ');
    if (requestId && requestId !== p.rid) throw new AppError(403, 'INVALID_ACTION_TOKEN', 'Liên kết không thuộc yêu cầu này');
    if (p.exp && p.exp * 1000 < Date.now()) throw new AppError(409, 'REQUEST_EXPIRED', 'Yêu cầu đã hết hạn');
    return { rid: p.rid, uid: p.uid };
  }

  /** New off-list request: push (with confirm/reject actions) to the child's parents only; it is NOT put in the general inbox. */
  async notifyRequestCreated(r: PickupRequest, childName: string, parentIds: string[]) {
    const base = process.env.PUBLIC_API_BASE || '';
    return this.notify.send(parentIds, {
      type: 'pickup_request', refId: r.id, important: true,
      title: `Xác nhận người đón bé ${childName}`,
      body: `${r.pickerName}${r.relation ? ' (' + r.relation + ')' : ''}, SĐT ${r.pickerPhone} xin đón bé lúc ${vnTime(r.createdAt)}. Hết hạn ${r.expiresAt ? vnTime(r.expiresAt) : ''}.`,
      data: { pickupRequestId: r.id, childId: r.childId, expiresAt: r.expiresAt },
      push: {
        url: '/today', tag: `pickup-${r.id}`, requireInteraction: true,
        actions: [{ action: 'confirm', title: 'Xác nhận' }, { action: 'reject', title: 'Từ chối' }],
        perUser: (uid) => {
          const t = this.signAction(r.id, uid, r.expiresAt);
          return { actionToken: t, actionUrl: `${base}/api/v1/push/actions`, photoUrl: r.photoUrl ? `${base}/api/v1/push/pickup-photo/${r.id}?t=${encodeURIComponent(t)}` : null };
        },
      },
    }, { only: ['webpush', 'sms', 'zalo'] });
  }

  /**
   * U10 "Bé đã được đón": inbox + web push (+ sms / zalo adapters when enabled) to the child's parents.
   * Body: "<relation> <name> đón lúc HH:MM, <teacher> giao." data carries who / when / teacher / photo / school phone for the card.
   */
  async notifyPickedUp(x: { childId: string; childName: string; pickerName: string; relation: string | null; at: Date; parentIds: string[]; pickupId: string;
    attendanceId: string; handedOverBy: { id: string; name: string } | null; hasPhoto: boolean; schoolPhone: string | null }) {
    const short = x.childName.trim().split(/\s+/).pop() ?? x.childName;
    const who = `${x.relation ? x.relation + ' ' : ''}${x.pickerName}`;
    const photoUrl = x.hasPhoto ? `/api/v1/attendance/${x.attendanceId}/pickup-photo` : null;
    return this.notify.send(x.parentIds, {
      type: 'picked_up', refId: x.pickupId, title: `🚸 Bé ${short} đã được đón`,
      body: `${who} đón lúc ${vnTime(x.at)}${x.handedOverBy ? `, ${x.handedOverBy.name} giao` : ''}.`,
      data: { childId: x.childId, childName: x.childName, pickupId: x.pickupId, attendanceId: x.attendanceId, pickedUpByName: x.pickerName, relation: x.relation,
        pickedUpAt: x.at.toISOString(), handedOverById: x.handedOverBy?.id ?? null, handedOverByName: x.handedOverBy?.name ?? null, photoUrl, schoolPhone: x.schoolPhone },
      push: { url: '/notifications', tag: `picked-${x.childId}` },
    });
  }

  async sweepExpired() {
    await this.ds.getRepository(PickupRequest).createQueryBuilder().update().set({ status: 'expired' })
      .where("status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()").execute();
  }

  /**
   * One step of the two-step approval. step 'parent': the child's parent (app / push) or admin on behalf (note required).
   * step 'school': admin or today's duty account. Reject by the school needs a note. 409 when the step is already decided / expired.
   */
  async decideStep(actor: { id: string; name: string }, id: string, step: 'parent' | 'school', decision: 'approved' | 'rejected',
    opts: { note?: string | null; channel?: string; role?: 'admin' | 'duty'; onBehalf?: boolean }) {
    await this.sweepExpired();
    const r0 = await this.ds.getRepository(PickupRequest).findOne({ where: { id } });
    if (!r0) throw NotFound('Không tìm thấy yêu cầu đón');
    if (isExpired(r0)) throw new AppError(409, 'REQUEST_EXPIRED', 'Yêu cầu đã hết hạn; giáo viên cần tạo yêu cầu mới');
    if (r0.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', 'Yêu cầu này đã được xử lý');
    if ((step === 'parent' ? r0.parentStatus : r0.schoolStatus) !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', step === 'parent' ? 'Phụ huynh đã trả lời yêu cầu này' : 'Nhà trường đã duyệt/từ chối yêu cầu này');
    const note = opts.note?.trim() || null;
    const col = step === 'parent'
      ? { parentStatus: decision, parentDecidedBy: actor.id, parentDecidedAt: () => 'now()', parentNote: note, parentChannel: opts.channel ?? 'app' }
      : { schoolStatus: decision, schoolDecidedBy: actor.id, schoolDecidedAt: () => 'now()', schoolNote: note, schoolDecidedRole: opts.role ?? 'admin' };
    const other = step === 'parent' ? r0.schoolStatus : r0.parentStatus;
    const status = overallStatus(step === 'parent' ? decision : other, step === 'school' ? decision : other);
    const res = await this.ds.getRepository(PickupRequest).createQueryBuilder().update()
      .set({ ...col, status, decidedBy: actor.id, decidedAt: () => 'now()', decisionNote: note, decidedOnBehalf: !!opts.onBehalf } as any)
      .where(`id = :id AND status = 'pending' AND ${step === 'parent' ? 'parent_status' : 'school_status'} = 'pending' AND (expires_at IS NULL OR expires_at > now())`, { id }).execute();
    if (!res.affected) throw new AppError(409, 'ALREADY_DECIDED', 'Yêu cầu này đã được xử lý hoặc đã hết hạn');
    const done = (await this.ds.getRepository(PickupRequest).findOne({ where: { id }, relations: { child: true, decider: true } }))!;
    const who = step === 'parent' ? (opts.onBehalf ? 'BGH (thay phụ huynh)' : 'Phụ huynh') : opts.role === 'duty' ? 'Trực đón' : 'BGH';
    if (done.requestedBy) await this.notify.send([done.requestedBy], {
      type: 'pickup_decision', refId: id,
      title: `${who} ${decision === 'approved' ? 'đồng ý' : 'TỪ CHỐI'} người đón bé ${done.child?.fullName ?? ''}`,
      body: `${done.pickerName}: ${status === 'approved' ? 'đủ 2 bước, có thể giao bé' : status === 'rejected' ? 'KHÔNG được giao trẻ' : 'chờ ' + (done.parentStatus === 'pending' ? 'phụ huynh' : 'nhà trường')}${note ? '. Ghi chú: ' + note : ''}`,
      data: { pickupRequestId: id, childId: done.childId, status, step, decision },
    });
    return done;
  }

}

export const endOfDayVN = (date: string) => new Date(`${addDays(date, 1)}T00:00:00+07:00`);
