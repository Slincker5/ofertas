const { Router } = require('express');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
const pool = require('../db/connection');
const { clearCache } = require('./ofertas');
const { authAdmin } = require('../middleware/auth');

const router = Router();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Serper image search ────────────────────────────────────────────────────
async function searchSerper(query) {
  const res = await fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, gl: 'sv', hl: 'es-419', num: 20 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.images || []).map(img => {
    let score = 0;
    const src = (img.imageUrl || '').toLowerCase();
    const title = (img.title || '').toLowerCase();
    if (!img.imageUrl) score -= 1000;
    if (/facebook|instagram|tiktok|pinterest|youtube|twitter|reddit/.test(src)) score -= 150;
    if (/walmart|maxidespensa|ladespensa/.test(src)) score += 35;
    if (/superselectos/.test(src)) score += 100;
    if (img.imageWidth  >= 600) score += 10;
    if (img.imageHeight >= 600) score += 10;
    query.toLowerCase().split(' ').forEach(w => { if (w.length > 2 && title.includes(w)) score += 4; });
    return { ...img, score };
  })
  .filter(img => img.imageUrl)
  .sort((a, b) => b.score - a.score)
  .slice(0, 12)
  .map(img => ({
    imageUrl: img.imageUrl,
    title:    img.title,
    width:    img.imageWidth,
    height:   img.imageHeight,
    source:   'serper',
  }));
}

// ── EAN lookup ────────────────────────────────────────────────────────────
const EAN_TIMEOUT = 8000;
const EAN_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

