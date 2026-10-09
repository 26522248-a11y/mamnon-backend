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

# 3. Migration + dữ liệu mẫu (CHỈ lần đầu)
npm run migration:run
npm run seed                  # DB đã có dữ liệu thì seed TỪ CHỐI chạy; muốn xoá sạch và tạo lại: npm run seed -- --force

# 4. Chạy
npm run start:dev             # chạy trực tiếp bằng ts-node
# hoặc: npm run build && npm start
```

- API: `http://localhost:3001/api/v1`
- Swagger: `http://localhost:3001/api/docs`
- Kiểm tra: `GET /api/v1/health`

**Khởi động lại server không bao giờ seed hay xoá dữ liệu.** `npm start` / `start:dev` chỉ chạy app; migration chỉ chạy khi gọi `npm run migration:run` (hoặc đặt `MIGRATIONS_RUN=true`), và mọi migration đều giữ nguyên dữ liệu. Seed là script riêng `npm run seed`, có chặn khi DB đã có dữ liệu.

Test e2e (dùng DB riêng `mamnon_test`, tự migrate và seed DB test, không đụng DB dev): `npm test`

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
| POST | `/children/:id/photo` (multipart, field `file`, JPG/PNG ≤ 3MB; kiểm tra nội dung thật bằng magic bytes) | admin, giáo viên của lớp |
| GET | `/children/:id/photo` (trả về ảnh, cần header `Authorization`) | admin, giáo viên của lớp, phụ huynh của trẻ |
| GET | `/pickup-requests/:id/photo` | admin, giáo viên của lớp, phụ huynh của trẻ |
| GET | `/children/:id/guardians` | admin, giáo viên của lớp, phụ huynh của trẻ |
| POST | `/children/:id/guardians` (có thể kèm `account:{username,password}` để cấp tài khoản phụ huynh, hoặc `userId` để liên kết) | admin |
| GET | `/children/:id/attendance?from&to` | admin, giáo viên của lớp, phụ huynh của trẻ |
| GET | `/classes/:id/attendance?date=YYYY-MM-DD` → `{classId,date,items[]}` | admin, giáo viên của lớp |
| PUT | `/classes/:id/attendance` `{date, items:[{childId,status,note?}]}` | admin, giáo viên của lớp |
| GET | `/attendance/:id/history` (ai sửa, lúc nào, giá trị cũ, giá trị mới) | admin, giáo viên của lớp |
| POST | `/attendance/:id/pickup` `{guardianId \| pickupRequestId, pickedUpAt?, note?}` | admin, giáo viên của lớp |
| POST | `/attendance/:id/pickup-requests` (JSON hoặc multipart: `pickerName, pickerPhone, note` **bắt buộc** (thiếu/rỗng → 400), `relation?`, ảnh `photo` tuỳ chọn) | admin, giáo viên của lớp |
| GET | `/pickup-requests?status&childId&date` | admin; giáo viên: lớp mình; phụ huynh: con mình |
| POST | `/pickup-requests/:id/confirm`, `/pickup-requests/:id/reject` `{note?}` → `status` thành **`approved`** (không phải `confirmed`) / `rejected` | admin, phụ huynh của trẻ |
| GET | `/children/attendance-summary?month=YYYY-MM&classId` (chỉ số ngày) | admin, kế toán; giáo viên: lớp mình; phụ huynh: con mình |
| GET | `/dashboard/summary?date=` | tất cả (theo phạm vi, xem dưới) |
| GET/POST/PATCH/DELETE | `/fee-items`, `/fee-items/:id` (scope `school`/`class`/`child`, type `monthly`/`one_time`) | admin, kế toán |
| POST | `/invoices/generate` `{period, classId?, dueDate?}` | admin, kế toán |
| POST | `/invoices` `{childId, period, applyCredit?, lines:[{feeItemId? \| description+unitPrice, kind?: charge\|discount\|refund, quantity?, reason?}]}` → hoá đơn + `warnings[]` | admin, kế toán |
| GET | `/invoices?period&classId&childId&status(unpaid\|partial\|paid\|void\|outstanding)&page&limit`, `/invoices/:id` | admin, kế toán; phụ huynh: con mình |
| POST | `/invoices/:id/void` `{reason}` (bắt buộc; huỷ cả hoá đơn đã thu: tiền đã thu → số dư; ghi vào `/invoices/:id/history`) | admin, kế toán (giáo viên/phụ huynh 403) |
| POST | `/children/:id/withdraw` `{leaveDate, reason}` (tất toán nghỉ học, xem dưới) | admin, kế toán |
| GET | `/children/:id/withdrawal` (trạng thái tất toán: nợ, số dư, `nextAction`, các phiếu chi) | admin, kế toán; phụ huynh: con mình |
| POST | `/children/:id/refund-payouts` `{method, recipientName, amount?, paidAt?, note?}` → dữ liệu **phiếu chi** | admin, kế toán |
| GET | `/refund-payouts/:id/voucher` (in phiếu chi: số PC, số tiền bằng chữ) | admin, kế toán; phụ huynh: con mình |
| POST | `/invoices/:id/payments` `{amount, method: cash\|transfer, paidAt?, payerName?, note?}` → dữ liệu phiếu thu | admin, kế toán |
| GET | `/payments/:id/receipt` (số phiếu, số tiền bằng chữ, các dòng hoá đơn) | admin, kế toán; phụ huynh: con mình |
| GET | `/children/:id/balance` | admin, kế toán; phụ huynh: con mình |
| GET | `/debts?classId&upToPeriod&overdueOnly` (mỗi dòng có `childStatus`, `leaveDate`) | admin, kế toán |
| GET / POST | `/children/:id/growth` (ghi lại theo ngày), DELETE `/growth/:id` | đọc: admin, giáo viên của lớp, phụ huynh của trẻ; ghi: admin, giáo viên của lớp |
| GET / PUT | `/menus?week=`, `/menus` `{weekStart (thứ Hai), items:[{date, meal: breakfast\|lunch\|snack, dishes}]}` | đọc: admin, giáo viên, phụ huynh; ghi: admin |
| GET / PUT | `/classes/:id/daily-notes?date=` `{date, items:[{childId, eating, sleepMinutes, mood, toilet, note}]}` | admin, giáo viên của lớp |
| GET | `/children/:id/daily-notes?from&to` | admin, giáo viên của lớp, phụ huynh của trẻ |
| POST / PATCH / DELETE | `/invoices/:id/lines`, `/invoices/:id/lines/:lineId` (sửa dòng hoá đơn, kể cả dòng hoàn tiền ăn) | admin, kế toán |
| GET | `/invoices/:id/history` (ai sửa, lúc nào, giá trị cũ, giá trị mới) | admin, kế toán |
| POST | `/children/:id/prepayments` `{amount, method, ...}` | admin, kế toán |
| GET | `/children/:id/credits` (số dư trả trước / trả thừa và lịch sử) | admin, kế toán; phụ huynh: con mình |
| POST | `/announcements` `{title, body, scope: school\|class, classId?, audience: all\|parents\|staff}` | admin; giáo viên: chỉ thông báo cho lớp mình |
| GET / DELETE | `/announcements`, `/announcements/:id` | xem: theo phạm vi; xoá: admin hoặc người tạo |
| GET | `/notifications?unreadOnly&page&limit` → `{items,total,unreadCount}`, `/notifications/unread-count` | mọi người dùng (hộp thư của chính mình) |
| POST | `/notifications/:id/read`, `/notifications/read-all` | chính chủ (của người khác thì nhận 404) |
| GET | `/reports/attendance?fromMonth&toMonth&classId` (tỉ lệ chuyên cần theo lớp, theo tháng) | admin |
| GET | `/reports/enrollment` (sĩ số, sức chứa, nam/nữ, số trẻ mới nhập học theo tháng) | admin |
| GET | `/reports/finance?fromMonth&toMonth&classId` (phải thu, đã thu, công nợ, quá hạn, giảm trừ theo kỳ; tiền thu theo tháng) | admin, kế toán |
| GET/POST/PATCH/DELETE | `/users`, `/users/:id` | admin |
| POST | `/users/:id/reset-password`, `/users/:id/deactivate`, `/users/:id/activate` | admin |
| POST | `/users/:id/unlock` (mở khoá đăng nhập sai nhiều lần) | admin |
| POST | `/auth/change-password` `{currentPassword, newPassword}` → cấp token mới | mọi người dùng |

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
- Học phí (xem thêm phần "Quyết định PM đã áp dụng"): admin và kế toán quản lý. Phụ huynh chỉ xem hoá đơn, phiếu thu, công nợ của con mình. Giáo viên không truy cập được (403).
  - Mỗi trẻ chỉ có 1 hoá đơn còn hiệu lực cho mỗi kỳ; huỷ hoá đơn thì lập lại được.
  - Số tiền tính bằng VND, kiểu số nguyên.
  - Khi lập hoá đơn tháng, khoản `one_time` không tự động được thêm vào.
