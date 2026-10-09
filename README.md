# mamnon-backend

API quản lý học sinh trường mầm non (200–300 trẻ). NestJS 10 + TypeScript + PostgreSQL 17 + TypeORM (có migration).

## Chạy nhanh

```bash
# 1. PostgreSQL (Debian/Ubuntu)
sudo apt-get install -y postgresql && sudo service postgresql start
sudo -u postgres psql -c "CREATE USER mamnon WITH PASSWORD 'mamnon' CREATEDB;" \
  -c "CREATE DATABASE mamnon OWNER mamnon;" -c "CREATE DATABASE mamnon_test OWNER mamnon;"

# 2. Cài đặt + cấu hình
npm install
cp .env.example .env          # đổi JWT_*_SECRET khi chạy thật

# 3. Migration + dữ liệu mẫu (seed xoá sạch dữ liệu cũ rồi tạo lại)
npm run migration:run
npm run seed

# 4. Chạy
npm run start:dev             # chạy trực tiếp bằng ts-node
# hoặc: npm run build && npm start
```

- API: `http://localhost:3001/api/v1`
- Swagger: `http://localhost:3001/api/docs`
- Kiểm tra: `GET /api/v1/health`

Test e2e (dùng DB `mamnon_test`, tự migrate và seed): `npm test`

Tạo migration mới sau khi sửa entity: `npm run typeorm -- migration:generate src/database/migrations/TenMigration`

## Tài khoản mẫu (mật khẩu đều là `123456`)

| username | vai trò | phạm vi |
|---|---|---|
| `admin` | Ban giám hiệu (admin) | toàn quyền |
| `gv1` | giáo viên | lớp Mầm 1 |
| `gv2` | giáo viên | lớp Chồi 1 |
| `gv3` | giáo viên | lớp Lá 1 |
| `ketoan` | kế toán | xem tên + lớp của mọi trẻ |
| `ph1` | phụ huynh | bé Nguyễn Gia An (Mầm 1) |
| `ph2` | phụ huynh | bé Trần Minh Bình (Chồi 1) |

Dữ liệu mẫu:
- 3 lớp, 30 trẻ. Mỗi trẻ có 2 người giám hộ; bé An có thêm "Bà nội" với `canPickup=false`.
- Điểm danh và nhật ký ăn ngủ của ngày hôm qua, có kèm lịch sử sửa.
- Khoản thu: Học phí 1.500.000đ, Tiền ăn 900.000đ, Tiếng Anh 300.000đ cho lớp Lá 1, Năng khiếu vẽ 200.000đ riêng cho bé An, Đồng phục 250.000đ thu một lần.
- Hoá đơn tháng trước và tháng này. Tháng trước có hoá đơn đã trả đủ, trả một phần và chưa trả; tháng này 1/3 số trẻ đã trả.
- 2 lần đo chiều cao, cân nặng cho mỗi trẻ, và thực đơn tuần này (thứ Hai đến thứ Sáu).

## Xác thực

- `POST /auth/login` `{ username, password }` → `{ accessToken, tokenType, expiresIn, user }`. `user` = `{ id, username, name, role, classIds, childIds }`, giống mock của front end.
- Refresh token nằm trong cookie httpOnly `refresh_token` (path `/api/v1/auth`, SameSite=Lax, Secure khi `COOKIE_SECURE=true`).
- `POST /auth/refresh`: dùng cookie để lấy access token mới, cookie cũng được cấp lại. `POST /auth/logout`: thu hồi mọi token của user đó. `GET /auth/me`.
- Front end phải gọi `fetch(..., { credentials: 'include' })`; CORS mở cho `CORS_ORIGIN` (mặc định `http://localhost:3000`).

## Endpoint (tiền tố `/api/v1`)

