import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Without this, Nest's lifecycle hooks (OnModuleDestroy, e.g.
  // ConversionEventsListener's QueueEvents connection close) never fire on
  // SIGTERM -- matching the same fix already applied in
  // apps/worker/src/main.ts (Phase 4A) for the identical reason.
  app.enableShutdownHooks();
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'https://app.drm.apower.lan' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  // Safe to blanket-trust here NOT merely because Traefik is the sole entry
  // point (that's necessary but not sufficient), but because Traefik itself
  // always overwrites/sets X-Forwarded-For from the real TCP connection
  // rather than passing through a client-supplied one — so a client cannot
  // spoof req.ip by sending its own X-Forwarded-For header. If a second hop
  // is ever added in front of Traefik (e.g. a Kubernetes Ingress or cloud
  // load balancer in a future migration), that hop's forwarding behavior
  // becomes the thing that matters, and `true` would then trust an
  // attacker-controlled header from anything behind it. At that point this
  // must change to a numeric trusted-hop-count or an explicit trusted-subnet
  // list — see docker-compose.yml's `traefik` service for the matching note.
  app.set('trust proxy', true);

  // API documentation is intentionally unavailable in production.  This
  // prevents the public service from exposing its complete endpoint and data
  // model inventory, while retaining an interactive contract for development
  // and integration environments.
  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('DRM API')
      .setDescription('文件管理、權限控管、稽核、回收桶與限時分享 API。')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api-docs', app, document, {
      jsonDocumentUrl: 'api-docs/openapi.json',
      customSiteTitle: 'DRM API 文件',
    });
  }
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
