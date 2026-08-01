import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://app.drm.localhost' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  // Traefik is the sole entry point into this service — docker-compose.yml
  // publishes no other route directly to `api`, so trusting all proxies is
  // safe here and lets req.ip reflect the real client address (forwarded by
  // Traefik via X-Forwarded-For) instead of Traefik's own container IP.
  app.set('trust proxy', true);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
