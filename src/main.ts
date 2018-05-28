import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

/**
 * The service entry point.
 *
 * Runs on in-memory adapters by default, so `pnpm dev` needs nothing installed. Setting
 * DATABASE_URL and REDIS_URL swaps the bindings; no code above the port changes.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.enableCors({ origin: true, credentials: true });
  // Drains in-flight requests before exit, so a deploy is not a burst of connection resets.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);

  process.stdout.write(`incident console listening on ${port}\n`);
  process.stdout.write('portfolio demonstration: this does not contact emergency services\n');
}

void bootstrap();
