const { Router } = require('express');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
const pool = require('../db/connection');

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
async function lookupEAN(ean) {
  const images = [];
  const opts = { signal: AbortSignal.timeout(8000) };

  const sources = [
    fetch(`https://world.openfoodfacts.org/api/v0/product/${ean}.json`, opts)
      .then(r => r.json()).then(d => {
        const img = d?.product?.image_url;
        if (img) images.push({ imageUrl: img, title: d.product?.product_name || ean, source: 'openfoodfacts', width: 0, height: 0 });
      }).catch(() => {}),
    fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`, opts)
      .then(r => r.json()).then(d => {
        (d?.items?.[0]?.images || []).forEach(img =>
          images.push({ imageUrl: img, title: d.items[0]?.title || ean, source: 'upcitemdb', width: 0, height: 0 })
        );
      }).catch(() => {}),
  ];

  await Promise.allSettled(sources);
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
router.post('/subir', async (req, res) => {
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

    // Actualizar en codigos (solo si no tiene imagen)
    const [resultCodigos] = await pool.query(
      `UPDATE codigos SET imagen = ? WHERE TRIM(barra) = ? AND (imagen IS NULL OR TRIM(imagen) = '')`,
      [cdnUrl, barra.trim()]
    );
    // También actualizar en codigos_global si existe la fila
    const [resultGlobal] = await pool.query(
      `UPDATE codigos_global SET imagen = ? WHERE TRIM(barra) = ? AND (imagen IS NULL OR TRIM(imagen) = '')`,
      [cdnUrl, barra.trim()]
    );

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
router.post('/subir-base64', async (req, res) => {
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
      `UPDATE codigos SET imagen = ? WHERE TRIM(barra) = ? AND (imagen IS NULL OR TRIM(imagen) = '')`,
      [cdnUrl, barra.trim()]
    );
    const [resultGlobal] = await pool.query(
      `UPDATE codigos_global SET imagen = ? WHERE TRIM(barra) = ? AND (imagen IS NULL OR TRIM(imagen) = '')`,
      [cdnUrl, barra.trim()]
    );

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