- Sức khoẻ và dinh dưỡng: kế toán không truy cập được (403). Phụ huynh chỉ được đọc. Nhật ký ăn ngủ có cùng giới hạn sửa 3 ngày như điểm danh.

## Ảnh

- **Ảnh đại diện mẫu:** 10 ảnh của designer nằm ở `assets/avatars/avatar-01.png..avatar-10.png`. Seed gán lần lượt cho 30 trẻ (trẻ thứ i → `avatar-(i%10+1)`), mỗi trẻ một file riêng `uploads/avatar-<childId>.png` (thay ảnh trẻ này không xoá ảnh trẻ khác).
- `npm run avatars` gán ảnh mẫu cho các trẻ **chưa có ảnh** trên DB đang chạy (không ghi đè ảnh thật, không xoá dữ liệu); `npm run avatars -- "Nguyễn Gia An"` chỉ cho 1 trẻ.

Thư mục `uploads/` (hoặc đường dẫn trong `UPLOAD_DIR`) **không** được phục vụ công khai. `photoUrl` trong dữ liệu trả về là endpoint API, ví dụ `/api/v1/children/:id/photo`. Endpoint này kiểm tra quyền giống như khi xem hồ sơ trẻ. Không có token thì nhận 401, sai người thì nhận 403.

Front end phải tải ảnh bằng `fetch` có header `Authorization`, rồi hiển thị qua `URL.createObjectURL(blob)`, vì thẻ `<img src>` không gửi được Bearer token.

