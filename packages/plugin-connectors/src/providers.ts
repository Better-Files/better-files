import { BetterFilesError } from '@better-files/core';

/** A file or folder in a cloud drive. */
export interface RemoteItem {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  size?: number;
  mimeType?: string;
  modifiedAt?: number;
  /** Changes whenever the content changes (etag, content hash, revision); re-imports compare it. */
  revision?: string;
}

export interface ConnectorCall {
  /** The signed-in user's OAuth access token for this provider. */
  token: string;
  fetch: typeof fetch;
}

/** A cloud drive. Implement it for other sources (SFTP, a DMS, another data room). */
export interface Connector {
  readonly id: string;
  readonly label: string;
  /** Children of a folder; the drive's root when `folderId` is omitted. */
  list(input: ConnectorCall & { folderId?: string }): Promise<RemoteItem[]>;
  download(input: ConnectorCall & { item: RemoteItem; maxBytes: number }): Promise<{
    bytes: Uint8Array;
    filename: string;
    mimeType?: string;
  }>;
}

async function check(label: string, response: Response): Promise<Response> {
  if (response.ok) return response;
  const detail = (await response.text().catch(() => '')).slice(0, 200);
  throw new BetterFilesError('CONFLICT', `${label} refused the request (${response.status})`, {
    details: { provider: label, status: response.status, ...(detail ? { detail } : {}) },
  });
}

async function readLimited(
  label: string,
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes)
    throw new BetterFilesError('PAYLOAD_TOO_LARGE', `The ${label} file is too large`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BetterFilesError('PAYLOAD_TOO_LARGE', `The ${label} file is too large`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const time = (value: unknown) =>
  typeof value === 'string' ? Date.parse(value) || undefined : undefined;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const googleFolder = 'application/vnd.google-apps.folder';
/** Google-native files have no bytes of their own: they are exported. */
const googleExports: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': { mimeType: 'application/pdf', extension: '.pdf' },
  'application/vnd.google-apps.presentation': { mimeType: 'application/pdf', extension: '.pdf' },
  'application/vnd.google-apps.drawing': { mimeType: 'application/pdf', extension: '.pdf' },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
};

/** Google Drive (API v3), including shared drives. Scope: `drive.readonly`. */
export function googleDrive(options: { baseUrl?: string } = {}): Connector {
  const base = options.baseUrl ?? 'https://www.googleapis.com/drive/v3';
  return {
    id: 'google-drive',
    label: 'Google Drive',
    async list({ token, fetch, folderId }) {
      const items: RemoteItem[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(`${base}/files`);
        url.searchParams.set(
          'q',
          `'${(folderId ?? 'root').replace(/['\\]/g, '\\$&')}' in parents and trashed = false`,
        );
        url.searchParams.set(
          'fields',
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,version)',
        );
        url.searchParams.set('pageSize', '1000');
        url.searchParams.set('supportsAllDrives', 'true');
        url.searchParams.set('includeItemsFromAllDrives', 'true');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const body = (await (
          await check('Google Drive', await fetch(url, { headers: bearer(token) }))
        ).json()) as {
          nextPageToken?: string;
          files: {
            id: string;
            name: string;
            mimeType: string;
            size?: string;
            modifiedTime?: string;
            md5Checksum?: string;
            version?: string;
          }[];
        };
        for (const file of body.files) {
          const folder = file.mimeType === googleFolder;
          const modifiedAt = time(file.modifiedTime);
          items.push({
            id: file.id,
            name: file.name,
            kind: folder ? 'folder' : 'file',
            mimeType: file.mimeType,
            ...(file.size ? { size: Number(file.size) } : {}),
            ...(modifiedAt ? { modifiedAt } : {}),
            ...(folder
              ? {}
              : { revision: file.md5Checksum ?? file.version ?? file.modifiedTime ?? '' }),
          });
        }
        pageToken = body.nextPageToken;
      } while (pageToken);
      return items;
    },
    async download({ token, fetch, item, maxBytes }) {
      const exported = item.mimeType ? googleExports[item.mimeType] : undefined;
      const id = encodeURIComponent(item.id);
      const url = exported
        ? `${base}/files/${id}/export?mimeType=${encodeURIComponent(exported.mimeType)}`
        : `${base}/files/${id}?alt=media&supportsAllDrives=true`;
      const response = await check('Google Drive', await fetch(url, { headers: bearer(token) }));
      return {
        bytes: await readLimited('Google Drive', response, maxBytes),
        filename:
          exported && !item.name.toLowerCase().endsWith(exported.extension)
            ? item.name + exported.extension
            : item.name,
        ...(exported
          ? { mimeType: exported.mimeType }
          : item.mimeType
            ? { mimeType: item.mimeType }
            : {}),
      };
    },
  };
}

