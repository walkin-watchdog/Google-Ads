import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const composePath = path.join(import.meta.dir, '..', 'docker-compose.vps.yml');

describe('VPS Docker Compose', () => {
    test('mounts PostgreSQL 18 data at its version-aware parent directory', () => {
        const compose = fs.readFileSync(composePath, 'utf8');
        expect(compose).toContain('image: pgvector/pgvector:pg18');
        expect(compose).toContain('postgres_data:/var/lib/postgresql');
        expect(compose).not.toContain('postgres_data:/var/lib/postgresql/data');
    });
});
