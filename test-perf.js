require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 3,
});

async function t(label, fn) {
  const start = Date.now();
  const result = await fn();
  const rows = Array.isArray(result) ? result : result[0];
  console.log(`${label}: ${Date.now() - start}ms | rows: ${rows.length}`);
  return rows;
}

async function main() {
  // 1. Query base sin JOINs
  const rows = await t('1. rotulos_mini solo', async () => {
    return pool.query(`
      SELECT rm.barra, rm.user_uuid, MAX(rm.descripcion) AS descripcion,
             MAX(rm.precio) AS precio_oferta, MAX(rm.f_inicio) AS f_inicio,
             MAX(rm.f_fin) AS f_fin, MAX(rm.cantidad) AS cantidad
      FROM rotulos_mini rm
      WHERE rm.f_fin_dt >= CURDATE() AND rm.f_inicio_dt <= CURDATE() AND TRIM(rm.barra) != ''
      GROUP BY rm.barra, rm.user_uuid
      ORDER BY MAX(rm.fecha) DESC LIMIT 30
    `);
  });

  // 2. IN en codigos_global (30 barras)
  const barras = rows.map(r => r.barra);
  const ph = barras.map(() => '?').join(',');

  await t('2. codigos_global IN (30 barras)', async () => {
    return pool.query(`SELECT barra, imagen, categoria, marca FROM codigos_global WHERE barra IN (${ph})`, barras);
  });

  // 3. IN en codigos (30 barras)
  await t('3. codigos IN (30 barras) imagen', async () => {
    return pool.query(`SELECT barra, imagen FROM codigos WHERE barra IN (${ph}) AND imagen IS NOT NULL`, barras);
  });

  // 4. IN en codigos (30 barras) precio
  await t('4. codigos IN (30 barras) precio', async () => {
    return pool.query(`SELECT barra, precio FROM codigos WHERE barra IN (${ph}) GROUP BY barra`, barras);
  });

  // 5. IN en usuarios
  const uuids = [...new Set(rows.map(r => r.user_uuid).filter(Boolean))];
  if (uuids.length) {
    const phu = uuids.map(() => '?').join(',');
    await t('5. usuarios IN', async () => {
      return pool.query(`SELECT user_uuid, username, nombre, photo FROM usuarios WHERE user_uuid IN (${phu})`, uuids);
    });
  }

  console.log('\nTodo OK - estrategia sin JOINs funciona');
  await pool.end();
}

main().catch(console.error);
