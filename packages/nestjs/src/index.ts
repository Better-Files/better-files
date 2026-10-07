import {
  createParamDecorator,
  ForbiddenException,
  Global,
  HttpException,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { BetterFilesError, type Credential } from '@better-files/core';
import {
  bindApi,
  basePathOf,
  requireCapabilities,
  toHeaders,
  type BoundApi,
  type BetterFilesLike,
} from '@better-files/middleware';
import { createBetterFilesExpress } from '@better-files/middleware/express';

/** Injection token for the `betterFiles()` instance. */
export const BETTER_FILES = Symbol.for('better-iam:better-files');
const CAPABILITIES = 'better-files:capabilities';

type HttpRequest = {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string>;
  query?: unknown;
  body?: unknown;
};
/** Reads an id from the request: a dotted path (`params.nodeId`, `body.roomId`) or a function. */
export type Selector = string | ((request: HttpRequest) => string | undefined);

export interface CapabilityOptions {
  tenantId: Selector;
  roomId: Selector;
  nodeId: Selector;
}

const select = (request: HttpRequest, selector: Selector): string | undefined => {
  if (typeof selector === 'function') return selector(request);
  let value: unknown = request;
  for (const part of selector.split('.'))
    value = (value as Record<string, unknown> | undefined)?.[part];
  return typeof value === 'string' ? value : undefined;
};

/** Maps Better Files and Better IAM errors onto Nest's HTTP exceptions. */
export function toHttpException(error: unknown): unknown {
  const code = error instanceof BetterFilesError ? error.code : (error as { code?: unknown })?.code;
  const status =
    error instanceof BetterFilesError ? error.status : (error as { status?: unknown })?.status;
  const message = error instanceof Error ? error.message : 'Request failed';
  if (typeof status !== 'number' || status >= 500) return error;
  if (status === 401) return new UnauthorizedException(message);
  if (status === 403) return new ForbiddenException(message);
  if (status === 404) return new NotFoundException(message);
  return new HttpException({ error: { code, message } }, status);
}

/**
 * Guards a route on the permission matrix. Use with `BetterFilesGuard` (registered globally by
 * `BetterFilesModule.forRoot({ guard: true })`, or per controller with `@UseGuards(BetterFilesGuard)`).
 *
 * ```ts
 * @Get('rooms/:roomId/docs/:nodeId')
 * @RequireCapability(['VIEW'], { tenantId: 'params.tenantId', roomId: 'params.roomId', nodeId: 'params.nodeId' })
 * ```
 */
export const RequireCapability = (capabilities: readonly string[], options: CapabilityOptions) =>
  SetMetadata(CAPABILITIES, { capabilities, options });

/** Injects `dr.api` bound to the request's credential: `@BetterFilesApi() api: BoundApi<typeof dr.api>`. */
export const BetterFilesApi = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context
    .switchToHttp()
    .getRequest<HttpRequest & { __betterFiles?: BetterFilesLike }>();
  const dr = request.__betterFiles;
  if (!dr) throw new Error('BetterFilesModule is not registered');
  return bindApi(dr, { headers: toHeaders(request.headers) });
});

@Injectable()
export class BetterFilesService<D extends BetterFilesLike = BetterFilesLike> {
  constructor(@Inject(BETTER_FILES) readonly dr: D) {}
  /** `dr.api` for a request (pass `req.headers`) or any credential. */
  api(
    credential: Credential | { headers: Record<string, string | string[] | undefined> },
  ): BoundApi<D['api']> {
    const headers =
      'headers' in credential && credential.headers
        ? toHeaders(credential.headers as Record<string, string>)
        : undefined;
    return bindApi(this.dr, headers ? { headers } : (credential as Credential));
  }
}

@Injectable()
export class BetterFilesGuard implements CanActivate {
  constructor(
    @Inject(BETTER_FILES) private readonly dr: BetterFilesLike,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<HttpRequest & { __betterFiles?: BetterFilesLike }>();
    request.__betterFiles = this.dr;
    const rule = this.reflector.getAllAndOverride<
      { capabilities: readonly string[]; options: CapabilityOptions } | undefined
    >(CAPABILITIES, [context.getHandler(), context.getClass()]);
    if (!rule) return true;
    try {
      await requireCapabilities(
        this.dr,
        { headers: toHeaders(request.headers) },
        {
          tenantId: select(request, rule.options.tenantId) ?? '',
          roomId: select(request, rule.options.roomId) ?? '',
          nodeId: select(request, rule.options.nodeId) ?? '',
          capabilities: rule.capabilities,
        },
      );
      return true;
    } catch (error) {
      throw toHttpException(error);
    }
  }
}

export interface BetterFilesModuleOptions {
  dr: BetterFilesLike;
  /** Serve the Better Files protocol from the Nest app (Express platform). Default true. */
  mount?: boolean;
  /** Register `BetterFilesGuard` for every route, so `@RequireCapability` works without `@UseGuards`. Default true. */
  guard?: boolean;
}

@Global()
@Module({})
export class BetterFilesModule implements NestModule {
  private static options: BetterFilesModuleOptions | undefined;

  static forRoot(options: BetterFilesModuleOptions): DynamicModule {
    BetterFilesModule.options = options;
    return {
      module: BetterFilesModule,
      providers: [
        { provide: BETTER_FILES, useValue: options.dr },
        BetterFilesService,
        BetterFilesGuard,
        ...(options.guard === false ? [] : [{ provide: APP_GUARD, useExisting: BetterFilesGuard }]),
      ],
      exports: [BETTER_FILES, BetterFilesService, BetterFilesGuard],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    const options = BetterFilesModule.options;
    if (!options || options.mount === false) return;
    const { middleware } = createBetterFilesExpress(options.dr);
    consumer.apply(middleware).forRoutes(`${basePathOf(options.dr)}/*path`);
  }
}
