import { Controller, Get, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ApiTags, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { schoolInfo } from './common/school';
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
  /** Public (login page / print headers): school name, address, phone from env. */
  @Public() @Get('school') school() { return schoolInfo(); }
}

@Module({
  imports: [
    TypeOrmModule.forRoot({ ...dataSourceOptions, migrationsRun: process.env.MIGRATIONS_RUN === 'true' }),
    TypeOrmModule.forFeature(ENTITIES),
    JwtModule.register({}),
  ],
  controllers: [HealthController, SettingsController, AuthController, ClassesController, ChildrenController, AttendanceController, DashboardController, FeesController, HealthNutritionController, NotificationsController, ReportsController, UsersController],
  providers: [
    AccessService, UserContextService, NotificationsService, LoginThrottleService,
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
