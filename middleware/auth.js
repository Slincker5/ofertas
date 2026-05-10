const jwt  = require('jsonwebtoken');
const pool = require('../db/connection');

function authJWT(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Token requerido' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
  }
}

async function authAdmin(req, res, next) {
  const user_uuid = req.user?.user_uuid;
  if (!user_uuid) return res.status(403).json({ ok: false, error: 'Sin permisos' });

  try {
    const [[usuario]] = await pool.query(
      'SELECT rol FROM usuarios WHERE user_uuid = ?',
      [user_uuid]
    );
    if (!usuario || usuario.rol !== 'Admin') {
      return res.status(403).json({ ok: false, error: 'Se requiere rol Admin' });
    }
    next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = { authJWT, authAdmin };
