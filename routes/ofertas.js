const { Router } = require('express');
const pool = require('../db/connection');

const router = Router();

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

// Enriquece con imagen/categoria/marca: primero codigos_global, fallback codigos
async function agregarDatosProducto(rows) {
  if (!rows.length) return rows;
  const barras = [...new Set(rows.map(r => r.barra))];
  const ph = barras.map(() => '?').join(',');

  const [[cgRows], [cRows]] = await Promise.all([
    pool.query(`SELECT barra, imagen, categoria, marca FROM codigos_global WHERE barra IN (${ph})`, barras),
    pool.query(`SELECT barra, imagen FROM codigos WHERE barra IN (${ph}) AND imagen IS NOT NULL AND imagen != ''`, barras),
  ]);

  const mapaCg = Object.fromEntries(cgRows.map(r => [r.barra, r]));
  const mapaC  = Object.fromEntries(cRows.map(r => [r.barra, r.imagen]));

  return rows.map(r => {
    const cg = mapaCg[r.barra] || {};
    return {
      ...r,
      imagen:    cg.imagen    || mapaC[r.barra] || null,
      categoria: cg.categoria || null,
      marca:     cg.marca     || null,
    };
  });
}

// Enriquece con precio actual desde codigos
async function agregarPrecioActual(rows) {
  if (!rows.length) return rows;
  const barras = [...new Set(rows.map(r => r.barra))];
  const ph = barras.map(() => '?').join(',');
  const [precios] = await pool.query(
    `SELECT barra, precio FROM codigos WHERE barra IN (${ph}) GROUP BY barra`,
    barras
  );
  const mapa = Object.fromEntries(precios.map(p => [p.barra, p.precio]));
  return rows.map(r => ({ ...r, precio_actual: mapa[r.barra] ?? null }));
}

// Enriquece con datos del usuario
async function agregarUsuarios(rows) {
  const uuids = [...new Set(rows.map(r => r.user_uuid).filter(Boolean))];
  if (!uuids.length) return rows.map(r => ({ ...r, username: null, nombre: null, photo: null }));
  const ph = uuids.map(() => '?').join(',');
  const [usuarios] = await pool.query(
    `SELECT user_uuid, username, nombre, photo FROM usuarios WHERE user_uuid IN (${ph})`,
    uuids
  );
  const mapa = Object.fromEntries(usuarios.map(u => [u.user_uuid, u]));
  return rows.map(r => {
    const u = mapa[r.user_uuid] || {};
    return { ...r, username: u.username || null, nombre: u.nombre || null, photo: u.photo || null };
  });
}

async function enriquecer(rows) {
  const [conProducto, conPrecio] = await Promise.all([
    agregarDatosProducto(rows),
    agregarPrecioActual(rows),
  ]);
  const mapaPrecios = Object.fromEntries(conPrecio.map(r => [r.barra, r.precio_actual]));
  const merged = conProducto.map(r => ({ ...r, precio_actual: mapaPrecios[r.barra] ?? null }));
  return agregarUsuarios(merged);
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
      SELECT barra, user_uuid, descripcion, precio AS precio_oferta, f_inicio, f_fin, cantidad, fecha
      FROM (
        SELECT
          barra, user_uuid, descripcion, precio, f_inicio, f_fin, cantidad, fecha,
          ROW_NUMBER() OVER (PARTITION BY barra ORDER BY fecha DESC) AS rn
        FROM rotulos_mini
        WHERE f_fin_dt >= CURDATE()
          AND f_inicio_dt <= CURDATE()
          AND barra REGEXP '^[0-9]{6,}$'
      ) sub
      WHERE rn = 1
      ORDER BY fecha DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    const ofertas = await enriquecer(rows);
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
        MAX(rm.user_uuid)   AS user_uuid,
        MAX(rm.descripcion) AS descripcion,
        (
          SELECT r2.precio
          FROM rotulos_mini r2
          WHERE r2.barra = rm.barra
            AND r2.f_fin_dt >= CURDATE()
            AND r2.f_inicio_dt <= CURDATE()
          GROUP BY r2.precio
          ORDER BY COUNT(*) DESC
          LIMIT 1
        )                   AS precio_oferta,
        MAX(rm.f_inicio)    AS f_inicio,
        MAX(rm.f_fin)       AS f_fin,
        COUNT(*)            AS veces_generado
      FROM rotulos_mini rm
      WHERE rm.f_fin_dt >= CURDATE()
        AND rm.f_inicio_dt <= CURDATE()
        AND rm.barra REGEXP '^[0-9]{6,}$'
      GROUP BY rm.barra
      ORDER BY veces_generado DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    const recomendadas = await enriquecer(rows);
    const result = { ok: true, total: recomendadas.length, hasMore: rows.length === limit, recomendadas };
    setCache(cacheKey, result, TTL.recomendadas);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/ofertas/hoy
router.get('/hoy', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const cacheKey = `hoy:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.query(`
      SELECT barra, user_uuid, descripcion, precio AS precio_oferta, f_inicio, f_fin, cantidad, fecha
      FROM (
        SELECT
          barra, user_uuid, descripcion, precio, f_inicio, f_fin, cantidad, fecha,
          ROW_NUMBER() OVER (PARTITION BY barra ORDER BY fecha DESC) AS rn
        FROM rotulos_mini
        WHERE (f_inicio_dt = CURDATE() OR STR_TO_DATE(f_inicio, '%d/%m/%Y') = CURDATE())
          AND (f_fin_dt >= CURDATE() OR f_fin_dt IS NULL)
          AND barra REGEXP '^[0-9]{6,}$'
      ) sub
      WHERE rn = 1
      ORDER BY fecha DESC
      LIMIT ?
    `, [limit]);

    const hoy = await enriquecer(rows);
    const result = { ok: true, total: hoy.length, hoy };
    setCache(cacheKey, result, TTL.hoy);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function clearCache() {
  cache.clear();
}

module.exports = router;
module.exports.clearCache = clearCache;
