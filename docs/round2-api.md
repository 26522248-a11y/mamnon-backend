# Đợt 2 – API contract

Delivery: **batch 1** = §0, §1, §2, §5, §11 (+ audit_events). **batch 2** = §3, §4, §6, §7, §8. **batch 2b** = §9, holiday reminder.

Scope: parent messages, holidays, medicine, late pickup, photo consent.

Base `/api/v1`. Errors `{code, message, details?}`. Dates `YYYY-MM-DD` (VN calendar), times `HH:MM` (VN wall clock),
timestamps ISO-8601 UTC. Names follow `mamnon-web/src/lib/messages-api.ts`; differences are marked **≠ FE guess**.

## 0. Config (env → `GET /settings/school`, public)

| env | default | field in `/settings/school` | meaning |
|---|---|---|---|
| `ABSENCE_CUTOFF` | `08:00` | `absenceCutoff` | report / cancel for TODAY strictly before this time → meal refund + free cancel |
| `LATEST_PICKUP_TIME` | `18:00` | `latestPickupTime` (+ alias `latestPickup`) | latest allowed late-pickup time |
| `SCHOOL_OPEN_TIME` | `06:30` | `schoolOpenTime` | earliest time for a late-pickup request |
| `MEDICINE_LATE_MINUTES` | `30` | `medicineLateMinutes` | dose counts as "not given" this long after its time |
| `KITCHEN_NOTIFY_ROLES` | `admin,accountant` | – | who gets "kitchen" notices (meal count changes) |

`GET /settings/school` → `{name, address, phone, absenceCutoff, latestPickupTime, latestPickup, schoolOpenTime, medicineLateMinutes}`.

## 1. Absence reports (`Báo vắng`)

### Model
```ts
type AbsenceReason = 'sick' | 'family' | 'other';
type AbsenceDay = { date: string; refundEligible: boolean; reportedAt: string; overridden: boolean; cancelled: boolean; cancelledAt: string | null };
// days falling on a CONFIRMED school holiday are omitted from `days` (history excludes them)
type Absence = { id; childId; childName; classId; className; from; to; reason: AbsenceReason; note: string | null;
  days: AbsenceDay[];              // school days only (no weekends, no holidays)
  skippedDates: { date: string; reason: 'WEEKEND' | 'HOLIDAY' | 'ALREADY_PRESENT' }[];
  status: 'active' | 'partly_cancelled' | 'cancelled';
  cancellable: string[];           // dates the CURRENT user may still cancel
  createdAt; createdBy; createdByName; cancelledAt: string | null;   // cancelledAt = all days cancelled
  history: { action: 'created' | 'cancelled' | 'overridden'; dates: string[]; by: string | null; byName: string | null; byRole: string | null; at: string }[] };
```

### Endpoints
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/children/:id/absences` `{from, to?, reason, note?}` | parent of child; admin | `to` defaults to `from`; `from ≥ today` (else 400 `DATE_IN_PAST`), `to ≥ from`, ≤ 31 days. Days that are weekend / holiday / already marked present are skipped (`skippedDates`); none left → 400 `NO_SCHOOL_DAYS`. A day already covered by another active report → 409 `ABSENCE_OVERLAP` (`details` = dates). Withdrawn child → 400 `CHILD_WITHDRAWN`. 201 `Absence`. Class teachers + kitchen roles notified. |
| GET | `/children/:id/absences?from&to` | parent of child, class teacher, admin | default `from` = today − 30, all reports overlapping the range (incl. cancelled), newest first |
| GET | `/absences/:id` | same | |
| DELETE | `/absences/:id` (optional body/query `dates[]`) | parent of child; admin | cancels the cancellable days (all, or the given ones). 200 `Absence`. Nothing cancellable → 409 `CANCEL_AFTER_CUTOFF`. |
| GET | `/absences/config` | public | `{cutoff, latestPickup}` (FE fallback) |

### Rules
- **Refund**: a day is `refundEligible` iff it was reported before that day, or on that day strictly before `absenceCutoff` (VN time; reported at 07:59:59 = refund, at exactly 08:00:00 = no refund). Weekends/holidays never appear. `AbsenceDay.refundEligible` is exactly what the meal invoice uses (false once overridden).
- History route = `GET /children/:id/absences?from&to` (reports overlapping the range; `days` exclude confirmed holidays; each day has `refundEligible` + `reportedAt`). E.g. the parent screen loads the past 30 days with `from = today − 30` (also the default).
- **Attendance**: each day is written to attendance immediately as `status:'absent'`, `excused: true`, `absenceReason`, `absenceId`, `notifiedInAdvance = refundEligible` (this is what meal refunds read, unchanged logic).
- **Cancel (parent)**: allowed for future days, and for today only strictly before the cutoff. After the cutoff a parent cannot cancel today (nor past days). Admin may cancel any day that is today or later. Cancelled days remove the generated attendance row.
- **Teacher marks present on an excused day** (explicit override, see §5): attendance becomes present, the day gets `overridden: true`, `notifiedInAdvance=false` → **no refund** for that day; kitchen roles + parents notified (`absence_overridden`).
- History of every report/cancel/override is in `history` (and attendance_history for the attendance rows).

## 2. Holiday calendar (`Lịch nghỉ`)

```ts
type Holiday = { id; date; name; kind: 'national' | 'school'; status: 'pending' | 'confirmed';
  createdBy; createdByName; createdAt; confirmedBy: { id: string; name: string } | null; confirmedByName: string | null; confirmedAt: string | null };
