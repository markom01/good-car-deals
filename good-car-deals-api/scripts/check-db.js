// Check DB state with pg
const pg = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/good_car_deals?sslmode=disable';
  const client = new pg.Client(connectionString);
  
  try {
    await client.connect();
    
    // Check table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public'
        AND table_name = 'Listing'
      );
    `);
    console.log('Table exists:', tableCheck.rows[0].exists);
    
    if (!tableCheck.rows[0].exists) {
      console.log('Table does not exist!');
      await client.end();
      return;
    }
    
    // Get count
    const countResult = await client.query('SELECT COUNT(*) as count FROM "Listing"');
    console.log('Total listings:', countResult.rows[0].count);
    
    // Get classification status
    const distResult = await client.query(`
      SELECT "dealType", COUNT(*) as count 
      FROM "Listing" 
      GROUP BY "dealType"
    `);
    console.log('\nDistribution:');
    distResult.rows.forEach(r => {
      console.log(`  ${r.dealType || 'null'}: ${r.count}`);
    });
    
    // Need classification
    const needClass = await client.query(`
      SELECT COUNT(*) as count FROM "Listing" 
      WHERE "dealType" IS NULL 
        AND "priceNumeric" IS NOT NULL 
        AND year IS NOT NULL
    `);
    console.log('\nNeed classification:', needClass.rows[0].count);
    
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    await client.end();
  }
}

main();