Ảnh được nhận diện qua magic bytes: chỉ chấp nhận JPEG và PNG thật. Tên file hay Content-Type không có tác dụng.

## Quyết định PM đã áp dụng

- **Yêu cầu đón:** hết hạn sau 2 giờ hoặc khi hết ngày (giờ VN), tuỳ mốc nào đến trước (`expiresAt`, trạng thái `expired`).
  - Giao trẻ theo yêu cầu đã hết hạn thì nhận 403 `PICKUP_REQUEST_EXPIRED`. Xác nhận yêu cầu đã hết hạn thì nhận 409 `REQUEST_EXPIRED`.
  - Admin xác nhận hay từ chối thay phụ huynh thì bắt buộc có `note`, nếu thiếu nhận 400 `NOTE_REQUIRED`. Khi đó `decidedOnBehalf=true`.
  - Phụ huynh nhận thông báo trong hộp thư khi có yêu cầu mới. Giáo viên nhận thông báo khi yêu cầu đã được quyết định.
- **Hoàn tiền ăn:** điểm danh có thêm cờ `notifiedInAdvance`, chỉ có tác dụng khi `status=absent`.
  - Khi lập hoá đơn, các ngày vắng có báo trước chưa từng được hoàn (xét 3 tháng trước kỳ) được trừ theo mức `mealRefundPerDay` của khoản tiền ăn.
  - Bảng `meal_refunds` ghi từng ngày đã hoàn, nên lập lại hoá đơn không bao giờ hoàn trùng.
  - Nếu sau khi đã hoàn mà điểm danh bị sửa (không còn là vắng có báo trước), hoá đơn tiếp theo có đúng 1 dòng "Thu lại tiền ăn".
  - Kế toán sửa dòng hoàn bằng PATCH, mọi thay đổi được ghi vào `invoice_audit`. Dòng hoàn không xoá được; muốn bỏ hoàn thì đặt `unitPrice=0`.
- **Trả trước và trả thừa:** phần tiền vượt số còn nợ được cộng vào số dư (credit) của trẻ. `POST /children/:id/prepayments` dùng để trả trước khi chưa có hoá đơn. Số dư được tự trừ vào hoá đơn kế tiếp bằng dòng `credit`.
- **Huỷ hoá đơn (chốt):** chỉ admin/kế toán, bắt buộc `reason` (rỗng → 400 `REASON_REQUIRED`), ghi lịch sử `voided` kèm `reason`, `movedToCredit`, `creditRestored`. Huỷ được cả hoá đơn đã thu tiền. Số đã nộp được chuyển thành số dư (`void_refund`), số dư đã dùng cho hoá đơn đó được hoàn lại, và các ngày hoàn tiền ăn được giải phóng để hoá đơn mới xử lý lại.
- **Giảm trừ:** là khoản thu loại `type=discount`, bắt buộc có `reason`. Mọi dòng hoá đơn đều có `unitPrice ≥ 0`; dấu của số tiền do `kind` quyết định (`charge`, `discount`, `refund`, `credit`). Nhập số âm thì nhận 400.
  - **Giảm trừ vượt số phải thu (chốt):** áp dụng giống nhau cho hoá đơn tự động, lập tay và thêm/sửa dòng: hoá đơn về **0đ**, phần vượt **bị bỏ** (không thành số dư). Không còn lỗi 400. Response có `warnings[]`: `{code: "DISCOUNT_CAPPED", message, description, kind, requested, applied, discarded, lineId?}` (khi lập tự động còn có `invoiceId, childId, childName`). Hoàn tiền ăn được trừ trước, giảm trừ bị giới hạn sau.
