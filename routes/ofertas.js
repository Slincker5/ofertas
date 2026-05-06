const { Router } = require('express');
const pool = require('../db/connection');

const router = Router();

// Cache simple en memoria
const cache = new Map();
const TTL = {
  activas:      60 * 1000,
  recomendadas: 60 * 1000,
  hoy:          60 * 1000,
};

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data, ttl) {
  cache.set(key, { data, expires: Date.now() + ttl });
}

async function agregarPrecioActual(rows) {
  if (!rows.length) return rows;
  const barras = [...new Set(rows.map(r => r.barra))];
  const placeholders = barras.map(() => '?').join(',');
  const [precios] = await pool.query(
    `SELECT barra, precio FROM codigos WHERE barra IN (${placeholders}) GROUP BY barra`,
    barras
  );
  const mapaPrecios = Object.fromEntries(precios.map(p => [p.barra, p.precio]));
  return rows.map(r => ({ ...r, precio_actual: mapaPrecios[r.barra] ?? null }));
}

// GET /api/ofertas/activas
router.get('/activas', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 30, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const cacheKey = `activas:${limit}:${offset}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.query(`
      SELECT
        rm.barra,
        MAX(rm.descripcion) AS descripcion,
        MAX(rm.precio)      AS precio_oferta,
        MAX(rm.f_inicio)    AS f_inicio,
        MAX(rm.f_fin)       AS f_fin,
        MAX(rm.cantidad)    AS cantidad,
        cg.imagen,
        cg.categoria,
        cg.marca,
        u.user_uuid,
        u.username,
        u.nombre,
        u.photo
      FROM rotulos_mini rm
      INNER JOIN codigos_global cg ON cg.barra = rm.barra
      LEFT JOIN usuarios u ON u.user_uuid = rm.user_uuid
      WHERE rm.f_fin_dt >= CURDATE()
        AND rm.f_inicio_dt <= CURDATE()
        AND TRIM(rm.barra) != ''
      GROUP BY rm.barra
      ORDER BY MAX(rm.fecha) DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    const ofertas = await agregarPrecioActual(rows);
    const result = { ok: true, total: ofertas.length, hasMore: rows.length === limit, ofertas };
    setCache(cacheKey, result, TTL.activas);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/ofertas/recomendadas
router.get('/recomendadas', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
    const offset = Math.max(parseInt(req.query.offset) || 0,  0);
    const cacheKey = `recomendadas:${limit}:${offset}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.query(`
      SELECT
        rm.barra,
        rm.descripcion,
        rm.precio   AS precio_oferta,
        rm.f_inicio,
        rm.f_fin,
        cg.imagen,
        cg.categoria,
        cg.marca,
        u.user_uuid,
        u.username,
        u.nombre,
        u.photo,
        COUNT(*)    AS veces_generado
      FROM rotulos_mini rm
      INNER JOIN codigos_global cg ON cg.barra = rm.barra
      LEFT JOIN usuarios u ON u.user_uuid = rm.user_uuid
      WHERE rm.f_fin_dt >= CURDATE()
        AND rm.f_inicio_dt <= CURDATE()
        AND TRIM(rm.barra) != ''
      GROUP BY rm.barra
      ORDER BY veces_generado DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    const recomendadas = await agregarPrecioActual(rows);
    const result = { ok: true, total: recomendadas.length, hasMore: rows.length === limit, recomendadas };
    setCache(cacheKey, result, TTL.recomendadas);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/ofertas/hoy — Ofertas con fecha de inicio hoy y aún activas
router.get('/hoy', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const cacheKey = `hoy:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.query(`
      SELECT
        rm.barra,
        rm.descripcion,
        rm.precio   AS precio_oferta,
        rm.f_inicio,
        rm.f_fin,
        rm.cantidad,
        cg.imagen,
        cg.categoria,
        cg.marca,
        u.user_uuid,
        u.username,
        u.nombre,
        u.photo
      FROM rotulos_mini rm
      LEFT JOIN codigos_global cg ON cg.barra = rm.barra
      LEFT JOIN usuarios u ON u.user_uuid = rm.user_uuid
      WHERE (rm.f_inicio_dt = CURDATE() OR STR_TO_DATE(rm.f_inicio, '%d/%m/%Y') = CURDATE())
        AND (rm.f_fin_dt >= CURDATE() OR rm.f_fin_dt IS NULL)
        AND TRIM(rm.barra) != ''
      GROUP BY rm.barra, rm.precio, rm.f_inicio, rm.f_fin
      ORDER BY rm.fecha DESC
      LIMIT ?
    `, [limit]);

    const hoy = await agregarPrecioActual(rows);
    const result = { ok: true, total: hoy.length, hoy };
    setCache(cacheKey, result, TTL.hoy);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
