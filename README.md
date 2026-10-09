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

Dữ liệu mẫu: 3 lớp, 30 trẻ, mỗi trẻ có 2 người giám hộ (bé An có thêm "Bà nội" với `canPickup=false`), điểm danh của ngày hôm qua.

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
| POST | `/attendance/:id/pickup` `{guardianId? \| pickedUpByName+note, relation?, pickedUpAt?}` | admin, giáo viên của lớp |

Mỗi phần tử trong bảng điểm danh có dạng `{ attendanceId, childId, fullName, allergies, status, note, recorded, pickup }`. Trẻ chưa được điểm danh có `status: null` và `recorded: false`.

## Quy tắc phân quyền

- Giáo viên chỉ thao tác với lớp có trong `class_teachers`. Gọi lớp khác hoặc trẻ lớp khác sẽ nhận **403**.
- Phụ huynh chỉ xem được trẻ có `guardians.user_id` trùng với mình. Đổi ID trên URL sẽ nhận **403**.
- Kế toán chỉ thấy `id, fullName, classId, className, status` của trẻ. Không xem được sức khoẻ, người giám hộ, điểm danh (403).
- Sửa điểm danh: giáo viên được sửa từ hôm nay lùi tối đa 3 ngày (theo giờ Việt Nam). Cũ hơn thì nhận 403 `EDIT_WINDOW_EXPIRED`, chỉ admin sửa được. Không ai được điểm danh cho ngày tương lai.
- Đón trẻ: người giám hộ có `canPickup=true` thì được đón (`isAuthorized=true`). Nếu `canPickup=false` thì nhận 403 `PICKUP_NOT_ALLOWED`. Người không có trong danh sách vẫn được ghi nhận nhưng bắt buộc có `pickedUpByName` và `note`, và bị đánh dấu `isAuthorized=false`. Quy tắc này **tạm thời, chờ PM chốt**. Trẻ vắng thì không ghi nhận đón được.

## Định dạng lỗi

Mọi lỗi đều có dạng `{ "code": "FORBIDDEN", "message": "..." }`. Lỗi validate có thêm `details[]`.
Các mã lỗi: `UNAUTHORIZED`, `TOKEN_INVALID`, `INVALID_CREDENTIALS`, `NO_REFRESH_TOKEN`, `FORBIDDEN`, `EDIT_WINDOW_EXPIRED`, `PICKUP_NOT_ALLOWED`, `NOT_FOUND`, `VALIDATION_ERROR`, `BAD_REQUEST`, `CONFLICT`, `USERNAME_TAKEN`, `CHILD_NOT_IN_CLASS`, `CLASS_NOT_EMPTY`, `DATE_IN_FUTURE`, `NOTE_REQUIRED`, `INVALID_GUARDIAN`, `INVALID_FILE`, `INTERNAL_ERROR`.

## Cấu trúc

```
src/database/entities.ts      # users, classes, class_teachers, children, guardians, attendance, pickups
src/database/migrations/      # migration TypeORM
src/database/seed.ts          # dữ liệu mẫu
src/common/                   # guard JWT, quy tắc phân quyền (access.ts), bộ lọc lỗi, xử lý ngày
src/auth, classes, children, attendance/   # controller
test/app.e2e-spec.ts          # 12 test e2e
```

## Chưa làm (các tuần sau)

Học phí và công nợ (kế toán), sức khoẻ và dinh dưỡng (cân nặng, chiều cao, thực đơn), nhật ký ngày, thông báo, báo cáo, API quản lý user và đổi mật khẩu, giới hạn số lần đăng nhập sai, lưu ảnh lên S3 (hiện ảnh nằm trong thư mục `uploads/` trên máy chủ).
