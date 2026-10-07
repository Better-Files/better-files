/**
 * NestJS: `BetterFilesModule` mounts the protocol and provides `BetterFilesService`; `@RequireCapability` guards routes
 * on room capabilities and `@BetterFilesApi()` injects the API bound to the caller.
 */
import 'reflect-metadata';
import { Controller, Get, Module, Param } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { BoundApi } from 'better-files/middleware';
import { BetterFilesApi, BetterFilesModule, RequireCapability } from 'better-files/nestjs';
import { dr } from '../express-better-iam/better-files.js';

const TENANT = process.env.BETTER_FILES_TENANT ?? 'acme';

@Controller('deals')
class DealsController {
  @Get(':roomId/documents/:nodeId')
  @RequireCapability(['VIEW'], {
    tenantId: () => TENANT,
    roomId: 'params.roomId',
    nodeId: 'params.nodeId',
  })
  async document(@Param('nodeId') nodeId: string, @BetterFilesApi() api: BoundApi<typeof dr.api>) {
    const document = await api.documents.get({ tenantId: TENANT, nodeId });
    return {
      name: document.name,
      version: document.currentVersion?.number ?? null,
      size: document.currentVersion?.size ?? 0,
    };
  }
}

@Module({ imports: [BetterFilesModule.forRoot({ dr })], controllers: [DealsController] })
export class AppModule {}

if (process.argv[1]?.endsWith('app.module.ts')) {
  await dr.initialize();
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
