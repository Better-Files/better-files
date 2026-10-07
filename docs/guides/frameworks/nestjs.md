# NestJS

`better-files/nestjs` provides a global module that mounts the protocol, a guard driven by
`@RequireCapability`, and `@BetterFilesApi()`, which injects the API bound to the caller.

## 1. Register the module

```ts
import { Module } from '@nestjs/common';
import { BetterFilesModule } from 'better-files/nestjs';
import { dr } from './better-files';

@Module({ imports: [BetterFilesModule.forRoot({ dr })], controllers: [DealsController] })
export class AppModule {}
```

| Option  | Default | Meaning                                                                                   |
| ------- | ------- | ----------------------------------------------------------------------------------------- |
| `dr`    | (none)  | The `betterFiles()` instance, also injectable as the `BETTER_FILES` token.                |
| `mount` | `true`  | Serve the protocol under `basePath` (Express platform).                                   |
| `guard` | `true`  | Register `BetterFilesGuard` globally, so `@RequireCapability` works without `@UseGuards`. |

Run `await dr.initialize()` before `NestFactory.create(AppModule)`, or at deploy time with `npx better-files migrate`.

## 2. Guard routes and call the API

```ts
import { Controller, Get, Param } from '@nestjs/common';
import type { BoundApi } from 'better-files/middleware';
import { BetterFilesApi, RequireCapability } from 'better-files/nestjs';

@Controller('deals')
export class DealsController {
  @Get(':tenantId/:roomId/documents/:nodeId')
  @RequireCapability(['VIEW'], {
    tenantId: 'params.tenantId',
    roomId: 'params.roomId',
    nodeId: 'params.nodeId',
  })
  async document(
    @Param('tenantId') tenantId: string,
    @Param('nodeId') nodeId: string,
    @BetterFilesApi() api: BoundApi<typeof dr.api>,
  ) {
    return api.documents.get({ tenantId, nodeId });
  }
}
```

Selectors are dotted paths into the request (`params.x`, `query.x`, `body.x`) or functions `(request) => string`. Use a
function to take the tenant from your session middleware.

When the check fails, the guard throws Nest's own exceptions: `NotFoundException` for a hidden node, `ForbiddenException`
for a visible node without the capability, and `UnauthorizedException` with no session. Use `toHttpException(error)` to
map errors from your own `dr.api` calls the same way.

## 3. In services

```ts
@Injectable()
export class DealService {
  constructor(private readonly rooms: BetterFilesService<typeof dr>) {}

  list(headers: Record<string, string | string[] | undefined>, tenantId: string) {
    return this.rooms.api({ headers }).rooms.list({ tenantId });
  }
}
```

`BetterFilesService.api()` accepts the request's headers or any credential (`{ token }`).

## With Better IAM's Nest module

Import `IamModule.forRoot({ iam, ... })` from `better-iam/nestjs` next to `BetterFilesModule`. Both read the same cookies
or bearer token, so a person signed in to Better IAM is the caller in Better Files too.

## Fastify platform

`mount: true` uses Express middleware. On `@nestjs/platform-fastify`, set `mount: false` and register the Fastify
integration on the underlying instance:

```ts
BetterFilesModule.forRoot({ dr, mount: false });

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
await betterFilesFastify(app.getHttpAdapter().getInstance(), { dr }); // better-files/middleware/fastify
```

## Maintenance

Call `dr.maintain()` on a schedule, for example with `@nestjs/schedule`:

```ts
@Cron('*/5 * * * *')
maintain() {
  return dr.maintain();
}
```

A complete example lives in [`examples/nestjs`](../../../examples/nestjs).