- **Quá hạn:** hạn nộp mặc định là ngày 10. Hoá đơn bị tính quá hạn từ **00:01 giờ VN ngày 11**. `/debts` có `overdue`, `overdueAmount`, lọc được bằng `?overdueOnly=true`, và sắp xếp khoản quá hạn lên đầu. Không có phí trễ hạn.
- **Trẻ nghỉ học (chốt):** `POST /children/:id/withdraw {leaveDate, reason}`; `leaveDate` là ngày học cuối, không được ở tương lai. Không xoá dữ liệu nào. Trong 1 giao dịch:
  1. Hoá đơn của các kỳ **sau** tháng nghỉ bị huỷ (tiền đã thu → số dư).
  2. Tiền ăn những ngày vắng có báo trước đến hết `leaveDate` mà chưa hoàn → cộng vào số dư (`meal_refund`); ngày đã hoàn nhưng điểm danh bị sửa → trừ lại (`meal_clawback`).
  3. Số dư được trừ vào các hoá đơn còn nợ, cũ trước (dòng `credit`, ghi lịch sử `credit_applied`).
  4. Trẻ chuyển `status='withdrawn'`, lưu `leaveDate`, lý do, người thực hiện; yêu cầu đón đang chờ chuyển `expired`.
  - Kết quả có `outstandingDebt`, `creditBalance`, `netBalance`, `nextAction`: `refund_payout` (còn số dư → kế toán lập phiếu chi `POST /children/:id/refund-payouts`, chi đúng toàn bộ số dư, số dư về 0, số phiếu `PCyyyymm-00001`), `collect_debt` (còn nợ → vẫn nằm trong `/debts` đến khi thu đủ), hoặc `none`.
  - Sau khi nghỉ: không có trong danh sách trẻ mặc định (`?status=withdrawn` hoặc `all` để xem), không có trong bảng điểm danh các ngày sau `leaveDate` (điểm danh → 400 `CHILD_WITHDRAWN`), không được lập hoá đơn tự động, lập tay cho kỳ sau tháng nghỉ hay trả trước → 409 `CHILD_WITHDRAWN`. Thu nợ cũ vẫn bình thường.
  - **Tháng nghỉ học (chốt):** khoản cố định (học phí, năng khiếu…) tính **đủ tháng**, không chia theo ngày. Tiền ăn chỉ tính **số ngày đi học thực tế** (có mặt / đi muộn, từ ngày 1 đến `leaveDate`) × `mealRefundPerDay`, không vượt mức tiền ăn tháng; vì vậy ngày vắng có báo trước trong tháng nghỉ không bị tính.
    - Đã có hoá đơn tháng nghỉ: thêm dòng `refund` "Hoàn tiền ăn tháng nghỉ học" = tiền ăn đã tính − tiền ăn theo ngày thực tế. Nếu hoá đơn đã thu nhiều hơn tổng mới, phần thừa thành số dư (`adjustment`).
    - Chưa có hoá đơn tháng nghỉ: tạo mới với học phí đủ tháng + tiền ăn theo ngày + hoàn tiền ăn các tháng trước.
    - Kế toán sửa tay dòng đó bằng `PATCH /invoices/:id/lines/:lineId` (có ghi lịch sử). Kết quả withdraw có `leaveMonth: {period, invoiceId, created, attendedDays, mealRate, mealCharged, mealAdjustment, movedToCredit}`.
  - Nhập học lại: P2, chưa làm.
- **Thực đơn:** mỗi bữa có `allergyNotes` (món thay thế cho trẻ dị ứng). `GET /menus` trả kèm `allergyAlerts` gồm các trẻ có dị ứng: admin thấy toàn trường, giáo viên thấy lớp mình, phụ huynh thấy con mình.

## Tài khoản và bảo mật đăng nhập

