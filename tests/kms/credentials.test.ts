import { describe, expect, it } from 'vitest';
import { awsCredentials, azureIdentityToken, gcpMetadataToken } from '@better-files/kms';

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/** A fetch that answers from a route table and records every call. */
function scripted(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? String(init.body) : '',
    };
    calls.push(call);
    const route = Object.keys(routes).find((prefix) =>
      `${call.method} ${call.url}`.startsWith(prefix),
    );
    if (!route) throw new TypeError(`fetch failed: ${call.method} ${call.url}`);
    return routes[route]!(call);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const later = (ms: number, from: number) => new Date(from + ms).toISOString();

describe('awsCredentials', () => {
  it('reads static keys from the environment', async () => {
    const get = awsCredentials({
      env: { AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'tok' },
      fetch: scripted({}).fetch,
    });
    expect(await get()).toEqual({
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      sessionToken: 'tok',
    });
  });

  it('exchanges a web identity token with STS, and refreshes before expiry', async () => {
    let now = Date.UTC(2026, 9, 3);
    const sts = scripted({
      'POST https://sts.eu-west-1.amazonaws.com/': (call) => {
        const form = new URLSearchParams(call.body);
        expect(form.get('Action')).toBe('AssumeRoleWithWebIdentity');
        expect(form.get('RoleArn')).toBe('arn:aws:iam::1:role/better-files');
        expect(form.get('WebIdentityToken')).toBe('jwt-from-file');
        return new Response(
          `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
            <AccessKeyId>ASIA${sts.calls.length}</AccessKeyId><SecretAccessKey>s</SecretAccessKey>
            <SessionToken>st</SessionToken><Expiration>${later(3600_000, now)}</Expiration>
          </Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
        );
      },
    });
    const get = awsCredentials({
      env: {
        AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/token',
        AWS_ROLE_ARN: 'arn:aws:iam::1:role/better-files',
        AWS_REGION: 'eu-west-1',
      },
      fetch: sts.fetch,
      now: () => now,
      readFile: async (path) => (path === '/var/run/token' ? 'jwt-from-file\n' : ''),
    });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toEqual({ accessKeyId: 'ASIA1', secretAccessKey: 's', sessionToken: 'st' });
    expect(b).toBe(a);
    expect(sts.calls).toHaveLength(1);
    now += 50 * 60_000; // 10 minutes left: still cached
    expect((await get()).accessKeyId).toBe('ASIA1');
    now += 6 * 60_000; // inside the refresh window
    expect((await get()).accessKeyId).toBe('ASIA2');
  });

  it('uses container credentials with an authorization token file (EKS Pod Identity)', async () => {
    const endpoint = scripted({
      'GET http://169.254.170.23/v1/credentials': (call) => {
        expect(call.headers.get('authorization')).toBe('pod-token');
        return json({
          AccessKeyId: 'ASIAPOD',
          SecretAccessKey: 's',
          Token: 't',
          Expiration: later(3600_000, Date.now()),
        });
      },
    });
    const get = awsCredentials({
      env: {
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/var/run/pod-token',
      },
      fetch: endpoint.fetch,
      readFile: async () => 'pod-token',
    });
    expect(await get()).toEqual({
      accessKeyId: 'ASIAPOD',
      secretAccessKey: 's',
      sessionToken: 't',
    });
  });

  it('refuses a plain-HTTP container endpoint on another host', async () => {
    const get = awsCredentials({
      env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://attacker.test/creds' },
      fetch: scripted({}).fetch,
    });
    await expect(get()).rejects.toThrow(/https or a link-local/);
  });

  it('falls back to the EC2 instance role through IMDSv2', async () => {
    const imds = scripted({
      'PUT http://169.254.169.254/latest/api/token': (call) => {
        expect(call.headers.get('x-aws-ec2-metadata-token-ttl-seconds')).toBe('21600');
        return new Response('imds-token');
      },
      'GET http://169.254.169.254/latest/meta-data/iam/security-credentials/better-files-role': (
        call,
      ) => {
        expect(call.headers.get('x-aws-ec2-metadata-token')).toBe('imds-token');
        return json({
          AccessKeyId: 'ASIAEC2',
          SecretAccessKey: 's',
          Token: 't',
          Expiration: later(3600_000, Date.now()),
        });
      },
      'GET http://169.254.169.254/latest/meta-data/iam/security-credentials/': () =>
        new Response('better-files-role\n'),
    });
    const get = awsCredentials({ env: {}, fetch: imds.fetch });
    expect((await get()).accessKeyId).toBe('ASIAEC2');
  });

  it('explains when no credentials are available', async () => {
    await expect(awsCredentials({ env: {}, fetch: scripted({}).fetch })()).rejects.toThrow(
      /No AWS credentials found/,
    );
    await expect(
      awsCredentials({ env: { AWS_EC2_METADATA_DISABLED: 'true' }, fetch: scripted({}).fetch })(),
    ).rejects.toThrow(/metadata service is disabled/);
  });
});

describe('gcpMetadataToken', () => {
  it('asks the metadata server with the flavor header and caches the token', async () => {
    const server = scripted({
      'GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token':
        (call) => {
          expect(call.headers.get('metadata-flavor')).toBe('Google');
          expect(new URL(call.url).searchParams.get('scopes')).toBe(
            'https://www.googleapis.com/auth/cloud-platform',
          );
          return json({ access_token: 'ya29.token', expires_in: 3599 });
        },
    });
    const token = gcpMetadataToken({ env: {}, fetch: server.fetch });
    expect(await token()).toBe('ya29.token');
    expect(await token()).toBe('ya29.token');
    expect(server.calls).toHaveLength(1);
  });
});

describe('azureIdentityToken', () => {
  it('exchanges an AKS workload identity token', async () => {
    const entra = scripted({
      'POST https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token': (call) => {
        const form = new URLSearchParams(call.body);
        expect(form.get('client_assertion')).toBe('federated-jwt');
        expect(form.get('scope')).toBe('https://vault.azure.net/.default');
        expect(form.get('client_id')).toBe('client-1');
        return json({ access_token: 'entra-token', expires_in: 3600 });
      },
    });
    const token = azureIdentityToken({
      env: {
        AZURE_FEDERATED_TOKEN_FILE: '/var/run/azure',
        AZURE_CLIENT_ID: 'client-1',
        AZURE_TENANT_ID: 'tenant-1',
      },
      fetch: entra.fetch,
      readFile: async () => 'federated-jwt\n',
    });
    expect(await token()).toBe('entra-token');
  });

  it('uses the App Service identity endpoint', async () => {
    const appService = scripted({
      'GET http://localhost:4141/msi/token': (call) => {
        expect(call.headers.get('x-identity-header')).toBe('secret-header');
        expect(new URL(call.url).searchParams.get('api-version')).toBe('2019-08-01');
        return json({
          access_token: 'app-token',
          expires_on: String(Math.floor(Date.now() / 1000) + 3600),
        });
      },
    });
    const token = azureIdentityToken({
      env: {
        IDENTITY_ENDPOINT: 'http://localhost:4141/msi/token',
        IDENTITY_HEADER: 'secret-header',
      },
      fetch: appService.fetch,
    });
    expect(await token()).toBe('app-token');
  });

  it('falls back to the VM managed identity, and explains when there is none', async () => {
    const imds = scripted({
      'GET http://169.254.169.254/metadata/identity/oauth2/token': (call) => {
        expect(call.headers.get('metadata')).toBe('true');
        expect(new URL(call.url).searchParams.get('resource')).toBe('https://managedhsm.azure.net');
        return json({ access_token: 'vm-token', expires_in: '3600' });
      },
    });
    expect(
      await azureIdentityToken({
        env: {},
        fetch: imds.fetch,
        resource: 'https://managedhsm.azure.net',
      })(),
    ).toBe('vm-token');
    await expect(azureIdentityToken({ env: {}, fetch: scripted({}).fetch })()).rejects.toThrow(
      /No Azure identity found/,
    );
  });
});