async function fetchJson(url, timeout = EAN_TIMEOUT) {
  try {
    const r = await fetch(url, { headers: EAN_HEADERS, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function openFoodFacts(ean) {
  const data = await fetchJson(`https://world.openfoodfacts.org/api/v2/product/${ean}.json`);
  if (!data || data.status !== 1) return null;
  const p = data.product;
  const imgs = [...new Set([p.image_url, p.image_front_url, p.image_ingredients_url, p.image_nutrition_url].filter(Boolean))];
  return { source: 'openfoodfacts', name: p.product_name || '', images: imgs };
}

async function openBeautyFacts(ean) {
  const data = await fetchJson(`https://world.openbeautyfacts.org/api/v2/product/${ean}.json`);
  if (!data || data.status !== 1) return null;
  const p = data.product;
  const imgs = [...new Set([p.image_url, p.image_front_url].filter(Boolean))];
  return { source: 'openbeautyfacts', name: p.product_name || '', images: imgs };
}

async function openPetFoodFacts(ean) {
  const data = await fetchJson(`https://world.openpetfoodfacts.org/api/v2/product/${ean}.json`);
  if (!data || data.status !== 1) return null;
  const p = data.product;
  const imgs = [...new Set([p.image_url, p.image_front_url].filter(Boolean))];
  return { source: 'openpetfoodfacts', name: p.product_name || '', images: imgs };
}

async function upcitemdb(ean) {
  const data = await fetchJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`);
  if (!data) return null;
  const item = data.items?.[0];
  if (!item) return null;
  return { source: 'upcitemdb', name: item.title || '', images: item.images || [] };
}

const VTEX_STORES = [
  { name: 'Despensa (SV)', base: 'https://www.ladespensadedonjuan.com.sv', priority: 'high' },
  { name: 'Walmart (GT)',  base: 'https://www.walmart.com.gt',             priority: 'high' },
  { name: 'Walmart (CR)',  base: 'https://www.walmart.co.cr',              priority: 'medium' },
  { name: 'Éxito (CO)',    base: 'https://www.exito.com',                  priority: 'low' },
  { name: 'Carulla (CO)', base: 'https://www.carulla.com',                priority: 'low' },
  { name: 'Jumbo (CO)',    base: 'https://www.tiendasjumbo.co',            priority: 'low' },
  { name: 'Chedraui (MX)',base: 'https://www.chedraui.com.mx',            priority: 'low' },
  { name: 'Jumbo (AR)',    base: 'https://www.jumbo.com.ar',               priority: 'low' },
  { name: 'Jumbo (CL)',    base: 'https://www.jumbo.cl',                   priority: 'low' },
  { name: 'Wong (PE)',     base: 'https://www.wong.pe',                    priority: 'low' },
  { name: 'Carrefour (BR)',base: 'https://www.carrefour.com.br',           priority: 'low' },
];

async function vtexLookup(store, ean) {
  const data = await fetchJson(`${store.base}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean}`);
  if (Array.isArray(data) && data.length > 0) {
    const p = data[0];
    for (const item of (p.items || [])) {
      const imgs = (item.images || []).map(i => i.imageUrl).filter(Boolean);
      if (imgs.length) return { source: `vtex-${store.name}`, name: p.productName || '', images: imgs };
    }
  }
  const sku = await fetchJson(`${store.base}/api/catalog_system/pub/sku/stockkeepingunitbyean/${ean}`);
  if (sku?.Id) {
    const imgs = (sku.Images || []).filter(i => typeof i === 'object').map(i => i.ImageUrl).filter(Boolean);
    if (imgs.length) return { source: `vtex-${store.name}`, name: sku.NameComplete || '', images: imgs };
  }
  return null;
}

async function lookupEAN(ean) {
  const highVtex = VTEX_STORES.filter(s => s.priority === 'high');
  const lowVtex  = VTEX_STORES.filter(s => s.priority !== 'high');

  const wave1 = await Promise.allSettled([
    openFoodFacts(ean),
    upcitemdb(ean),
    openBeautyFacts(ean),
    openPetFoodFacts(ean),
    ...highVtex.map(s => vtexLookup(s, ean)),
  ]);

  const results = wave1.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

  if (!results.length) {
    const wave2 = await Promise.allSettled(lowVtex.map(s => vtexLookup(s, ean)));
    wave2.filter(r => r.status === 'fulfilled' && r.value).forEach(r => results.push(r.value));
  }

  const seenUrls = new Set();
  const images = [];
  for (const r of results) {
    for (const url of (r.images || [])) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        images.push({ imageUrl: url, title: r.name || ean, source: r.source, width: 0, height: 0 });
      }
    }
  }
  return images;
}

// ── GET /api/imagenes/buscar?barra=&descripcion= ──────────────────────────
router.get('/buscar', async (req, res) => {
  const { barra = '', descripcion = '' } = req.query;
  if (!descripcion && !barra) return res.json({ ok: false, error: 'barra o descripcion requerida' });

  const query = [descripcion, barra].filter(Boolean).join(' ');
  const isEAN = /^\d{8,14}$/.test(barra.trim());

  const [serperResults, eanResults] = await Promise.allSettled([
    searchSerper(query),
    isEAN ? lookupEAN(barra.trim()) : Promise.resolve([]),
  ]);

  const serper = serperResults.status === 'fulfilled' ? serperResults.value : [];
  const ean    = eanResults.status    === 'fulfilled' ? eanResults.value    : [];

  res.json({ ok: true, resultados: [...ean, ...serper] });
});

// ── POST /api/imagenes/subir ──────────────────────────────────────────────
// body: { barra, imageUrl }
router.post('/subir', authAdmin, async (req, res) => {
  const { barra, imageUrl } = req.body;
  if (!barra || !imageUrl) return res.status(400).json({ ok: false, error: 'barra e imageUrl requeridos' });

  try {
    // Descargar imagen
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!imgRes.ok) throw new Error(`No se pudo descargar la imagen: ${imgRes.status}`);

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
    const ext = extMap[contentType.split(';')[0].trim()] || 'jpg';

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const key    = `${process.env.S3_KEY_PREFIX || ''}${randomUUID()}.${ext}`;

    // Subir a S3
    await s3.send(new PutObjectCommand({
      Bucket:      process.env.AWS_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
    }));

    const cdnUrl = `${process.env.CDN_BASE_URL}/${key}`;

    // Actualizar en codigos
    const [resultCodigos] = await pool.query(
      `UPDATE codigos SET imagen = ? WHERE TRIM(barra) = ?`,
      [cdnUrl, barra.trim()]
    );
    // También actualizar en codigos_global si existe la fila
    const [resultGlobal] = await pool.query(
      `UPDATE codigos_global SET imagen = ? WHERE TRIM(barra) = ?`,
      [cdnUrl, barra.trim()]
    );

    clearCache();

    res.json({
      ok: true,
      cdnUrl,
      actualizados: {
        codigos:       resultCodigos.affectedRows,
        codigos_global: resultGlobal.affectedRows,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/imagenes/subir-base64 ──────────────────────────────────────
// body: { barra, imageBase64, contentType }
router.post('/subir-base64', authAdmin, async (req, res) => {
  const { barra, imageBase64, contentType = 'image/jpeg' } = req.body;
  if (!barra || !imageBase64) return res.status(400).json({ ok: false, error: 'barra e imageBase64 requeridos' });

  try {
    const buffer = Buffer.from(imageBase64, 'base64');
    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
    const ext = extMap[contentType.split(';')[0].trim()] || 'jpg';
    const key = `${process.env.S3_KEY_PREFIX || ''}${randomUUID()}.${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket:      process.env.AWS_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
    }));

    const cdnUrl = `${process.env.CDN_BASE_URL}/${key}`;

    const [resultCodigos] = await pool.query(
      `UPDATE codigos SET imagen = ? WHERE TRIM(barra) = ?`,
      [cdnUrl, barra.trim()]
    );
    const [resultGlobal] = await pool.query(
      `UPDATE codigos_global SET imagen = ? WHERE TRIM(barra) = ?`,
      [cdnUrl, barra.trim()]
    );

    clearCache();

    res.json({
      ok: true,
      cdnUrl,
      actualizados: {
        codigos:        resultCodigos.affectedRows,
        codigos_global: resultGlobal.affectedRows,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