| Method | Path | Ai được gọi |
|---|---|---|
| GET | `/classes` | tất cả (giáo viên: lớp mình; phụ huynh: lớp của con) |
| POST/PATCH/DELETE | `/classes`, `/classes/:id` | admin |
| GET | `/classes/:id` | admin, kế toán, giáo viên của lớp, phụ huynh có con trong lớp |
| POST / DELETE | `/classes/:id/teachers` `{userId,isHead?}`, `/classes/:id/teachers/:userId` | admin |
| GET | `/children?page&limit&classId&search&status` → `{items,page,limit,total}` | tất cả, tự lọc theo phạm vi; tìm theo tên không phân biệt dấu |
| GET | `/children/:id` | theo phạm vi |
| POST / DELETE | `/children`, `/children/:id` | admin |
| PATCH | `/children/:id` | admin; giáo viên của lớp chỉ được sửa `allergies`, `healthNotes` |
| POST | `/children/:id/photo` (multipart, field `file`, JPG/PNG/WEBP ≤ 3MB) | admin, giáo viên của lớp |
| GET | `/children/:id/guardians` | admin, giáo viên của lớp, phụ huynh của trẻ |
| POST | `/children/:id/guardians` (có thể kèm `account:{username,password}` để cấp tài khoản phụ huynh, hoặc `userId` để liên kết) | admin |
| GET | `/children/:id/attendance?from&to` | admin, giáo viên của lớp, phụ huynh của trẻ |
| GET | `/classes/:id/attendance?date=YYYY-MM-DD` → `{classId,date,items[]}` | admin, giáo viên của lớp |
| PUT | `/classes/:id/attendance` `{date, items:[{childId,status,note?}]}` | admin, giáo viên của lớp |
| GET | `/attendance/:id/history` (ai sửa, lúc nào, giá trị cũ, giá trị mới) | admin, giáo viên của lớp |
| POST | `/attendance/:id/pickup` `{guardianId \| pickupRequestId, pickedUpAt?, note?}` | admin, giáo viên của lớp |
| POST | `/attendance/:id/pickup-requests` (JSON hoặc multipart: `pickerName, pickerPhone, note, relation?`, ảnh `photo` tuỳ chọn) | admin, giáo viên của lớp |
| GET | `/pickup-requests?status&childId&date` | admin; giáo viên: lớp mình; phụ huynh: con mình |
| POST | `/pickup-requests/:id/confirm`, `/pickup-requests/:id/reject` `{note?}` | admin, phụ huynh của trẻ |
| GET | `/children/attendance-summary?month=YYYY-MM&classId` (chỉ số ngày) | admin, kế toán; giáo viên: lớp mình; phụ huynh: con mình |
| GET | `/dashboard/summary?date=` | tất cả (theo phạm vi, xem dưới) |
| GET/POST/PATCH/DELETE | `/fee-items`, `/fee-items/:id` (scope `school`/`class`/`child`, type `monthly`/`one_time`) | admin, kế toán |
| POST | `/invoices/generate` `{period, classId?, dueDate?}` | admin, kế toán |
| POST | `/invoices` `{childId, period, lines:[{feeItemId? \| description+unitPrice, quantity?}]}` (unitPrice âm = giảm trừ) | admin, kế toán |
| GET | `/invoices?period&classId&childId&status(unpaid\|partial\|paid\|void\|outstanding)&page&limit`, `/invoices/:id` | admin, kế toán; phụ huynh: con mình |
| POST | `/invoices/:id/void` `{reason}` (chỉ huỷ được khi chưa có thanh toán) | admin, kế toán |
| POST | `/invoices/:id/payments` `{amount, method: cash\|transfer, paidAt?, payerName?, note?}` → dữ liệu phiếu thu | admin, kế toán |
| GET | `/payments/:id/receipt` (số phiếu, số tiền bằng chữ, các dòng hoá đơn) | admin, kế toán; phụ huynh: con mình |
| GET | `/children/:id/balance` | admin, kế toán; phụ huynh: con mình |
| GET | `/debts?classId&upToPeriod` | admin, kế toán |
| GET / POST | `/children/:id/growth` (ghi lại theo ngày), DELETE `/growth/:id` | đọc: admin, giáo viên của lớp, phụ huynh của trẻ; ghi: admin, giáo viên của lớp |
| GET / PUT | `/menus?week=`, `/menus` `{weekStart (thứ Hai), items:[{date, meal: breakfast\|lunch\|snack, dishes}]}` | đọc: admin, giáo viên, phụ huynh; ghi: admin |
| GET / PUT | `/classes/:id/daily-notes?date=` `{date, items:[{childId, eating, sleepMinutes, mood, toilet, note}]}` | admin, giáo viên của lớp |
| GET | `/children/:id/daily-notes?from&to` | admin, giáo viên của lớp, phụ huynh của trẻ |

Mỗi phần tử trong bảng điểm danh có dạng `{ attendanceId, childId, fullName, allergies, status, note, recorded, pickup }`. Trẻ chưa được điểm danh có `status: null` và `recorded: false`.

## Quy tắc phân quyền

