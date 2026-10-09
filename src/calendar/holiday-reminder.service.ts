import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';

/** Last day of the "early December" window (env HOLIDAY_REMINDER_LAST_DAY, default 7). */
const lastDay = () => { const n = Number(process.env.HOLIDAY_REMINDER_LAST_DAY); return Number.isInteger(n) && n >= 1 && n <= 31 ? n : 7; };

/**
 * Early-December reminder: once per year (Dec 1..HOLIDAY_REMINDER_LAST_DAY, VN time) admins are asked to finalize next
 * year's holidays (apply template, confirm lunar Tết / Giỗ Tổ). Checked hourly; deduplicated via notifications(type, data.year).
 */
@Injectable()
export class HolidayReminderService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private log = new Logger('HolidayReminder');
  constructor(private ds: DataSource, private notify: NotificationsService) {}

  onModuleInit() {
    if (process.env.HOLIDAY_REMINDER_DISABLED === 'true') return;
    this.timer = setInterval(() => this.run().catch((e) => this.log.error(e)), 60 * 60 * 1000);
    this.timer.unref();
    setTimeout(() => this.run().catch((e) => this.log.error(e)), 30_000).unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async run(now = new Date(), force = false) {
    const vn = new Date(now.getTime() + 7 * 3600_000);
    const month = vn.getUTCMonth() + 1, day = vn.getUTCDate(), year = vn.getUTCFullYear() + 1;
    if (!force && !(month === 12 && day <= lastDay())) return { sent: false, reason: 'NOT_IN_WINDOW', year };
    const [{ n: done }] = await this.ds.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'holiday_reminder' AND data->>'year' = $1`, [String(year)]);
    if (done && !force) return { sent: false, reason: 'ALREADY_SENT', year };
    const [st] = await this.ds.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed, COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
      FROM holidays WHERE date BETWEEN $1 AND $2`, [`${year}-01-01`, `${year}-12-31`]);
    const admins: string[] = (await this.ds.query(`SELECT id FROM users WHERE is_active AND role = 'admin'`)).map((r: any) => r.id);
    const body = st.confirmed + st.pending === 0
      ? `Chưa có ngày nghỉ nào cho năm ${year}. Vào Lịch nghỉ → "Mẫu ngày lễ" để thêm, rồi xác nhận Tết Nguyên đán và Giỗ Tổ.`
      : `Năm ${year}: ${st.confirmed} ngày đã xác nhận, ${st.pending} ngày chờ xác nhận (Tết, Giỗ Tổ). Vui lòng rà soát và xác nhận.`;
    await this.notify.send(admins, { type: 'holiday_reminder', important: true, title: `Chốt lịch nghỉ năm ${year}`, body,
      data: { year, confirmed: st.confirmed, pending: st.pending }, push: { url: '/holidays' } });
    return { sent: true, year, admins: admins.length, confirmed: st.confirmed, pending: st.pending };
  }
}