```
**Only `confirmed` holidays have any effect.** `pending` = national lunar holiday from the template, waiting for admin confirmation: no `SCHOOL_HOLIDAY` block, absence days / attendance / meals behave as a normal school day.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/holidays?year=` or `?from&to` (`&status=pending|confirmed`) | any logged-in user | sorted by date, includes `status` |
| POST | `/holidays` `{date, to?, name, kind?}` | admin | range `date..to` (≤ 60 days) → one **confirmed** row per day; existing dates → 409 `HOLIDAY_EXISTS` (`details.dates`). Recorded attendance (not from a parent report) on a date → 409 `HOLIDAY_HAS_ATTENDANCE`. Active parent absence days on those dates are cancelled automatically (parents notified). |
| PATCH | `/holidays/:id` `{name?, kind?}` | admin | |
| DELETE | `/holidays/:id` | admin | 204 |
| POST | `/holidays/:id/confirm` | admin | pending → confirmed (same side effects as POST); already confirmed → 200 unchanged |
| POST | `/holidays/confirm` `{year}` | admin | confirms all pending holidays of that year → `{year, confirmed: Holiday[]}` |
| POST | `/holidays/template` `{year, dryRun?}` | admin | Vietnamese national holidays. **Solar** (Tết dương lịch 1/1, 30/4, 1/5, Quốc khánh 1/9 + 2/9) are inserted as `confirmed`; **lunar** (Tết Nguyên đán 5 ngày: 29/30 tháng Chạp → mùng 4, Giỗ Tổ 10/3 âm lịch) are inserted as `pending`. Existing dates are skipped. → `{year, created: Holiday[], skipped: [{date,name}]}`; `dryRun:true` → `{year, items[{date,name,status,exists}]}` without writing. Bundled years 2025–2030 (lunar dates computed with a lunar calendar); other years → 400 `TEMPLATE_YEAR_UNSUPPORTED`. |

`POST /holidays/:id/confirm` → `Holiday` with `confirmedBy: {id, name}`, `confirmedAt` (also `confirmedByName`).
Effects of a **confirmed** holiday (attendance `holiday` is set only for confirmed ones): attendance sheet returns `holiday: {id, name}` with every item `status:null`, `PUT` attendance for that date → 400 `SCHOOL_HOLIDAY`; dates are skipped in absence reports (`skippedDates` reason `HOLIDAY`); medicine / late-pickup requests → 400 `SCHOOL_HOLIDAY` (batch 2); no meal refund (no attendance rows). Monthly meal fee itself is unchanged (flat monthly price). Dashboard does not report "classes not marked" on a holiday.
Planned (batch 2b): early-December reminder to admins to confirm next year's pending holidays.

## 3. Medicine instructions (`Dặn thuốc`)

```ts
type Dose = { id; time: 'HH:MM'; label: string | null; givenAt: string | null; givenBy: string | null; givenByName: string | null; late: boolean };
type Medicine = { id; childId; childName; classId; date; name; dose; note: string | null; photoUrl: string | null;
  doses: Dose[]; status: 'active' | 'cancelled'; createdBy; createdByName; createdAt; cancelledAt: string | null };
```
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/children/:id/medicines` (multipart or JSON) | parent of child; admin | `date` (default today; ≥ today, not holiday/weekend), `name*`, `dose*` (e.g. "5 ml"), `doses*` = JSON `[{time:"11:30", label?}]` **or** repeated `times` fields; 1–6 doses, distinct times; `note?`, `photo?` (JPG/PNG/HEIC→JPEG). Missing dose/doses → 400 `VALIDATION_ERROR`. 201 `Medicine`. Class teachers notified. |
| GET | `/children/:id/medicines?date=` | parent of child, class teacher, admin | default today |
| GET | `/medicines/:id/photo` | same | |
| DELETE | `/medicines/:id` | parent of child; admin | only while no dose given → else 409 `DOSE_ALREADY_GIVEN`; 200 `Medicine` (status cancelled) |
| POST | `/medicine-doses/:id/given` `{note?}` | class teacher; admin | atomic; second mark → **409 `ALREADY_GIVEN`** (`details.givenAt/givenByName`); other class → 403; cancelled medicine → 409 `MEDICINE_CANCELLED`; only on the medicine's date (else 400 `NOT_TODAY`). Returns `Medicine`. Parents notified "Bé đã được cho uống thuốc X lúc HH:MM (Cô Y)". |

Parent sees `givenAt` + `givenByName` per dose. `late` = not given and now > time + `medicineLateMinutes`.

## 4. Late pickup (`Đón muộn`)

```ts
type LatePickup = { id; childId; childName; classId; date; time; pickerName: string | null; note: string | null;
  status: 'active' | 'cancelled'; createdBy; createdByName; createdAt; cancelledAt: string | null };
