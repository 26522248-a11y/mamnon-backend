import { Controller, Get, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ApiTags, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AbsencesController } from './absences/absences.controller';
import { AbsencesService } from './absences/absences.service';
import { HolidayReminderService } from './calendar/holiday-reminder.service';
import { ParentMessagesController } from './messages/parent-messages.controller';
import { PhotoConsentController } from './children/photo-consent.controller';
import { HolidaysController } from './calendar/holidays.controller';
import { DataSource } from 'typeorm';
import { todayStr } from './common/dates';
import { schoolSettings } from './common/school';
import { TypeOrmModule } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as path from 'path';
import { AttendanceController } from './attendance/attendance.controller';
import { AuthController } from './auth/auth.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { HealthController as HealthNutritionController } from './health/health.controller';
import { LoginThrottleService } from './auth/login-throttle.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { NotificationDispatcher } from './notifications/channels';
import { AuthorizedPickersController, ContactPhonesController } from './pickup/authorized-pickers.controller';
import { PickupDutiesController } from './pickup/duties.controller';
import { PickupSafetyService } from './pickup/pickup-safety.service';
import { PushController } from './pickup/push.controller';
import { AuditController } from './audit/audit.controller';
import { SensitiveAuditController } from './audit/sensitive.controller';
import { StaffController } from './staff/staff.controller';
import { FinanceController } from './finance/finance.controller';
import { ImportsController } from './imports/imports.controller';
import { ReportsController } from './reports/reports.controller';
import { UsersController } from './users/users.controller';
import { FeesController } from './fees/fees.controller';
import { ChildrenController } from './children/children.controller';
import { ClassesController } from './classes/classes.controller';
import { AccessService } from './common/access';
import { JwtAuthGuard, Public, UserContextService } from './common/auth';
import { AllExceptionsFilter } from './common/errors';
import { dataSourceOptions } from './database/data-source';
import { ENTITIES } from './database/entities';

@Controller('health')
class HealthController {
  @Public() @Get() health() { return { status: 'ok', time: new Date().toISOString() }; }
}

@ApiTags('settings')
@Controller('settings')
class SettingsController {
  constructor(private ds: DataSource) {}
  /** Public (login page / print headers / parent banner): school info + round-2 settings + today's confirmed closure. */
  @Public() @Get('school') async school() {
    const today = todayStr();
    const [h] = await this.ds.query(`SELECT id, name, kind, reason FROM holidays WHERE date = $1 AND status = 'confirmed'`, [today]);
    return { ...schoolSettings(), todayClosure: h ? { date: today, id: h.id, name: h.name, kind: h.kind, reason: h.reason } : null };
  }
}

@Module({
  imports: [
    TypeOrmModule.forRoot({ ...dataSourceOptions, migrationsRun: process.env.MIGRATIONS_RUN === 'true' }),
    TypeOrmModule.forFeature(ENTITIES),
    JwtModule.register({}),
  ],
  controllers: [HealthController, SettingsController, AuthController, ClassesController, ChildrenController, AttendanceController, DashboardController, FeesController, HealthNutritionController, NotificationsController, ReportsController, UsersController, ImportsController, AuthorizedPickersController, ContactPhonesController, PickupDutiesController, PushController, AuditController, SensitiveAuditController, StaffController, FinanceController, AbsencesController, HolidaysController, ParentMessagesController, PhotoConsentController],
  providers: [
    AccessService, UserContextService, AbsencesService, HolidayReminderService, NotificationsService, NotificationDispatcher, PickupSafetyService, LoginThrottleService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}

/** Shared app configuration (used by main.ts and e2e tests). */
export function configureApp(app: NestExpressApplication) {
  app.setGlobalPrefix('api/v1');
  if (process.env.TRUST_PROXY) { const t = process.env.TRUST_PROXY; app.set('trust proxy', t === 'true' ? true : /^\d+$/.test(t) ? Number(t) : t); } // for correct req.ip behind a reverse proxy
  app.use(cookieParser());
  app.enableCors({ origin: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(','), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  // NOTE: uploads are intentionally NOT served statically; photos go through permission-checked endpoints.
  const doc = new DocumentBuilder()
    .setTitle('Mầm non API').setDescription('API quản lý học sinh trường mầm non. Lỗi luôn có dạng { code, message }.')
    .setVersion('1.0').addBearerAuth().addCookieAuth('refresh_token').build();
  SwaggerModule.setup('api/docs', app as INestApplication, SwaggerModule.createDocument(app as INestApplication, doc),
    { swaggerOptions: { persistAuthorization: true } });
  return app;
}
