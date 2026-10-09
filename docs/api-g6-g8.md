# API G6 · G7 · H1 · G8 – nghỉ phép, duyệt + trông thay, dặn thuốc cho cô trông thay

Base `/api/v1`. Ngày `YYYY-MM-DD` giờ VN; thời điểm ISO. Lỗi theo dạng chung `{ code, message, details? }`.
Tương thích ngược: các trường cũ giữ nguyên; trường mới chỉ thêm.

## G6 – Đơn nghỉ: loại + nửa ngày + ngày công

### Mô hình `staff_leaves` (migration `LeaveTypes`)
| cột | kiểu | ghi chú |
|---|---|---|
| `type` | `sick` \| `annual` \| `personal` | đơn cũ → `personal` |
| `session` | `full` \| `morning` \| `afternoon` | nửa ngày chỉ khi `fromDate = toDate` |
| `days` | numeric(5,1) | ngày công trừ: số ngày làm việc (T2–T6, bỏ ngày nghỉ trường đã chốt) × 1, nửa ngày = 0.5 |
| `handover_note` | text null | ghi chú bàn giao lớp (G7) cho cô trông thay |
| `reason` | text | **không còn bắt buộc** (mặc định = nhãn loại nghỉ) |

Nhãn: `sick` "Ốm", `annual` "Phép năm", `personal` "Việc riêng". Buổi: `full` "Cả ngày", `morning` "Buổi sáng", `afternoon` "Buổi chiều".

### `POST /staff/leaves` (GV, kế toán, admin)
```json
{ "type": "sick", "fromDate": "2026-10-12", "toDate": "2026-10-12", "session": "morning",
  "reason": "Sốt", "handoverNote": "Bé Na dị ứng sữa; 10h cho cả lớp tập văn nghệ" }
```
- `type` sai → 400 `VALIDATION_ERROR`; thiếu → `personal` (tương thích đơn cũ; web luôn gửi). `session` mặc định `full`; `morning/afternoon` với nhiều ngày → 400 `HALF_DAY_SINGLE_DATE`.
- `annual` vượt số ngày còn lại → 409 `ANNUAL_EXCEEDED` (`details: { remaining }`).
- Trùng đơn chờ/đã duyệt cùng buổi → 409 `LEAVE_OVERLAP` (sáng + chiều cùng ngày không trùng nhau).
- 201 → `LeaveView` (dưới). Thông báo BGH (G7).

### `LeaveView`
```json
{ "id": "…", "userId": "…", "userName": "Cô Lan", "classes": [{ "id": "…", "name": "Mầm 1" }],
  "type": "sick", "typeLabel": "Ốm", "session": "morning", "sessionLabel": "Buổi sáng", "days": 0.5,
  "fromDate": "2026-10-12", "toDate": "2026-10-12", "reason": "Sốt", "handoverNote": "…",
  "status": "pending", "decidedBy": null, "decidedByName": null, "decidedAt": null, "decisionNote": null,
  "substitutions": [ { "id": "…", "date": "2026-10-12", "class": { "id": "…", "name": "Mầm 1" }, "substituteTeacher": { "id": "…", "name": "Cô Hoa" }, "session": "morning" } ],
  "createdAt": "…" }
```

### `GET /staff/leaves/balance?year=2026&userId=` (mình; admin xem người khác)
`{ "year": 2026, "annualAllowance": 12, "annualUsed": 3, "annualPending": 1, "annualRemaining": 8 }` – `annualAllowance` = env `ANNUAL_LEAVE_DAYS` (mặc định 12). Dùng cho chip "Phép năm · còn 8 ngày".

### `GET /staff/leaves/preview?fromDate&toDate&session` → `{ "days": 0.5 }` (dòng "Tính n ngày công" trên form; web có thể tự tính, API là chuẩn).

### Bảng công (`GET /staff/attendance`)
Mỗi ô ngày thêm `leaveType`, `leaveSession`, `leaveDays` (1 | 0.5). Nghỉ nửa ngày + có chấm công → `status` theo chấm công, kèm `leaveDays: 0.5`. `totals.leave` là **số thập phân** (vd 1.5); `totals.workDays` trừ 0.5 cho ngày nghỉ nửa buổi có đi làm.

## G7 + H1 – BGH duyệt, phân trông thay, báo kết quả

### Khi GV gửi đơn
Thông báo cho mọi admin: `type: "staff_leave"`, tiêu đề `"Cô Lan xin nghỉ ốm 12/10 (buổi sáng)"`, nội dung `"Lớp Mầm 1 cần cô trông thay"`,
`data: { leaveId, userId, url: "/staff/leaves/<id>" }`. **H1:** web bấm thông báo `staff_leave` → mở `/staff/leaves/<id>` (trang duyệt), không chỉ đánh dấu đã đọc. Push dùng cùng `url`.

