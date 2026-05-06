require('dotenv').config();

const express = require('express');
const cors = require('cors');
const ofertasRouter = require('./routes/ofertas');

const app = express();
const PORT = process.env.PORT || 3580;

app.use(cors());
app.use(express.json());

app.use('/api/ofertas', ofertasRouter);

app.listen(PORT, () => {
  console.log(`Ofertas API corriendo en http://localhost:${PORT}`);
});
