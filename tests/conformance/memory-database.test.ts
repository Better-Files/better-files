import { describe, it } from 'vitest';
import { conformanceSchema, databaseConformanceCases } from '@better-files/core/conformance';
import { memoryDatabase } from '@better-files/testing';

describe('memory database conformance', () => {
  for (const testCase of databaseConformanceCases())
    it(testCase.name, async () => {
      const db = memoryDatabase();
      await db.migrate(conformanceSchema);
      await testCase.run(db);
    });
});