### `GET /staff/leaves/:id` (admin; GV chủ đơn; cô trông thay của đơn)
`LeaveView` + `"coverage"`: mỗi ngày × lớp bị ảnh hưởng (theo ca được xếp, nếu không có ca thì lớp chủ nhiệm + ca đang hoạt động đầu tiên):
```json
"coverage": [ { "date": "2026-10-12", "class": { "id": "…", "name": "Mầm 1", "children": 24 }, "shift": { "id": "…", "name": "Ca ngày", "startTime": "07:00", "endTime": "16:30" },
  "substitution": null, "suggestions": [ { "userId": "…", "name": "Cô Hoa", "freeNote": "Rảnh cả ngày" } ] } ]
```
Cô trông thay chỉ thấy `handoverNote` + lớp/ngày của mình (không thấy `reason`).

### `POST /staff/leaves/:id/approve` (admin)
```json
{ "note": "Nghỉ khoẻ nhé", "substituteUserId": "…" }
```
hoặc chi tiết từng ô: `"substitutions": [{ "date", "classId", "shiftId", "substituteUserId" }]`.
- Duyệt + tạo trông thay **cùng transaction** (một lỗi → không duyệt). Lỗi trông thay như `POST /staff/substitutions`: 409 `SLOT_TAKEN` / `SUBSTITUTE_BUSY` / `SUBSTITUTE_ON_LEAVE`. Không bắt buộc chọn trông thay (lớp không có ca vẫn duyệt được).
- 409 `ALREADY_DECIDED` nếu đã xử lý (bấm 2 lần không tạo 2 lần).
- GV nhận `type: "staff_leave_decision"`: `"✓ Đơn nghỉ ốm 12/10 (buổi sáng) đã duyệt"`, nội dung `"Cô trông thay: Cô Hoa"`, `data: { leaveId, status, url: "/staff/leaves/<id>" }`.
- Cô trông thay nhận `type: "substitution"`: `"Trông thay lớp Mầm 1 · 12/10 buổi sáng"`, nội dung = ghi chú bàn giao, `data.url: "/home"`.

### `POST /staff/leaves/:id/reject` (admin) – `note` bắt buộc (400 `NOTE_REQUIRED`). GV nhận `"Đơn nghỉ … bị từ chối"`, nội dung = lý do.

### `PATCH /staff/leaves/:id` (GV chủ đơn, khi `pending`/`approved` và chưa qua ngày) – `{ "handoverNote": "…" }`. Đổi ghi chú khi đã có trông thay → báo cô trông thay.

### `POST /staff/substitutions` thêm `session` (`full` mặc định) và `leaveId` (tuỳ chọn) để liên kết đơn.

## G8 – Phụ huynh + cô trông thay

### Báo phụ huynh lớp
Khi trông thay được tạo (duyệt đơn hoặc phân tay): phụ huynh có con **đang học** lớp đó nhận `type: "substitute_teacher"`,
tiêu đề `"↔ Cô trông thay hôm nay"` (ngày khác: `"↔ Cô trông thay ngày 12/10"`), nội dung `"Cô Hoa trông lớp Mầm 1 buổi sáng thay cô Lan."`,
`data: { substitutionId, classId, date, session, substituteName }`. Xoá trông thay trước ngày đó → không gửi lại; không gửi khi ngày đã qua.

### Quyền tạm của cô trông thay
Trong **ngày** có trông thay, cô trông thay được như GV lớp đó với: `GET /classes/:id/parent-messages` (dặn thuốc, báo nghỉ, đón muộn),
`GET /children/:id/medicines`, `GET /medicines/:id/photo`, `POST /medicine-doses/:id/given`. Ngày khác/lớp khác → 403 như cũ (không lộ dặn thuốc lớp khác).

### `GET /staff/me/substitutions/today`
```json
{ "date": "2026-10-12", "items": [ { "substitutionId": "…", "class": { "id": "…", "name": "Mầm 1" }, "session": "morning", "shift": { … },
  "absentTeacher": { "id": "…", "name": "Cô Lan" }, "handoverNote": "…",
  "medicines": [ /* MedicineView như parent-messages: childName, name, dose, doses[{ id, time, label, givenAt, givenByName }] */ ] } ] }
```

### `POST /medicine-doses/:id/given`
Như cũ (`{ note? }`), idempotent: lần 2 → 409 `ALREADY_GIVEN` kèm `givenAt`, `givenByName` (không báo trùng). Phụ huynh nhận
`type: "medicine_given"` tiêu đề `"Bé Na đã được cho uống thuốc lúc 10:05"`, nội dung `"Hạ sốt, 5ml · Cô Hoa (cô trông thay)"`.
Trả về `MedicineView` với `doses[].givenAt` + `givenByName` để web hiện "Đã cho uống lúc HH:MM · đã báo phụ huynh".
