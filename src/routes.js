const express = require('express');

const routes = express.Router();

const AuthController = require('./controllers/AuthController');
const CorridaController = require('./controllers/CorridaController');
const MotoristaController = require('./controllers/MotoristaController');

const auth = require('./middlewares/auth');

routes.get('/', (request, response) => {

    return response.json({
        message: 'Bem-vindo ao servidor Mobilidade!'
    });

});

routes.get('/health', (request, response) => {

    return response.json({
        status: true,
        message: 'API funcionando!'
    });

});

routes.post('/signIn', AuthController.signIn);
routes.post('/signUp', AuthController.signUp);

routes.post('/corridas', auth, CorridaController.store);
routes.get(
    '/corridas/disponiveis',
    auth,
    CorridaController.disponiveis
);

routes.get(
    '/corridas/minha',
    auth,
    CorridaController.minha
);

routes.put(
    '/corridas/:id/aceitar',
    auth,
    CorridaController.aceitar
);

routes.put(
    '/corridas/:id/iniciar',
    auth,
    CorridaController.iniciar
);

routes.put(
    '/corridas/:id/finalizar',
    auth,
    CorridaController.finalizar
);

routes.get(
    '/corridas/historico', 
    auth, 
    CorridaController.historico
);
 
routes.put(
  '/corridas/:id/cancelar',
  auth,
  CorridaController.cancelar
);

// ==========================================================
// MOTORISTA
// ==========================================================

routes.put(
    '/motoristas/localizacao',
    auth,
    MotoristaController.atualizarLocalizacao
);

module.exports = routes;