- Sai mật khẩu 5 lần trong 15 phút (tính theo cặp username + IP) thì bị khoá 15 phút: trả 429 `{ code: "TOO_MANY_ATTEMPTS", message, lockedUntil: "2026-10-09T11:56:46.013Z" (ISO, UTC), retryAfterSeconds, lockScope: "account"|"ip" }` kèm header `Retry-After`. Khi đang khoá, nhập đúng mật khẩu cũng bị chặn.
  - Mỗi IP bị giới hạn 30 lần sai. Đăng nhập đúng thì bộ đếm của username đó được xoá.
  - `GET /users` / `GET /users/:id` có `locked`, `lockedUntil`. Admin mở khoá bằng `POST /users/:id/unlock` (hoặc reset mật khẩu). Khoá theo IP (30 lần) không gỡ bằng unlock, tự hết sau 15 phút.
- **`mustChangePassword`:** `true` với tài khoản admin tạo (`POST /users`, tài khoản phụ huynh tạo kèm người giám hộ) và sau khi admin reset mật khẩu; về `false` khi người dùng tự đổi (`POST /auth/change-password`). Có trong `user` của response login / refresh / change-password và trong `/users`. Frontend nên chuyển thẳng tới màn hình đổi mật khẩu khi `true` (backend chưa chặn API khác). Có cả trong `GET /auth/me`. Tài khoản seed = `false`.
  - Các ngưỡng chỉnh được qua `LOGIN_MAX_FAILS`, `LOGIN_IP_MAX_FAILS`, `LOGIN_LOCK_MINUTES`. Nếu chạy sau reverse proxy thì đặt `TRUST_PROXY`.
  - Bộ đếm nằm trong bộ nhớ, chỉ đúng khi chạy 1 instance.
- Reset mật khẩu, khoá tài khoản, đổi vai trò, hay tự đổi mật khẩu đều thu hồi mọi phiên đăng nhập cũ.
- Không xoá, khoá hay đổi vai trò được admin cuối cùng (`LAST_ADMIN`). Không tự khoá hay tự đổi vai trò của chính mình.
  - Tài khoản đã có dữ liệu liên quan thì không xoá được (`USER_HAS_HISTORY`), hãy khoá thay vì xoá.
  - Đổi vai trò khi tài khoản còn gắn với lớp hoặc trẻ thì nhận `USER_HAS_LINKS`.

## Triển khai (Docker Compose)

Thư mục `deploy/`: PostgreSQL 17 + API + web (Next.js, build từ `../mamnon-web`) + Caddy (HTTPS tự động) + backup hằng ngày. Yêu cầu: Docker + Compose v2, thư mục đặt cạnh nhau `<root>/mamnon-backend` và `<root>/mamnon-web`, domain trỏ về máy chủ, mở cổng 80/443.

```bash
cd mamnon-backend/deploy
cp .env.example .env        # sửa DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, JWT_*_SECRET (openssl rand -base64 48), SCHOOL_*
docker compose up -d --build
docker compose ps           # migrate: exited (0); db, api, web, caddy, backup: running/healthy
```

- **Thứ tự khởi động:** `db` (healthcheck) → `migrate` (chạy migration một lần rồi thoát, không xoá dữ liệu) → `api`. Không service nào seed. Dữ liệu demo (XOÁ SẠCH DB): `docker compose run --rm api node dist/database/seed.js --force`.
- **Định tuyến (Caddy, `deploy/Caddyfile`):** `https://DOMAIN/api/*` → API (Swagger ở `/api/docs`), còn lại → web. Web build với `NEXT_PUBLIC_API_URL=""` nên gọi `/api/v1` cùng origin; cookie refresh `Secure`, `CORS_ORIGIN=https://DOMAIN`, `TRUST_PROXY=1` (IP thật cho giới hạn đăng nhập). Có HSTS, nosniff, chặn iframe, giới hạn body 5MB. Thử trong LAN không có domain: `DOMAIN=localhost` (chứng chỉ nội bộ của Caddy).
- **Ảnh:** volume `uploads` (`/data/uploads`), chỉ phục vụ qua API có kiểm tra quyền.
- **Backup** (service `backup`, `deploy/backup/`): mỗi ngày lúc `BACKUP_TIME` (giờ VN, mặc định 02:30) chạy `pg_dump -Fc` (kiểm tra đọc lại bằng `pg_restore -l`) + nén thư mục ảnh vào `BACKUP_DIR/daily`; giữ 14 bản ngày, 8 bản Chủ nhật (`weekly`), 12 bản ngày 1 (`monthly`) – chỉnh bằng `BACKUP_KEEP_*`. Chạy ngay: `docker compose exec backup backup.sh`. **Nên chép `BACKUP_DIR` ra ngoài máy chủ.**
- **Khôi phục:**
  ```bash
  docker compose stop api
  docker compose exec -T db pg_restore -U mamnon -d mamnon --clean --if-exists < backups/daily/mamnon_YYYY-MM-DD_HHMM.dump
  docker compose run --rm -v "$PWD/backups:/b" --entrypoint sh api -c 'cd /data/uploads && tar -xzf /b/daily/uploads_YYYY-MM-DD_HHMM.tar.gz'
  docker compose start api
  ```
