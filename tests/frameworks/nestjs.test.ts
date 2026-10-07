import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Inject, Module, Param } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  BetterFilesApi,
  BetterFilesModule,
  BetterFilesService,
  RequireCapability,
} from '@better-files/nestjs';
import type { BoundApi } from '@better-files/middleware';
import { fixture, TENANT } from '../fixtures.js';

describe('NestJS', () => {
  it('mounts the protocol, guards routes on the matrix and injects the bound API', async () => {
    const f = await fixture();
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'nest.pdf',
      content: f.bytes(64),
    });
    type Api = BoundApi<typeof f.dr.api>;

    @Controller('deals')
    class DealsController {
      constructor(
        @Inject(BetterFilesService) private readonly rooms: BetterFilesService<typeof f.dr>,
      ) {}

      @Get(':roomId/docs/:nodeId')
      @RequireCapability(['VIEW'], {
        tenantId: () => TENANT,
        roomId: 'params.roomId',
        nodeId: 'params.nodeId',
      })
      async document(@Param('nodeId') nodeId: string, @BetterFilesApi() api: Api) {
        const doc = await api.documents.get({ tenantId: TENANT, nodeId });
        return { name: doc.name, hasService: this.rooms.dr === f.dr };
      }
    }

    @Module({ imports: [BetterFilesModule.forRoot({ dr: f.dr })], controllers: [DealsController] })
    class AppModule {}

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    try {
      const allowed = await fetch(`${base}/deals/${room.id}/docs/${document.id}`, {
        headers: { authorization: 'Bearer alice' },
      });
      expect(await allowed.json()).toEqual({ name: 'nest.pdf', hasService: true });
      const hidden = await fetch(`${base}/deals/${room.id}/docs/${document.id}`, {
        headers: { authorization: 'Bearer bob' },
      });
      expect(hidden.status).toBe(404);
      const anonymous = await fetch(`${base}/deals/${room.id}/docs/${document.id}`);
      expect(anonymous.status).toBe(401);
      // The protocol is served by the Nest app, after Nest's JSON body parser.
      const listed = await fetch(`${base}/api/better-files/rooms/list`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer alice',
          'x-better-files': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tenantId: TENANT }),
      });
      expect(((await listed.json()) as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([
        room.id,
      ]);
    } finally {
      await app.close();
    }
  });
});
