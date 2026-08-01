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
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