/** Dropbox (API v2). Scopes: `files.metadata.read`, `files.content.read`. */
export function dropbox(options: { apiUrl?: string; contentUrl?: string } = {}): Connector {
  const api = options.apiUrl ?? 'https://api.dropboxapi.com/2';
  const content = options.contentUrl ?? 'https://content.dropboxapi.com/2';
  // Dropbox-API-Arg is JSON in a header: non-ASCII characters must be escaped.
  const headerJson = (value: unknown) =>
    JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  return {
    id: 'dropbox',
    label: 'Dropbox',
    async list({ token, fetch, folderId }) {
      const items: RemoteItem[] = [];
      type Page = {
        entries: {
          '.tag': 'file' | 'folder' | 'deleted';
          id: string;
          name: string;
          size?: number;
          server_modified?: string;
          content_hash?: string;
          rev?: string;
        }[];
        cursor: string;
        has_more: boolean;
      };
      const post = async (path: string, body: unknown) =>
        (await (
          await check(
            'Dropbox',
            await fetch(`${api}${path}`, {
              method: 'POST',
              headers: { ...bearer(token), 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
          )
        ).json()) as Page;
      let page = await post('/files/list_folder', {
        path: folderId ?? '',
        recursive: false,
        limit: 2000,
      });
      for (;;) {
        for (const entry of page.entries) {
          if (entry['.tag'] === 'deleted') continue;
          const modifiedAt = time(entry.server_modified);
          items.push({
            id: entry.id,
            name: entry.name,
            kind: entry['.tag'] === 'folder' ? 'folder' : 'file',
            ...(entry.size !== undefined ? { size: entry.size } : {}),
            ...(modifiedAt ? { modifiedAt } : {}),
            ...(entry['.tag'] === 'file'
              ? { revision: entry.content_hash ?? entry.rev ?? '' }
              : {}),
          });
        }
        if (!page.has_more) break;
        page = await post('/files/list_folder/continue', { cursor: page.cursor });
      }
      return items;
    },
    async download({ token, fetch, item, maxBytes }) {
      const response = await check(
        'Dropbox',
        await fetch(`${content}/files/download`, {
          method: 'POST',
          headers: { ...bearer(token), 'dropbox-api-arg': headerJson({ path: item.id }) },
        }),
      );
      return { bytes: await readLimited('Dropbox', response, maxBytes), filename: item.name };
    },
  };
}

/** OneDrive and SharePoint through Microsoft Graph. Scope: `Files.Read.All`. `driveId` picks a SharePoint library. */
export function microsoftGraph(options: { driveId?: string; baseUrl?: string } = {}): Connector {
  const base = options.baseUrl ?? 'https://graph.microsoft.com/v1.0';
  const drive = options.driveId
    ? `${base}/drives/${encodeURIComponent(options.driveId)}`
    : `${base}/me/drive`;
  return {
    id: options.driveId ? `sharepoint:${options.driveId}` : 'onedrive',
    label: options.driveId ? 'SharePoint' : 'OneDrive',
    async list({ token, fetch, folderId }) {
      const items: RemoteItem[] = [];
      let url: string | undefined =
        `${folderId ? `${drive}/items/${encodeURIComponent(folderId)}` : `${drive}/root`}/children` +
        '?$top=999&$select=id,name,size,file,folder,lastModifiedDateTime,eTag,cTag';
      while (url) {
        const body = (await (
          await check('Microsoft Graph', await fetch(url, { headers: bearer(token) }))
        ).json()) as {
          value: {
            id: string;
            name: string;
            size?: number;
            file?: { mimeType?: string };
            folder?: object;
            lastModifiedDateTime?: string;
            cTag?: string;
            eTag?: string;
          }[];
          '@odata.nextLink'?: string;
        };
        for (const entry of body.value) {
          const modifiedAt = time(entry.lastModifiedDateTime);
          items.push({
            id: entry.id,
            name: entry.name,
            kind: entry.folder ? 'folder' : 'file',
            ...(entry.size !== undefined ? { size: entry.size } : {}),
            ...(entry.file?.mimeType ? { mimeType: entry.file.mimeType } : {}),
            ...(modifiedAt ? { modifiedAt } : {}),
            ...(entry.folder ? {} : { revision: entry.cTag ?? entry.eTag ?? '' }),
          });
        }
        url = body['@odata.nextLink'];
      }
      return items;
    },
    async download({ token, fetch, item, maxBytes }) {
      const response = await check(
        'Microsoft Graph',
        await fetch(`${drive}/items/${encodeURIComponent(item.id)}/content`, {
          headers: bearer(token),
        }),
      );
      return {
        bytes: await readLimited('Microsoft Graph', response, maxBytes),
        filename: item.name,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      };
    },
  };
}

/** Box (API 2.0). Scope: read all files and folders. */
export function box(options: { baseUrl?: string } = {}): Connector {
  const base = options.baseUrl ?? 'https://api.box.com/2.0';
  return {
    id: 'box',
    label: 'Box',
    async list({ token, fetch, folderId }) {
      const items: RemoteItem[] = [];
      for (let offset = 0; ; ) {
        const url = `${base}/folders/${encodeURIComponent(folderId ?? '0')}/items?fields=id,type,name,size,modified_at,sha1,etag&limit=1000&offset=${offset}`;
        const body = (await (
          await check('Box', await fetch(url, { headers: bearer(token) }))
        ).json()) as {
          total_count: number;
          entries: {
            id: string;
            type: 'file' | 'folder' | 'web_link';
            name: string;
            size?: number;
            modified_at?: string;
            sha1?: string;
            etag?: string;
          }[];
        };
        for (const entry of body.entries) {
          if (entry.type === 'web_link') continue;
          const modifiedAt = time(entry.modified_at);
          items.push({
            id: entry.id,
            name: entry.name,
            kind: entry.type,
            ...(entry.size !== undefined ? { size: entry.size } : {}),
            ...(modifiedAt ? { modifiedAt } : {}),
            ...(entry.type === 'file' ? { revision: entry.sha1 ?? entry.etag ?? '' } : {}),
          });
        }
        offset += body.entries.length;
        if (body.entries.length === 0 || offset >= body.total_count) break;
      }
      return items;
    },
    async download({ token, fetch, item, maxBytes }) {
      const response = await check(
        'Box',
        await fetch(`${base}/files/${encodeURIComponent(item.id)}/content`, {
          headers: bearer(token),
        }),
      );
      return { bytes: await readLimited('Box', response, maxBytes), filename: item.name };
    },
  };
}
