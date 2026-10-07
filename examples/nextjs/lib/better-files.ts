import 'server-only';
import { createIamNext } from 'better-iam/next';
import { createBetterFilesNext } from 'better-files/next';
import { dr, iam } from '../../express-better-iam/better-files.js';

// Same instance setup as the Express example; in your app it lives here.
export { dr };

// Better IAM's Next helpers read the request's cookies; Better Files takes the credential and the tenant from them.
export const iamNext = createIamNext(iam);
export const drNext = createBetterFilesNext(dr, { iamNext });
