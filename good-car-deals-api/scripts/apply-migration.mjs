import { readFileSync } from 'fs';
import pg from 'pg';
const { Client } = pg;

const sql = readFileSync(new URL('../prisma/migrations/202605090000_init/migration.sql', import.meta.url), 'utf-8');

const client = new Client({
  host: '127.0.0.1',
  port: 51218,
  user: 'postgres',
  password: 'postgres',
  database: 'template1',
});

try {
  await client.connect();
  console.log('Connected to local PostgreSQL');
  await client.query(sql);
  console.log('Migration SQL applied successfully');
  await client.end();
  console.log('Done');
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