- Giáo viên chỉ thao tác với lớp có trong `class_teachers`. Gọi lớp khác hoặc trẻ lớp khác sẽ nhận **403**.
- Phụ huynh chỉ xem được trẻ có `guardians.user_id` trùng với mình. Đổi ID trên URL sẽ nhận **403**.
- Kế toán chỉ thấy `id, fullName, classId, className, status` của trẻ. Không xem được sức khoẻ, người giám hộ, điểm danh (403).
- Sửa điểm danh: giáo viên được sửa từ hôm nay lùi tối đa 3 ngày (theo giờ Việt Nam). Cũ hơn thì nhận 403 `EDIT_WINDOW_EXPIRED`, chỉ admin sửa được. Không ai được điểm danh cho ngày tương lai.
- Mọi lần tạo hoặc sửa điểm danh đều được ghi vào `attendance_history`. Lưu lại thao tác không làm thay đổi gì thì không sinh bản ghi.
- Đón trẻ: người giám hộ có `canPickup=true` thì được giao trẻ. Nếu `canPickup=false` thì nhận 403 `PICKUP_NOT_ALLOWED`.
  - Với người không có trong danh sách, giáo viên tạo yêu cầu đón (chỉ cho ngày hôm nay), trạng thái ban đầu là `pending`.
  - Phụ huynh của trẻ hoặc admin xác nhận hay từ chối. Khi đó giáo viên mới gọi `POST /attendance/:id/pickup {pickupRequestId}`.
  - Yêu cầu còn chờ thì nhận 403 `PICKUP_REQUEST_PENDING`, yêu cầu bị từ chối thì nhận 403 `PICKUP_REQUEST_REJECTED`. Yêu cầu đã xử lý rồi thì nhận 409 `ALREADY_DECIDED`.
- Dashboard: admin xem toàn trường và từng lớp (`byClass`). Giáo viên xem các lớp của mình kèm `byClass`. Kế toán chỉ xem tổng. Phụ huynh xem con mình kèm trạng thái từng bé.
- Học phí: admin và kế toán quản lý. Phụ huynh chỉ xem hoá đơn, phiếu thu, công nợ của con mình. Giáo viên không truy cập được (403).
  - Mỗi trẻ chỉ có 1 hoá đơn còn hiệu lực cho mỗi kỳ; huỷ hoá đơn thì lập lại được.
  - Không cho thu vượt số còn nợ (`OVERPAYMENT`). Số tiền tính bằng VND, kiểu số nguyên.
  - Khi lập hoá đơn tháng, khoản `one_time` không tự động được thêm vào.
- Sức khoẻ và dinh dưỡng: kế toán không truy cập được (403). Phụ huynh chỉ được đọc. Nhật ký ăn ngủ có cùng giới hạn sửa 3 ngày như điểm danh.

## Định dạng lỗi

Mọi lỗi đều có dạng `{ "code": "FORBIDDEN", "message": "..." }`. Lỗi validate có thêm `details[]`.
Các mã lỗi: `UNAUTHORIZED`, `TOKEN_INVALID`, `INVALID_CREDENTIALS`, `NO_REFRESH_TOKEN`, `FORBIDDEN`, `EDIT_WINDOW_EXPIRED`, `PICKUP_NOT_ALLOWED`, `NOT_FOUND`, `VALIDATION_ERROR`, `BAD_REQUEST`, `CONFLICT`, `USERNAME_TAKEN`, `PICKUP_REQUEST_PENDING`, `PICKUP_REQUEST_REJECTED`, `ALREADY_DECIDED`, `INVOICE_EXISTS`, `HAS_PAYMENTS`, `ALREADY_VOID`, `ALREADY_PAID`, `OVERPAYMENT`, `INVOICE_VOID`, `INVALID_SCOPE`, `NEGATIVE_TOTAL`, `INVALID_WEEK_START`, `CHILD_NOT_IN_CLASS`, `CLASS_NOT_EMPTY`, `DATE_IN_FUTURE`, `NOTE_REQUIRED`, `INVALID_GUARDIAN`, `INVALID_FILE`, `INTERNAL_ERROR`.

## Cấu trúc

```
src/database/entities.ts      # users, classes, class_teachers, children, guardians, attendance, pickups
src/database/migrations/      # migration TypeORM
src/database/seed.ts          # dữ liệu mẫu
src/common/                   # guard JWT, quy tắc phân quyền (access.ts), bộ lọc lỗi, xử lý ngày
src/auth, classes, children, attendance, dashboard, fees, health/   # controller
test/app.e2e-spec.ts          # 24 test e2e
```

## Chưa làm (các tuần sau)

Thông báo đẩy cho phụ huynh khi có yêu cầu đón, thông báo chung, báo cáo thu chi, xuất PDF phiếu thu, API quản lý user và đổi mật khẩu, giới hạn số lần đăng nhập sai, lưu ảnh lên S3 (hiện ảnh nằm trong thư mục `uploads/` trên máy chủ).
