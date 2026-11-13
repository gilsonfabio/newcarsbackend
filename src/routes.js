
const express = require('express');

const routes = express.Router();

const AuthController = require('./controllers/AuthController');
const CorridaController = require('./controllers/CorridaController');
const MotoristaController = require('./controllers/MotoristaController');
const VeiculoController = require('./controllers/VeiculoController');
const AdminMotoristaController = require('./controllers/AdminMotoristaController');
const PasswordController = require('./controllers/PasswordController');
const PagamentoController = require('./controllers/PagamentoController');

const auth = require('./middlewares/auth');
const admin = require('./middlewares/admin');

// ==========================================================
// PRINCIPAL
// ==========================================================

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

// ==========================================================
// AUTENTICAÇÃO
// ==========================================================

routes.post('/signIn', AuthController.signIn);
routes.post('/signUp', AuthController.signUp);

// ==========================================================
// CORRIDAS
// ==========================================================

routes.post(
    '/corridas/estimativa',
    auth,
    CorridaController.estimativa
);

routes.post(
    '/corridas',
    auth,
    CorridaController.store
);

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

routes.put(
    '/corridas/:id/pagamento/confirmar',
    auth,
    CorridaController.confirmarPagamento
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

routes.put(
    '/corridas/:id/recusar',
    auth,
    CorridaController.recusar
);

// ==========================================================
// PAGAMENTOS ONLINE - MERCADO PAGO
// ==========================================================

// Criar PIX para uma corrida

routes.post(
    '/corridas/:id/pagamento/pix',
    auth,
    PagamentoController.criarPix
);

// Consultar pagamento de uma corrida

routes.get(
    '/corridas/:id/pagamento',
    auth,
    PagamentoController.consultar
);

// Webhook Mercado Pago
// Não utilizar middleware auth: a autenticação é feita
// pela assinatura HMAC enviada pelo próprio Mercado Pago.

routes.post(
    '/webhooks/mercadopago',
    PagamentoController.webhook
);

// ==========================================================
// MOTORISTA
// ==========================================================

routes.put(
    '/motoristas/localizacao',
    auth,
    MotoristaController.atualizarLocalizacao
);

routes.get(
    '/marcas',
    VeiculoController.marcas
);

routes.get(
    '/modelos/marca/:marcaId',
    VeiculoController.modelosPorMarca
);

routes.get(
    '/categorias',
    VeiculoController.categorias
);

// ==========================================================
// ADMINISTRAÇÃO DE MOTORISTAS
// ==========================================================

routes.get(
    '/admin/motoristas/pendentes',
    auth,
    admin,
    AdminMotoristaController.listarPendentes
);

routes.put(
    '/admin/motoristas/:motoristaId/status',
    auth,
    admin,
    AdminMotoristaController.atualizarStatus
);

// ==========================================================
// RECUPERAÇÃO DE SENHA
// ==========================================================

routes.post(
    '/password/forgot',
    PasswordController.forgot
);

routes.post(
    '/password/reset',
    PasswordController.reset
);

module.exports = routes;
