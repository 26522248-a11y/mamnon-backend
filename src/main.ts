import './database/data-source'; // loads .env
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, configureApp } from './app.module';

async function bootstrap() {
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) if (!process.env[k]) throw new Error(`Missing env ${k}`);
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule));
  const port = Number(process.env.PORT || 3001);
  await app.listen(port);
  console.log(`API: http://localhost:${port}/api/v1  |  Swagger: http://localhost:${port}/api/docs`);
}
bootstrap();