- **Cập nhật phiên bản:** `git pull` cả 2 repo → `docker compose up -d --build` (migrate tự chạy migration mới trước khi API khởi động).
- Lưu ý: giới hạn đăng nhập lưu trong bộ nhớ → chạy 1 instance `api`. Nên chặn `/api/docs` ở môi trường thật nếu không cần (thêm `respond /api/docs* 404` trong Caddyfile).

## Định dạng lỗi

Mọi lỗi đều có dạng `{ "code": "FORBIDDEN", "message": "..." }`. Lỗi validate có thêm `details[]`; 429 có thêm `lockedUntil`; `AMOUNT_MISMATCH` có `details.creditBalance`.
Các mã lỗi: `UNAUTHORIZED`, `TOKEN_INVALID`, `INVALID_CREDENTIALS`, `NO_REFRESH_TOKEN`, `FORBIDDEN`, `EDIT_WINDOW_EXPIRED`, `PICKUP_NOT_ALLOWED`, `NOT_FOUND`, `VALIDATION_ERROR`, `BAD_REQUEST`, `CONFLICT`, `USERNAME_TAKEN`, `TOO_MANY_ATTEMPTS`, `WRONG_PASSWORD`, `SAME_PASSWORD`, `LAST_ADMIN`, `SELF_CHANGE`, `USER_HAS_LINKS`, `USER_HAS_HISTORY`, `PICKUP_REQUEST_EXPIRED`, `REQUEST_EXPIRED`, `NOTE_REQUIRED`, `REASON_REQUIRED`, `TOTAL_BELOW_PAID`, `CREDIT_LINE_LOCKED`, `REFUND_LINE_USE_PATCH`, `PICKUP_REQUEST_PENDING`, `PICKUP_REQUEST_REJECTED`, `ALREADY_DECIDED`, `INVOICE_EXISTS`, `ALREADY_VOID`, `ALREADY_PAID`, `INVOICE_VOID`, `INVALID_SCOPE`, `NEGATIVE_TOTAL`, `INVALID_WEEK_START`, `CHILD_NOT_IN_CLASS`, `CLASS_NOT_EMPTY`, `DATE_IN_FUTURE`, `NOTE_REQUIRED`, `INVALID_GUARDIAN`, `INVALID_FILE`, `CHILD_WITHDRAWN`, `ALREADY_WITHDRAWN`, `LEAVE_DATE_IN_FUTURE`, `INVALID_LEAVE_DATE`, `CHILD_NOT_WITHDRAWN`, `NO_CREDIT_BALANCE`, `OUTSTANDING_DEBT`, `AMOUNT_MISMATCH`, `INTERNAL_ERROR`.

## Cấu trúc

```
src/database/entities.ts      # users, classes, class_teachers, children, guardians, attendance, pickups
src/database/migrations/      # migration TypeORM
src/database/seed.ts          # dữ liệu mẫu
src/common/                   # guard JWT, quy tắc phân quyền (access.ts), bộ lọc lỗi, xử lý ngày
src/auth, classes, children, attendance, dashboard, fees, health, notifications, reports, users/   # controller
test/app.e2e-spec.ts, features.e2e-spec.ts, withdrawal.e2e-spec.ts   # 52 test e2e
```

## Chưa làm

- Gửi push, SMS hoặc Zalo (hiện chỉ có hộp thư trong app) và xuất PDF phiếu thu.
- Giảm trừ theo % (hiện chỉ có số tiền cố định) và hoàn tiền ăn theo đơn giá của đúng ngày vắng (hiện dùng đơn giá lúc lập hoá đơn).
- Nhập học lại trẻ đã nghỉ (P2).
- Bộ đếm giới hạn đăng nhập cần Redis hoặc DB nếu chạy nhiều instance.
- Lưu ảnh lên S3.