```
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/children/:id/late-pickups` `{date, time, pickerName?, note?}` | parent of child; admin | `date ≥ today`, school day; `schoolOpenTime ≤ time ≤ latestPickupTime` else 400 `OUTSIDE_SCHOOL_HOURS`; today: time must be in the future (400 `TIME_PASSED`). One active per child+date → 409 `LATE_PICKUP_EXISTS`. Teachers notified. |
| GET | `/children/:id/late-pickups?from&to` | parent, class teacher, admin | default from = today − 30 |
| DELETE | `/late-pickups/:id` | parent of child; admin | 200 `LatePickup` (cancelled) |

`pickerName` is information only – the hand-over still follows the pickup-safety rules (guardian / approved picker / two-step request).

## 5. Attendance changes

- Sheet item (GET/PUT `/classes/:id/attendance`) gains: `excused: boolean`, `absenceReason: AbsenceReason|null`, `absenceId: string|null`, `absenceNote`, `refundEligible: boolean`. Response gains `holiday: {id,name}|null` and `skipped: [{childId, reason}]` (PUT only).
- PUT item gains `absenceReason?` (`sick|family|other`, for `absent`) and `overrideAbsence?: boolean`.
- **Refund eligibility is computed by the server.** `notifiedInAdvance` is still accepted (compatibility) but ignored: an absence is refundable only when a parent report made before the cutoff exists for that day. A teacher marking "absent" (even "có phép") = no refund. Rows saved before round 2 keep their stored flag while they stay absent. Response `notifiedInAdvance`/`refundEligible` show the computed value.
- **"Tất cả có mặt" never overrides an excused absence**: an item `present|late` for a child with an excused day is skipped (`skipped[{childId, reason:'EXCUSED_ABSENCE'}]`) unless `overrideAbsence: true` (explicit per-child action) → see §1 override rule.
- Confirmed holiday → 400 `SCHOOL_HOLIDAY` (pending holidays: no effect).

## 6. Class message feed (pinned on top of Điểm danh)

`GET /classes/:id/parent-messages?date=` (class teacher, admin) →
`{date, holiday: Holiday|null, absences: Absence[] (active on that date), medicines: Medicine[] (that date, active), latePickups: LatePickup[] (that date, active), counts: {absences, medicines, dosesPending, latePickups}}`.

## 7. Daily notes

Item fields: `eating` (lunch), **`breakfast`** (same scale `all|most|half|little|none`), `sleepMinutes`, `mood`, `toilet` (recommended values `Bình thường`, `Tiêu chảy`, `Táo`; free text ≤ 40 kept for compatibility), `note`. Partial update: absent = unchanged, `null` = clear (PUT and PATCH).

## 8. Dashboard

`attention.medicinesNotGiven: MedicineDue[]` and `attention.medicinesNotGivenCount`, where
`MedicineDue = {childId, fullName, classId, className, medicineId, medicineName, doseId, time, minutesLate}` – today's active doses not given, `now > time + medicineLateMinutes`, child not absent.

## 9. Photo consent (`Đồng ý chụp/đăng ảnh`) – batch 2b

- `children.photoConsent: boolean`, **default false** (existing children too).
- `photoConsent` is included in child lists (`GET /children`, child detail) and in the class roster / attendance sheet items teachers see, so the UI can show a badge.
- Parents see `photoConsent` only for their own children; another child → 403.
- `GET /children/:id/photo-consent` (parent of own child, class teacher, admin) →
  `{childId, consent: boolean, updatedBy: {id, name} | null, updatedAt: string | null, history: [{before, after, by: {id, name, role}, at, note, source}]}`.
- `PUT /children/:id/photo-consent` `{consent: boolean, note?}` (parent of child, admin) → same shape. Every change goes to `audit_events` (`child.photo_consent`) + jsonl.
- Excel import: new optional column `Đồng ý chụp ảnh` (Có / Không, default Không) → stored as initial consent, history entry `source: import`.

## 10. Notifications (types)
`absence_report`, `absence_cancelled`, `absence_overridden`, `kitchen_change`, `medicine_request`, `medicine_given`, `late_pickup`. Inbox + push (if subscribed).

## 11. Password change enforcement
If the logged-in user has `mustChangePassword=true`, every authenticated endpoint returns **403 `PASSWORD_CHANGE_REQUIRED`** except: `GET /auth/me`, `POST /auth/logout`, `POST /auth/change-password`, (public: `/auth/login`, `/auth/refresh`, `/settings/school`, `/push/vapid-public-key`, `/push/actions`), `GET /pickup-requests/feed`, `POST /pickup-requests/:id/confirm|reject`, `GET /pickup-requests/:id/photo`, `POST|GET|DELETE /push/subscriptions`.
