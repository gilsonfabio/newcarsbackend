const express = require('express');
const cors = require('cors');
const http = require('http');

const {recuperarDespachos } = require('./services/DespachoCorridas');

require('dotenv/config');

const routes = require('./routes');
const { configurarSocket } = require('./socket');

console.log(
'Google Routes API configurada:',
Boolean(process.env.GOOGLE_ROUTES_API_KEY)
);

const app = express();

app.use(cors());

app.use(express.json());

app.use(routes);

const server = http.createServer(app);

// Inicializa o Socket.IO no mesmo servidor HTTP da API.
configurarSocket(server);

const port = process.env.PORT || 3333;

server.listen(port, '0.0.0.0', () => {
    console.info(`Servidor Mobilidade rodando na porta ${port}`);

    await recuperarDespachos();

});
