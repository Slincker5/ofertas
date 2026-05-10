require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { authJWT } = require('./middleware/auth');
const ofertasRouter  = require('./routes/ofertas');
const imagenesRouter = require('./routes/imagenes');

const app  = express();
const PORT = process.env.PORT || 3580;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(authJWT);

app.use('/api/ofertas',  ofertasRouter);
app.use('/api/imagenes', imagenesRouter);

app.listen(PORT, () => {
  console.log(`Ofertas API corriendo en http://localhost:${PORT}`);
});
