import { beforeAll, describe, it } from 'vitest';
import { storageConformanceCases } from '@better-files/core/conformance';
import { ensureBucket, realS3, s3Configured } from '../docker/services.js';

// `tests/storage/storage.test.ts` runs the same cases against an in-memory S3 fake. This file runs them against a real
// S3-compatible service (MinIO from tests/docker/compose.yml, or any bucket), which enforces what a fake may not:
// signatures, the 5 MiB minimum for every multipart part but the last, and ETag handling.
describe.skipIf(!s3Configured)('s3 (real service) storage conformance', () => {
  beforeAll(ensureBucket);
  for (const testCase of storageConformanceCases())
    it(testCase.name, () => testCase.run(realS3('conformance')), 60_000);
});
